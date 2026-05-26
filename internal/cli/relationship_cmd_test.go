package cli

import (
	"context"
	"strings"
	"testing"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// ── parseDotNotation ──────────────────────────────────────────────────────────

// TestParseDotNotation is a table-driven test for parseDotNotation.
func TestParseDotNotation(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		wantTable string
		wantCol   string
		wantErr   bool
	}{
		{name: "valid", input: "orders.user_id", wantTable: "orders", wantCol: "user_id"},
		{name: "no_dot", input: "orders", wantErr: true},
		{name: "multiple_dots", input: "schema.orders.user_id", wantErr: true},
		{name: "empty_table", input: ".user_id", wantErr: true},
		{name: "empty_column", input: "orders.", wantErr: true},
		{name: "both_empty", input: ".", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			table, col, err := parseDotNotation(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Errorf("parseDotNotation(%q): expected error, got nil", tt.input)
				}
				return
			}
			if err != nil {
				t.Errorf("parseDotNotation(%q): unexpected error: %v", tt.input, err)
				return
			}
			if table != tt.wantTable {
				t.Errorf("table: got %q, want %q", table, tt.wantTable)
			}
			if col != tt.wantCol {
				t.Errorf("column: got %q, want %q", col, tt.wantCol)
			}
		})
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

func setupRelationshipTest(t *testing.T) (*sqlite.GlobalStore, *schema.Project, string, func()) {
	t.Helper()

	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}

	ctx := context.Background()
	proj := schema.Project{ID: "proj-rel-1", Name: "testapp", RepoPath: dir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	conn := schema.Connection{
		Name:     "local",
		Host:     "127.0.0.1",
		Port:     3306,
		Database: "myapp",
		User:     "u",
		Password: "p",
		Active:   true,
	}
	if err := gs.SaveConnection(ctx, proj.ID, conn); err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}

	if err := gs.SetConfig(ctx, "author", "alice"); err != nil {
		t.Fatalf("SetConfig author: %v", err)
	}

	cleanup := func() { _ = gs.Close() }
	return gs, &proj, conn.Name, cleanup
}

// ── runRelationshipAdd ────────────────────────────────────────────────────────

// TestRunRelationshipAdd_WithoutLabel verifies add without label.
func TestRunRelationshipAdd_WithoutLabel(t *testing.T) {
	gs, proj, connName, cleanup := setupRelationshipTest(t)
	defer cleanup()

	ctx := context.Background()
	id, err := runRelationshipAdd(ctx, gs, proj.ID, connName, "orders", "user_id", "users", "id", "")
	if err != nil {
		t.Fatalf("runRelationshipAdd: %v", err)
	}
	if id == "" {
		t.Error("expected non-empty UUID")
	}

	rels, err := gs.ListRelationships(ctx, proj.ID, connName)
	if err != nil {
		t.Fatalf("ListRelationships: %v", err)
	}
	if len(rels) == 0 {
		t.Fatal("expected relationship to be persisted")
	}
	if rels[0].Label != "" {
		t.Errorf("Label: got %q, want empty", rels[0].Label)
	}
}

// TestRunRelationshipAdd_WithLabel verifies add with label.
func TestRunRelationshipAdd_WithLabel(t *testing.T) {
	gs, proj, connName, cleanup := setupRelationshipTest(t)
	defer cleanup()

	ctx := context.Background()
	_, err := runRelationshipAdd(ctx, gs, proj.ID, connName, "orders", "user_id", "users", "id", "Order owner")
	if err != nil {
		t.Fatalf("runRelationshipAdd with label: %v", err)
	}

	rels, err := gs.ListRelationships(ctx, proj.ID, connName)
	if err != nil {
		t.Fatalf("ListRelationships: %v", err)
	}
	if len(rels) == 0 {
		t.Fatal("expected relationship")
	}
	if rels[0].Label != "Order owner" {
		t.Errorf("Label: got %q, want %q", rels[0].Label, "Order owner")
	}
}

// TestRunRelationshipAdd_ConnectionOverride verifies add uses specified connection.
func TestRunRelationshipAdd_ConnectionOverride(t *testing.T) {
	gs, proj, _, cleanup := setupRelationshipTest(t)
	defer cleanup()

	ctx := context.Background()

	legacy := schema.Connection{
		Name:     "legacy",
		Host:     "127.0.0.1",
		Port:     3306,
		Database: "legacydb",
		User:     "u",
		Password: "p",
	}
	if err := gs.SaveConnection(ctx, proj.ID, legacy); err != nil {
		t.Fatalf("SaveConnection legacy: %v", err)
	}

	_, err := runRelationshipAdd(ctx, gs, proj.ID, "legacy", "orders", "user_id", "users", "id", "")
	if err != nil {
		t.Fatalf("runRelationshipAdd legacy: %v", err)
	}

	rels, err := gs.ListRelationships(ctx, proj.ID, "legacy")
	if err != nil {
		t.Fatalf("ListRelationships: %v", err)
	}
	if len(rels) == 0 {
		t.Fatal("expected relationship on legacy connection")
	}

	localRels, err := gs.ListRelationships(ctx, proj.ID, "local")
	if err != nil {
		t.Fatalf("ListRelationships local: %v", err)
	}
	if len(localRels) != 0 {
		t.Errorf("expected no relationship on local connection, got %d", len(localRels))
	}
}

// ── runRelationshipDelete ─────────────────────────────────────────────────────

// TestRunRelationshipDelete_Existing verifies delete removes the relationship.
func TestRunRelationshipDelete_Existing(t *testing.T) {
	gs, proj, connName, cleanup := setupRelationshipTest(t)
	defer cleanup()

	ctx := context.Background()
	id, err := runRelationshipAdd(ctx, gs, proj.ID, connName, "orders", "user_id", "users", "id", "")
	if err != nil {
		t.Fatalf("runRelationshipAdd: %v", err)
	}

	if err := runRelationshipDelete(ctx, gs, id); err != nil {
		t.Fatalf("runRelationshipDelete: %v", err)
	}

	rels, err := gs.ListRelationships(ctx, proj.ID, connName)
	if err != nil {
		t.Fatalf("ListRelationships: %v", err)
	}
	if len(rels) != 0 {
		t.Errorf("expected 0 relationships after delete, got %d", len(rels))
	}
}

// TestRunRelationshipDelete_NotFound verifies error for unknown UUID.
func TestRunRelationshipDelete_NotFound(t *testing.T) {
	gs, _, _, cleanup := setupRelationshipTest(t)
	defer cleanup()

	ctx := context.Background()
	err := runRelationshipDelete(ctx, gs, "unknown-uuid-1234")
	if err == nil {
		t.Fatal("expected error for unknown UUID, got nil")
	}
}

// ── runRelationshipList ───────────────────────────────────────────────────────

// TestRunRelationshipList_WithRelationships verifies output contains expected fields.
func TestRunRelationshipList_WithRelationships(t *testing.T) {
	gs, proj, connName, cleanup := setupRelationshipTest(t)
	defer cleanup()

	ctx := context.Background()
	id, err := runRelationshipAdd(ctx, gs, proj.ID, connName, "orders", "user_id", "users", "id", "Order owner")
	if err != nil {
		t.Fatalf("runRelationshipAdd: %v", err)
	}

	var out strings.Builder
	err = runRelationshipList(ctx, gs, proj.ID, connName, &out)
	if err != nil {
		t.Fatalf("runRelationshipList: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, id) {
		t.Errorf("output should contain UUID %q\nGot: %s", id, output)
	}
	if !strings.Contains(output, "orders.user_id") {
		t.Errorf("output should contain 'orders.user_id'\nGot: %s", output)
	}
	if !strings.Contains(output, "users.id") {
		t.Errorf("output should contain 'users.id'\nGot: %s", output)
	}
	if !strings.Contains(output, "Order owner") {
		t.Errorf("output should contain label 'Order owner'\nGot: %s", output)
	}
}

// TestRunRelationshipList_Empty verifies "no relationships defined" is printed.
func TestRunRelationshipList_Empty(t *testing.T) {
	gs, proj, connName, cleanup := setupRelationshipTest(t)
	defer cleanup()

	ctx := context.Background()
	var out strings.Builder
	err := runRelationshipList(ctx, gs, proj.ID, connName, &out)
	if err != nil {
		t.Fatalf("runRelationshipList empty: %v", err)
	}

	if !strings.Contains(out.String(), "no relationships defined") {
		t.Errorf("expected 'no relationships defined', got: %q", out.String())
	}
}

// TestRunRelationshipList_ConnectionOverride verifies only the named connection's rels are shown.
func TestRunRelationshipList_ConnectionOverride(t *testing.T) {
	gs, proj, connName, cleanup := setupRelationshipTest(t)
	defer cleanup()

	ctx := context.Background()

	legacy := schema.Connection{
		Name:     "legacy",
		Host:     "127.0.0.1",
		Port:     3306,
		Database: "legacydb",
		User:     "u",
		Password: "p",
	}
	if err := gs.SaveConnection(ctx, proj.ID, legacy); err != nil {
		t.Fatalf("SaveConnection legacy: %v", err)
	}

	// Add relationship to "local" only.
	if _, err := runRelationshipAdd(ctx, gs, proj.ID, connName, "orders", "user_id", "users", "id", ""); err != nil {
		t.Fatalf("runRelationshipAdd: %v", err)
	}

	// List for "legacy" should return empty.
	var out strings.Builder
	if err := runRelationshipList(ctx, gs, proj.ID, "legacy", &out); err != nil {
		t.Fatalf("runRelationshipList legacy: %v", err)
	}

	if !strings.Contains(out.String(), "no relationships defined") {
		t.Errorf("expected 'no relationships defined' for legacy, got: %q", out.String())
	}
}
