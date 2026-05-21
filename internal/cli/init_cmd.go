package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/google/uuid"
	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

const (
	heydbDir      = ".heydb"
	gitignoreFile = ".gitignore"

	// v2 gitignore: excludes only generated/sensitive files.
	// manifest.json and chunks/ are intentionally tracked in git.
	defaultGitignoreV2 = `# heydb — generated and sensitive files
*.sqlite
*.tmp
`
)

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialise .heydb/ in the current directory",
	Long: `Creates the .heydb/ directory with a manifest.json and a .gitignore.
Registers the project in the global heydb database (~/.heydb/heydb.db).
Prompts for author name on first run.

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

	dbPath := GlobalDBPath()

	// Ensure global DB directory exists.
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
		return fmt.Errorf("init: create global DB dir: %w", err)
	}

	// Resolve author — prompt if not set in global config.
	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		return fmt.Errorf("init: open global DB: %w", err)
	}
	defer gs.Close()

	ctx := context.Background()
	author, err := gs.GetConfig(ctx, "author")
	if err != nil {
		return fmt.Errorf("init: get author config: %w", err)
	}
	if author == "" {
		author, err = promptAuthor()
		if err != nil {
			return fmt.Errorf("init: prompt author: %w", err)
		}
		if err := gs.SetConfig(ctx, "author", author); err != nil {
			return fmt.Errorf("init: save author: %w", err)
		}
	}

	if err := runInitCore(cwd, dbPath, author); err != nil {
		return err
	}

	fmt.Println("Initialised .heydb/ successfully.")
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Println("  heydb connect    — add a database connection")
	fmt.Println("  heydb sync       — introspect the database schema")
	fmt.Println("  heydb serve      — start the MCP server for AI agents")

	// Non-fatal AI assistant detection hint.
	homeDir, err := os.UserHomeDir()
	if err == nil {
		printAIHint(homeDir, os.Stdout)
	}

	return nil
}

// runInitCore contains the testable logic for `heydb init`.
// It receives the project directory and the path to the global DB,
// so tests can supply isolated temp paths.
//
// author is passed in because the interactive prompt is handled
// by the Cobra command layer.
func runInitCore(projectDir, globalDBPath, author string) error {
	ctx := context.Background()

	// Open (or reuse) the global DB.
	if err := os.MkdirAll(filepath.Dir(globalDBPath), 0o700); err != nil {
		return fmt.Errorf("init: create global DB dir: %w", err)
	}

	gs, err := sqlite.OpenGlobal(globalDBPath)
	if err != nil {
		return fmt.Errorf("init: open global DB: %w", err)
	}
	defer gs.Close()

	// Create .heydb/ directory.
	dir := filepath.Join(projectDir, heydbDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("init: create %s: %w", dir, err)
	}

	// Register project in the global DB (idempotent — INSERT OR IGNORE).
	proj := schema.Project{
		ID:       uuid.New().String(),
		Name:     filepath.Base(projectDir),
		RepoPath: projectDir,
	}
	if err := gs.CreateProject(ctx, proj); err != nil {
		return fmt.Errorf("init: register project: %w", err)
	}

	// Reload project to get the real ID (the DB may have ignored our INSERT
	// if the project already existed — fetch the actual stored UUID).
	stored, err := gs.GetProjectByPath(ctx, projectDir)
	if err != nil {
		return fmt.Errorf("init: fetch project: %w", err)
	}
	if stored == nil {
		return fmt.Errorf("init: project not found after registration")
	}

	// Write manifest.json (skip if already exists — idempotent).
	manifestPath := filepath.Join(dir, "manifest.json")
	if _, statErr := os.Stat(manifestPath); errors.Is(statErr, os.ErrNotExist) {
		manifest := map[string]interface{}{
			"project_id": stored.ID,
			"chunks":     []interface{}{},
		}
		data, err := json.MarshalIndent(manifest, "", "  ")
		if err != nil {
			return fmt.Errorf("init: marshal manifest: %w", err)
		}
		if err := os.WriteFile(manifestPath, append(data, '\n'), 0o644); err != nil {
			return fmt.Errorf("init: write manifest.json: %w", err)
		}
	}

	// Write .gitignore (skip if already exists).
	giPath := filepath.Join(dir, gitignoreFile)
	if _, statErr := os.Stat(giPath); errors.Is(statErr, os.ErrNotExist) {
		if err := os.WriteFile(giPath, []byte(defaultGitignoreV2), 0o644); err != nil {
			return fmt.Errorf("init: write .gitignore: %w", err)
		}
	}

	return nil
}

// promptAuthor shows an interactive prompt for the author name and returns it.
func promptAuthor() (string, error) {
	var author string
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Your name").
				Description("Used as the author field in all annotations you create.").
				Placeholder("Alice Smith").
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return fmt.Errorf("author name is required")
					}
					return nil
				}).
				Value(&author),
		),
	)
	if err := form.Run(); err != nil {
		return "", fmt.Errorf("form cancelled: %w", err)
	}
	return strings.TrimSpace(author), nil
}

// printAIHint detects installed AI assistants and prints a hint suggesting
// the user run "heydb setup-ai" to inject schema context. If no assistants
// are detected, or if homeDir is empty, nothing is printed. Errors from
// detection are silently swallowed — the hint is non-fatal.
func printAIHint(homeDir string, out io.Writer) {
	targets := detectAssistants(homeDir)
	if len(targets) == 0 {
		return
	}

	names := make([]string, len(targets))
	for i, t := range targets {
		names[i] = t.Name
	}

	fmt.Fprintf(out, "\nDetected AI assistants: %s. Run 'heydb setup-ai' to configure them.\n",
		strings.Join(names, ", "))
}
