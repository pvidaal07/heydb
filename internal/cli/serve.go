package cli

import (
	"fmt"
	"os"
	"path/filepath"

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
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("serve: cannot determine working directory: %w", err)
	}

	dir := filepath.Join(cwd, heydbDir)
	sqlitePath := filepath.Join(dir, "heydb.sqlite")

	// Verify the SQLite file exists before trying to open it.
	if _, err := os.Stat(sqlitePath); os.IsNotExist(err) {
		return fmt.Errorf(
			"serve: heydb.sqlite not found at %s\n\nRun `heydb sync` first to populate the schema store.",
			sqlitePath,
		)
	}

	if Verbose {
		fmt.Fprintf(os.Stderr, "[debug] opening heydb.sqlite: %s\n", sqlitePath)
	}

	// Open the SQLite store in read-only mode.
	store, err := sqlite.OpenReadOnly(sqlitePath)
	if err != nil {
		return fmt.Errorf("serve: open sqlite store: %w", err)
	}
	defer store.Close()

	// Start the MCP server (blocking — returns when stdin is closed).
	mcpSrv := heydbmcp.New(store)
	return mcpSrv.Serve()
}
