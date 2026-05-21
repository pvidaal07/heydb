package cli

import (
	"path/filepath"
	"strings"
	"testing"
)

// Ensure strings is used (avoid unused import if assertContains is removed).
var _ = strings.Contains

func TestGlobalDBPath_UsesHEYDB_HOME(t *testing.T) {
	customHome := t.TempDir()
	t.Setenv("HEYDB_HOME", customHome)

	got := GlobalDBPath()
	want := filepath.Join(customHome, "heydb.db")
	if got != want {
		t.Errorf("GlobalDBPath() = %q, want %q", got, want)
	}
}

func TestGlobalDBPath_FallsBackToHome(t *testing.T) {
	// Unset HEYDB_HOME so the function falls back to ~/.heydb/heydb.db.
	t.Setenv("HEYDB_HOME", "")

	got := GlobalDBPath()
	if !strings.HasSuffix(got, filepath.Join(".heydb", "heydb.db")) {
		t.Errorf("GlobalDBPath() = %q, expected suffix %q", got, filepath.Join(".heydb", "heydb.db"))
	}

	// Must be an absolute path.
	if !filepath.IsAbs(got) {
		t.Errorf("GlobalDBPath() = %q, expected absolute path", got)
	}
}

