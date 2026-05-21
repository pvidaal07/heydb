package cli

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// TestConnect_SavesToGlobalStore verifies that saveConnectionToGlobal persists
// a connection in the GlobalStore for the given project.
func TestConnect_SavesToGlobalStore(t *testing.T) {
	gs, cleanup := setupConnectTest(t)
	defer cleanup()

	ctx := context.Background()
	projectID := "proj-connect-1"

	conn := schema.Connection{
		Name:     "local",
		Host:     "127.0.0.1",
		Port:     3306,
		Database: "myapp",
		User:     "root",
		Password: "secret",
	}

	if err := gs.SaveConnection(ctx, projectID, conn); err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}

	got, err := gs.GetConnection(ctx, projectID, "local")
	if err != nil {
		t.Fatalf("GetConnection: %v", err)
	}
	if got == nil {
		t.Fatal("expected connection to be saved, got nil")
	}
	if got.Host != "127.0.0.1" {
		t.Errorf("Host: got %q, want %q", got.Host, "127.0.0.1")
	}
	if got.Database != "myapp" {
		t.Errorf("Database: got %q, want %q", got.Database, "myapp")
	}
}

// TestConnect_ListShowsActiveFlag verifies that after SetActive the correct
// connection shows as active in the list.
func TestConnect_ListShowsActiveFlag(t *testing.T) {
	gs, cleanup := setupConnectTest(t)
	defer cleanup()

	ctx := context.Background()
	projectID := "proj-connect-2"

	for _, name := range []string{"local", "staging"} {
		c := schema.Connection{Name: name, Host: "h", Port: 3306, Database: "d", User: "u", Password: "p"}
		if err := gs.SaveConnection(ctx, projectID, c); err != nil {
			t.Fatalf("SaveConnection(%q): %v", name, err)
		}
	}

	if err := gs.SetActive(ctx, projectID, "staging"); err != nil {
		t.Fatalf("SetActive: %v", err)
	}

	list, err := gs.ListConnections(ctx, projectID)
	if err != nil {
		t.Fatalf("ListConnections: %v", err)
	}

	found := false
	for _, c := range list {
		if c.Name == "staging" && c.Active {
			found = true
		}
		if c.Name == "local" && c.Active {
			t.Error("local should not be active after SetActive(staging)")
		}
	}
	if !found {
		t.Error("expected staging to be active")
	}
}

// TestConnect_DeleteRemovesConnection verifies DeleteConnection removes the row.
func TestConnect_DeleteRemovesConnection(t *testing.T) {
	gs, cleanup := setupConnectTest(t)
	defer cleanup()

	ctx := context.Background()
	projectID := "proj-connect-3"

	conn := schema.Connection{Name: "local", Host: "h", Port: 3306, Database: "d", User: "u", Password: "p"}
	if err := gs.SaveConnection(ctx, projectID, conn); err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}
	if err := gs.DeleteConnection(ctx, projectID, "local"); err != nil {
		t.Fatalf("DeleteConnection: %v", err)
	}

	got, err := gs.GetConnection(ctx, projectID, "local")
	if err != nil {
		t.Fatalf("GetConnection after delete: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil after delete, got %+v", got)
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

func setupConnectTest(t *testing.T) (gs *sqlite.GlobalStore, cleanup func()) {
	t.Helper()

	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "heydb.db")

	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	var err error
	gs, err = sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}

	cleanup = func() { _ = gs.Close() }
	return
}
