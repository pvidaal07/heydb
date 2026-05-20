package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
