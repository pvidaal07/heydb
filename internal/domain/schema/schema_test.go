package schema_test

import (
	"testing"

	"github.com/pvidaal07/heydb/internal/domain/schema"
)

func TestComputeHash_Determinism(t *testing.T) {
	tables := []schema.Table{
		{
			Name: "users",
			Columns: []schema.Column{
				{Name: "id", OrdinalPos: 1, Type: "bigint unsigned", Nullable: false},
				{Name: "email", OrdinalPos: 2, Type: "varchar(255)", Nullable: false},
			},
		},
	}

	h1 := schema.ComputeHash(tables)
	h2 := schema.ComputeHash(tables)
	h3 := schema.ComputeHash(tables)

	if h1 == "" {
		t.Fatal("ComputeHash returned empty string")
	}
	if h1 != h2 || h2 != h3 {
		t.Errorf("ComputeHash is not deterministic: %q %q %q", h1, h2, h3)
	}
}

func TestComputeHash_SortedOrder(t *testing.T) {
	// Tables in different order should produce the same hash.
	t1 := []schema.Table{
		{Name: "alpha", Columns: []schema.Column{{Name: "id", OrdinalPos: 1, Type: "int"}}},
		{Name: "beta", Columns: []schema.Column{{Name: "id", OrdinalPos: 1, Type: "int"}}},
	}
	t2 := []schema.Table{
		{Name: "beta", Columns: []schema.Column{{Name: "id", OrdinalPos: 1, Type: "int"}}},
		{Name: "alpha", Columns: []schema.Column{{Name: "id", OrdinalPos: 1, Type: "int"}}},
	}

	h1 := schema.ComputeHash(t1)
	h2 := schema.ComputeHash(t2)
	if h1 != h2 {
		t.Errorf("ComputeHash should be order-independent: %q vs %q", h1, h2)
	}
}

func TestComputeHash_ColumnOrdinalSort(t *testing.T) {
	// Columns in different ordinal order should produce the same hash.
	col1 := schema.Column{Name: "id", OrdinalPos: 1, Type: "int"}
	col2 := schema.Column{Name: "name", OrdinalPos: 2, Type: "varchar(100)"}

	tableAsc := []schema.Table{{Name: "t", Columns: []schema.Column{col1, col2}}}
	tableDesc := []schema.Table{{Name: "t", Columns: []schema.Column{col2, col1}}}

	hAsc := schema.ComputeHash(tableAsc)
	hDesc := schema.ComputeHash(tableDesc)
	if hAsc != hDesc {
		t.Errorf("ComputeHash should sort columns by OrdinalPos: %q vs %q", hAsc, hDesc)
	}
}

func TestComputeHash_DifferentSchemasDiffer(t *testing.T) {
	t1 := []schema.Table{
		{Name: "users", Columns: []schema.Column{{Name: "id", OrdinalPos: 1, Type: "int"}}},
	}
	t2 := []schema.Table{
		{Name: "users", Columns: []schema.Column{{Name: "id", OrdinalPos: 1, Type: "bigint"}}},
	}

	h1 := schema.ComputeHash(t1)
	h2 := schema.ComputeHash(t2)
	if h1 == h2 {
		t.Error("ComputeHash should differ when column type changes")
	}
}

func TestComputeHash_EmptySlice(t *testing.T) {
	h := schema.ComputeHash(nil)
	if h == "" {
		t.Fatal("ComputeHash of empty input should return a non-empty string")
	}
	// Same call should be deterministic
	h2 := schema.ComputeHash([]schema.Table{})
	if h != h2 {
		t.Errorf("ComputeHash nil vs empty differ: %q vs %q", h, h2)
	}
}

func TestComputeHash_VersionStability(t *testing.T) {
	// This test pins the known hash value for a stable schema.
	// If this test breaks, the canonical form changed — it's a breaking change.
	defVal := "0"
	tables := []schema.Table{
		{
			Name: "orders",
			Columns: []schema.Column{
				{Name: "id", OrdinalPos: 1, Type: "int", Nullable: false, Default: nil, Extra: "auto_increment"},
				{Name: "total", OrdinalPos: 2, Type: "decimal(10,2)", Nullable: true, Default: &defVal, Extra: ""},
			},
		},
	}

	got := schema.ComputeHash(tables)
	// Pre-computed expected value — must not change without a version bump.
	const expected = "d64dd8688dd4bf4a47eecf923068d8e92cc3d1d7e9e646d2842a838838f3caff"
	if got != expected {
		t.Errorf("ComputeHash version stability broken:\n  got:  %s\n  want: %s\nIf the canonical form changed intentionally, update this test AND bump schema.Version.", got, expected)
	}
}
