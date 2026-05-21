package cli

import (
	"context"
	"testing"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// TestOpenGlobalStore_ReturnsConnSchemaStore verifies that openGlobalSchemaStore
// returns a usable ConnSchemaStore for the active connection.
func TestOpenGlobalStore_ReturnsConnSchemaStore(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	proj := schema.Project{ID: "proj-query-1", Name: "testapp", RepoPath: dir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	conn := schema.Connection{Name: "local", Host: "h", Port: 3306, Database: "d", User: "u", Password: "p", Active: true}
	if err := gs.SaveConnection(ctx, proj.ID, conn); err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}
	if err := gs.SetActive(ctx, proj.ID, "local"); err != nil {
		t.Fatalf("SetActive: %v", err)
	}

	// Save schema data so LoadSchema succeeds.
	connID := proj.ID + "/" + conn.Name
	store := gs.ForConnection(connID)
	sc := schema.Schema{
		Database: "d",
		Hash:     "hash1",
		Engine:   "mysql",
		Version:  "1.0",
		Tables:   []schema.Table{{Name: "users"}, {Name: "orders"}},
	}
	if err := store.SaveSchema(ctx, sc); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	// Now test that openGlobalSchemaStore finds the active connection and returns a working store.
	connStore, cleanup, err := openGlobalSchemaStore(gs, dir)
	if err != nil {
		t.Fatalf("openGlobalSchemaStore: %v", err)
	}
	defer cleanup()

	loaded, err := connStore.LoadSchema(ctx)
	if err != nil {
		t.Fatalf("LoadSchema via openGlobalSchemaStore: %v", err)
	}
	if len(loaded.Tables) != 2 {
		t.Errorf("expected 2 tables, got %d", len(loaded.Tables))
	}
}
