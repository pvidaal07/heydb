package sqlite_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// openTestStore creates a temporary SQLite store for testing.
func openTestStore(t *testing.T) *sqlite.Store {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "test.sqlite")
	st, err := sqlite.Open(path)
	if err != nil {
		t.Fatalf("sqlite.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// sampleSchemaToDB builds a full schema suitable for store tests.
func sampleSchemaToDB() schema.Schema {
	defVal := "CURRENT_TIMESTAMP"
	return schema.Schema{
		Database: "testdb",
		Hash:     "abc123def",
		SyncedAt: time.Date(2024, 5, 1, 0, 0, 0, 0, time.UTC),
		Engine:   "mysql",
		Version:  "1.0",
		Tables: []schema.Table{
			{
				Name:       "users",
				Engine:     "InnoDB",
				Comment:    "Application users",
				PrimaryKey: []string{"id"},
				Columns: []schema.Column{
					{Name: "id", OrdinalPos: 1, Type: "bigint unsigned", Nullable: false, Key: "PRI", Extra: "auto_increment"},
					{Name: "email", OrdinalPos: 2, Type: "varchar(255)", Nullable: false, Key: "UNI"},
					{Name: "created_at", OrdinalPos: 3, Type: "datetime", Nullable: true, Default: &defVal},
				},
				Indexes: []schema.Index{
					{Name: "idx_email", Columns: []string{"email"}, Unique: true, Type: "BTREE"},
				},
			},
			{
				Name:    "orders",
				Engine:  "InnoDB",
				Comment: "Customer orders",
				Columns: []schema.Column{
					{Name: "id", OrdinalPos: 1, Type: "int", Nullable: false, Key: "PRI", Extra: "auto_increment"},
					{Name: "user_id", OrdinalPos: 2, Type: "bigint unsigned", Nullable: false},
					{Name: "total", OrdinalPos: 3, Type: "decimal(10,2)", Nullable: false},
				},
				PrimaryKey: []string{"id"},
				ForeignKeys: []schema.ForeignKey{
					{Name: "fk_order_user", Column: "user_id", ReferencedTable: "users", ReferencedColumn: "id"},
				},
			},
		},
	}
}

func TestSaveSchema_LoadSchema_Roundtrip(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	original := sampleSchemaToDB()

	if err := st.SaveSchema(ctx, original); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	loaded, err := st.LoadSchema(ctx)
	if err != nil {
		t.Fatalf("LoadSchema: %v", err)
	}

	if loaded.Database != original.Database {
		t.Errorf("Database: got %q want %q", loaded.Database, original.Database)
	}
	if loaded.Hash != original.Hash {
		t.Errorf("Hash: got %q want %q", loaded.Hash, original.Hash)
	}
	if loaded.Engine != original.Engine {
		t.Errorf("Engine: got %q want %q", loaded.Engine, original.Engine)
	}
	if len(loaded.Tables) != 2 {
		t.Errorf("Tables count: got %d want 2", len(loaded.Tables))
	}
}

func TestSaveSchema_ReplacesExisting(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	// Save first version
	if err := st.SaveSchema(ctx, sampleSchemaToDB()); err != nil {
		t.Fatalf("first SaveSchema: %v", err)
	}

	// Save a different schema (replace)
	updated := schema.Schema{
		Database: "newdb",
		Hash:     "newhash",
		SyncedAt: time.Now(),
		Tables: []schema.Table{
			{Name: "items", Columns: []schema.Column{{Name: "id", OrdinalPos: 1, Type: "int", Key: "PRI"}}},
		},
	}
	if err := st.SaveSchema(ctx, updated); err != nil {
		t.Fatalf("second SaveSchema: %v", err)
	}

	loaded, err := st.LoadSchema(ctx)
	if err != nil {
		t.Fatalf("LoadSchema after replace: %v", err)
	}

	if loaded.Database != "newdb" {
		t.Errorf("Database after replace: got %q want %q", loaded.Database, "newdb")
	}
	if len(loaded.Tables) != 1 {
		t.Errorf("Tables after replace: got %d want 1", len(loaded.Tables))
	}
}

func TestGetTable_Hit(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.SaveSchema(ctx, sampleSchemaToDB()); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	tbl, err := st.GetTable(ctx, "users")
	if err != nil {
		t.Fatalf("GetTable users: %v", err)
	}
	if tbl.Name != "users" {
		t.Errorf("Table name: got %q want %q", tbl.Name, "users")
	}
	if len(tbl.Columns) != 3 {
		t.Errorf("Columns: got %d want 3", len(tbl.Columns))
	}
	if len(tbl.Indexes) != 1 {
		t.Errorf("Indexes: got %d want 1", len(tbl.Indexes))
	}
}

func TestGetTable_Miss_ReturnsError(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.SaveSchema(ctx, sampleSchemaToDB()); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	_, err := st.GetTable(ctx, "does_not_exist")
	if err == nil {
		t.Error("GetTable for nonexistent table should return error, got nil")
	}
}

func TestGetTable_ForeignKeys(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.SaveSchema(ctx, sampleSchemaToDB()); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	tbl, err := st.GetTable(ctx, "orders")
	if err != nil {
		t.Fatalf("GetTable orders: %v", err)
	}
	if len(tbl.ForeignKeys) != 1 {
		t.Fatalf("ForeignKeys: got %d want 1", len(tbl.ForeignKeys))
	}
	fk := tbl.ForeignKeys[0]
	if fk.Name != "fk_order_user" {
		t.Errorf("FK name: got %q want %q", fk.Name, "fk_order_user")
	}
	if fk.ReferencedTable != "users" {
		t.Errorf("FK ReferencedTable: got %q want %q", fk.ReferencedTable, "users")
	}
	if fk.ReferencedColumn != "id" {
		t.Errorf("FK ReferencedColumn: got %q want %q", fk.ReferencedColumn, "id")
	}
}

func TestGetTable_ColumnDefault(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.SaveSchema(ctx, sampleSchemaToDB()); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	tbl, err := st.GetTable(ctx, "users")
	if err != nil {
		t.Fatalf("GetTable: %v", err)
	}

	// created_at (index 2) has a non-nil default
	createdAt := tbl.Columns[2]
	if createdAt.Default == nil {
		t.Error("created_at Default: expected non-nil")
	} else if *createdAt.Default != "CURRENT_TIMESTAMP" {
		t.Errorf("created_at Default: got %q want %q", *createdAt.Default, "CURRENT_TIMESTAMP")
	}
}

func TestSearchTables_Match(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.SaveSchema(ctx, sampleSchemaToDB()); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	results, err := st.SearchTables(ctx, "user", "", "")
	if err != nil {
		t.Fatalf("SearchTables: %v", err)
	}
	if len(results) == 0 {
		t.Error("SearchTables 'user': expected at least 1 result, got 0")
	}

	found := false
	for _, tbl := range results {
		if tbl.Name == "users" {
			found = true
			break
		}
	}
	if !found {
		t.Error("SearchTables 'user': expected 'users' table in results")
	}
}

func TestSearchTables_MatchByColumnName(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.SaveSchema(ctx, sampleSchemaToDB()); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	// "email" is a column in "users" — should match
	results, err := st.SearchTables(ctx, "email", "", "")
	if err != nil {
		t.Fatalf("SearchTables: %v", err)
	}
	if len(results) == 0 {
		t.Error("SearchTables 'email': expected match on column name, got 0 results")
	}
}

func TestSearchTables_NoMatch(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.SaveSchema(ctx, sampleSchemaToDB()); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	results, err := st.SearchTables(ctx, "zzznomatch", "", "")
	if err != nil {
		t.Fatalf("SearchTables: %v", err)
	}
	if results == nil {
		t.Error("SearchTables no-match: result should be non-nil empty slice, got nil")
	}
	if len(results) != 0 {
		t.Errorf("SearchTables no-match: expected 0 results, got %d", len(results))
	}
}

func TestSearchTables_CaseInsensitive(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.SaveSchema(ctx, sampleSchemaToDB()); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	// "USERS" should match "users" table name (COLLATE NOCASE)
	results, err := st.SearchTables(ctx, "USERS", "", "")
	if err != nil {
		t.Fatalf("SearchTables: %v", err)
	}
	if len(results) == 0 {
		t.Error("SearchTables should be case-insensitive: 'USERS' should match 'users'")
	}
}
