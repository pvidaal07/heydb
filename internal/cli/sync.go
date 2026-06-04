package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	mysqlAdapter "github.com/pvidaal07/heydb/internal/adapters/mysql"
	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
	"github.com/pvidaal07/heydb/internal/introspection"
)

var syncListFlag bool
var syncDeleteFlag string
var syncAllFlag bool

var syncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Introspect the active connection and update schema in the global DB",
	Long: `Connects to the active database, reads INFORMATION_SCHEMA, and writes
schema data to ~/.heydb/heydb.db (global database).

Schema is stored per-connection and can be queried by heydb serve and heydb tui.
Run heydb docs to generate Markdown documentation from the stored schema.

Flags:
  --list       List all connections with synced schema
  --delete X   Delete schema data for connection X`,
	RunE: runSync,
}

func init() {
	syncCmd.Flags().BoolVar(&syncListFlag, "list", false, "list connections with synced schema")
	syncCmd.Flags().StringVar(&syncDeleteFlag, "delete", "", "delete schema data for a connection")
	syncCmd.Flags().BoolVar(&syncAllFlag, "all", false, "sync all configured connections sequentially")
	rootCmd.AddCommand(syncCmd)
}

func runSync(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	dbPath := GlobalDBPath()
	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		return fmt.Errorf("sync: open global DB: %w", err)
	}
	defer gs.Close()

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("sync: cannot determine working directory: %w", err)
	}

	proj, err := gs.GetProjectByPath(ctx, cwd)
	if err != nil {
		return fmt.Errorf("sync: lookup project: %w", err)
	}
	if proj == nil {
		return fmt.Errorf("sync: no heydb project found for %q — run `heydb init` first", cwd)
	}

	if err := checkSyncAllMutualExclusivity(syncAllFlag, syncListFlag, syncDeleteFlag != ""); err != nil {
		return err
	}

	if syncListFlag {
		return listSyncedConnectionsV2(ctx, gs, proj.ID)
	}
	if syncDeleteFlag != "" {
		return deleteSyncedSchemaV2(ctx, gs, proj.ID, syncDeleteFlag)
	}
	if syncAllFlag {
		return runSyncAll(ctx, gs, proj.ID, cwd, func(ctx context.Context, gs *sqlite.GlobalStore, projectID, connName string) error {
			return runSyncV2Named(ctx, gs, projectID, cwd, connName)
		})
	}

	return runSyncV2(ctx, gs, proj.ID, cwd)
}

// runSyncV2 performs the full sync: introspects MySQL and writes schema to GlobalStore.
func runSyncV2(ctx context.Context, gs *sqlite.GlobalStore, projectID, cwd string) error {
	connID, conn, name, connSchemaStore, err := resolveActiveGlobalConnection(gs, cwd)
	if err != nil {
		return fmt.Errorf("sync: %w", err)
	}
	_ = connID // used inside resolveActiveGlobalConnection

	if Verbose {
		fmt.Fprintf(os.Stderr, "[debug] connection %q: host=%s port=%d database=%s\n",
			name, conn.Host, conn.Port, conn.Database)
	}

	dsn := conn.DSN()

	// Build MySQL introspector.
	introspector := mysqlAdapter.New(dsn)
	if err := introspector.Connect(ctx); err != nil {
		return handleIntrospectionError(err)
	}
	defer introspector.Close()

	if Verbose {
		fmt.Fprintln(os.Stderr, "[debug] connected to MySQL — starting introspection")
	}

	// Run sync use-case with no markdown writer (schema only, docs are generated separately).
	syncer := introspection.NewSyncer(introspector, connSchemaStore, nil, Verbose)
	result, err := syncer.Run(ctx, conn.Database)
	if err != nil {
		return handleIntrospectionError(err)
	}

	fmt.Printf("Synced %d table(s) from %s (connection: %s)\n", result.TablesCount, result.Database, name)
	fmt.Printf("  schema_hash: %s\n", result.Hash[:12]+"...")
	fmt.Printf("  stored in:   %s\n", GlobalDBPath())

	return nil
}

// runSyncV2Named performs the full sync for a specific named connection (used by --all).
func runSyncV2Named(ctx context.Context, gs *sqlite.GlobalStore, projectID, cwd, connName string) error {
	conn, err := gs.GetConnection(ctx, projectID, connName)
	if err != nil {
		return fmt.Errorf("sync: get connection %q: %w", connName, err)
	}
	if conn == nil {
		return fmt.Errorf("sync: connection %q not found", connName)
	}

	if Verbose {
		fmt.Fprintf(os.Stderr, "[debug] connection %q: host=%s port=%d database=%s\n",
			connName, conn.Host, conn.Port, conn.Database)
	}

	dsn := conn.DSN()
	connID := projectID + "/" + connName
	connSchemaStore := gs.ForConnection(connID)

	introspector := mysqlAdapter.New(dsn)
	if err := introspector.Connect(ctx); err != nil {
		return handleIntrospectionError(err)
	}
	defer introspector.Close()

	syncer := introspection.NewSyncer(introspector, connSchemaStore, nil, Verbose)
	result, err := syncer.Run(ctx, conn.Database)
	if err != nil {
		return handleIntrospectionError(err)
	}

	fmt.Printf("Synced %d table(s) from %s (connection: %s)\n", result.TablesCount, result.Database, connName)
	fmt.Printf("  schema_hash: %s\n", result.Hash[:12]+"...")
	fmt.Printf("  stored in:   %s\n", GlobalDBPath())
	return nil
}

// resolveActiveGlobalConnection opens GlobalStore, finds the project by cwd,
// and returns the active connection along with a scoped ConnSchemaStore.
// Returns: connID, connection, connectionName, connSchemaStore, error.
func resolveActiveGlobalConnection(gs *sqlite.GlobalStore, cwd string) (string, schema.Connection, string, *sqlite.ConnSchemaStore, error) {
	ctx := context.Background()

	proj, err := gs.GetProjectByPath(ctx, cwd)
	if err != nil {
		return "", schema.Connection{}, "", nil, fmt.Errorf("lookup project: %w", err)
	}
	if proj == nil {
		return "", schema.Connection{}, "", nil, fmt.Errorf("no heydb project found for %q — run `heydb init` first", cwd)
	}

	conns, err := gs.ListConnections(ctx, proj.ID)
	if err != nil {
		return "", schema.Connection{}, "", nil, fmt.Errorf("list connections: %w", err)
	}

	var active *schema.Connection
	for i := range conns {
		if conns[i].Active {
			active = &conns[i]
			break
		}
	}
	if active == nil {
		return "", schema.Connection{}, "", nil, fmt.Errorf(
			"no active connection — run `heydb connect --use <name>` to set one")
	}

	connID := proj.ID + "/" + active.Name
	connSchemaStore := gs.ForConnection(connID)
	return connID, *active, active.Name, connSchemaStore, nil
}

// listSyncedConnectionsV2 prints all connections for the project from GlobalStore.
func listSyncedConnectionsV2(ctx context.Context, gs *sqlite.GlobalStore, projectID string) error {
	conns, err := gs.ListConnections(ctx, projectID)
	if err != nil {
		return fmt.Errorf("sync: list connections: %w", err)
	}

	if len(conns) == 0 {
		fmt.Println("No connections configured. Run `heydb connect` to add one, then `heydb sync` to sync.")
		return nil
	}

	fmt.Println("Connections:")
	for _, c := range conns {
		active := ""
		if c.Active {
			active = " (active)"
		}
		fmt.Printf("  %-20s  %s:%d/%s%s\n", c.Name, c.Host, c.Port, c.Database, active)
	}
	return nil
}

// deleteSyncedSchemaV2 removes schema data for a connection from GlobalStore.
// It is idempotent — no error if there is no data for the connection.
func deleteSyncedSchemaV2(ctx context.Context, gs *sqlite.GlobalStore, projectID, connName string) error {
	connID := projectID + "/" + connName
	db := gs.DB()

	// Delete schema rows for this connection (cascade handles child tables).
	if _, err := db.ExecContext(ctx,
		`DELETE FROM schema_tables WHERE connection_id = ?`, connID); err != nil {
		return fmt.Errorf("sync: delete schema_tables for %q: %w", connName, err)
	}
	if _, err := db.ExecContext(ctx,
		`DELETE FROM schema_meta WHERE connection_id = ?`, connID); err != nil {
		return fmt.Errorf("sync: delete schema_meta for %q: %w", connName, err)
	}

	fmt.Printf("Schema data for connection %q removed from global DB.\n", connName)
	return nil
}

// checkSyncAllMutualExclusivity returns an error if --all is combined with --list or --delete.
func checkSyncAllMutualExclusivity(all, list, hasDelete bool) error {
	if all && (list || hasDelete) {
		return fmt.Errorf("sync: --all is mutually exclusive with --list and --delete")
	}
	return nil
}

// perConnSyncFn is a function type used to inject the per-connection sync logic
// in tests without requiring a real MySQL connection.
type perConnSyncFn func(ctx context.Context, gs *sqlite.GlobalStore, projectID, connName string) error

// runSyncAll syncs every connection for the project sequentially.
// It continues on error — all connections are attempted regardless of failures.
// Returns errors.Join of all per-connection errors; nil if all succeeded.
func runSyncAll(ctx context.Context, gs *sqlite.GlobalStore, projectID, cwd string, syncFn perConnSyncFn) error {
	conns, err := gs.ListConnections(ctx, projectID)
	if err != nil {
		return fmt.Errorf("sync --all: list connections: %w", err)
	}
	if len(conns) == 0 {
		fmt.Println("No connections configured. Run `heydb connect` to add one.")
		return nil
	}

	var errs []error
	for _, conn := range conns {
		connErr := syncFn(ctx, gs, projectID, conn.Name)
		if connErr != nil {
			fmt.Printf("  [FAIL] %s: %v\n", conn.Name, connErr)
			errs = append(errs, fmt.Errorf("%s: %w", conn.Name, connErr))
		} else {
			fmt.Printf("  [ OK ] %s\n", conn.Name)
		}
	}

	return errors.Join(errs...)
}

// handleIntrospectionError inspects errors from MySQL and returns actionable messages.
func handleIntrospectionError(err error) error {
	msg := err.Error()
	if strings.Contains(msg, "SELECT command denied") ||
		strings.Contains(msg, "Access denied") ||
		strings.Contains(msg, "access denied") {
		return fmt.Errorf(
			"sync: database access denied\n\n"+
				"The connected user lacks SELECT privileges on INFORMATION_SCHEMA.\n"+
				"Run `heydb create-user` to generate the SQL needed to create a read-only user.\n\n"+
				"Original error: %w", err)
	}
	return fmt.Errorf("sync: %w", err)
}
