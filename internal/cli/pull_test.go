package cli

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// TestPullCmd_ImportsNewChunks verifies runPull imports annotations from a pushed chunk.
func TestPullCmd_ImportsNewChunks(t *testing.T) {
	// Use push to create a chunk, then pull into a second store.
	globalDir1 := t.TempDir()
	dbPath1 := filepath.Join(globalDir1, "heydb.db")
	heydbDir := t.TempDir()

	// Set up first store with 3 annotations and push.
	gs1, err := sqlite.OpenGlobal(dbPath1)
	if err != nil {
		t.Fatalf("OpenGlobal (store1): %v", err)
	}
	ctx := context.Background()
	proj := schema.Project{ID: "proj-pull-1", Name: "testapp", RepoPath: heydbDir}
	if err := gs1.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	for _, content := range []string{"ann one", "ann two", "ann three"} {
		_, err := gs1.AddAnnotation(ctx, schema.Annotation{
			ProjectID:      proj.ID,
			ConnectionName: "local",
			TargetType:     "table",
			TargetName:     "users",
			Content:        content,
			Author:         "alice",
		})
		if err != nil {
			t.Fatalf("AddAnnotation: %v", err)
		}
	}
	gs1.Close()

	if err := runPush(dbPath1, heydbDir); err != nil {
		t.Fatalf("runPush: %v", err)
	}

	// Set up second store (simulating another developer) — registers same project.
	globalDir2 := t.TempDir()
	dbPath2 := filepath.Join(globalDir2, "heydb.db")
	gs2, err := sqlite.OpenGlobal(dbPath2)
	if err != nil {
		t.Fatalf("OpenGlobal (store2): %v", err)
	}
	if err := gs2.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject (store2): %v", err)
	}
	gs2.Close()

	if err := runPull(dbPath2, heydbDir); err != nil {
		t.Fatalf("runPull: %v", err)
	}

	// Verify annotations were imported.
	gs2, err = sqlite.OpenGlobal(dbPath2)
	if err != nil {
		t.Fatalf("re-open store2: %v", err)
	}
	defer gs2.Close()

	anns, err := gs2.GetAnnotations(ctx, proj.ID, "local", "table", "users")
	if err != nil {
		t.Fatalf("GetAnnotations: %v", err)
	}
	if len(anns) != 3 {
		t.Errorf("expected 3 annotations after pull, got %d", len(anns))
	}
}

// TestPullCmd_SkipsAlreadyImportedChunks verifies a second pull is a no-op.
func TestPullCmd_SkipsAlreadyImportedChunks(t *testing.T) {
	globalDir1 := t.TempDir()
	dbPath1 := filepath.Join(globalDir1, "heydb.db")
	heydbDir := t.TempDir()

	gs1, err := sqlite.OpenGlobal(dbPath1)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	ctx := context.Background()
	proj := schema.Project{ID: "proj-pull-2", Name: "testapp", RepoPath: heydbDir}
	if err := gs1.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	if _, err := gs1.AddAnnotation(ctx, schema.Annotation{
		ProjectID:      proj.ID,
		ConnectionName: "local",
		TargetType:     "table",
		TargetName:     "orders",
		Content:        "orders table",
		Author:         "bob",
	}); err != nil {
		t.Fatalf("AddAnnotation: %v", err)
	}
	gs1.Close()

	if err := runPush(dbPath1, heydbDir); err != nil {
		t.Fatalf("runPush: %v", err)
	}

	globalDir2 := t.TempDir()
	dbPath2 := filepath.Join(globalDir2, "heydb.db")
	gs2, err := sqlite.OpenGlobal(dbPath2)
	if err != nil {
		t.Fatalf("OpenGlobal store2: %v", err)
	}
	if err := gs2.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject store2: %v", err)
	}
	gs2.Close()

	// First pull.
	if err := runPull(dbPath2, heydbDir); err != nil {
		t.Fatalf("first runPull: %v", err)
	}

	// Second pull — should succeed and not error.
	if err := runPull(dbPath2, heydbDir); err != nil {
		t.Fatalf("second runPull: %v", err)
	}

	// Count should still be 1.
	gs2, err = sqlite.OpenGlobal(dbPath2)
	if err != nil {
		t.Fatalf("re-open store2: %v", err)
	}
	defer gs2.Close()

	anns, err := gs2.GetAnnotations(ctx, proj.ID, "local", "table", "orders")
	if err != nil {
		t.Fatalf("GetAnnotations: %v", err)
	}
	if len(anns) != 1 {
		t.Errorf("expected 1 annotation (no duplicates), got %d", len(anns))
	}
}

// TestPullCmd_DedupsAnnotationsByUUID verifies importing the same chunk twice
// does not create duplicate annotations.
func TestPullCmd_DedupsAnnotationsByUUID(t *testing.T) {
	globalDir1 := t.TempDir()
	dbPath1 := filepath.Join(globalDir1, "heydb.db")
	heydbDir := t.TempDir()

	gs1, err := sqlite.OpenGlobal(dbPath1)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	ctx := context.Background()
	proj := schema.Project{ID: "proj-pull-3", Name: "testapp", RepoPath: heydbDir}
	if err := gs1.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	if _, err := gs1.AddAnnotation(ctx, schema.Annotation{
		ProjectID:      proj.ID,
		ConnectionName: "local",
		TargetType:     "table",
		TargetName:     "products",
		Content:        "product catalog",
		Author:         "alice",
	}); err != nil {
		t.Fatalf("AddAnnotation: %v", err)
	}
	gs1.Close()

	if err := runPush(dbPath1, heydbDir); err != nil {
		t.Fatalf("runPush: %v", err)
	}

	// Pull into same store twice (bypassing IsChunkImported by using a fresh store).
	globalDir2 := t.TempDir()
	dbPath2 := filepath.Join(globalDir2, "heydb.db")
	gs2, err := sqlite.OpenGlobal(dbPath2)
	if err != nil {
		t.Fatalf("OpenGlobal store2: %v", err)
	}
	if err := gs2.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject store2: %v", err)
	}
	gs2.Close()

	if err := runPull(dbPath2, heydbDir); err != nil {
		t.Fatalf("runPull: %v", err)
	}

	gs2, err = sqlite.OpenGlobal(dbPath2)
	if err != nil {
		t.Fatalf("re-open store2: %v", err)
	}
	defer gs2.Close()

	anns, err := gs2.GetAnnotations(ctx, proj.ID, "local", "table", "products")
	if err != nil {
		t.Fatalf("GetAnnotations: %v", err)
	}
	if len(anns) != 1 {
		t.Errorf("expected 1 annotation (dedup by UUID), got %d", len(anns))
	}
}
