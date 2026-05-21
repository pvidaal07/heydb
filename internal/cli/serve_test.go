package cli

import (
	"context"
	"testing"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// TestBuildRegistryV2_MultipleConnections verifies that buildRegistryV2 creates
// entries for all connections in the project and marks the active one correctly.
func TestBuildRegistryV2_MultipleConnections(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	proj := schema.Project{ID: "proj-serve-1", Name: "testapp", RepoPath: dir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	conns := []schema.Connection{
		{Name: "local", Host: "127.0.0.1", Port: 3306, Database: "app", User: "u", Password: "p"},
		{Name: "staging", Host: "stg.db", Port: 3306, Database: "app_stg", User: "u", Password: "p"},
	}
	for _, c := range conns {
		if err := gs.SaveConnection(ctx, proj.ID, c); err != nil {
			t.Fatalf("SaveConnection(%q): %v", c.Name, err)
		}
	}
	if err := gs.SetActive(ctx, proj.ID, "local"); err != nil {
		t.Fatalf("SetActive: %v", err)
	}

	// Save schema for both connections so they are considered "synced".
	for _, c := range conns {
		connID := proj.ID + "/" + c.Name
		store := gs.ForConnection(connID)
		sc := schema.Schema{
			Database: c.Database,
			Hash:     "hash-" + c.Name,
			Engine:   "mysql",
			Version:  "1.0",
			Tables:   []schema.Table{{Name: "users"}},
		}
		if err := store.SaveSchema(ctx, sc); err != nil {
			t.Fatalf("SaveSchema(%q): %v", c.Name, err)
		}
	}

	reg, err := buildRegistryV2(gs, proj.ID, "local")
	if err != nil {
		t.Fatalf("buildRegistryV2: %v", err)
	}
	defer reg.CloseAll()

	infos := reg.List()
	if len(infos) != 2 {
		t.Errorf("expected 2 connections, got %d", len(infos))
	}

	for _, info := range infos {
		if info.Name == "local" && !info.Active {
			t.Error("local should be active")
		}
		if info.Name == "staging" && info.Active {
			t.Error("staging should not be active")
		}
	}
}

// TestBuildRegistryV2_AnnotationStoreIsSet verifies that each ConnEntry in the
// registry has a non-nil Annotations field backed by GlobalStore.
// This is the serve.go equivalent of TestServeCmd_PassesAuthorToServer.
func TestBuildRegistryV2_AnnotationStoreIsSet(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	proj := schema.Project{ID: "proj-ann-1", Name: "ann-app", RepoPath: dir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	conn := schema.Connection{Name: "local", Host: "127.0.0.1", Port: 3306, Database: "app", User: "u", Password: "p"}
	if err := gs.SaveConnection(ctx, proj.ID, conn); err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}

	// Save schema so the connection is "synced".
	connID := proj.ID + "/" + conn.Name
	store := gs.ForConnection(connID)
	sc := schema.Schema{
		Database: conn.Database, Hash: "hash", Engine: "mysql", Version: "1.0",
		Tables: []schema.Table{{Name: "users"}},
	}
	if err := store.SaveSchema(ctx, sc); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	reg, err := buildRegistryV2(gs, proj.ID, "local")
	if err != nil {
		t.Fatalf("buildRegistryV2: %v", err)
	}
	defer reg.CloseAll()

	// Verify the synced entry has a non-nil Annotations field.
	entry, _, err := reg.Resolve("local")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if entry.Annotations == nil {
		t.Error("expected ConnEntry.Annotations to be non-nil (backed by GlobalStore)")
	}
}

// TestBuildRegistryV2_NoConnections verifies that buildRegistryV2 returns
// an empty registry (no error) when no connections exist.
func TestBuildRegistryV2_NoConnections(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	reg, err := buildRegistryV2(gs, "proj-empty", "")
	if err != nil {
		t.Fatalf("buildRegistryV2 (empty): %v", err)
	}
	defer reg.CloseAll()

	if len(reg.List()) != 0 {
		t.Errorf("expected empty registry, got %d entries", len(reg.List()))
	}
}
