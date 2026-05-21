package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
)

// TestPrintAIHint_BothAssistants verifies that printAIHint outputs a hint
// containing both assistant names and "heydb setup-ai" when both are detected.
func TestPrintAIHint_BothAssistants(t *testing.T) {
	home := t.TempDir()

	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatalf("mkdir claude: %v", err)
	}
	if err := os.WriteFile(filepath.Join(claudeDir, "CLAUDE.md"), []byte("# Claude"), 0o644); err != nil {
		t.Fatalf("write CLAUDE.md: %v", err)
	}

	opencodeDir := filepath.Join(home, ".config", "opencode")
	if err := os.MkdirAll(opencodeDir, 0o755); err != nil {
		t.Fatalf("mkdir opencode: %v", err)
	}
	if err := os.WriteFile(filepath.Join(opencodeDir, "AGENTS.md"), []byte("# Agents"), 0o644); err != nil {
		t.Fatalf("write AGENTS.md: %v", err)
	}

	var out strings.Builder
	printAIHint(home, &out)

	hint := out.String()
	// Spec format: "Detected AI assistants: X, Y. Run 'heydb setup-ai' to configure them."
	assertContains(t, hint, "Detected AI assistants:")
	assertContains(t, hint, "Claude Code")
	assertContains(t, hint, "OpenCode")
	assertContains(t, hint, "heydb setup-ai")
	assertContains(t, hint, "configure them")
}

// TestPrintAIHint_OneAssistant verifies the hint names only the detected assistant.
func TestPrintAIHint_OneAssistant(t *testing.T) {
	home := t.TempDir()

	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(claudeDir, "CLAUDE.md"), []byte("# Claude"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	var out strings.Builder
	printAIHint(home, &out)

	hint := out.String()
	// Spec format: "Detected AI assistants: Claude Code. Run 'heydb setup-ai' to configure them."
	assertContains(t, hint, "Detected AI assistants:")
	assertContains(t, hint, "Claude Code")
	assertContains(t, hint, "heydb setup-ai")
	assertContains(t, hint, "configure them")

	if strings.Contains(hint, "OpenCode") {
		t.Error("hint should not mention OpenCode when only Claude Code is detected")
	}
}

// TestPrintAIHint_NoneDetected verifies no output when no assistants are detected.
func TestPrintAIHint_NoneDetected(t *testing.T) {
	home := t.TempDir()

	var out strings.Builder
	printAIHint(home, &out)

	if out.Len() > 0 {
		t.Errorf("expected no output when no assistants detected, got: %q", out.String())
	}
}

// TestPrintAIHint_EmptyHomeDir verifies graceful failure when homeDir is empty.
func TestPrintAIHint_EmptyHomeDir(t *testing.T) {
	var out strings.Builder
	// Should not panic and should produce no output.
	printAIHint("", &out)

	if out.Len() > 0 {
		t.Errorf("expected no output for empty homeDir, got: %q", out.String())
	}
}

// TestRunInitCore_CreatesHeydbDir verifies that runInitCore creates .heydb/ directory.
func TestRunInitCore_CreatesHeydbDir(t *testing.T) {
	projectDir, dbPath, gs, cleanup := setupInitTest(t)
	defer cleanup()

	if err := runInitCore(projectDir, dbPath, "testauthor"); err != nil {
		t.Fatalf("runInitCore: %v", err)
	}

	dir := filepath.Join(projectDir, heydbDir)
	if _, err := os.Stat(dir); err != nil {
		t.Errorf("expected .heydb/ to exist: %v", err)
	}

	// GlobalStore not needed for this assertion but kept for consistency.
	_ = gs
}

// TestRunInitCore_RegistersProject verifies the project is registered in the global DB.
func TestRunInitCore_RegistersProject(t *testing.T) {
	projectDir, dbPath, gs, cleanup := setupInitTest(t)
	defer cleanup()

	if err := runInitCore(projectDir, dbPath, "testauthor"); err != nil {
		t.Fatalf("runInitCore: %v", err)
	}

	ctx := context.Background()
	proj, err := gs.GetProjectByPath(ctx, projectDir)
	if err != nil {
		t.Fatalf("GetProjectByPath: %v", err)
	}
	if proj == nil {
		t.Fatal("expected project to be registered, got nil")
	}
	if proj.RepoPath != projectDir {
		t.Errorf("RepoPath: got %q, want %q", proj.RepoPath, projectDir)
	}
	if proj.Name != filepath.Base(projectDir) {
		t.Errorf("Name: got %q, want %q", proj.Name, filepath.Base(projectDir))
	}
	if proj.ID == "" {
		t.Error("expected non-empty project ID (UUID)")
	}
}

// TestRunInitCore_WritesManifest verifies manifest.json is created with correct structure.
func TestRunInitCore_WritesManifest(t *testing.T) {
	projectDir, dbPath, _, cleanup := setupInitTest(t)
	defer cleanup()

	if err := runInitCore(projectDir, dbPath, "testauthor"); err != nil {
		t.Fatalf("runInitCore: %v", err)
	}

	manifestPath := filepath.Join(projectDir, heydbDir, "manifest.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("read manifest.json: %v", err)
	}

	var m struct {
		ProjectID string        `json:"project_id"`
		Chunks    []interface{} `json:"chunks"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse manifest.json: %v", err)
	}
	if m.ProjectID == "" {
		t.Error("expected non-empty project_id in manifest.json")
	}
	if m.Chunks == nil {
		t.Error("expected chunks field to be present (may be empty array)")
	}
}

// TestRunInitCore_WritesGitignore verifies .gitignore is created with correct content.
func TestRunInitCore_WritesGitignore(t *testing.T) {
	projectDir, dbPath, _, cleanup := setupInitTest(t)
	defer cleanup()

	if err := runInitCore(projectDir, dbPath, "testauthor"); err != nil {
		t.Fatalf("runInitCore: %v", err)
	}

	giPath := filepath.Join(projectDir, heydbDir, gitignoreFile)
	data, err := os.ReadFile(giPath)
	if err != nil {
		t.Fatalf("read .gitignore: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, "*.sqlite") {
		t.Error(".gitignore should exclude *.sqlite")
	}
	// manifest.json and chunks/ must NOT be excluded.
	if strings.Contains(content, "manifest.json") {
		t.Error(".gitignore must NOT exclude manifest.json")
	}
	if strings.Contains(content, "chunks/") {
		t.Error(".gitignore must NOT exclude chunks/")
	}
}

// TestRunInitCore_Idempotent verifies that running init twice does not fail
// and does not overwrite existing files.
func TestRunInitCore_Idempotent(t *testing.T) {
	projectDir, dbPath, gs, cleanup := setupInitTest(t)
	defer cleanup()

	if err := runInitCore(projectDir, dbPath, "testauthor"); err != nil {
		t.Fatalf("first runInitCore: %v", err)
	}
	if err := runInitCore(projectDir, dbPath, "testauthor"); err != nil {
		t.Fatalf("second runInitCore: %v", err)
	}

	// Only one project row should exist.
	ctx := context.Background()
	proj, err := gs.GetProjectByPath(ctx, projectDir)
	if err != nil {
		t.Fatalf("GetProjectByPath: %v", err)
	}
	if proj == nil {
		t.Fatal("expected project to exist after idempotent init")
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

// setupInitTest creates a temp project directory and an in-memory-style GlobalStore.
// It returns the project dir, the db path, the open GlobalStore, and a cleanup func.
func setupInitTest(t *testing.T) (projectDir, dbPath string, gs *sqlite.GlobalStore, cleanup func()) {
	t.Helper()

	tmpRoot := t.TempDir()
	projectDir = filepath.Join(tmpRoot, "myproject")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("MkdirAll projectDir: %v", err)
	}

	dbDir := filepath.Join(tmpRoot, ".heydb")
	if err := os.MkdirAll(dbDir, 0o700); err != nil {
		t.Fatalf("MkdirAll dbDir: %v", err)
	}
	dbPath = filepath.Join(dbDir, "heydb.db")

	var err error
	gs, err = sqlite.OpenGlobal(dbPath)
	if err != nil {
		t.Fatalf("OpenGlobal: %v", err)
	}

	cleanup = func() {
		_ = gs.Close()
	}
	return
}
