package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// setupDocsEnv creates a minimal GlobalStore with a project, connection, and schema.
// Returns (globalDBPath, heydbDir, projectID).
func setupDocsEnv(t *testing.T) (globalDBPath, heydbDir, projectID string) {
	t.Helper()
	dir := t.TempDir()
	globalDBPath = filepath.Join(dir, "heydb.db")
	// heydbDir is inside dir so GetProjectByPath(dir) resolves correctly.
	heydbDir = filepath.Join(dir, ".heydb")
	if err := os.MkdirAll(heydbDir, 0755); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	gs, err := sqlite.OpenGlobal(globalDBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer gs.Close()

	// Create a project using dir as RepoPath (GetProjectByPath uses dir).
	proj := schema.Project{ID: "proj-docs-1", Name: "testproject", RepoPath: dir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatal(err)
	}
	projectID = proj.ID

	// Create a connection.
	conn := schema.Connection{
		ProjectID: proj.ID,
		Name:      "mydb",
		Host:      "localhost",
		Port:      3306,
		Database:  "testdb",
		User:      "root",
	}
	if err := gs.SaveConnection(ctx, proj.ID, conn); err != nil {
		t.Fatal(err)
	}

	// Save a schema so the connection is "synced".
	connID := proj.ID + "/mydb"
	connStore := gs.ForConnection(connID)
	s := schema.Schema{
		Database: "testdb",
		Hash:     "abc123",
		SyncedAt: time.Now().UTC(),
		Engine:   "mysql",
		Tables: []schema.Table{
			{
				Name: "users",
				Columns: []schema.Column{
					{Name: "id", OrdinalPos: 1, Type: "bigint unsigned", Nullable: false, Key: "PRI"},
					{Name: "email", OrdinalPos: 2, Type: "varchar(255)", Nullable: false},
				},
				PrimaryKey: []string{"id"},
			},
		},
	}
	if err := connStore.SaveSchema(ctx, s); err != nil {
		t.Fatal(err)
	}

	return globalDBPath, heydbDir, projectID
}

func TestDocsCmd_GeneratesMarkdownFile(t *testing.T) {
	globalDBPath, heydbDir, _ := setupDocsEnv(t)

	if err := runDocs(globalDBPath, heydbDir, "mydb", false); err != nil {
		t.Fatalf("runDocs error: %v", err)
	}

	mdPath := filepath.Join(heydbDir, "mydb.md")
	data, err := os.ReadFile(mdPath)
	if err != nil {
		t.Fatalf("expected markdown file at %s: %v", mdPath, err)
	}

	out := string(data)
	if !strings.Contains(out, "users") {
		t.Error("markdown file missing 'users' table")
	}
	if !strings.Contains(out, "testdb") {
		t.Error("markdown file missing database name 'testdb'")
	}
}

func TestDocsCmd_IncludesAnnotationsWithAuthor(t *testing.T) {
	globalDBPath, heydbDir, projID := setupDocsEnv(t)

	// Add an annotation.
	ctx := context.Background()
	gs, err := sqlite.OpenGlobal(globalDBPath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = gs.AddAnnotation(ctx, schema.Annotation{
		ProjectID:      projID,
		ConnectionName: "mydb",
		TargetType:     "table",
		TargetName:     "users",
		Content:        "Stores all registered users",
		Author:         "pvidal",
	})
	if err != nil {
		t.Fatal(err)
	}
	gs.Close()

	if err := runDocs(globalDBPath, heydbDir, "mydb", false); err != nil {
		t.Fatalf("runDocs error: %v", err)
	}

	mdPath := filepath.Join(heydbDir, "mydb.md")
	data, err := os.ReadFile(mdPath)
	if err != nil {
		t.Fatalf("expected markdown file at %s: %v", mdPath, err)
	}

	out := string(data)
	if !strings.Contains(out, "pvidal") {
		t.Errorf("markdown missing author 'pvidal'; output:\n%s", out)
	}
	if !strings.Contains(out, "Stores all registered users") {
		t.Error("markdown missing annotation content")
	}
}

func TestDocsCmd_NoSchema_Error(t *testing.T) {
	dir := t.TempDir()
	globalDBPath := filepath.Join(dir, "heydb.db")
	heydbDir := filepath.Join(dir, ".heydb")
	_ = os.MkdirAll(heydbDir, 0755)

	ctx := context.Background()
	gs, err := sqlite.OpenGlobal(globalDBPath)
	if err != nil {
		t.Fatal(err)
	}

	// Create project and connection but NO schema (no sync).
	proj := schema.Project{ID: "proj-docs-noschema", Name: "emptyproj", RepoPath: dir}
	if err := gs.CreateProject(ctx, proj); err != nil {
		t.Fatal(err)
	}
	conn := schema.Connection{
		ProjectID: proj.ID,
		Name:      "mydb",
		Host:      "localhost",
		Port:      3306,
		Database:  "testdb",
		User:      "root",
	}
	if err := gs.SaveConnection(ctx, proj.ID, conn); err != nil {
		t.Fatal(err)
	}
	gs.Close()

	err = runDocs(globalDBPath, heydbDir, "mydb", false)
	if err == nil {
		t.Error("expected error when no schema synced, got nil")
	}
	if !strings.Contains(err.Error(), "not synced") && !strings.Contains(err.Error(), "no schema") {
		t.Errorf("expected 'not synced' or 'no schema' error, got: %v", err)
	}
}
