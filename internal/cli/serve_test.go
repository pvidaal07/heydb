package cli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/pvidaal07/heydb/internal/config"
)

// TestBuildRegistry_MultipleConnections verifies that buildRegistry opens every
// sqlite file that exists in the heydb directory and adds it to the registry.
func TestBuildRegistry_MultipleConnections(t *testing.T) {
	dir := t.TempDir()

	// Create two sqlite files (minimal valid SQLite — just the header magic bytes).
	// sqlite.Open will succeed on empty files in practice; we use real empty files.
	for _, name := range []string{"prod", "staging"} {
		path := filepath.Join(dir, name+".sqlite")
		if err := os.WriteFile(path, []byte{}, 0o644); err != nil {
			t.Fatalf("create %s.sqlite: %v", name, err)
		}
	}

	cfg := &config.Config{
		Connections: map[string]config.Connection{
			"prod":    {},
			"staging": {},
		},
		ActiveConnection: "prod",
	}

	reg, err := buildRegistry(dir, cfg)
	if err != nil {
		t.Fatalf("buildRegistry returned error: %v", err)
	}
	defer reg.CloseAll()

	// Both connections should be listed.
	infos := reg.List()
	if len(infos) != 2 {
		t.Errorf("want 2 connections in list, got %d", len(infos))
	}

	// Active connection should be "prod".
	activeFound := false
	for _, info := range infos {
		if info.Name == "prod" && info.Active {
			activeFound = true
		}
	}
	if !activeFound {
		t.Error("prod should be marked active")
	}
}

// TestBuildRegistry_MissingSqliteSkipped verifies that connections whose sqlite
// file does not exist are still included in the list (as unsynced) but do not
// cause buildRegistry to return an error.
func TestBuildRegistry_MissingSqliteSkipped(t *testing.T) {
	dir := t.TempDir()

	// Only create "prod.sqlite" — "staging" has no file.
	prodPath := filepath.Join(dir, "prod.sqlite")
	if err := os.WriteFile(prodPath, []byte{}, 0o644); err != nil {
		t.Fatalf("create prod.sqlite: %v", err)
	}

	cfg := &config.Config{
		Connections: map[string]config.Connection{
			"prod":    {},
			"staging": {},
		},
		ActiveConnection: "prod",
	}

	reg, err := buildRegistry(dir, cfg)
	if err != nil {
		t.Fatalf("buildRegistry must not error on missing sqlite: %v", err)
	}
	defer reg.CloseAll()

	infos := reg.List()
	// Both connections are listed regardless of sync status.
	if len(infos) != 2 {
		t.Errorf("want 2 connections in list (one unsynced), got %d", len(infos))
	}

	// "staging" must be listed but unsynced.
	for _, info := range infos {
		if info.Name == "staging" && info.Synced {
			t.Error("staging has no sqlite file — should be unsynced")
		}
		if info.Name == "prod" && !info.Synced {
			t.Error("prod has a sqlite file — should be synced")
		}
	}
}

// TestBuildRegistry_ActiveConnection verifies that the active connection name
// from cfg is correctly forwarded to the registry.
func TestBuildRegistry_ActiveConnection(t *testing.T) {
	dir := t.TempDir()

	// Create both sqlite files.
	for _, name := range []string{"alpha", "beta"} {
		path := filepath.Join(dir, name+".sqlite")
		if err := os.WriteFile(path, []byte{}, 0o644); err != nil {
			t.Fatalf("create %s.sqlite: %v", name, err)
		}
	}

	cfg := &config.Config{
		Connections: map[string]config.Connection{
			"alpha": {},
			"beta":  {},
		},
		ActiveConnection: "beta",
	}

	reg, err := buildRegistry(dir, cfg)
	if err != nil {
		t.Fatalf("buildRegistry returned error: %v", err)
	}
	defer reg.CloseAll()

	for _, info := range reg.List() {
		switch info.Name {
		case "beta":
			if !info.Active {
				t.Error("beta should be active")
			}
		case "alpha":
			if info.Active {
				t.Error("alpha should not be active")
			}
		}
	}
}
