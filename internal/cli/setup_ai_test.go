package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// assertContainsAI is a local alias so this file is self-contained even
// though assertContains is already declared in create_user_test.go (same
// package). We reuse the one from create_user_test.go directly.

// ---------------------------------------------------------------------------
// T-01/T-02: generateBlockContent
// ---------------------------------------------------------------------------

func TestGenerateBlockContent_HasMarkers(t *testing.T) {
	block := generateBlockContent()
	if !strings.Contains(block, blockStart) {
		t.Errorf("block missing opening marker %q", blockStart)
	}
	if !strings.Contains(block, blockEnd) {
		t.Errorf("block missing closing marker %q", blockEnd)
	}
}

func TestGenerateBlockContent_HasAllMCPTools(t *testing.T) {
	block := generateBlockContent()
	tools := []string{
		"list_connections",
		"list_tables",
		"describe_table",
		"search_columns",
		"get_annotations",
		"set_annotation",
	}
	for _, tool := range tools {
		if !strings.Contains(block, tool) {
			t.Errorf("block missing MCP tool name %q", tool)
		}
	}
}

func TestGenerateBlockContent_HasHeydbDescription(t *testing.T) {
	block := generateBlockContent()
	assertContains(t, block, "heydb")
}

func TestGenerateBlockContent_HasSchemaPath(t *testing.T) {
	block := generateBlockContent()
	assertContains(t, block, ".heydb/*.md")
}

func TestGenerateBlockContent_HasMultiConnectionInfo(t *testing.T) {
	block := generateBlockContent()
	assertContains(t, block, "list_connections")
}

// ---------------------------------------------------------------------------
// T-03/T-04: stripExistingBlock
// ---------------------------------------------------------------------------

func TestStripExistingBlock_NoBlock(t *testing.T) {
	content := "some content\nwithout a block\n"
	got := stripExistingBlock(content)
	if got != content {
		t.Errorf("content with no block should be unchanged\ngot:  %q\nwant: %q", got, content)
	}
}

func TestStripExistingBlock_BlockAtEnd(t *testing.T) {
	before := "before content\n"
	block := blockStart + "\ninner\n" + blockEnd
	content := before + block
	got := stripExistingBlock(content)
	if strings.Contains(got, blockStart) {
		t.Error("stripped content still contains opening marker")
	}
	if strings.Contains(got, blockEnd) {
		t.Error("stripped content still contains closing marker")
	}
	if !strings.Contains(got, "before content") {
		t.Error("content before block was removed — should be intact")
	}
}

func TestStripExistingBlock_BlockInMiddle(t *testing.T) {
	before := "before\n"
	after := "\nafter\n"
	block := blockStart + "\ninner\n" + blockEnd
	content := before + block + after
	got := stripExistingBlock(content)
	if strings.Contains(got, blockStart) || strings.Contains(got, blockEnd) {
		t.Error("stripped content still contains markers")
	}
	if !strings.Contains(got, "before") {
		t.Error("content before block removed")
	}
	if !strings.Contains(got, "after") {
		t.Error("content after block removed")
	}
}

func TestStripExistingBlock_CustomInnerContent(t *testing.T) {
	content := "preamble\n" + blockStart + "\ncustom inner content\n" + blockEnd + "\npostamble\n"
	got := stripExistingBlock(content)
	if strings.Contains(got, "custom inner content") {
		t.Error("inner content inside markers should be removed")
	}
	assertContains(t, got, "preamble")
	assertContains(t, got, "postamble")
}

// ---------------------------------------------------------------------------
// T-05/T-06: writeAIBlock
// ---------------------------------------------------------------------------

func TestWriteAIBlock_NewFileInNonexistentDir(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "subdir", "CLAUDE.md")

	block := generateBlockContent()
	if err := writeAIBlock(path, block); err != nil {
		t.Fatalf("writeAIBlock error: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("could not read created file: %v", err)
	}
	assertContains(t, string(data), blockStart)
	assertContains(t, string(data), blockEnd)
}

func TestWriteAIBlock_ExistingFileWithoutBlock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "CLAUDE.md")

	existing := "# Existing content\n\nSome instructions.\n"
	if err := os.WriteFile(path, []byte(existing), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}

	block := generateBlockContent()
	if err := writeAIBlock(path, block); err != nil {
		t.Fatalf("writeAIBlock error: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	content := string(data)
	assertContains(t, content, "Existing content")
	assertContains(t, content, blockStart)
	assertContains(t, content, blockEnd)
}

func TestWriteAIBlock_ExistingFileWithBlock_Replaced(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "CLAUDE.md")

	initial := "# Header\n" + blockStart + "\nold inner\n" + blockEnd + "\nfooter\n"
	if err := os.WriteFile(path, []byte(initial), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}

	block := generateBlockContent()
	if err := writeAIBlock(path, block); err != nil {
		t.Fatalf("writeAIBlock error: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	content := string(data)

	if strings.Contains(content, "old inner") {
		t.Error("old inner content should have been replaced")
	}
	assertContains(t, content, "# Header")
	assertContains(t, content, "footer")
	assertContains(t, content, blockStart)
}

func TestWriteAIBlock_Idempotent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "CLAUDE.md")

	block := generateBlockContent()
	if err := writeAIBlock(path, block); err != nil {
		t.Fatalf("first write: %v", err)
	}
	if err := writeAIBlock(path, block); err != nil {
		t.Fatalf("second write: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	content := string(data)

	// Count occurrences of the opening marker — must be exactly 1.
	count := strings.Count(content, blockStart)
	if count != 1 {
		t.Errorf("opening marker appears %d times, want exactly 1", count)
	}
}

func TestWriteAIBlock_NoTmpFileAfterSuccess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "CLAUDE.md")

	block := generateBlockContent()
	if err := writeAIBlock(path, block); err != nil {
		t.Fatalf("writeAIBlock error: %v", err)
	}

	tmpPath := path + ".tmp"
	if _, err := os.Stat(tmpPath); err == nil {
		t.Error(".tmp file should not exist after successful write")
	}
}

// ---------------------------------------------------------------------------
// T-07/T-08: detectAssistants
// ---------------------------------------------------------------------------

func TestDetectAssistants_BothExist(t *testing.T) {
	home := t.TempDir()

	// Create sentinel files.
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

	targets := detectAssistants(home)
	if len(targets) != 2 {
		t.Fatalf("want 2 targets, got %d", len(targets))
	}
	names := []string{targets[0].Name, targets[1].Name}
	if !contains(names, "Claude Code") {
		t.Error("expected Claude Code target")
	}
	if !contains(names, "OpenCode") {
		t.Error("expected OpenCode target")
	}
}

func TestDetectAssistants_OnlyClaudeExists(t *testing.T) {
	home := t.TempDir()

	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(claudeDir, "CLAUDE.md"), []byte("# Claude"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	targets := detectAssistants(home)
	if len(targets) != 1 {
		t.Fatalf("want 1 target, got %d", len(targets))
	}
	if targets[0].Name != "Claude Code" {
		t.Errorf("want Claude Code, got %q", targets[0].Name)
	}
}

func TestDetectAssistants_OnlyOpenCodeExists(t *testing.T) {
	home := t.TempDir()

	opencodeDir := filepath.Join(home, ".config", "opencode")
	if err := os.MkdirAll(opencodeDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(opencodeDir, "AGENTS.md"), []byte("# Agents"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	targets := detectAssistants(home)
	if len(targets) != 1 {
		t.Fatalf("want 1 target, got %d", len(targets))
	}
	if targets[0].Name != "OpenCode" {
		t.Errorf("want OpenCode, got %q", targets[0].Name)
	}
}

// TestDetectAssistants_OpenCodeDirWithoutAgentsMD verifies that OpenCode is detected
// when the ~/.config/opencode/ directory exists, even without AGENTS.md inside it.
func TestDetectAssistants_OpenCodeDirWithoutAgentsMD(t *testing.T) {
	home := t.TempDir()

	// Create directory only — no AGENTS.md inside.
	opencodeDir := filepath.Join(home, ".config", "opencode")
	if err := os.MkdirAll(opencodeDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	targets := detectAssistants(home)
	if len(targets) != 1 {
		t.Fatalf("want 1 target (OpenCode via directory detection), got %d", len(targets))
	}
	if targets[0].Name != "OpenCode" {
		t.Errorf("want OpenCode, got %q", targets[0].Name)
	}
}

func TestDetectAssistants_NoneExist(t *testing.T) {
	home := t.TempDir()
	targets := detectAssistants(home)
	if len(targets) != 0 {
		t.Errorf("want 0 targets, got %d", len(targets))
	}
}

func TestDetectAssistants_EmptyHomeDir(t *testing.T) {
	targets := detectAssistants("")
	if len(targets) != 0 {
		t.Errorf("empty homeDir should return empty slice, got %d", len(targets))
	}
}

// TestRunSetupAI_WriteError verifies that an error is returned when writeAIBlock
// cannot write to the target path (e.g., path inside a file treated as directory).
func TestRunSetupAI_WriteError(t *testing.T) {
	home := t.TempDir()

	// Create a file where we expect a directory — MkdirAll will fail when
	// writeAIBlock tries to create the parent directory.
	blockingFile := filepath.Join(home, ".claude")
	if err := os.WriteFile(blockingFile, []byte("not a dir"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}
	// Target path: ~/.claude/CLAUDE.md — but ~/.claude is a FILE not a dir.
	var outBuf, errBuf strings.Builder
	err := runSetupAIWithHome(home, true, false, false, &outBuf, &errBuf)
	if err == nil {
		t.Fatal("expected error when writeAIBlock fails, got nil")
	}
}

// ---------------------------------------------------------------------------
// T-09/T-10: runSetupAI / NewSetupAICmd flag behavior
// ---------------------------------------------------------------------------

// runSetupAIWithHome is a testable variant of runSetupAI that accepts a
// homeDir parameter instead of calling os.UserHomeDir().
// It is defined in setup_ai.go alongside the real command.

func TestRunSetupAI_ClaudeFlag(t *testing.T) {
	home := t.TempDir()
	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(claudeDir, "CLAUDE.md"), []byte("# Claude"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	var outBuf strings.Builder
	err := runSetupAIWithHome(home, true, false, false, &outBuf, &outBuf)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out := outBuf.String()
	assertContains(t, out, "Claude Code")

	// Verify file was written.
	data, err := os.ReadFile(filepath.Join(claudeDir, "CLAUDE.md"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	assertContains(t, string(data), blockStart)
}

func TestRunSetupAI_OpenCodeFlag(t *testing.T) {
	home := t.TempDir()
	opencodeDir := filepath.Join(home, ".config", "opencode")
	if err := os.MkdirAll(opencodeDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(opencodeDir, "AGENTS.md"), []byte("# Agents"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	var outBuf strings.Builder
	err := runSetupAIWithHome(home, false, true, false, &outBuf, &outBuf)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, outBuf.String(), "OpenCode")
}

func TestRunSetupAI_AllFlag(t *testing.T) {
	home := t.TempDir()

	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(claudeDir, "CLAUDE.md"), []byte("# Claude"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	opencodeDir := filepath.Join(home, ".config", "opencode")
	if err := os.MkdirAll(opencodeDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(opencodeDir, "AGENTS.md"), []byte("# Agents"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	var outBuf strings.Builder
	err := runSetupAIWithHome(home, false, false, true, &outBuf, &outBuf)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out := outBuf.String()
	assertContains(t, out, "Claude Code")
	assertContains(t, out, "OpenCode")
}

func TestRunSetupAI_NoFlags_AutoDetect(t *testing.T) {
	home := t.TempDir()

	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(claudeDir, "CLAUDE.md"), []byte("# Claude"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	opencodeDir := filepath.Join(home, ".config", "opencode")
	if err := os.MkdirAll(opencodeDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(opencodeDir, "AGENTS.md"), []byte("# Agents"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	var outBuf strings.Builder
	err := runSetupAIWithHome(home, false, false, false, &outBuf, &outBuf)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out := outBuf.String()
	assertContains(t, out, "Claude Code")
	assertContains(t, out, "OpenCode")
}

// TestRunSetupAI_AllFlag_ContinuesOnPartialFailure verifies that when --all is used
// and one target fails, the other target is still written. The command returns an
// error but does not abort after the first failure.
func TestRunSetupAI_AllFlag_ContinuesOnPartialFailure(t *testing.T) {
	home := t.TempDir()

	// Make ~/.claude a file so writing ~/.claude/CLAUDE.md fails.
	blockingFile := filepath.Join(home, ".claude")
	if err := os.WriteFile(blockingFile, []byte("not a dir"), 0o644); err != nil {
		t.Fatalf("setup blocking file: %v", err)
	}

	// Create a valid opencode dir so that target succeeds.
	opencodeDir := filepath.Join(home, ".config", "opencode")
	if err := os.MkdirAll(opencodeDir, 0o755); err != nil {
		t.Fatalf("mkdir opencode: %v", err)
	}

	var outBuf, errBuf strings.Builder
	err := runSetupAIWithHome(home, false, false, true, &outBuf, &errBuf)
	// Must return an error because Claude Code target failed.
	if err == nil {
		t.Fatal("expected combined error, got nil")
	}
	// The OpenCode target must still have been written.
	agentsPath := filepath.Join(opencodeDir, "AGENTS.md")
	data, readErr := os.ReadFile(agentsPath)
	if readErr != nil {
		t.Fatalf("AGENTS.md not created — --all did not continue after Claude failure: %v", readErr)
	}
	if !strings.Contains(string(data), blockStart) {
		t.Error("AGENTS.md does not contain the heydb block")
	}
	// Success message for OpenCode must appear in stdout.
	assertContains(t, outBuf.String(), "OpenCode")
}

func TestRunSetupAI_NoFlags_NoneDetected(t *testing.T) {
	home := t.TempDir()

	var outBuf, errBuf strings.Builder
	err := runSetupAIWithHome(home, false, false, false, &outBuf, &errBuf)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Must print a message to stderr when nothing is detected.
	assertContains(t, errBuf.String(), "No AI assistants detected")
	assertContains(t, errBuf.String(), "--claude")
	assertContains(t, errBuf.String(), "--opencode")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// contains checks if slice s contains element e.
func contains(s []string, e string) bool {
	for _, v := range s {
		if v == e {
			return true
		}
	}
	return false
}
