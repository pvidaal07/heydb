package cli

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/ports"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// ── heydb tables ─────────────────────────────────────────────────────────────

var tablesCmd = &cobra.Command{
	Use:   "tables",
	Short: "List all tables in the stored schema",
	RunE:  runTables,
}

func init() {
	rootCmd.AddCommand(tablesCmd)
	rootCmd.AddCommand(describeCmd)
	rootCmd.AddCommand(searchCmd)
}

func runTables(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	gs, closeGS, err := openGlobalStoreForCWD()
	if err != nil {
		return err
	}
	defer closeGS()

	cwd, _ := cwdOrEmpty()
	store, cleanup, err := openGlobalSchemaStore(gs, cwd)
	if err != nil {
		return err
	}
	defer cleanup()

	sc, err := store.LoadSchema(ctx)
	if err != nil {
		return fmt.Errorf("tables: %w\n\nRun `heydb sync` first.", err)
	}

	if len(sc.Tables) == 0 {
		fmt.Println("No tables found — run `heydb sync` first")
		return nil
	}

	// Find max name length for alignment.
	maxLen := 0
	for _, t := range sc.Tables {
		if len(t.Name) > maxLen {
			maxLen = len(t.Name)
		}
	}

	for _, t := range sc.Tables {
		comment := ""
		if t.Comment != "" {
			comment = "  " + t.Comment
		}
		fmt.Printf("  %-*s  %2d cols%s\n", maxLen, t.Name, len(t.Columns), comment)
	}
	return nil
}

// ── heydb describe <table> ───────────────────────────────────────────────────

var describeCmd = &cobra.Command{
	Use:   "describe <table>",
	Short: "Show full details for a table (columns, indexes, foreign keys)",
	Args:  cobra.ExactArgs(1),
	RunE:  runDescribe,
}

func runDescribe(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	gs, closeGS, err := openGlobalStoreForCWD()
	if err != nil {
		return err
	}
	defer closeGS()

	cwd, _ := cwdOrEmpty()
	store, cleanup, err := openGlobalSchemaStore(gs, cwd)
	if err != nil {
		return err
	}
	defer cleanup()

	t, err := store.GetTable(ctx, args[0])
	if err != nil {
		names, listErr := allTableNamesV2(store, ctx)
		if listErr != nil {
			return fmt.Errorf("describe: table %q not found", args[0])
		}
		return fmt.Errorf("describe: table %q not found\n\nAvailable tables: %s", args[0], strings.Join(names, ", "))
	}

	// Annotations are now in GlobalStore — CLI describe does not load them yet
	// (full integration deferred to PR-5 docs command).
	printTable(t, "")
	return nil
}

func printTable(t schema.Table, annotation string) {
	fmt.Printf("Table: %s\n", t.Name)
	if t.Comment != "" {
		fmt.Printf("Comment: %s\n", t.Comment)
	}
	if t.Engine != "" {
		fmt.Printf("Engine: %s\n", t.Engine)
	}
	if annotation != "" {
		fmt.Printf("Annotation: %s\n", annotation)
	}
	if len(t.PrimaryKey) > 0 {
		fmt.Printf("Primary Key: %s\n", strings.Join(t.PrimaryKey, ", "))
	}

	// Columns.
	fmt.Printf("\nColumns (%d):\n", len(t.Columns))
	maxName := 0
	maxType := 0
	for _, c := range t.Columns {
		if len(c.Name) > maxName {
			maxName = len(c.Name)
		}
		if len(c.Type) > maxType {
			maxType = len(c.Type)
		}
	}
	for _, c := range t.Columns {
		null := "NOT NULL"
		if c.Nullable {
			null = "NULL"
		}
		extra := ""
		if c.Extra != "" {
			extra = "  " + c.Extra
		}
		comment := ""
		if c.Comment != "" {
			comment = "  -- " + c.Comment
		}
		fmt.Printf("  %-*s  %-*s  %-8s%s%s\n", maxName, c.Name, maxType, c.Type, null, extra, comment)
	}

	// Indexes.
	if len(t.Indexes) > 0 {
		fmt.Printf("\nIndexes (%d):\n", len(t.Indexes))
		for _, idx := range t.Indexes {
			unique := ""
			if idx.Unique {
				unique = " UNIQUE"
			}
			fmt.Printf("  %s%s (%s)\n", idx.Name, unique, strings.Join(idx.Columns, ", "))
		}
	}

	// Foreign Keys.
	if len(t.ForeignKeys) > 0 {
		fmt.Printf("\nForeign Keys (%d):\n", len(t.ForeignKeys))
		for _, fk := range t.ForeignKeys {
			fmt.Printf("  %s: %s → %s.%s\n", fk.Name, fk.Column, fk.ReferencedTable, fk.ReferencedColumn)
		}
	}
}

// ── heydb search <query> ────────────────────────────────────────────────────

var searchCmd = &cobra.Command{
	Use:   "search <query>",
	Short: "Search tables and columns by keyword",
	Args:  cobra.ExactArgs(1),
	RunE:  runSearch,
}

func runSearch(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	gs, closeGS, err := openGlobalStoreForCWD()
	if err != nil {
		return err
	}
	defer closeGS()

	cwd, _ := cwdOrEmpty()
	store, cleanup, err := openGlobalSchemaStore(gs, cwd)
	if err != nil {
		return err
	}
	defer cleanup()

	// Pass empty strings for projectID and connectionName — the CLI search
	// path does not have these available. Annotation/relationship search
	// is only available via the MCP server.
	tables, err := store.SearchTables(ctx, args[0], "", "")
	if err != nil {
		return fmt.Errorf("search: %w", err)
	}

	if len(tables) == 0 {
		fmt.Printf("No results for %q\n", args[0])
		return nil
	}

	query := strings.ToLower(args[0])
	for _, t := range tables {
		fmt.Printf("  %s (%d cols)\n", t.Name, len(t.Columns))
		for _, c := range t.Columns {
			if strings.Contains(strings.ToLower(c.Name), query) ||
				strings.Contains(strings.ToLower(c.Comment), query) {
				fmt.Printf("    → %s  %s\n", c.Name, c.Type)
			}
		}
	}
	return nil
}

// ── helpers ──────────────────────────────────────────────────────────────────

// openGlobalStoreForCWD opens the GlobalStore for the current working directory.
func openGlobalStoreForCWD() (*sqlite.GlobalStore, func(), error) {
	dbPath := GlobalDBPath()
	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		return nil, nil, fmt.Errorf("open global DB: %w", err)
	}
	return gs, func() { gs.Close() }, nil
}

// cwdOrEmpty returns the current working directory or empty string on error.
func cwdOrEmpty() (string, error) {
	return os.Getwd()
}

// openGlobalSchemaStore resolves the active connection for the given project
// directory and returns a ConnSchemaStore. The caller must call cleanup().
func openGlobalSchemaStore(gs *sqlite.GlobalStore, cwd string) (ports.SchemaStore, func(), error) {
	_, _, _, connStore, err := resolveActiveGlobalConnection(gs, cwd)
	if err != nil {
		return nil, nil, fmt.Errorf("open schema store: %w\n\nRun `heydb sync` first.", err)
	}
	return connStore, func() {}, nil
}

func allTableNamesV2(store ports.SchemaStore, ctx context.Context) ([]string, error) {
	sc, err := store.LoadSchema(ctx)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(sc.Tables))
	for _, t := range sc.Tables {
		names = append(names, t.Name)
	}
	return names, nil
}
