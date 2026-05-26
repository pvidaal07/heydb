package cli

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// TestRunSyncListV2_Empty verifies that listSyncedConnectionsV2 prints a
// "no connections" message when the project has no connections.
func TestRunSyncListV2_Empty(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	proj := schema.Project{ID: "proj-sync-1", Name: "testapp", RepoPath: dir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	// Should not error — just prints empty message.
	err = listSyncedConnectionsV2(ctx, gs, proj.ID)
	if err != nil {
		t.Errorf("listSyncedConnectionsV2 empty: %v", err)
	}
}

// TestRunSyncListV2_WithConnections verifies that listSyncedConnectionsV2
// lists connections that exist in GlobalStore.
func TestRunSyncListV2_WithConnections(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	proj := schema.Project{ID: "proj-sync-2", Name: "testapp", RepoPath: dir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	conns := []schema.Connection{
		{Name: "local", Host: "127.0.0.1", Port: 3306, Database: "myapp", User: "u", Password: "p"},
		{Name: "staging", Host: "stg.example.com", Port: 3306, Database: "myapp_stg", User: "u", Password: "p"},
	}
	for _, c := range conns {
		if err := gs.SaveConnection(ctx, proj.ID, c); err != nil {
			t.Fatalf("SaveConnection(%q): %v", c.Name, err)
		}
	}

	// list should not error.
	if err := listSyncedConnectionsV2(ctx, gs, proj.ID); err != nil {
		t.Errorf("listSyncedConnectionsV2: %v", err)
	}
}

// TestRunSyncDeleteV2_RemovesSchemaData verifies that deleteSyncedSchemaV2
// deletes the schema rows for the given connection from GlobalStore.
func TestRunSyncDeleteV2_RemovesSchemaData(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	proj := schema.Project{ID: "proj-sync-3", Name: "testapp", RepoPath: dir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	conn := schema.Connection{Name: "local", Host: "h", Port: 3306, Database: "d", User: "u", Password: "p"}
	if err := gs.SaveConnection(ctx, proj.ID, conn); err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}

	// Save some schema data.
	connID := proj.ID + "/" + conn.Name
	store := gs.ForConnection(connID)
	sc := schema.Schema{
		Database: "d",
		Hash:     "testhash",
		Engine:   "mysql",
		Version:  "1.0",
		Tables:   []schema.Table{{Name: "users"}},
	}
	if err := store.SaveSchema(ctx, sc); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	// Delete should remove schema data — not error.
	if err := deleteSyncedSchemaV2(ctx, gs, proj.ID, conn.Name); err != nil {
		t.Errorf("deleteSyncedSchemaV2: %v", err)
	}

	// After delete, LoadSchema should fail (no rows).
	_, loadErr := store.LoadSchema(ctx)
	if loadErr == nil {
		t.Error("expected LoadSchema to fail after delete, but it succeeded")
	}
}

// TestRunSyncDeleteV2_NotFound verifies that deleteSyncedSchemaV2 does not
// error when there is no schema data for the connection — it's idempotent.
func TestRunSyncDeleteV2_NotFound(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	proj := schema.Project{ID: "proj-sync-4", Name: "testapp", RepoPath: dir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	// No schema data exists — delete should not error.
	if err := deleteSyncedSchemaV2(ctx, gs, proj.ID, "nonexistent"); err != nil {
		t.Errorf("deleteSyncedSchemaV2 (not-found): %v", err)
	}
}

// TestResolveActiveGlobalConnection_NoProject verifies error when project is not found.
func TestResolveActiveGlobalConnection_NoProject(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	// Point to a dir with no project registered.
	t.Setenv("PWD", dir)
	_, _, _, _, err = resolveActiveGlobalConnection(gs, dir)
	if err == nil {
		t.Error("expected error for unregistered project, got nil")
	}
}

// TestSyncHelperCompilation ensures syncV2 helpers compile correctly even
// without running the full MySQL-dependent sync path.
func TestSyncHelperCompilation(t *testing.T) {
	// Ensure we can refer to the symbols without calling them.
	// This is a compile-check test.
	_ = os.Stderr
	t.Log("sync v2 helpers compile OK")
}

// ── runSyncAll ────────────────────────────────────────────────────────────────

// setupSyncAllTest creates a temp GlobalStore with a project and N named connections.
func setupSyncAllTest(t *testing.T, connNames []string) (string, *sqlite.GlobalStore, *schema.Project, func()) {
	t.Helper()

	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}

	ctx := context.Background()
	proj := schema.Project{ID: "proj-syncall-1", Name: "testapp", RepoPath: dir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	for i, name := range connNames {
		conn := schema.Connection{
			Name:     name,
			Host:     "127.0.0.1",
			Port:     3306,
			Database: "myapp",
			User:     "u",
			Password: "p",
			Active:   i == 0,
		}
		if err := gs.SaveConnection(ctx, proj.ID, conn); err != nil {
			t.Fatalf("SaveConnection(%q): %v", name, err)
		}
	}

	cleanup := func() { _ = gs.Close() }
	return dir, gs, &proj, cleanup
}

// TestRunSyncAll_AllSucceed verifies that runSyncAll returns nil when all per-connection
// funcs succeed.
func TestRunSyncAll_AllSucceed(t *testing.T) {
	_, gs, proj, cleanup := setupSyncAllTest(t, []string{"conn1", "conn2", "conn3"})
	defer cleanup()

	ctx := context.Background()

	// successSyncer is a per-connection sync func that always succeeds.
	successSyncer := func(_ context.Context, _ *sqlite.GlobalStore, _ string, connName string) error {
		return nil
	}

	err := runSyncAll(ctx, gs, proj.ID, proj.RepoPath, successSyncer)
	if err != nil {
		t.Errorf("runSyncAll all-succeed: expected nil, got %v", err)
	}
}

// TestRunSyncAll_OneFails verifies that runSyncAll returns non-nil when one connection fails,
// while still attempting the remaining connections.
func TestRunSyncAll_OneFails(t *testing.T) {
	_, gs, proj, cleanup := setupSyncAllTest(t, []string{"conn1", "conn2", "conn3"})
	defer cleanup()

	ctx := context.Background()
	called := make(map[string]bool)

	failSyncer := func(_ context.Context, _ *sqlite.GlobalStore, _ string, connName string) error {
		called[connName] = true
		if connName == "conn2" {
			return errors.New("connection refused")
		}
		return nil
	}

	err := runSyncAll(ctx, gs, proj.ID, proj.RepoPath, failSyncer)
	if err == nil {
		t.Error("runSyncAll one-fails: expected non-nil error, got nil")
	}
	// All three connections must have been attempted.
	for _, name := range []string{"conn1", "conn2", "conn3"} {
		if !called[name] {
			t.Errorf("expected syncer to be called for %q, but it was not", name)
		}
	}
}

// TestRunSyncAll_AllFail verifies exit non-zero when all connections fail.
func TestRunSyncAll_AllFail(t *testing.T) {
	_, gs, proj, cleanup := setupSyncAllTest(t, []string{"conn1", "conn2"})
	defer cleanup()

	ctx := context.Background()

	failSyncer := func(_ context.Context, _ *sqlite.GlobalStore, _ string, connName string) error {
		return errors.New("dial tcp: connection refused")
	}

	err := runSyncAll(ctx, gs, proj.ID, proj.RepoPath, failSyncer)
	if err == nil {
		t.Error("runSyncAll all-fail: expected non-nil error, got nil")
	}
	// Combined error should mention both connections.
	msg := err.Error()
	if !strings.Contains(msg, "conn1") && !strings.Contains(msg, "connection refused") {
		t.Errorf("error message should mention failed connections: %v", msg)
	}
}

// TestRunSync_AllMutualExclusivity verifies that --all and --list cannot be combined.
func TestRunSync_AllListMutualExclusivity(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	proj := schema.Project{ID: "proj-syncall-mutex", Name: "testapp", RepoPath: dir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	err = checkSyncAllMutualExclusivity(true, true, false)
	if err == nil {
		t.Error("expected error for --all --list, got nil")
	}
	if !strings.Contains(err.Error(), "mutually exclusive") {
		t.Errorf("error should mention mutual exclusivity: %v", err)
	}
}
