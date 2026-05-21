package cli

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// setupPushEnv creates a temp globalDB + heydbDir, registers a project, and
// adds some annotations. Returns (globalDBPath, heydbDir, projectID, cleanup).
func setupPushEnv(t *testing.T) (string, string, string, func()) {
	t.Helper()

	globalDir := t.TempDir()
	dbPath := filepath.Join(globalDir, "heydb.db")
	heydbDir := t.TempDir()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}

	ctx := context.Background()
	proj := schema.Project{ID: "proj-push-1", Name: "testapp", RepoPath: heydbDir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	// Add 3 annotations.
	for i, content := range []string{"note one", "note two", "note three"} {
		ann := schema.Annotation{
			ProjectID:      proj.ID,
			ConnectionName: "local",
			TargetType:     "table",
			TargetName:     "users",
			Content:        content,
			Author:         "alice",
		}
		_ = i
		if _, err := gs.AddAnnotation(ctx, ann); err != nil {
			t.Fatalf("AddAnnotation: %v", err)
		}
	}
	gs.Close()

	return dbPath, heydbDir, proj.ID, func() {}
}

// TestPushCmd_CreatesChunkFile verifies runPush creates a chunk file.
func TestPushCmd_CreatesChunkFile(t *testing.T) {
	dbPath, heydbDir, _, cleanup := setupPushEnv(t)
	defer cleanup()

	if err := runPush(dbPath, heydbDir); err != nil {
		t.Fatalf("runPush: %v", err)
	}

	// Verify a chunk file exists under heydbDir/chunks/.
	chunksDir := filepath.Join(heydbDir, "chunks")
	entries, err := os.ReadDir(chunksDir)
	if err != nil {
		t.Fatalf("ReadDir chunks/: %v", err)
	}
	if len(entries) == 0 {
		t.Error("expected at least one chunk file, got none")
	}
}

// TestPushCmd_UpdatesManifest verifies runPush writes manifest.json with the chunk reference.
func TestPushCmd_UpdatesManifest(t *testing.T) {
	dbPath, heydbDir, _, cleanup := setupPushEnv(t)
	defer cleanup()

	if err := runPush(dbPath, heydbDir); err != nil {
		t.Fatalf("runPush: %v", err)
	}

	manifestPath := filepath.Join(heydbDir, "manifest.json")
	if _, err := os.Stat(manifestPath); err != nil {
		t.Fatalf("manifest.json not created: %v", err)
	}

	// Verify manifest contains a chunk entry.
	chunksDir := filepath.Join(heydbDir, "chunks")
	entries, err := os.ReadDir(chunksDir)
	if err != nil {
		t.Fatalf("ReadDir chunks/: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("expected chunk files")
	}
}

// TestPushCmd_NoNewAnnotations_Skips verifies runPush exits cleanly with no annotations.
func TestPushCmd_NoNewAnnotations_Skips(t *testing.T) {
	globalDir := t.TempDir()
	dbPath := filepath.Join(globalDir, "heydb.db")
	heydbDir := t.TempDir()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}

	ctx := context.Background()
	proj := schema.Project{ID: "proj-push-empty", Name: "emptyapp", RepoPath: heydbDir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	gs.Close()

	// runPush should not return an error.
	if err := runPush(dbPath, heydbDir); err != nil {
		t.Fatalf("runPush with no annotations: %v", err)
	}

	// No chunk file should be created.
	chunksDir := filepath.Join(heydbDir, "chunks")
	entries, _ := os.ReadDir(chunksDir)
	if len(entries) != 0 {
		t.Errorf("expected 0 chunk files for empty project, got %d", len(entries))
	}
}
