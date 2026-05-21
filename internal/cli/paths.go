package cli

import (
	"os"
	"path/filepath"
)

// GlobalDBPath returns the absolute path to the global heydb SQLite database.
// It respects the HEYDB_HOME environment variable, falling back to ~/.heydb/heydb.db.
func GlobalDBPath() string {
	if h := os.Getenv("HEYDB_HOME"); h != "" {
		return filepath.Join(h, "heydb.db")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		// Extremely unlikely — fall back to current dir as last resort.
		return filepath.Join(".heydb", "heydb.db")
	}
	return filepath.Join(home, ".heydb", "heydb.db")
}
