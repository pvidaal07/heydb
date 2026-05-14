package schema

import "testing"

func TestDiff_NoChanges(t *testing.T) {
	tables := []Table{{Name: "users", Columns: []Column{{Name: "id", Type: "int"}}}}
	entries := Diff(tables, tables)
	if len(entries) != 0 {
		t.Fatalf("expected no changes, got %d", len(entries))
	}
}

func TestDiff_TableAdded(t *testing.T) {
	old := []Table{{Name: "users"}}
	new := []Table{{Name: "users"}, {Name: "orders", Columns: []Column{{Name: "id"}, {Name: "total"}}}}
	entries := Diff(old, new)

	found := false
	for _, e := range entries {
		if e.Kind == DiffAdded && e.Table == "orders" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected 'orders' table added entry")
	}
}

func TestDiff_TableRemoved(t *testing.T) {
	old := []Table{{Name: "users"}, {Name: "logs"}}
	new := []Table{{Name: "users"}}
	entries := Diff(old, new)

	found := false
	for _, e := range entries {
		if e.Kind == DiffRemoved && e.Table == "logs" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected 'logs' table removed entry")
	}
}

func TestDiff_ColumnAdded(t *testing.T) {
	old := []Table{{Name: "users", Columns: []Column{{Name: "id", Type: "int"}}}}
	new := []Table{{Name: "users", Columns: []Column{{Name: "id", Type: "int"}, {Name: "email", Type: "varchar(255)"}}}}
	entries := Diff(old, new)

	found := false
	for _, e := range entries {
		if e.Kind == DiffAdded && e.Table == "users" && e.Detail == `column "email" added (varchar(255))` {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected column added entry, got %v", entries)
	}
}

func TestDiff_ColumnRemoved(t *testing.T) {
	old := []Table{{Name: "users", Columns: []Column{{Name: "id"}, {Name: "legacy"}}}}
	new := []Table{{Name: "users", Columns: []Column{{Name: "id"}}}}
	entries := Diff(old, new)

	found := false
	for _, e := range entries {
		if e.Kind == DiffRemoved && e.Detail == `column "legacy" removed` {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected column removed entry, got %v", entries)
	}
}

func TestDiff_ColumnTypeChanged(t *testing.T) {
	old := []Table{{Name: "users", Columns: []Column{{Name: "age", Type: "int"}}}}
	new := []Table{{Name: "users", Columns: []Column{{Name: "age", Type: "bigint"}}}}
	entries := Diff(old, new)

	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d: %v", len(entries), entries)
	}
	if entries[0].Kind != DiffModified {
		t.Fatalf("expected modified, got %s", entries[0].Kind)
	}
}

func TestDiff_NullabilityChanged(t *testing.T) {
	old := []Table{{Name: "t", Columns: []Column{{Name: "c", Type: "int", Nullable: false}}}}
	new := []Table{{Name: "t", Columns: []Column{{Name: "c", Type: "int", Nullable: true}}}}
	entries := Diff(old, new)

	if len(entries) != 1 || entries[0].Kind != DiffModified {
		t.Fatalf("expected 1 modified entry, got %v", entries)
	}
}
