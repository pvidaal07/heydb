package cli

import (
	"context"
	"testing"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// TestLoadStoredHashV2_Found verifies that loadStoredHashV2 returns the hash
// stored in schema_meta for the given connection.
func TestLoadStoredHashV2_Found(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	connID := "proj-review-1/local"
	store := gs.ForConnection(connID)

	sc := schema.Schema{
		Database: "myapp",
		Hash:     "abc123hash",
		Engine:   "mysql",
		Version:  "1.0",
		Tables:   []schema.Table{{Name: "users"}},
	}
	if err := store.SaveSchema(ctx, sc); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	hash, err := loadStoredHashV2(ctx, gs, connID)
	if err != nil {
		t.Fatalf("loadStoredHashV2: %v", err)
	}
	if hash != "abc123hash" {
		t.Errorf("hash: got %q, want %q", hash, "abc123hash")
	}
}

// TestLoadStoredHashV2_NotFound verifies that loadStoredHashV2 returns an
// error when no schema has been synced for the connection.
func TestLoadStoredHashV2_NotFound(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	_, err = loadStoredHashV2(ctx, gs, "proj-x/nonexistent")
	if err == nil {
		t.Error("expected error for missing schema, got nil")
	}
}
