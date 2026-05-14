package markdown_test

import (
	"strings"
	"testing"
	"time"

	"github.com/pvidaal07/heydb/internal/adapters/markdown"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// sampleSchema returns a consistent test schema.
func sampleSchema() schema.Schema {
	defVal := "CURRENT_TIMESTAMP"
	return schema.Schema{
		Database: "testdb",
		Hash:     "abc123",
		SyncedAt: time.Date(2024, 1, 15, 10, 30, 0, 0, time.UTC),
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
		},
	}
}

func TestWrite_ContainsMetaBlock(t *testing.T) {
	var buf strings.Builder
	if err := markdown.Write(&buf, sampleSchema(), nil); err != nil {
		t.Fatalf("Write error: %v", err)
	}
	out := buf.String()

	if !strings.Contains(out, "<!-- heydb:meta") {
		t.Error("output missing <!-- heydb:meta --> block")
	}
	if !strings.Contains(out, "schema_hash: abc123") {
		t.Error("output missing schema_hash in meta block")
	}
	if !strings.Contains(out, "synced_at: 2024-01-15T10:30:00Z") {
		t.Error("output missing synced_at in meta block")
	}
	if !strings.Contains(out, "engine: mysql") {
		t.Error("output missing engine in meta block")
	}
	if !strings.Contains(out, "heydb_version: 1.0") {
		t.Error("output missing heydb_version in meta block")
	}
}

func TestWrite_ContainsTOC(t *testing.T) {
	var buf strings.Builder
	if err := markdown.Write(&buf, sampleSchema(), nil); err != nil {
		t.Fatalf("Write error: %v", err)
	}
	out := buf.String()

	if !strings.Contains(out, "<!-- heydb:toc -->") {
		t.Error("output missing <!-- heydb:toc -->")
	}
	if !strings.Contains(out, "<!-- /heydb:toc -->") {
		t.Error("output missing <!-- /heydb:toc -->")
	}
	if !strings.Contains(out, "[users]") {
		t.Error("output missing TOC entry for users table")
	}
}

func TestWrite_ContainsTableBlock(t *testing.T) {
	var buf strings.Builder
	if err := markdown.Write(&buf, sampleSchema(), nil); err != nil {
		t.Fatalf("Write error: %v", err)
	}
	out := buf.String()

	if !strings.Contains(out, `<!-- heydb:table name="users" -->`) {
		t.Error(`output missing <!-- heydb:table name="users" -->`)
	}
	if !strings.Contains(out, "<!-- /heydb:table -->") {
		t.Error("output missing <!-- /heydb:table -->")
	}
	if !strings.Contains(out, "bigint unsigned") {
		t.Error("output missing column type 'bigint unsigned'")
	}
	if !strings.Contains(out, "idx_email") {
		t.Error("output missing index name 'idx_email'")
	}
}

func TestWrite_AnnotationPreserved(t *testing.T) {
	opts := &markdown.WriteOptions{
		Annotations: map[string]string{
			"users": "This table is critical. Do not drop.\n",
		},
	}
	var buf strings.Builder
	if err := markdown.Write(&buf, sampleSchema(), opts); err != nil {
		t.Fatalf("Write error: %v", err)
	}
	out := buf.String()

	if !strings.Contains(out, "<!-- heydb:annotations -->") {
		t.Error("output missing <!-- heydb:annotations --> anchor")
	}
	if !strings.Contains(out, "This table is critical. Do not drop.") {
		t.Error("annotation content not preserved in output")
	}
	if !strings.Contains(out, "<!-- /heydb:annotations -->") {
		t.Error("output missing <!-- /heydb:annotations --> anchor")
	}
}

func TestWrite_NoAnnotationWhenEmpty(t *testing.T) {
	var buf strings.Builder
	if err := markdown.Write(&buf, sampleSchema(), nil); err != nil {
		t.Fatalf("Write error: %v", err)
	}
	out := buf.String()

	if strings.Contains(out, "<!-- heydb:annotations -->") {
		t.Error("output should not contain annotation anchors when no annotations provided")
	}
}

func TestWrite_PrimaryKeySection(t *testing.T) {
	var buf strings.Builder
	if err := markdown.Write(&buf, sampleSchema(), nil); err != nil {
		t.Fatalf("Write error: %v", err)
	}
	out := buf.String()

	if !strings.Contains(out, "**Primary Key:**") {
		t.Error("output missing primary key section")
	}
	if !strings.Contains(out, "`id`") {
		t.Error("output missing primary key column name")
	}
}

func TestWrite_ForeignKeys(t *testing.T) {
	s := schema.Schema{
		Database: "testdb",
		Hash:     "x",
		SyncedAt: time.Now(),
		Tables: []schema.Table{
			{
				Name: "orders",
				Columns: []schema.Column{
					{Name: "id", OrdinalPos: 1, Type: "int"},
					{Name: "user_id", OrdinalPos: 2, Type: "bigint unsigned"},
				},
				ForeignKeys: []schema.ForeignKey{
					{Name: "fk_user", Column: "user_id", ReferencedTable: "users", ReferencedColumn: "id"},
				},
			},
		},
	}

	var buf strings.Builder
	if err := markdown.Write(&buf, s, nil); err != nil {
		t.Fatalf("Write error: %v", err)
	}
	out := buf.String()

	if !strings.Contains(out, "### Foreign Keys") {
		t.Error("output missing Foreign Keys section")
	}
	if !strings.Contains(out, "fk_user") {
		t.Error("output missing foreign key name")
	}
	if !strings.Contains(out, "`users`.`id`") {
		t.Error("output missing referenced table.column")
	}
}
