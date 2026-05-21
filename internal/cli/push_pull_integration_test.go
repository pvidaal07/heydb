package cli

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// TestPushPullRoundTrip validates the full push→pull workflow:
//  1. Create project + 3 annotations in store1
//  2. Push → chunk file + manifest in heydbDir
//  3. Open store2 (second developer), pull → verify 3 annotations
//  4. Pull again → verify "already up to date" (no duplicates, no error)
func TestPushPullRoundTrip(t *testing.T) {
	ctx := context.Background()
	heydbDir := t.TempDir()

	// ── Step 1: Set up store1 with 3 annotations ───────────────────────────
	dbPath1 := filepath.Join(t.TempDir(), "heydb.db")
	gs1, err := sqlite.OpenGlobal(dbPath1)
	if err != nil {
		t.Fatalf("OpenGlobal (store1): %v", err)
	}

	proj := schema.Project{
		ID:       "proj-integration-1",
		Name:     "integration-test",
		RepoPath: heydbDir,
	}
	if err := gs1.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	contents := []string{"first annotation", "second annotation", "third annotation"}
	for _, content := range contents {
		_, err := gs1.AddAnnotation(ctx, schema.Annotation{
			ProjectID:      proj.ID,
			ConnectionName: "local",
			TargetType:     "table",
			TargetName:     "users",
			Content:        content,
			Author:         "alice",
		})
		if err != nil {
			t.Fatalf("AddAnnotation %q: %v", content, err)
		}
	}
	gs1.Close()

	// ── Step 2: Push ────────────────────────────────────────────────────────
	if err := runPush(dbPath1, heydbDir); err != nil {
		t.Fatalf("runPush: %v", err)
	}

	// ── Step 3: Open store2, pull, verify 3 annotations imported ───────────
	dbPath2 := filepath.Join(t.TempDir(), "heydb.db")
	gs2, err := sqlite.OpenGlobal(dbPath2)
	if err != nil {
		t.Fatalf("OpenGlobal (store2): %v", err)
	}
	if err := gs2.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject (store2): %v", err)
	}
	gs2.Close()

	if err := runPull(dbPath2, heydbDir); err != nil {
		t.Fatalf("first runPull: %v", err)
	}

	gs2, err = sqlite.OpenGlobal(dbPath2)
	if err != nil {
		t.Fatalf("re-open store2: %v", err)
	}

	anns, err := gs2.GetAnnotations(ctx, proj.ID, "local", "table", "users")
	if err != nil {
		t.Fatalf("GetAnnotations (after pull): %v", err)
	}
	if len(anns) != 3 {
		t.Errorf("expected 3 annotations after pull, got %d", len(anns))
	}
	gs2.Close()

	// ── Step 4: Pull again → no duplicates, no error ────────────────────────
	if err := runPull(dbPath2, heydbDir); err != nil {
		t.Fatalf("second runPull: %v", err)
	}

	gs2, err = sqlite.OpenGlobal(dbPath2)
	if err != nil {
		t.Fatalf("re-open store2 (second pull): %v", err)
	}
	defer gs2.Close()

	anns2, err := gs2.GetAnnotations(ctx, proj.ID, "local", "table", "users")
	if err != nil {
		t.Fatalf("GetAnnotations (after second pull): %v", err)
	}
	if len(anns2) != 3 {
		t.Errorf("expected 3 annotations after second pull (no duplicates), got %d", len(anns2))
	}
}
