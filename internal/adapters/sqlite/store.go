// Package sqlite provides a SchemaStore implementation backed by a local
// SQLite database file. It uses modernc.org/sqlite (pure Go, no CGO).
package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	// Register the modernc sqlite driver as a side-effect.
	_ "modernc.org/sqlite"

	"github.com/pvidaal07/heydb/internal/domain/ports"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// Compile-time check: Store must satisfy both ports.
var (
	_ ports.SchemaStore     = (*Store)(nil)
	_ ports.AnnotationStore = (*Store)(nil)
)

const ddl = `
CREATE TABLE IF NOT EXISTS heydb_meta (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    database    TEXT    NOT NULL DEFAULT '',
    schema_hash TEXT    NOT NULL DEFAULT '',
    synced_at   TEXT    NOT NULL DEFAULT '',
    engine      TEXT    NOT NULL DEFAULT '',
    version     TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS heydb_tables (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL UNIQUE,
    engine  TEXT NOT NULL DEFAULT '',
    comment TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS heydb_columns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name  TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    ordinal_pos INTEGER NOT NULL DEFAULT 0,
    type        TEXT    NOT NULL DEFAULT '',
    nullable    INTEGER NOT NULL DEFAULT 0,
    col_default TEXT,
    key_type    TEXT    NOT NULL DEFAULT '',
    extra       TEXT    NOT NULL DEFAULT '',
    comment     TEXT    NOT NULL DEFAULT '',
    FOREIGN KEY (table_name) REFERENCES heydb_tables(name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS heydb_indexes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    columns    TEXT    NOT NULL DEFAULT '',
    is_unique  INTEGER NOT NULL DEFAULT 0,
    idx_type   TEXT    NOT NULL DEFAULT 'BTREE',
    FOREIGN KEY (table_name) REFERENCES heydb_tables(name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS heydb_foreign_keys (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name       TEXT NOT NULL,
    name             TEXT NOT NULL,
    column_name      TEXT NOT NULL DEFAULT '',
    ref_table        TEXT NOT NULL DEFAULT '',
    ref_column       TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (table_name) REFERENCES heydb_tables(name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS heydb_annotations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT    NOT NULL,
    content    TEXT    NOT NULL DEFAULT '',
    updated_at TEXT    NOT NULL DEFAULT '',
    UNIQUE(table_name)
);

CREATE TABLE IF NOT EXISTS heydb_column_annotations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name  TEXT    NOT NULL,
    column_name TEXT    NOT NULL,
    content     TEXT    NOT NULL DEFAULT '',
    updated_at  TEXT    NOT NULL DEFAULT '',
    UNIQUE(table_name, column_name)
);

CREATE TABLE IF NOT EXISTS heydb_db_annotation (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    content    TEXT    NOT NULL DEFAULT '',
    updated_at TEXT    NOT NULL DEFAULT ''
);
`

// Store implements ports.SchemaStore using a local SQLite file.
type Store struct {
	db *sql.DB
}

// Open opens (or creates) the SQLite database at the given path and runs DDL
// migrations to ensure all tables exist.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("sqlite: open %q: %w", path, err)
	}
	// Enable WAL mode and foreign key enforcement.
	if _, err := db.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("sqlite: pragma setup: %w", err)
	}
	if _, err := db.Exec(ddl); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("sqlite: ddl: %w", err)
	}
	return &Store{db: db}, nil
}

// OpenReadOnly opens an existing SQLite database at the given path in
// immutable read-only mode. It does not run any DDL migrations.
// Returns an error if the file does not exist or cannot be opened.
func OpenReadOnly(path string) (*Store, error) {
	// Use the SQLite URI format to request immutable read-only access.
	// This prevents any write-ahead log creation and is safe for concurrent
	// reads from a file that a writer (sync) may be accessing.
	uri := "file:" + path + "?mode=ro&_foreign_keys=on"
	db, err := sql.Open("sqlite", uri)
	if err != nil {
		return nil, fmt.Errorf("sqlite: open read-only %q: %w", path, err)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("sqlite: ping read-only %q: %w", path, err)
	}
	return &Store{db: db}, nil
}

// SaveSchema replaces ALL existing schema data and writes sc from scratch.
func (s *Store) SaveSchema(ctx context.Context, sc schema.Schema) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("sqlite: SaveSchema begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Truncate all tables.
	for _, tbl := range []string{
		"heydb_foreign_keys",
		"heydb_indexes",
		"heydb_columns",
		"heydb_tables",
		"heydb_meta",
	} {
		if _, err := tx.ExecContext(ctx, "DELETE FROM "+tbl); err != nil {
			return fmt.Errorf("sqlite: truncate %s: %w", tbl, err)
		}
	}

	// Insert meta row.
	_, err = tx.ExecContext(ctx, `
		INSERT INTO heydb_meta (id, database, schema_hash, synced_at, engine, version)
		VALUES (1, ?, ?, ?, ?, ?)`,
		sc.Database,
		sc.Hash,
		sc.SyncedAt.UTC().Format(time.RFC3339),
		sc.Engine,
		sc.Version,
	)
	if err != nil {
		return fmt.Errorf("sqlite: insert meta: %w", err)
	}

	for _, t := range sc.Tables {
		if err := insertTable(ctx, tx, t); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// LoadSchema returns the full schema from SQLite.
func (s *Store) LoadSchema(ctx context.Context) (schema.Schema, error) {
	var sc schema.Schema

	row := s.db.QueryRowContext(ctx,
		`SELECT database, schema_hash, synced_at, engine, version FROM heydb_meta WHERE id = 1`)
	var syncedAtStr string
	if err := row.Scan(&sc.Database, &sc.Hash, &syncedAtStr, &sc.Engine, &sc.Version); err != nil {
		return sc, fmt.Errorf("sqlite: LoadSchema meta: %w", err)
	}
	if t, err := time.Parse(time.RFC3339, syncedAtStr); err == nil {
		sc.SyncedAt = t
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT name, engine, comment FROM heydb_tables ORDER BY name`)
	if err != nil {
		return sc, fmt.Errorf("sqlite: LoadSchema tables: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var name, eng, comment string
		if err := rows.Scan(&name, &eng, &comment); err != nil {
			return sc, err
		}
		t, err := s.loadTableByName(ctx, name)
		if err != nil {
			return sc, err
		}
		t.Engine = eng
		t.Comment = comment
		sc.Tables = append(sc.Tables, t)
	}
	return sc, rows.Err()
}

// GetTable returns a single table by exact name.
func (s *Store) GetTable(ctx context.Context, name string) (schema.Table, error) {
	var exists int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(1) FROM heydb_tables WHERE name = ?`, name).Scan(&exists); err != nil {
		return schema.Table{}, fmt.Errorf("sqlite: GetTable check: %w", err)
	}
	if exists == 0 {
		return schema.Table{}, fmt.Errorf("sqlite: table %q not found", name)
	}

	t, err := s.loadTableByName(ctx, name)
	if err != nil {
		return schema.Table{}, err
	}

	var eng, comment string
	_ = s.db.QueryRowContext(ctx,
		`SELECT engine, comment FROM heydb_tables WHERE name = ?`, name).
		Scan(&eng, &comment)
	t.Engine = eng
	t.Comment = comment
	return t, nil
}

// SearchTables returns tables whose name, column names, or comments contain
// query as a case-insensitive substring. Returns a non-nil empty slice on no
// matches.
func (s *Store) SearchTables(ctx context.Context, query string) ([]schema.Table, error) {
	like := "%" + query + "%"

	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT ht.name
		FROM heydb_tables ht
		LEFT JOIN heydb_columns hc ON hc.table_name = ht.name
		WHERE ht.name    LIKE ? COLLATE NOCASE
		   OR ht.comment LIKE ? COLLATE NOCASE
		   OR hc.name    LIKE ? COLLATE NOCASE
		   OR hc.comment LIKE ? COLLATE NOCASE
		ORDER BY ht.name`,
		like, like, like, like)
	if err != nil {
		return nil, fmt.Errorf("sqlite: SearchTables: %w", err)
	}
	defer rows.Close()

	result := []schema.Table{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		t, err := s.GetTable(ctx, name)
		if err != nil {
			return nil, err
		}
		result = append(result, t)
	}
	return result, rows.Err()
}

// Close releases the underlying *sql.DB.
func (s *Store) Close() error {
	if s.db != nil {
		return s.db.Close()
	}
	return nil
}

// ── helpers ──────────────────────────────────────────────────────────────────

func insertTable(ctx context.Context, tx *sql.Tx, t schema.Table) error {
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO heydb_tables (name, engine, comment) VALUES (?, ?, ?)`,
		t.Name, t.Engine, t.Comment); err != nil {
		return fmt.Errorf("sqlite: insert table %q: %w", t.Name, err)
	}

	for _, c := range t.Columns {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO heydb_columns
			    (table_name, name, ordinal_pos, type, nullable, col_default, key_type, extra, comment)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			t.Name, c.Name, c.OrdinalPos, c.Type,
			boolToInt(c.Nullable), c.Default, c.Key, c.Extra, c.Comment); err != nil {
			return fmt.Errorf("sqlite: insert column %q.%q: %w", t.Name, c.Name, err)
		}
	}

	for _, idx := range t.Indexes {
		colsStr := strings.Join(idx.Columns, ",")
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO heydb_indexes (table_name, name, columns, is_unique, idx_type)
			VALUES (?, ?, ?, ?, ?)`,
			t.Name, idx.Name, colsStr, boolToInt(idx.Unique), idx.Type); err != nil {
			return fmt.Errorf("sqlite: insert index %q.%q: %w", t.Name, idx.Name, err)
		}
	}

	for _, fk := range t.ForeignKeys {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO heydb_foreign_keys (table_name, name, column_name, ref_table, ref_column)
			VALUES (?, ?, ?, ?, ?)`,
			t.Name, fk.Name, fk.Column, fk.ReferencedTable, fk.ReferencedColumn); err != nil {
			return fmt.Errorf("sqlite: insert fk %q.%q: %w", t.Name, fk.Name, err)
		}
	}

	return nil
}

func (s *Store) loadTableByName(ctx context.Context, name string) (schema.Table, error) {
	t := schema.Table{Name: name}

	// Columns
	colRows, err := s.db.QueryContext(ctx, `
		SELECT name, ordinal_pos, type, nullable, col_default, key_type, extra, comment
		FROM   heydb_columns
		WHERE  table_name = ?
		ORDER  BY ordinal_pos`, name)
	if err != nil {
		return t, fmt.Errorf("sqlite: load columns for %q: %w", name, err)
	}
	defer colRows.Close()

	for colRows.Next() {
		var col schema.Column
		var nullable int
		var def sql.NullString
		if err := colRows.Scan(
			&col.Name, &col.OrdinalPos, &col.Type,
			&nullable, &def, &col.Key, &col.Extra, &col.Comment,
		); err != nil {
			return t, err
		}
		col.Nullable = nullable == 1
		if def.Valid {
			v := def.String
			col.Default = &v
		}
		t.Columns = append(t.Columns, col)
		if col.Key == "PRI" {
			t.PrimaryKey = append(t.PrimaryKey, col.Name)
		}
	}
	if err := colRows.Err(); err != nil {
		return t, err
	}

	// Indexes
	idxRows, err := s.db.QueryContext(ctx, `
		SELECT name, columns, is_unique, idx_type
		FROM   heydb_indexes
		WHERE  table_name = ?
		ORDER  BY name`, name)
	if err != nil {
		return t, fmt.Errorf("sqlite: load indexes for %q: %w", name, err)
	}
	defer idxRows.Close()

	for idxRows.Next() {
		var idx schema.Index
		var colsStr string
		var unique int
		if err := idxRows.Scan(&idx.Name, &colsStr, &unique, &idx.Type); err != nil {
			return t, err
		}
		idx.Unique = unique == 1
		if colsStr != "" {
			idx.Columns = strings.Split(colsStr, ",")
		}
		t.Indexes = append(t.Indexes, idx)
	}
	if err := idxRows.Err(); err != nil {
		return t, err
	}

	// Foreign keys
	fkRows, err := s.db.QueryContext(ctx, `
		SELECT name, column_name, ref_table, ref_column
		FROM   heydb_foreign_keys
		WHERE  table_name = ?
		ORDER  BY name`, name)
	if err != nil {
		return t, fmt.Errorf("sqlite: load fks for %q: %w", name, err)
	}
	defer fkRows.Close()

	for fkRows.Next() {
		var fk schema.ForeignKey
		if err := fkRows.Scan(&fk.Name, &fk.Column, &fk.ReferencedTable, &fk.ReferencedColumn); err != nil {
			return t, err
		}
		t.ForeignKeys = append(t.ForeignKeys, fk)
	}
	return t, fkRows.Err()
}

// SaveAnnotation upserts an annotation for a table. The content is free-form text.
func (s *Store) SaveAnnotation(ctx context.Context, tableName, content string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO heydb_annotations (table_name, content, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(table_name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
		tableName, content, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		return fmt.Errorf("sqlite: save annotation for %q: %w", tableName, err)
	}
	return nil
}

// GetAnnotation returns the annotation for a single table, or empty string if none.
func (s *Store) GetAnnotation(ctx context.Context, tableName string) (string, error) {
	var content string
	err := s.db.QueryRowContext(ctx,
		`SELECT content FROM heydb_annotations WHERE table_name = ?`, tableName).Scan(&content)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("sqlite: get annotation for %q: %w", tableName, err)
	}
	return content, nil
}

// GetAllAnnotations returns all annotations as a map of table_name → content.
func (s *Store) GetAllAnnotations(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT table_name, content FROM heydb_annotations ORDER BY table_name`)
	if err != nil {
		return nil, fmt.Errorf("sqlite: get all annotations: %w", err)
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var name, content string
		if err := rows.Scan(&name, &content); err != nil {
			return nil, err
		}
		result[name] = content
	}
	return result, rows.Err()
}

// ── Column annotations ──────────────────────────────────────────────────────

// SaveColumnAnnotation upserts an annotation for a specific column.
func (s *Store) SaveColumnAnnotation(ctx context.Context, tableName, columnName, content string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO heydb_column_annotations (table_name, column_name, content, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(table_name, column_name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
		tableName, columnName, content, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		return fmt.Errorf("sqlite: save column annotation for %q.%q: %w", tableName, columnName, err)
	}
	return nil
}

// GetColumnAnnotation returns the annotation for a specific column, or empty string if none.
func (s *Store) GetColumnAnnotation(ctx context.Context, tableName, columnName string) (string, error) {
	var content string
	err := s.db.QueryRowContext(ctx,
		`SELECT content FROM heydb_column_annotations WHERE table_name = ? AND column_name = ?`,
		tableName, columnName).Scan(&content)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("sqlite: get column annotation for %q.%q: %w", tableName, columnName, err)
	}
	return content, nil
}

// GetAllColumnAnnotations returns all column annotations for a table as a map of column_name → content.
func (s *Store) GetAllColumnAnnotations(ctx context.Context, tableName string) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT column_name, content FROM heydb_column_annotations WHERE table_name = ? ORDER BY column_name`,
		tableName)
	if err != nil {
		return nil, fmt.Errorf("sqlite: get all column annotations for %q: %w", tableName, err)
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var name, content string
		if err := rows.Scan(&name, &content); err != nil {
			return nil, err
		}
		result[name] = content
	}
	return result, rows.Err()
}

// ── Database annotation ─────────────────────────────────────────────────────

// SaveDBAnnotation upserts the database-level annotation (singleton row, id=1).
func (s *Store) SaveDBAnnotation(ctx context.Context, content string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO heydb_db_annotation (id, content, updated_at)
		VALUES (1, ?, ?)
		ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
		content, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		return fmt.Errorf("sqlite: save db annotation: %w", err)
	}
	return nil
}

// GetDBAnnotation returns the database-level annotation, or empty string if none.
func (s *Store) GetDBAnnotation(ctx context.Context) (string, error) {
	var content string
	err := s.db.QueryRowContext(ctx,
		`SELECT content FROM heydb_db_annotation WHERE id = 1`).Scan(&content)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("sqlite: get db annotation: %w", err)
	}
	return content, nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
