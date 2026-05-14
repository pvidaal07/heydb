package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	mysqlAdapter "github.com/pvidaal07/heydb/internal/adapters/mysql"
	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/config"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

var diffCmd = &cobra.Command{
	Use:   "diff",
	Short: "Show what changed in the schema since the last sync",
	Long: `Compares the stored schema (from last heydb sync) against the live database
and prints a human-readable diff grouped by table.

Exit codes:
  0  no changes detected
  1  changes detected`,
	RunE: runDiff,
}

func init() {
	rootCmd.AddCommand(diffCmd)
}

func runDiff(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("diff: cannot determine working directory: %w", err)
	}

	dir := filepath.Join(cwd, heydbDir)
	cfgPath := filepath.Join(dir, configFileName)

	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("diff: load config: %w", err)
	}

	_, conn, err := cfg.Active()
	if err != nil {
		return fmt.Errorf("diff: %w\n\nRun `heydb connect` to add a connection first.", err)
	}

	// Load stored schema from SQLite.
	sqlitePath := filepath.Join(dir, "heydb.sqlite")
	store, err := sqlite.Open(sqlitePath)
	if err != nil {
		return fmt.Errorf("diff: open sqlite store: %w\n\nRun `heydb sync` first.", err)
	}
	defer store.Close()

	storedSchema, err := store.LoadSchema(ctx)
	if err != nil {
		return fmt.Errorf("diff: load stored schema: %w\n\nRun `heydb sync` first.", err)
	}

	if Verbose {
		fmt.Fprintf(os.Stderr, "[debug] stored schema: %d tables, hash %s\n",
			len(storedSchema.Tables), storedSchema.Hash[:12]+"...")
	}

	// Introspect live DB.
	dsn := conn.DSN()
	introspector := mysqlAdapter.New(dsn)
	if err := introspector.Connect(ctx); err != nil {
		return fmt.Errorf("diff: connect to database: %w", err)
	}
	defer introspector.Close()

	fmt.Fprint(os.Stderr, "Introspecting live schema... ")
	tableNames, err := introspector.ListTables(ctx)
	if err != nil {
		return handleIntrospectionError(err)
	}
	fmt.Fprintf(os.Stderr, "%d tables\n", len(tableNames))

	liveTables := make([]schema.Table, 0, len(tableNames))
	for _, name := range tableNames {
		t, err := introspector.GetTable(ctx, name)
		if err != nil {
			return fmt.Errorf("diff: get table %q: %w", name, err)
		}
		liveTables = append(liveTables, t)
	}

	// Compare.
	entries := schema.Diff(storedSchema.Tables, liveTables)

	if len(entries) == 0 {
		fmt.Println("No changes detected")
		return nil
	}

	// Group by table for readable output.
	fmt.Printf("%d change(s) detected:\n\n", len(entries))
	currentTable := ""
	for _, e := range entries {
		if e.Table != currentTable {
			currentTable = e.Table
			fmt.Printf("  %s\n", currentTable)
		}
		symbol := symbolFor(e.Kind)
		fmt.Printf("    %s %s\n", symbol, e.Detail)
	}
	fmt.Println()
	fmt.Println("Run `heydb sync` to update heydb.md and heydb.sqlite")

	os.Exit(1)
	return nil
}

func symbolFor(kind schema.DiffKind) string {
	switch kind {
	case schema.DiffAdded:
		return "+"
	case schema.DiffRemoved:
		return "-"
	case schema.DiffModified:
		return "~"
	default:
		return "?"
	}
}
