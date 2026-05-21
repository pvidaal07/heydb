package sqlite_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// tempDB creates a temporary directory and returns a path to a DB file
// inside it. The returned cleanup func removes the temp dir.
func tempDB(t *testing.T) (string, func()) {
	t.Helper()
	dir, err := os.MkdirTemp("", "heydb-global-test-*")
	if err != nil {
		t.Fatalf("tempDB: MkdirTemp: %v", err)
	}
	return filepath.Join(dir, "heydb.db"), func() { os.RemoveAll(dir) }
}

// ── T-06: OpenGlobal constructor ──────────────────────────────────────────────

func TestOpenGlobal_CreatesTablesOnFreshDB(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	// Verify that required tables exist by querying sqlite_master.
	tables := []string{
		"user_config", "projects", "connections", "annotations", "sync_chunks",
		"schema_meta", "schema_tables", "schema_columns", "schema_indexes", "schema_foreign_keys",
	}
	for _, tbl := range tables {
		var count int
		err := gs.DB().QueryRowContext(context.Background(),
			`SELECT COUNT(1) FROM sqlite_master WHERE type='table' AND name=?`, tbl,
		).Scan(&count)
		if err != nil {
			t.Errorf("checking table %q: %v", tbl, err)
			continue
		}
		if count != 1 {
			t.Errorf("expected table %q to exist, but it doesn't", tbl)
		}
	}
}

func TestOpenGlobal_Idempotent(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	// Open twice — second open must not fail or lose data.
	gs1, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("first OpenGlobal: %v", err)
	}
	if err := gs1.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}

	gs2, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("second OpenGlobal: %v", err)
	}
	defer gs2.Close()
}

func TestOpenGlobal_WALMode(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	var mode string
	if err := gs.DB().QueryRowContext(context.Background(), `PRAGMA journal_mode`).Scan(&mode); err != nil {
		t.Fatalf("PRAGMA journal_mode: %v", err)
	}
	if mode != "wal" {
		t.Errorf("expected journal_mode=wal, got %q", mode)
	}
}

// ── T-07: ProjectStore ────────────────────────────────────────────────────────

func TestGlobalStore_CreateProject(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	p := schema.Project{
		ID:       "uuid-proj-1",
		Name:     "myapp",
		RepoPath: "/home/alice/projects/myapp",
	}

	if err := gs.CreateProject(ctx, p); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	// Retrieve and verify.
	got, err := gs.GetProjectByPath(ctx, "/home/alice/projects/myapp")
	if err != nil {
		t.Fatalf("GetProjectByPath: %v", err)
	}
	if got.ID != p.ID {
		t.Errorf("ID: got %q, want %q", got.ID, p.ID)
	}
	if got.Name != p.Name {
		t.Errorf("Name: got %q, want %q", got.Name, p.Name)
	}
	if got.RepoPath != p.RepoPath {
		t.Errorf("RepoPath: got %q, want %q", got.RepoPath, p.RepoPath)
	}
}

func TestGlobalStore_GetProjectByPath_NotFound(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	got, err := gs.GetProjectByPath(context.Background(), "/nonexistent/path")
	if err != nil {
		t.Fatalf("GetProjectByPath returned unexpected error: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil for not-found path, got %+v", got)
	}
}

func TestGlobalStore_GetProjectByPath_Found(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	p := schema.Project{ID: "uuid-2", Name: "app2", RepoPath: "/repos/app2"}
	if err := gs.CreateProject(ctx, p); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	got, err := gs.GetProjectByPath(ctx, "/repos/app2")
	if err != nil {
		t.Fatalf("GetProjectByPath: %v", err)
	}
	if got == nil {
		t.Fatal("expected project, got nil")
	}
	if got.ID != "uuid-2" {
		t.Errorf("ID: got %q, want %q", got.ID, "uuid-2")
	}
}

func TestGlobalStore_GetProjectByID(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	p := schema.Project{ID: "uuid-3", Name: "app3", RepoPath: "/repos/app3"}
	if err := gs.CreateProject(ctx, p); err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	got, err := gs.GetProjectByID(ctx, "uuid-3")
	if err != nil {
		t.Fatalf("GetProjectByID: %v", err)
	}
	if got == nil {
		t.Fatal("expected project, got nil")
	}
	if got.Name != "app3" {
		t.Errorf("Name: got %q, want %q", got.Name, "app3")
	}
}

// ── T-08: ConnectionStore ─────────────────────────────────────────────────────

func TestGlobalStore_SaveConnection(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	projectID := "proj-uuid-1"

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
		t.Fatal("expected connection, got nil")
	}
	if got.Name != "local" {
		t.Errorf("Name: got %q, want %q", got.Name, "local")
	}
	if got.Host != "127.0.0.1" {
		t.Errorf("Host: got %q, want %q", got.Host, "127.0.0.1")
	}
	if got.Port != 3306 {
		t.Errorf("Port: got %d, want %d", got.Port, 3306)
	}
	if got.Database != "myapp" {
		t.Errorf("Database: got %q, want %q", got.Database, "myapp")
	}
	if got.User != "root" {
		t.Errorf("User: got %q, want %q", got.User, "root")
	}
	if got.Password != "secret" {
		t.Errorf("Password: got %q, want %q", got.Password, "secret")
	}
}

func TestGlobalStore_GetConnection_NotFound(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	got, err := gs.GetConnection(context.Background(), "proj-x", "nonexistent")
	if err != nil {
		t.Fatalf("GetConnection returned unexpected error: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil for not-found connection, got %+v", got)
	}
}

func TestGlobalStore_ListConnections(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	projectID := "proj-list-1"

	conns := []schema.Connection{
		{Name: "local", Host: "127.0.0.1", Port: 3306, Database: "app", User: "u1", Password: "p1"},
		{Name: "staging", Host: "staging.db", Port: 3306, Database: "app_stg", User: "u2", Password: "p2"},
	}
	for _, c := range conns {
		if err := gs.SaveConnection(ctx, projectID, c); err != nil {
			t.Fatalf("SaveConnection(%q): %v", c.Name, err)
		}
	}

	list, err := gs.ListConnections(ctx, projectID)
	if err != nil {
		t.Fatalf("ListConnections: %v", err)
	}
	if len(list) != 2 {
		t.Errorf("expected 2 connections, got %d", len(list))
	}
}

func TestGlobalStore_SetActive(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	projectID := "proj-active-1"

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

	activeCount := 0
	activeName := ""
	for _, c := range list {
		if c.Active {
			activeCount++
			activeName = c.Name
		}
	}
	if activeCount != 1 {
		t.Errorf("expected exactly 1 active connection, got %d", activeCount)
	}
	if activeName != "staging" {
		t.Errorf("expected active=%q, got %q", "staging", activeName)
	}
}

func TestGlobalStore_DeleteConnection(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	projectID := "proj-del-1"
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

// ── T-12: SchemaStore via ConnSchemaStore ─────────────────────────────────────

func TestGlobalStore_SaveSchema(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	connID := "proj-1/local"

	sc := schema.Schema{
		Database: "myapp",
		Hash:     "abc123",
		Engine:   "mysql",
		Version:  "1.0",
		Tables: []schema.Table{
			{
				Name:    "users",
				Engine:  "InnoDB",
				Comment: "User accounts",
				Columns: []schema.Column{
					{Name: "id", OrdinalPos: 1, Type: "int", Key: "PRI"},
					{Name: "email", OrdinalPos: 2, Type: "varchar(255)"},
				},
			},
		},
	}

	store := gs.ForConnection(connID)
	if err := store.SaveSchema(ctx, sc); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}
}

func TestGlobalStore_LoadSchema(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	connID := "proj-1/local"
	store := gs.ForConnection(connID)

	sc := schema.Schema{
		Database: "myapp",
		Hash:     "abc123",
		Engine:   "mysql",
		Version:  "1.0",
		Tables:   []schema.Table{{Name: "orders", Engine: "InnoDB"}},
	}

	if err := store.SaveSchema(ctx, sc); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	loaded, err := store.LoadSchema(ctx)
	if err != nil {
		t.Fatalf("LoadSchema: %v", err)
	}
	if loaded.Database != "myapp" {
		t.Errorf("Database: got %q, want %q", loaded.Database, "myapp")
	}
	if loaded.Hash != "abc123" {
		t.Errorf("Hash: got %q, want %q", loaded.Hash, "abc123")
	}
	if len(loaded.Tables) != 1 {
		t.Errorf("Tables: got %d, want 1", len(loaded.Tables))
	}
}

func TestGlobalStore_SchemaRoundTrip(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	connID := "proj-1/local"
	store := gs.ForConnection(connID)

	sc := schema.Schema{
		Database: "testdb",
		Hash:     "def456",
		Engine:   "mysql",
		Version:  "1.0",
		Tables: []schema.Table{
			{
				Name:   "products",
				Engine: "InnoDB",
				Columns: []schema.Column{
					{Name: "id", OrdinalPos: 1, Type: "int", Key: "PRI"},
					{Name: "name", OrdinalPos: 2, Type: "varchar(100)"},
					{Name: "price", OrdinalPos: 3, Type: "decimal(10,2)", Nullable: true},
				},
				Indexes: []schema.Index{
					{Name: "PRIMARY", Columns: []string{"id"}, Unique: true, Type: "BTREE"},
				},
				ForeignKeys: []schema.ForeignKey{},
			},
		},
	}

	if err := store.SaveSchema(ctx, sc); err != nil {
		t.Fatalf("SaveSchema: %v", err)
	}

	loaded, err := store.LoadSchema(ctx)
	if err != nil {
		t.Fatalf("LoadSchema: %v", err)
	}

	if len(loaded.Tables) != 1 {
		t.Fatalf("Tables count: got %d, want 1", len(loaded.Tables))
	}
	tbl := loaded.Tables[0]
	if tbl.Name != "products" {
		t.Errorf("Table name: got %q, want %q", tbl.Name, "products")
	}
	if len(tbl.Columns) != 3 {
		t.Errorf("Columns count: got %d, want 3", len(tbl.Columns))
	}
	if len(tbl.Indexes) != 1 {
		t.Errorf("Indexes count: got %d, want 1", len(tbl.Indexes))
	}
	// Verify GetTable works too.
	got, err := store.GetTable(ctx, "products")
	if err != nil {
		t.Fatalf("GetTable: %v", err)
	}
	if got.Name != "products" {
		t.Errorf("GetTable name: got %q, want %q", got.Name, "products")
	}
}

// ── T-20: AnnotationStore v2 on GlobalStore ───────────────────────────────────

func TestGlobalStore_AddAnnotation(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	ann := schema.Annotation{
		ProjectID:      "proj-1",
		ConnectionName: "local",
		TargetType:     "table",
		TargetName:     "users",
		Content:        "User accounts table",
		Author:         "alice",
	}

	created, err := gs.AddAnnotation(ctx, ann)
	if err != nil {
		t.Fatalf("AddAnnotation: %v", err)
	}
	if created.ID == "" {
		t.Error("expected non-empty UUID in created annotation")
	}
	if created.Content != "User accounts table" {
		t.Errorf("Content: got %q, want %q", created.Content, "User accounts table")
	}
	if created.Author != "alice" {
		t.Errorf("Author: got %q, want %q", created.Author, "alice")
	}
	if created.CreatedAt.IsZero() {
		t.Error("CreatedAt should not be zero")
	}
	if created.UpdatedAt.IsZero() {
		t.Error("UpdatedAt should not be zero")
	}
}

func TestGlobalStore_GetAnnotations_Empty(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	anns, err := gs.GetAnnotations(ctx, "proj-1", "local", "table", "users")
	if err != nil {
		t.Fatalf("GetAnnotations: %v", err)
	}
	if len(anns) != 0 {
		t.Errorf("expected 0 annotations on empty DB, got %d", len(anns))
	}
}

func TestGlobalStore_GetAnnotations_MultipleResults(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	for i, content := range []string{"first annotation", "second annotation"} {
		ann := schema.Annotation{
			ProjectID:      "proj-1",
			ConnectionName: "local",
			TargetType:     "table",
			TargetName:     "users",
			Content:        content,
			Author:         fmt.Sprintf("author%d", i),
		}
		if _, err := gs.AddAnnotation(ctx, ann); err != nil {
			t.Fatalf("AddAnnotation %d: %v", i, err)
		}
	}

	anns, err := gs.GetAnnotations(ctx, "proj-1", "local", "table", "users")
	if err != nil {
		t.Fatalf("GetAnnotations: %v", err)
	}
	if len(anns) != 2 {
		t.Errorf("expected 2 annotations, got %d", len(anns))
	}
}

func TestGlobalStore_EditAnnotation(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	created, err := gs.AddAnnotation(ctx, schema.Annotation{
		ProjectID:      "proj-1",
		ConnectionName: "local",
		TargetType:     "table",
		TargetName:     "orders",
		Content:        "original",
		Author:         "alice",
	})
	if err != nil {
		t.Fatalf("AddAnnotation: %v", err)
	}

	updated, err := gs.EditAnnotation(ctx, created.ID, "updated content")
	if err != nil {
		t.Fatalf("EditAnnotation: %v", err)
	}
	if updated.Content != "updated content" {
		t.Errorf("Content: got %q, want %q", updated.Content, "updated content")
	}
	if updated.ID != created.ID {
		t.Errorf("ID should be unchanged: got %q, want %q", updated.ID, created.ID)
	}
}

func TestGlobalStore_EditAnnotation_NotFound(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	_, err = gs.EditAnnotation(context.Background(), "nonexistent-uuid", "content")
	if err == nil {
		t.Error("expected error for nonexistent ID, got nil")
	}
}

func TestGlobalStore_DeleteAnnotation(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	created, err := gs.AddAnnotation(ctx, schema.Annotation{
		ProjectID:      "proj-1",
		ConnectionName: "local",
		TargetType:     "table",
		TargetName:     "users",
		Content:        "to be deleted",
		Author:         "alice",
	})
	if err != nil {
		t.Fatalf("AddAnnotation: %v", err)
	}

	if err := gs.DeleteAnnotation(ctx, created.ID); err != nil {
		t.Fatalf("DeleteAnnotation: %v", err)
	}

	anns, err := gs.GetAnnotations(ctx, "proj-1", "local", "table", "users")
	if err != nil {
		t.Fatalf("GetAnnotations after delete: %v", err)
	}
	if len(anns) != 0 {
		t.Errorf("expected 0 annotations after delete, got %d", len(anns))
	}
}

func TestGlobalStore_DeleteAnnotation_NotFound(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	err = gs.DeleteAnnotation(context.Background(), "nonexistent-uuid")
	if err == nil {
		t.Error("expected error for nonexistent ID, got nil")
	}
}

func TestGlobalStore_AddAnnotation_MissingAuthor(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ann := schema.Annotation{
		ProjectID:      "proj-1",
		ConnectionName: "local",
		TargetType:     "table",
		TargetName:     "users",
		Content:        "Some annotation",
		Author:         "",
	}
	_, err = gs.AddAnnotation(context.Background(), ann)
	if err == nil {
		t.Error("expected error for empty author, got nil")
	}

	ann.Author = "   "
	_, err = gs.AddAnnotation(context.Background(), ann)
	if err == nil {
		t.Error("expected error for whitespace-only author, got nil")
	}
}

func TestGlobalStore_GetAnnotationsSince(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	before := time.Now().Add(-time.Hour)

	_, err = gs.AddAnnotation(ctx, schema.Annotation{
		ProjectID:      "proj-1",
		ConnectionName: "local",
		TargetType:     "table",
		TargetName:     "users",
		Content:        "recent annotation",
		Author:         "alice",
	})
	if err != nil {
		t.Fatalf("AddAnnotation: %v", err)
	}

	anns, err := gs.GetAnnotationsSince(ctx, "proj-1", before)
	if err != nil {
		t.Fatalf("GetAnnotationsSince: %v", err)
	}
	if len(anns) != 1 {
		t.Errorf("expected 1 annotation since 1 hour ago, got %d", len(anns))
	}

	// With a future cutoff, should return nothing.
	future := time.Now().Add(time.Hour)
	anns2, err := gs.GetAnnotationsSince(ctx, "proj-1", future)
	if err != nil {
		t.Fatalf("GetAnnotationsSince (future): %v", err)
	}
	if len(anns2) != 0 {
		t.Errorf("expected 0 annotations with future cutoff, got %d", len(anns2))
	}
}

func TestGlobalStore_ImportAnnotations_DedupsUUID(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()

	// Add one annotation to get a real UUID.
	created, err := gs.AddAnnotation(ctx, schema.Annotation{
		ProjectID:      "proj-1",
		ConnectionName: "local",
		TargetType:     "table",
		TargetName:     "products",
		Content:        "original",
		Author:         "alice",
	})
	if err != nil {
		t.Fatalf("AddAnnotation: %v", err)
	}

	// Import the same UUID with updated content + a new annotation.
	importBatch := []schema.Annotation{
		{
			ID:             created.ID,
			ProjectID:      "proj-1",
			ConnectionName: "local",
			TargetType:     "table",
			TargetName:     "products",
			Content:        "updated via import",
			Author:         "alice",
			CreatedAt:      created.CreatedAt,
			UpdatedAt:      created.UpdatedAt,
		},
		{
			ID:             "new-uuid-from-remote",
			ProjectID:      "proj-1",
			ConnectionName: "local",
			TargetType:     "table",
			TargetName:     "products",
			Content:        "brand new",
			Author:         "bob",
			CreatedAt:      created.CreatedAt,
			UpdatedAt:      created.UpdatedAt,
		},
	}

	if err := gs.ImportAnnotations(ctx, importBatch); err != nil {
		t.Fatalf("ImportAnnotations: %v", err)
	}

	anns, err := gs.GetAnnotations(ctx, "proj-1", "local", "table", "products")
	if err != nil {
		t.Fatalf("GetAnnotations: %v", err)
	}
	// Should have 2: the updated original + the brand new one.
	if len(anns) != 2 {
		t.Errorf("expected 2 annotations after import (dedup by UUID), got %d", len(anns))
	}

	// The original UUID should have the updated content.
	for _, a := range anns {
		if a.ID == created.ID && a.Content != "updated via import" {
			t.Errorf("imported annotation content: got %q, want %q", a.Content, "updated via import")
		}
	}
}

// ── T-24: sync_chunks ─────────────────────────────────────────────────────────

func TestGlobalStore_MarkChunkImported(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	if err := gs.MarkChunkImported(ctx, "chunk-abc123", "proj-1"); err != nil {
		t.Fatalf("MarkChunkImported: %v", err)
	}
}

func TestGlobalStore_IsChunkImported_False(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	imported, err := gs.IsChunkImported(ctx, "nonexistent-chunk")
	if err != nil {
		t.Fatalf("IsChunkImported: %v", err)
	}
	if imported {
		t.Error("expected false for nonexistent chunk, got true")
	}
}

func TestGlobalStore_IsChunkImported_True(t *testing.T) {
	dbPath, cleanup := tempDB(t)
	defer cleanup()

	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}
	defer gs.Close()

	ctx := context.Background()
	if err := gs.MarkChunkImported(ctx, "chunk-xyz789", "proj-1"); err != nil {
		t.Fatalf("MarkChunkImported: %v", err)
	}

	imported, err := gs.IsChunkImported(ctx, "chunk-xyz789")
	if err != nil {
		t.Fatalf("IsChunkImported: %v", err)
	}
	if !imported {
		t.Error("expected true after MarkChunkImported, got false")
	}
}
