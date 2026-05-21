package markdown_test

import (
	"strings"
	"testing"
	"time"

	"github.com/pvidaal07/heydb/internal/adapters/markdown"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

func TestParse_MetaBlock(t *testing.T) {
	content := `# heydb schema documentation

<!-- heydb:meta
schema_hash: deadbeef
synced_at: 2024-06-01T12:00:00Z
engine: mysql
heydb_version: 1.0
-->
`
	pf, err := markdown.Parse(content)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}

	if pf.SchemaHash != "deadbeef" {
		t.Errorf("SchemaHash: got %q want %q", pf.SchemaHash, "deadbeef")
	}
	if pf.Engine != "mysql" {
		t.Errorf("Engine: got %q want %q", pf.Engine, "mysql")
	}
	if pf.HeydbVersion != "1.0" {
		t.Errorf("HeydbVersion: got %q want %q", pf.HeydbVersion, "1.0")
	}
	expectedTime := time.Date(2024, 6, 1, 12, 0, 0, 0, time.UTC)
	if !pf.SyncedAt.Equal(expectedTime) {
		t.Errorf("SyncedAt: got %v want %v", pf.SyncedAt, expectedTime)
	}
}

func TestRoundtrip_PreservesAllFields(t *testing.T) {
	defVal := "0"
	original := schema.Schema{
		Database: "myapp",
		Hash:     "cafebabe",
		SyncedAt: time.Date(2024, 3, 10, 8, 0, 0, 0, time.UTC),
		Engine:   "mysql",
		Tables: []schema.Table{
			{
				Name:       "products",
				Engine:     "InnoDB",
				Comment:    "Product catalog",
				PrimaryKey: []string{"id"},
				Columns: []schema.Column{
					{Name: "id", OrdinalPos: 1, Type: "int", Nullable: false, Key: "PRI", Extra: "auto_increment"},
					{Name: "price", OrdinalPos: 2, Type: "decimal(10,2)", Nullable: false, Default: &defVal},
					{Name: "name", OrdinalPos: 3, Type: "varchar(200)", Nullable: false},
				},
				Indexes: []schema.Index{
					{Name: "idx_name", Columns: []string{"name"}, Unique: false, Type: "BTREE"},
				},
				ForeignKeys: []schema.ForeignKey{
					{Name: "fk_cat", Column: "category_id", ReferencedTable: "categories", ReferencedColumn: "id"},
				},
			},
		},
	}

	var buf strings.Builder
	if err := markdown.Write(&buf, original, nil); err != nil {
		t.Fatalf("Write error: %v", err)
	}

	pf, err := markdown.Parse(buf.String())
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}

	if pf.SchemaHash != original.Hash {
		t.Errorf("SchemaHash roundtrip: got %q want %q", pf.SchemaHash, original.Hash)
	}
	if len(pf.Tables) != 1 {
		t.Fatalf("expected 1 table, got %d", len(pf.Tables))
	}

	tbl := pf.Tables[0]
	if tbl.Name != "products" {
		t.Errorf("Table name: got %q want %q", tbl.Name, "products")
	}
	if len(tbl.Columns) != 3 {
		t.Errorf("Columns: got %d want 3", len(tbl.Columns))
	}
	if tbl.Columns[0].Name != "id" {
		t.Errorf("Column[0] name: got %q want %q", tbl.Columns[0].Name, "id")
	}
	if tbl.Columns[0].Type != "int" {
		t.Errorf("Column[0] type: got %q want %q", tbl.Columns[0].Type, "int")
	}
	if tbl.Columns[0].Extra != "auto_increment" {
		t.Errorf("Column[0] extra: got %q want %q", tbl.Columns[0].Extra, "auto_increment")
	}
	if tbl.Columns[1].Default == nil {
		t.Error("Column[1] default: expected non-nil")
	} else if *tbl.Columns[1].Default != "0" {
		t.Errorf("Column[1] default: got %q want %q", *tbl.Columns[1].Default, "0")
	}

	if len(tbl.PrimaryKey) != 1 || tbl.PrimaryKey[0] != "id" {
		t.Errorf("PrimaryKey: got %v want [id]", tbl.PrimaryKey)
	}
	if len(tbl.Indexes) != 1 || tbl.Indexes[0].Name != "idx_name" {
		t.Errorf("Indexes: got %v", tbl.Indexes)
	}
	if len(tbl.ForeignKeys) != 1 || tbl.ForeignKeys[0].Name != "fk_cat" {
		t.Errorf("ForeignKeys: got %v", tbl.ForeignKeys)
	}
	if tbl.ForeignKeys[0].ReferencedTable != "categories" {
		t.Errorf("FK ReferencedTable: got %q want %q", tbl.ForeignKeys[0].ReferencedTable, "categories")
	}
}

// TestRoundtrip_AnnotationPreservedOnResync is removed in v2.
// Annotations are no longer stored in or parsed from markdown files.
// They live in the global SQLite store with author tracking.
// The v1 legacy Annotations field on WriteOptions is kept for backward
// compatibility only; new code uses V2Annotations.

func TestParse_EmptyFileReturnsNilError(t *testing.T) {
	pf, err := markdown.Parse("")
	if err != nil {
		t.Errorf("Parse of empty string should not error: %v", err)
	}
	if pf == nil {
		t.Error("Parse should return non-nil ParsedFile for empty input")
	}
	if len(pf.Tables) != 0 {
		t.Errorf("expected 0 tables from empty input, got %d", len(pf.Tables))
	}
}

func TestParse_MultipleTables(t *testing.T) {
	s := schema.Schema{
		Database: "db",
		Hash:     "h",
		SyncedAt: time.Now(),
		Tables: []schema.Table{
			{Name: "alpha", Columns: []schema.Column{{Name: "id", OrdinalPos: 1, Type: "int"}}},
			{Name: "beta", Columns: []schema.Column{{Name: "id", OrdinalPos: 1, Type: "int"}}},
			{Name: "gamma", Columns: []schema.Column{{Name: "id", OrdinalPos: 1, Type: "int"}}},
		},
	}

	var buf strings.Builder
	if err := markdown.Write(&buf, s, nil); err != nil {
		t.Fatalf("Write error: %v", err)
	}

	pf, err := markdown.Parse(buf.String())
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	if len(pf.Tables) != 3 {
		t.Errorf("expected 3 tables, got %d", len(pf.Tables))
	}
}
