package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/markdown"
	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
)

var docsCmdStdout bool
var docsCmdConnection string

var docsCmd = &cobra.Command{
	Use:   "docs",
	Short: "Generate schema documentation as Markdown",
	Long: `Loads the schema and annotations for the active (or specified) connection
from the global store and generates a Markdown file at .heydb/{connection}.md.

Use --stdout to print to stdout instead of writing a file.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("docs: cannot determine working directory: %w", err)
		}
		dbPath := GlobalDBPath()
		heydbDir := filepath.Join(cwd, ".heydb")

		// Determine connection name.
		connName := docsCmdConnection
		if connName == "" {
			// Resolve active connection from GlobalStore.
			ctx := context.Background()
			gs, err := sqlite.OpenGlobal(dbPath)
			if err != nil {
				return fmt.Errorf("docs: open global DB: %w", err)
			}
			defer gs.Close()

			proj, err := gs.GetProjectByPath(ctx, cwd)
			if err != nil {
				return fmt.Errorf("docs: lookup project: %w", err)
			}
			if proj == nil {
				return fmt.Errorf("docs: no heydb project found — run `heydb init` first")
			}
			conns, err := gs.ListConnections(ctx, proj.ID)
			if err != nil {
				return fmt.Errorf("docs: list connections: %w", err)
			}
			for _, c := range conns {
				if c.Active {
					connName = c.Name
					break
				}
			}
			if connName == "" && len(conns) > 0 {
				connName = conns[0].Name
			}
			if connName == "" {
				return fmt.Errorf("docs: no connections configured — run `heydb connect` first")
			}
		}

		return runDocs(dbPath, heydbDir, connName, docsCmdStdout)
	},
}

func init() {
	docsCmd.Flags().BoolVar(&docsCmdStdout, "stdout", false, "print markdown to stdout instead of writing a file")
	docsCmd.Flags().StringVar(&docsCmdConnection, "connection", "", "connection name (default: active connection)")
	rootCmd.AddCommand(docsCmd)
}

// runDocs is the testable core of the docs command.
// globalDBPath: path to heydb.db
// heydbDir: path to .heydb/ directory (output destination)
// connName: name of the connection to document
// toStdout: if true, write markdown to stdout; otherwise write to .heydb/{connName}.md
func runDocs(globalDBPath, heydbDir, connName string, toStdout bool) error {
	ctx := context.Background()

	gs, err := sqlite.OpenGlobal(globalDBPath)
	if err != nil {
		return fmt.Errorf("docs: open global DB: %w", err)
	}
	defer gs.Close()

	// Resolve project from heydbDir's parent (same pattern as push/pull).
	proj, err := gs.GetProjectByPath(ctx, heydbDir)
	if err != nil {
		return fmt.Errorf("docs: lookup project: %w", err)
	}
	if proj == nil {
		// Try parent directory.
		parentDir := filepath.Dir(heydbDir)
		proj, err = gs.GetProjectByPath(ctx, parentDir)
		if err != nil {
			return fmt.Errorf("docs: lookup project (parent): %w", err)
		}
	}
	if proj == nil {
		return fmt.Errorf("docs: no heydb project found — run `heydb init` first")
	}

	// Load schema from ConnSchemaStore.
	connID := proj.ID + "/" + connName
	connStore := gs.ForConnection(connID)
	s, err := connStore.LoadSchema(ctx)
	if err != nil {
		// "no rows" means the connection has never been synced.
		if strings.Contains(err.Error(), "no rows") {
			return fmt.Errorf("docs: connection %q not synced — run `heydb sync` first", connName)
		}
		return fmt.Errorf("docs: load schema: %w", err)
	}
	if len(s.Tables) == 0 {
		return fmt.Errorf("docs: connection %q not synced — run `heydb sync` first", connName)
	}

	// Load annotations.
	annotations, err := gs.GetAllAnnotations(ctx, proj.ID, connName)
	if err != nil {
		return fmt.Errorf("docs: load annotations: %w", err)
	}

	// Generate markdown.
	opts := &markdown.WriteOptions{
		V2Annotations: annotations,
	}

	var buf strings.Builder
	if err := markdown.Write(&buf, s, opts); err != nil {
		return fmt.Errorf("docs: generate markdown: %w", err)
	}
	content := buf.String()

	if toStdout {
		_, err := fmt.Print(content)
		return err
	}

	// Write to .heydb/{connName}.md
	if err := os.MkdirAll(heydbDir, 0755); err != nil {
		return fmt.Errorf("docs: create .heydb dir: %w", err)
	}
	mdPath := filepath.Join(heydbDir, connName+".md")
	if err := os.WriteFile(mdPath, []byte(content), 0644); err != nil {
		return fmt.Errorf("docs: write markdown file: %w", err)
	}

	fmt.Printf("Generated docs for %s → %s\n", connName, mdPath)
	return nil
}
