package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/markdown"
	mysqlAdapter "github.com/pvidaal07/heydb/internal/adapters/mysql"
	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
	"github.com/pvidaal07/heydb/internal/introspection"
)

var syncListFlag bool
var syncDeleteFlag string

var syncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Introspect the active connection and update schema files",
	Long: `Connects to the active database, reads INFORMATION_SCHEMA, and writes:
  .heydb/{connection}.md      — human-readable schema documentation
  .heydb/{connection}.sqlite  — machine-queryable schema store for heydb serve

Any existing heydb:annotations blocks are preserved verbatim.

Flags:
  --list       List all synced connections
  --delete X   Delete schema files for connection X`,
	RunE: runSync,
}

func init() {
	syncCmd.Flags().BoolVar(&syncListFlag, "list", false, "list synced connections")
	syncCmd.Flags().StringVar(&syncDeleteFlag, "delete", "", "delete schema files for a connection")
	rootCmd.AddCommand(syncCmd)
}

func runSync(cmd *cobra.Command, args []string) error {
	if syncListFlag {
		return runSyncList()
	}
	if syncDeleteFlag != "" {
		return runSyncDelete(syncDeleteFlag)
	}

	ctx := context.Background()

	paths, _, conn, err := resolveActivePaths()
	if err != nil {
		return fmt.Errorf("sync: %w", err)
	}

	if Verbose {
		fmt.Fprintf(os.Stderr, "[debug] connection %q: host=%s port=%d database=%s\n",
			paths.ConnName, conn.Host, conn.Port, conn.Database)
	}

	dsn := conn.DSN()

	// Open SQLite store.
	store, err := sqlite.Open(paths.SQLite)
	if err != nil {
		return fmt.Errorf("sync: open sqlite store: %w", err)
	}
	defer store.Close()

	// Collect annotations from both sources (SQLite wins on conflict since
	// it's the canonical store written by MCP agents).
	annotations := make(map[string]string)
	columnAnnotations := make(map[string]map[string]string)
	var dbAnnotation string

	// Source 1: existing markdown file.
	if existingContent, err := os.ReadFile(paths.Markdown); err == nil {
		if parsed, err := markdown.Parse(string(existingContent)); err == nil {
			for k, v := range parsed.Annotations {
				annotations[k] = v
			}
			for tbl, cols := range parsed.ColumnAnnotations {
				colMap := make(map[string]string)
				for col, ann := range cols {
					colMap[col] = ann
				}
				columnAnnotations[tbl] = colMap
			}
			dbAnnotation = parsed.DBAnnotation
		}
	}

	// Source 2: SQLite annotations (from MCP agents) — these take precedence.
	if sqliteAnns, err := store.GetAllAnnotations(ctx); err == nil {
		for k, v := range sqliteAnns {
			annotations[k] = v
		}
	}

	// Source 2b: SQLite column annotations — take precedence over markdown.
	if sqliteSchema, err := store.LoadSchema(ctx); err == nil {
		for _, t := range sqliteSchema.Tables {
			if colAnns, err := store.GetAllColumnAnnotations(ctx, t.Name); err == nil && len(colAnns) > 0 {
				if columnAnnotations[t.Name] == nil {
					columnAnnotations[t.Name] = make(map[string]string)
				}
				for col, ann := range colAnns {
					columnAnnotations[t.Name][col] = ann
				}
			}
		}
	}

	// Source 2c: SQLite DB annotation — takes precedence over markdown.
	if sqliteDBann, err := store.GetDBAnnotation(ctx); err == nil && sqliteDBann != "" {
		dbAnnotation = sqliteDBann
	}

	totalAnns := len(annotations)
	for _, cols := range columnAnnotations {
		totalAnns += len(cols)
	}
	if dbAnnotation != "" {
		totalAnns++
	}
	if Verbose && totalAnns > 0 {
		fmt.Fprintf(os.Stderr, "[debug] preserved %d annotation(s) from markdown + sqlite\n",
			totalAnns)
	}

	// Build MySQL introspector.
	introspector := mysqlAdapter.New(dsn)
	if err := introspector.Connect(ctx); err != nil {
		return handleIntrospectionError(err)
	}
	defer introspector.Close()

	if Verbose {
		fmt.Fprintln(os.Stderr, "[debug] connected to MySQL — starting introspection")
	}

	// Open markdown file for writing.
	mdFile, err := os.Create(paths.Markdown)
	if err != nil {
		return fmt.Errorf("sync: create %s: %w", paths.Markdown, err)
	}
	defer mdFile.Close()

	// Build markdown writer (satisfies introspection.SchemaWriter).
	mdOpts := &markdown.WriteOptions{
		Annotations:      annotations,
		ColumnAnnotations: columnAnnotations,
		DBAnnotation:     dbAnnotation,
	}
	mdWriter := &markdownSchemaWriter{w: mdFile, opts: mdOpts}

	// Run sync use-case.
	syncer := introspection.NewSyncer(introspector, store, mdWriter, Verbose)
	result, err := syncer.Run(ctx, conn.Database)
	if err != nil {
		return handleIntrospectionError(err)
	}

	// Persist annotations to SQLite so MCP agents can read them.
	for tableName, content := range annotations {
		if err := store.SaveAnnotation(ctx, tableName, content); err != nil {
			if Verbose {
				fmt.Fprintf(os.Stderr, "[debug] warning: failed to save annotation for %q: %v\n",
					tableName, err)
			}
		}
	}
	for tableName, cols := range columnAnnotations {
		for colName, content := range cols {
			if err := store.SaveColumnAnnotation(ctx, tableName, colName, content); err != nil {
				if Verbose {
					fmt.Fprintf(os.Stderr, "[debug] warning: failed to save column annotation for %q.%q: %v\n",
						tableName, colName, err)
				}
			}
		}
	}
	if dbAnnotation != "" {
		if err := store.SaveDBAnnotation(ctx, dbAnnotation); err != nil {
			if Verbose {
				fmt.Fprintf(os.Stderr, "[debug] warning: failed to save db annotation: %v\n", err)
			}
		}
	}

	fmt.Printf("Synced %d table(s) from %s (connection: %s)\n", result.TablesCount, result.Database, paths.ConnName)
	fmt.Printf("  schema:      %s\n", paths.Markdown)
	fmt.Printf("  store:       %s\n", paths.SQLite)
	fmt.Printf("  schema_hash: %s\n", result.Hash[:12]+"...")

	return nil
}

func runSyncList() error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("sync: %w", err)
	}
	dir := filepath.Join(cwd, heydbDir)

	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("sync: read .heydb/: %w", err)
	}

	found := false
	for _, e := range entries {
		name := e.Name()
		if filepath.Ext(name) == ".sqlite" {
			connName := strings.TrimSuffix(name, ".sqlite")
			mdExists := "no"
			if _, err := os.Stat(filepath.Join(dir, connName+".md")); err == nil {
				mdExists = "yes"
			}
			fmt.Printf("  %-20s  sqlite: yes  md: %s\n", connName, mdExists)
			found = true
		}
	}
	if !found {
		fmt.Println("No synced connections found. Run `heydb sync` to sync the active connection.")
	}
	return nil
}

func runSyncDelete(connName string) error {
	paths, err := resolvePathsForDir(connName)
	if err != nil {
		return fmt.Errorf("sync: %w", err)
	}

	removed := 0
	for _, p := range []string{paths.SQLite, paths.Markdown} {
		if err := os.Remove(p); err == nil {
			fmt.Printf("  removed %s\n", p)
			removed++
		}
	}
	if removed == 0 {
		return fmt.Errorf("sync: no schema files found for connection %q", connName)
	}
	return nil
}

// markdownSchemaWriter adapts markdown.Write to the introspection.SchemaWriter interface.
type markdownSchemaWriter struct {
	w    *os.File
	opts *markdown.WriteOptions
}

func (m *markdownSchemaWriter) WriteSchema(s schema.Schema) error {
	return markdown.Write(m.w, s, m.opts)
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
