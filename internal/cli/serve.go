package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	heydbmcp "github.com/pvidaal07/heydb/internal/mcp"
)

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the MCP stdio server for all configured connections",
	Long: `Opens every synced connection from ~/.heydb/heydb.db and starts an MCP
server on stdio, exposing these tools to AI agents:

  heydb_list_connections    — list all configured database connections
  heydb_list_tables         — list all tables with column counts
  heydb_get_table           — get full table detail (columns, indexes, FKs, annotations)
  heydb_search              — search across table/column names, annotations, and relationships
  heydb_annotate            — annotate a table with business context
  heydb_annotate_column     — annotate a specific column
  heydb_annotate_db         — annotate the database itself
  heydb_add_relationship    — document an implicit FK relationship between two tables
  heydb_delete_relationship — delete an implicit relationship by UUID
  heydb_list_relationships  — list all implicit relationships for the connection

All tools accept an optional "connection" parameter. When omitted, the active
connection is used. Run heydb sync first to populate the schema stores.`,
	RunE: runServe,
}

func init() {
	rootCmd.AddCommand(serveCmd)
}

// buildRegistryV2 loads schema stores for all connections in the project from
// GlobalStore and returns a Registry. Connections that have not been synced
// (no schema_meta row) are still listed — they appear as unsynced.
// This function is extracted for testability.
func buildRegistryV2(gs *sqlite.GlobalStore, projectID, activeConn string) (*heydbmcp.Registry, error) {
	ctx := context.Background()

	conns, err := gs.ListConnections(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("serve: list connections: %w", err)
	}

	entries := make(map[string]*heydbmcp.ConnEntry)
	allNames := make([]string, 0, len(conns))

	for _, c := range conns {
		allNames = append(allNames, c.Name)

		connID := projectID + "/" + c.Name
		connStore := gs.ForConnection(connID)

		// Check if this connection has been synced by probing schema_meta.
		if isSynced(ctx, gs, connID) {
			if Verbose {
				fmt.Fprintf(os.Stderr, "[debug] connection %q: schema available\n", c.Name)
			}
			// GlobalStore implements AnnotationStore and RelationshipStore — pass it for both.
			entries[c.Name] = &heydbmcp.ConnEntry{Schema: connStore, Annotations: gs, Relationships: gs}
		} else {
			if Verbose {
				fmt.Fprintf(os.Stderr, "[debug] connection %q: not synced — run `heydb sync`\n", c.Name)
			}
		}
	}

	return heydbmcp.NewRegistry(entries, allNames, activeConn), nil
}

// isSynced returns true if there is a schema_meta row for the given connID.
func isSynced(ctx context.Context, gs *sqlite.GlobalStore, connID string) bool {
	var count int
	_ = gs.DB().QueryRowContext(ctx,
		`SELECT COUNT(1) FROM schema_meta WHERE connection_id = ?`, connID,
	).Scan(&count)
	return count > 0
}

func runServe(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	dbPath := GlobalDBPath()
	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		return fmt.Errorf("serve: open global DB: %w", err)
	}
	defer gs.Close()

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("serve: cannot determine working directory: %w", err)
	}

	proj, err := gs.GetProjectByPath(ctx, cwd)
	if err != nil {
		return fmt.Errorf("serve: lookup project: %w", err)
	}
	if proj == nil {
		return fmt.Errorf("serve: no heydb project found for %q — run `heydb init` first", cwd)
	}

	// Find the active connection name.
	conns, err := gs.ListConnections(ctx, proj.ID)
	if err != nil {
		return fmt.Errorf("serve: list connections: %w", err)
	}
	if len(conns) == 0 {
		return fmt.Errorf("serve: no connections configured\n\nRun `heydb connect` to add a connection first.")
	}

	activeConn := ""
	for _, c := range conns {
		if c.Active {
			activeConn = c.Name
			break
		}
	}

	registry, err := buildRegistryV2(gs, proj.ID, activeConn)
	if err != nil {
		return fmt.Errorf("serve: %w", err)
	}
	defer registry.CloseAll()

	if Verbose {
		fmt.Fprintf(os.Stderr, "[debug] active connection: %q\n", activeConn)
	}

	// Read author from user_config for annotation authorship.
	author, _ := gs.GetConfig(ctx, "author")

	// Start the MCP server (blocking — returns when stdin is closed).
	mcpSrv := heydbmcp.NewWithMeta(registry, proj.ID, author)
	return mcpSrv.Serve()
}
