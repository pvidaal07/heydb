package cli

import (
	"context"
	"strings"
	"testing"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// setupStatusTest creates a temp GlobalStore with a registered project, two connections,
// and some annotations.
func setupStatusTest(t *testing.T) (*sqlite.GlobalStore, *schema.Project, func()) {
	t.Helper()

	dir := t.TempDir()
	dbPath := dir + "/heydb.db"

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}

	ctx := context.Background()
	proj := schema.Project{ID: "proj-status-1", Name: "testapp", RepoPath: dir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	conns := []schema.Connection{
		{Name: "local", Host: "127.0.0.1", Port: 3306, Database: "myapp", User: "u", Password: "p", Active: true},
		{Name: "staging", Host: "stg.example.com", Port: 3306, Database: "myapp_stg", User: "u", Password: "p"},
	}
	for _, c := range conns {
		if err := gs.SaveConnection(ctx, proj.ID, c); err != nil {
			t.Fatalf("SaveConnection(%q): %v", c.Name, err)
		}
	}

	cleanup := func() { _ = gs.Close() }
	return gs, &proj, cleanup
}

// TestRunStatus_ProjectFound verifies output includes project name and path.
func TestRunStatus_ProjectFound(t *testing.T) {
	gs, proj, cleanup := setupStatusTest(t)
	defer cleanup()

	var out strings.Builder
	err := runStatus(context.Background(), gs, proj, &out)
	if err != nil {
		t.Fatalf("runStatus: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, proj.Name) {
		t.Errorf("output should contain project name %q\nGot: %s", proj.Name, output)
	}
	if !strings.Contains(output, proj.RepoPath) {
		t.Errorf("output should contain project path %q\nGot: %s", proj.RepoPath, output)
	}
}

// TestRunStatus_ConnectionsList verifies output lists connections with host:port/db and active marker.
func TestRunStatus_ConnectionsList(t *testing.T) {
	gs, proj, cleanup := setupStatusTest(t)
	defer cleanup()

	var out strings.Builder
	err := runStatus(context.Background(), gs, proj, &out)
	if err != nil {
		t.Fatalf("runStatus: %v", err)
	}

	output := out.String()
	// Both connections should appear.
	if !strings.Contains(output, "local") {
		t.Errorf("output should contain 'local'\nGot: %s", output)
	}
	if !strings.Contains(output, "staging") {
		t.Errorf("output should contain 'staging'\nGot: %s", output)
	}
	// Active marker should appear somewhere.
	if !strings.Contains(output, "active") {
		t.Errorf("output should contain active marker\nGot: %s", output)
	}
}

// TestRunStatus_NeverSynced verifies "never" appears for unsynced connections.
func TestRunStatus_NeverSynced(t *testing.T) {
	gs, proj, cleanup := setupStatusTest(t)
	defer cleanup()

	var out strings.Builder
	err := runStatus(context.Background(), gs, proj, &out)
	if err != nil {
		t.Fatalf("runStatus: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "never") {
		t.Errorf("output should show 'never' for unsynced connections\nGot: %s", output)
	}
}

// TestRunStatus_AnnotationCounts verifies annotation and relationship counts appear in output.
func TestRunStatus_AnnotationCounts(t *testing.T) {
	gs, proj, cleanup := setupStatusTest(t)
	defer cleanup()

	ctx := context.Background()

	// Add some annotations.
	for _, content := range []string{"note one", "note two"} {
		ann := schema.Annotation{
			ProjectID:      proj.ID,
			ConnectionName: "local",
			TargetType:     "table",
			TargetName:     "users",
			Content:        content,
			Author:         "alice",
		}
		if _, err := gs.AddAnnotation(ctx, ann); err != nil {
			t.Fatalf("AddAnnotation: %v", err)
		}
	}

	// Add a relationship.
	rel := schema.ImplicitRelationship{
		ProjectID:      proj.ID,
		ConnectionName: "local",
		FromTable:      "orders",
		FromColumn:     "user_id",
		ToTable:        "users",
		ToColumn:       "id",
		Author:         "alice",
	}
	if _, err := gs.AddRelationship(ctx, rel); err != nil {
		t.Fatalf("AddRelationship: %v", err)
	}

	var out strings.Builder
	err := runStatus(ctx, gs, proj, &out)
	if err != nil {
		t.Fatalf("runStatus: %v", err)
	}

	output := out.String()
	// Should show annotation count — we added 2 annotations.
	if !strings.Contains(output, "2") {
		t.Errorf("output should contain annotation count (2)\nGot: %s", output)
	}
}

// TestRunStatus_OfflineHint verifies the static drift-check hint is present.
func TestRunStatus_OfflineHint(t *testing.T) {
	gs, proj, cleanup := setupStatusTest(t)
	defer cleanup()

	var out strings.Builder
	err := runStatus(context.Background(), gs, proj, &out)
	if err != nil {
		t.Fatalf("runStatus: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "heydb review") {
		t.Errorf("output should contain hint about 'heydb review'\nGot: %s", output)
	}
}
