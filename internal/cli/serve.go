package cli

import (
	"fmt"
	"os"
	"sort"

	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/config"
	heydbmcp "github.com/pvidaal07/heydb/internal/mcp"
)

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the MCP stdio server for all configured connections",
	Long: `Opens every synced .heydb/{connection}.sqlite and starts an MCP server on
stdio, exposing these tools to AI agents:

  heydb_list_connections  — list all configured database connections
  heydb_list_tables       — list all tables with column counts
  heydb_get_table         — get full table detail (columns, indexes, foreign keys)
  heydb_search            — search tables and columns by keyword
  heydb_annotate          — annotate a table with business context
  heydb_annotate_column   — annotate a specific column
  heydb_annotate_db       — annotate the database itself

All tools accept an optional "connection" parameter. When omitted, the active
connection is used. Run heydb sync first to populate the schema stores.`,
	RunE: runServe,
}

func init() {
	rootCmd.AddCommand(serveCmd)
}

// buildRegistry loads sqlite stores for all connections defined in cfg and
// returns a Registry. Connections whose sqlite file is missing or fails to
// open are skipped with a warning — they appear unsynced in list_connections.
// This function is extracted for testability.
func buildRegistry(heydbDirPath string, cfg *config.Config) (*heydbmcp.Registry, error) {
	entries := make(map[string]*heydbmcp.ConnEntry)

	// Collect ALL connection names (sorted for determinism).
	allNames := make([]string, 0, len(cfg.Connections))
	for name := range cfg.Connections {
		allNames = append(allNames, name)
	}
	sort.Strings(allNames)

	// Open sqlite store for each connection. Missing/broken stores are skipped.
	for _, name := range allNames {
		sqlitePath := fmt.Sprintf("%s/%s.sqlite", heydbDirPath, name)

		// Skip connections whose sqlite file has not been synced yet.
		if _, statErr := os.Stat(sqlitePath); os.IsNotExist(statErr) {
			if Verbose {
				fmt.Fprintf(os.Stderr, "[debug] connection %q: no sqlite file — run `heydb sync`\n", name)
			}
			continue
		}

		store, err := sqlite.Open(sqlitePath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[warn] connection %q: skipping — %v\n", name, err)
			continue
		}

		if Verbose {
			fmt.Fprintf(os.Stderr, "[debug] connection %q: opened %s\n", name, sqlitePath)
		}

		entries[name] = &heydbmcp.ConnEntry{Schema: store, Annotations: store}
	}

	return heydbmcp.NewRegistry(entries, allNames, cfg.ActiveConnection), nil
}

func runServe(cmd *cobra.Command, args []string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("serve: cannot determine working directory: %w", err)
	}

	dir := fmt.Sprintf("%s/%s", cwd, heydbDir)
	cfgPath := fmt.Sprintf("%s/%s", dir, configFileName)

	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("serve: %w", err)
	}

	if len(cfg.Connections) == 0 {
		return fmt.Errorf("serve: no connections configured\n\nRun `heydb connect` to add a connection first.")
	}

	registry, err := buildRegistry(dir, cfg)
	if err != nil {
		return fmt.Errorf("serve: %w", err)
	}
	defer registry.CloseAll()

	if Verbose {
		fmt.Fprintf(os.Stderr, "[debug] active connection: %q\n", cfg.ActiveConnection)
	}

	// Start the MCP server (blocking — returns when stdin is closed).
	mcpSrv := heydbmcp.New(registry)
	return mcpSrv.Serve()
}
