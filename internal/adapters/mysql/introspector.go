// Package mysql provides a DBIntrospector implementation backed by MySQL's
// INFORMATION_SCHEMA views. It has no CGO dependency — it uses the pure-Go
// go-sql-driver/mysql driver.
package mysql

import (
	"context"
	"database/sql"
	"fmt"
	"sort"

	// Register the mysql driver as a side-effect.
	_ "github.com/go-sql-driver/mysql"

	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// Introspector implements ports.DBIntrospector for MySQL 5.7+/8.0.
// Zero-value is not usable; construct via New.
type Introspector struct {
	dsn string
	db  *sql.DB
}

// New returns a new Introspector configured to connect to the given DSN.
// The DSN must be in the go-sql-driver format, e.g.:
//
//	user:pass@tcp(host:port)/dbname?parseTime=true
func New(dsn string) *Introspector {
	return &Introspector{dsn: dsn}
}

// Connect opens and pings the MySQL connection.
func (i *Introspector) Connect(ctx context.Context) error {
	db, err := sql.Open("mysql", i.dsn)
	if err != nil {
		return fmt.Errorf("mysql: open: %w", err)
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return fmt.Errorf("mysql: ping: %w", err)
	}
	i.db = db
	return nil
}

// ListTables returns the names of all BASE TABLE objects in the target
// schema, ordered alphabetically. Views are excluded.
func (i *Introspector) ListTables(ctx context.Context) ([]string, error) {
	rows, err := i.db.QueryContext(ctx, `
		SELECT TABLE_NAME
		FROM   INFORMATION_SCHEMA.TABLES
		WHERE  TABLE_SCHEMA = DATABASE()
		  AND  TABLE_TYPE   = 'BASE TABLE'
		ORDER  BY TABLE_NAME`)
	if err != nil {
		return nil, fmt.Errorf("mysql: ListTables: %w", err)
	}
	defer rows.Close()

	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("mysql: ListTables scan: %w", err)
		}
		tables = append(tables, name)
	}
	return tables, rows.Err()
}

// GetTable returns the full schema.Table definition for the named table.
func (i *Introspector) GetTable(ctx context.Context, name string) (schema.Table, error) {
	t := schema.Table{Name: name}

	// ── 1. Table-level metadata (engine, comment) ──────────────────────────
	row := i.db.QueryRowContext(ctx, `
		SELECT COALESCE(ENGINE, ''), COALESCE(TABLE_COMMENT, '')
		FROM   INFORMATION_SCHEMA.TABLES
		WHERE  TABLE_SCHEMA = DATABASE()
		  AND  TABLE_NAME   = ?`, name)
	if err := row.Scan(&t.Engine, &t.Comment); err != nil {
		return t, fmt.Errorf("mysql: GetTable %q meta: %w", name, err)
	}

	// ── 2. Columns ──────────────────────────────────────────────────────────
	colRows, err := i.db.QueryContext(ctx, `
		SELECT COLUMN_NAME,
		       ORDINAL_POSITION,
		       COLUMN_TYPE,
		       CASE IS_NULLABLE WHEN 'YES' THEN 1 ELSE 0 END,
		       COLUMN_DEFAULT,
		       COALESCE(COLUMN_KEY, ''),
		       COALESCE(EXTRA, ''),
		       COALESCE(COLUMN_COMMENT, '')
		FROM   INFORMATION_SCHEMA.COLUMNS
		WHERE  TABLE_SCHEMA = DATABASE()
		  AND  TABLE_NAME   = ?
		ORDER  BY ORDINAL_POSITION`, name)
	if err != nil {
		return t, fmt.Errorf("mysql: GetTable %q columns: %w", name, err)
	}
	defer colRows.Close()

	for colRows.Next() {
		var col schema.Column
		var nullable int
		var def sql.NullString
		if err := colRows.Scan(
			&col.Name,
			&col.OrdinalPos,
			&col.Type,
			&nullable,
			&def,
			&col.Key,
			&col.Extra,
			&col.Comment,
		); err != nil {
			return t, fmt.Errorf("mysql: GetTable %q columns scan: %w", name, err)
		}
		col.Nullable = nullable == 1
		if def.Valid {
			v := def.String
			col.Default = &v
		}
		t.Columns = append(t.Columns, col)
	}
	if err := colRows.Err(); err != nil {
		return t, err
	}

	// ── 3. Primary key (from STATISTICS where KEY_NAME = 'PRIMARY') ────────
	pkRows, err := i.db.QueryContext(ctx, `
		SELECT COLUMN_NAME
		FROM   INFORMATION_SCHEMA.STATISTICS
		WHERE  TABLE_SCHEMA = DATABASE()
		  AND  TABLE_NAME   = ?
		  AND  INDEX_NAME   = 'PRIMARY'
		ORDER  BY SEQ_IN_INDEX`, name)
	if err != nil {
		return t, fmt.Errorf("mysql: GetTable %q primary key: %w", name, err)
	}
	defer pkRows.Close()

	for pkRows.Next() {
		var col string
		if err := pkRows.Scan(&col); err != nil {
			return t, fmt.Errorf("mysql: GetTable %q pk scan: %w", name, err)
		}
		t.PrimaryKey = append(t.PrimaryKey, col)
	}
	if err := pkRows.Err(); err != nil {
		return t, err
	}

	// ── 4. Non-primary indexes ───────────────────────────────────────────────
	idxRows, err := i.db.QueryContext(ctx, `
		SELECT INDEX_NAME,
		       COLUMN_NAME,
		       CASE NON_UNIQUE WHEN 0 THEN 1 ELSE 0 END AS is_unique,
		       COALESCE(INDEX_TYPE, 'BTREE')
		FROM   INFORMATION_SCHEMA.STATISTICS
		WHERE  TABLE_SCHEMA = DATABASE()
		  AND  TABLE_NAME   = ?
		  AND  INDEX_NAME  != 'PRIMARY'
		ORDER  BY INDEX_NAME, SEQ_IN_INDEX`, name)
	if err != nil {
		return t, fmt.Errorf("mysql: GetTable %q indexes: %w", name, err)
	}
	defer idxRows.Close()

	// Accumulate index columns; one schema.Index per INDEX_NAME.
	type idxKey struct{ name, idxType string; unique bool }
	indexMap := make(map[string]*schema.Index)
	var indexOrder []string

	for idxRows.Next() {
		var idxName, colName, idxType string
		var unique int
		if err := idxRows.Scan(&idxName, &colName, &unique, &idxType); err != nil {
			return t, fmt.Errorf("mysql: GetTable %q indexes scan: %w", name, err)
		}
		if _, seen := indexMap[idxName]; !seen {
			indexMap[idxName] = &schema.Index{
				Name:   idxName,
				Unique: unique == 1,
				Type:   idxType,
			}
			indexOrder = append(indexOrder, idxName)
		}
		indexMap[idxName].Columns = append(indexMap[idxName].Columns, colName)
	}
	if err := idxRows.Err(); err != nil {
		return t, err
	}
	for _, k := range indexOrder {
		t.Indexes = append(t.Indexes, *indexMap[k])
	}

	// ── 5. Foreign keys ─────────────────────────────────────────────────────
	fkRows, err := i.db.QueryContext(ctx, `
		SELECT CONSTRAINT_NAME,
		       COLUMN_NAME,
		       REFERENCED_TABLE_NAME,
		       REFERENCED_COLUMN_NAME
		FROM   INFORMATION_SCHEMA.KEY_COLUMN_USAGE
		WHERE  TABLE_SCHEMA            = DATABASE()
		  AND  TABLE_NAME              = ?
		  AND  REFERENCED_TABLE_NAME   IS NOT NULL
		ORDER  BY CONSTRAINT_NAME, ORDINAL_POSITION`, name)
	if err != nil {
		return t, fmt.Errorf("mysql: GetTable %q foreign keys: %w", name, err)
	}
	defer fkRows.Close()

	for fkRows.Next() {
		var fk schema.ForeignKey
		if err := fkRows.Scan(&fk.Name, &fk.Column, &fk.ReferencedTable, &fk.ReferencedColumn); err != nil {
			return t, fmt.Errorf("mysql: GetTable %q fk scan: %w", name, err)
		}
		t.ForeignKeys = append(t.ForeignKeys, fk)
	}
	return t, fkRows.Err()
}

// ComputeHash introspects all tables and delegates to schema.ComputeHash.
func (i *Introspector) ComputeHash(ctx context.Context) (string, error) {
	names, err := i.ListTables(ctx)
	if err != nil {
		return "", err
	}

	tables := make([]schema.Table, 0, len(names))
	for _, n := range names {
		t, err := i.GetTable(ctx, n)
		if err != nil {
			return "", err
		}
		tables = append(tables, t)
	}

	// Sort by name for determinism (ListTables already sorts, but be explicit).
	sort.Slice(tables, func(a, b int) bool { return tables[a].Name < tables[b].Name })
	return schema.ComputeHash(tables), nil
}

// Close releases the underlying *sql.DB.
func (i *Introspector) Close() error {
	if i.db != nil {
		return i.db.Close()
	}
	return nil
}
