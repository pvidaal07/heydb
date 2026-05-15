package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

const (
	heydbDir        = ".heydb"
	configFileName  = "config.json"
	gitignoreFile   = ".gitignore"
	defaultConfig   = `{"connections":{},"active_connection":"","version":1}` + "\n"
	defaultGitignore = `# heydb — generated files
config.json
*.sqlite

# schema markdown files are intentionally tracked
!*.md
`
)

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialise .heydb/ in the current directory",
	Long: `Creates the .heydb/ directory with an empty config.json and a .gitignore
that excludes config.json and heydb.sqlite while tracking heydb.md.

Running init on an already-initialised directory is safe — existing files
are never overwritten.`,
	RunE: runInit,
}

func init() {
	rootCmd.AddCommand(initCmd)
}

func runInit(cmd *cobra.Command, args []string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("init: cannot determine working directory: %w", err)
	}

	dir := filepath.Join(cwd, heydbDir)

	// Check if already initialised.
	if _, err := os.Stat(dir); err == nil {
		fmt.Fprintln(os.Stderr, "warning: .heydb/ already exists — skipping init (no files were overwritten)")
		fmt.Println("Already initialised. Run `heydb connect` to add a database connection.")
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("init: stat %s: %w", dir, err)
	}

	// Create the directory.
	if err := os.Mkdir(dir, 0o755); err != nil {
		return fmt.Errorf("init: create %s: %w", dir, err)
	}

	// Write config.json.
	cfgPath := filepath.Join(dir, configFileName)
	if err := os.WriteFile(cfgPath, []byte(defaultConfig), 0o600); err != nil {
		return fmt.Errorf("init: write config.json: %w", err)
	}

	// Write .gitignore.
	giPath := filepath.Join(dir, gitignoreFile)
	if err := os.WriteFile(giPath, []byte(defaultGitignore), 0o644); err != nil {
		return fmt.Errorf("init: write .gitignore: %w", err)
	}

	fmt.Println("Initialised .heydb/ successfully.")
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Println("  heydb connect    — add a database connection")
	fmt.Println("  heydb sync       — introspect the database and generate heydb.md")
	fmt.Println("  heydb serve      — start the MCP server for AI agents")
	return nil
}
