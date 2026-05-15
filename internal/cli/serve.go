package cli

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	heydbmcp "github.com/pvidaal07/heydb/internal/mcp"
)

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the MCP stdio server backed by heydb.sqlite",
	Long: `Opens .heydb/heydb.sqlite (read-only) and starts an MCP server on stdio,
exposing three tools to AI agents:

  heydb_list_tables   — list all tables with column counts
  heydb_get_table     — get full schema detail for one table
  heydb_search        — substring search across table and column names

Run heydb sync first to populate heydb.sqlite.`,
	RunE: runServe,
}

func init() {
	rootCmd.AddCommand(serveCmd)
}

func runServe(cmd *cobra.Command, args []string) error {
	paths, _, _, err := resolveActivePaths()
	if err != nil {
		return fmt.Errorf("serve: %w", err)
	}

	// Verify the SQLite file exists before trying to open it.
	if _, err := os.Stat(paths.SQLite); os.IsNotExist(err) {
		return fmt.Errorf(
			"serve: %s not found\n\nRun `heydb sync` first to populate the schema store.",
			paths.SQLite,
		)
	}

	if Verbose {
		fmt.Fprintf(os.Stderr, "[debug] connection %q: opening %s\n", paths.ConnName, paths.SQLite)
	}

	// Open the SQLite store in read-write mode (annotations need write access).
	store, err := sqlite.Open(paths.SQLite)
	if err != nil {
		return fmt.Errorf("serve: open sqlite store: %w", err)
	}
	defer store.Close()

	// Start the MCP server (blocking — returns when stdin is closed).
	mcpSrv := heydbmcp.New(store, store)
	return mcpSrv.Serve()
}
