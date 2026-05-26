package cli

import (
	"context"
	"strings"
	"testing"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// setupAnnotateTest creates a temp GlobalStore with a registered project and a connection.
// Returns (dbPath, projectID, connectionName, cleanup).
func setupAnnotateTest(t *testing.T) (string, *sqlite.GlobalStore, *schema.Project, string, func()) {
	t.Helper()

	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}

	ctx := context.Background()
	proj := schema.Project{ID: "proj-annotate-1", Name: "testapp", RepoPath: dir}
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

	cleanup := func() { _ = gs.Close() }
	return dbPath, gs, &proj, conn.Name, cleanup
}

// ── runAnnotateTable ──────────────────────────────────────────────────────────

// TestRunAnnotateTable_Success verifies a table annotation is persisted when author is set.
func TestRunAnnotateTable_Success(t *testing.T) {
	_, gs, proj, connName, cleanup := setupAnnotateTest(t)
	defer cleanup()

	ctx := context.Background()
	if err := gs.SetConfig(ctx, "author", "alice"); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}

	err := runAnnotateTable(ctx, gs, proj.ID, connName, "orders", "text about orders")
	if err != nil {
		t.Fatalf("runAnnotateTable: %v", err)
	}

	anns, err := gs.GetAnnotations(ctx, proj.ID, connName, "table", "orders")
	if err != nil {
		t.Fatalf("GetAnnotations: %v", err)
	}
	if len(anns) == 0 {
		t.Fatal("expected annotation to be persisted")
	}
	if anns[0].Content != "text about orders" {
		t.Errorf("Content: got %q, want %q", anns[0].Content, "text about orders")
	}
	if anns[0].Author != "alice" {
		t.Errorf("Author: got %q, want %q", anns[0].Author, "alice")
	}
	if anns[0].TargetType != "table" {
		t.Errorf("TargetType: got %q, want %q", anns[0].TargetType, "table")
	}
}

// TestRunAnnotateTable_ConnectionOverride verifies annotation is persisted on the named connection.
func TestRunAnnotateTable_ConnectionOverride(t *testing.T) {
	_, gs, proj, _, cleanup := setupAnnotateTest(t)
	defer cleanup()

	ctx := context.Background()

	// Add a second connection named "legacy".
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

	if err := gs.SetConfig(ctx, "author", "bob"); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}

	err := runAnnotateTable(ctx, gs, proj.ID, "legacy", "orders", "legacy annotation")
	if err != nil {
		t.Fatalf("runAnnotateTable: %v", err)
	}

	// Annotation must be on "legacy", not "local".
	anns, err := gs.GetAnnotations(ctx, proj.ID, "legacy", "table", "orders")
	if err != nil {
		t.Fatalf("GetAnnotations: %v", err)
	}
	if len(anns) == 0 {
		t.Fatal("expected annotation on legacy connection")
	}

	localAnns, err := gs.GetAnnotations(ctx, proj.ID, "local", "table", "orders")
	if err != nil {
		t.Fatalf("GetAnnotations local: %v", err)
	}
	if len(localAnns) != 0 {
		t.Errorf("expected no annotation on local connection, got %d", len(localAnns))
	}
}

// TestRunAnnotateTable_MissingAuthor verifies error when author is not configured.
func TestRunAnnotateTable_MissingAuthor(t *testing.T) {
	_, gs, proj, connName, cleanup := setupAnnotateTest(t)
	defer cleanup()

	ctx := context.Background()
	// No author configured.

	err := runAnnotateTable(ctx, gs, proj.ID, connName, "orders", "some text")
	if err == nil {
		t.Fatal("expected error for missing author, got nil")
	}
	if !strings.Contains(err.Error(), "author") {
		t.Errorf("error should mention 'author', got: %v", err)
	}
}

// ── runAnnotateColumn ─────────────────────────────────────────────────────────

// TestRunAnnotateColumn_Success verifies a column annotation is persisted.
func TestRunAnnotateColumn_Success(t *testing.T) {
	_, gs, proj, connName, cleanup := setupAnnotateTest(t)
	defer cleanup()

	ctx := context.Background()
	if err := gs.SetConfig(ctx, "author", "alice"); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}

	err := runAnnotateColumn(ctx, gs, proj.ID, connName, "orders", "total", "the total amount")
	if err != nil {
		t.Fatalf("runAnnotateColumn: %v", err)
	}

	anns, err := gs.GetAnnotations(ctx, proj.ID, connName, "column", "orders.total")
	if err != nil {
		t.Fatalf("GetAnnotations: %v", err)
	}
	if len(anns) == 0 {
		t.Fatal("expected column annotation to be persisted")
	}
	if anns[0].Content != "the total amount" {
		t.Errorf("Content: got %q, want %q", anns[0].Content, "the total amount")
	}
	if anns[0].TargetType != "column" {
		t.Errorf("TargetType: got %q, want %q", anns[0].TargetType, "column")
	}
	if anns[0].TargetName != "orders.total" {
		t.Errorf("TargetName: got %q, want %q", anns[0].TargetName, "orders.total")
	}
}

// TestRunAnnotateColumn_ConnectionOverride verifies column annotation on named connection.
func TestRunAnnotateColumn_ConnectionOverride(t *testing.T) {
	_, gs, proj, _, cleanup := setupAnnotateTest(t)
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

	if err := gs.SetConfig(ctx, "author", "carol"); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}

	err := runAnnotateColumn(ctx, gs, proj.ID, "legacy", "orders", "total", "legacy column note")
	if err != nil {
		t.Fatalf("runAnnotateColumn: %v", err)
	}

	anns, err := gs.GetAnnotations(ctx, proj.ID, "legacy", "column", "orders.total")
	if err != nil {
		t.Fatalf("GetAnnotations: %v", err)
	}
	if len(anns) == 0 {
		t.Fatal("expected annotation on legacy connection")
	}
}

// TestRunAnnotateColumn_MissingAuthor verifies error when author is not configured.
func TestRunAnnotateColumn_MissingAuthor(t *testing.T) {
	_, gs, proj, connName, cleanup := setupAnnotateTest(t)
	defer cleanup()

	ctx := context.Background()

	err := runAnnotateColumn(ctx, gs, proj.ID, connName, "orders", "total", "some text")
	if err == nil {
		t.Fatal("expected error for missing author, got nil")
	}
	if !strings.Contains(err.Error(), "author") {
		t.Errorf("error should mention 'author', got: %v", err)
	}
}
