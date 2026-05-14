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
	"github.com/pvidaal07/heydb/internal/config"
	"github.com/pvidaal07/heydb/internal/domain/schema"
	"github.com/pvidaal07/heydb/internal/introspection"
)

var syncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Introspect the active connection and update heydb.md + heydb.sqlite",
	Long: `Connects to the active database, reads INFORMATION_SCHEMA, and writes:
  .heydb/heydb.md      — human-readable schema documentation
  .heydb/heydb.sqlite  — machine-queryable schema store for heydb serve

Any existing heydb:annotations blocks in heydb.md are preserved verbatim.`,
	RunE: runSync,
}

func init() {
	rootCmd.AddCommand(syncCmd)
}

func runSync(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("sync: cannot determine working directory: %w", err)
	}

	dir := filepath.Join(cwd, heydbDir)
	cfgPath := filepath.Join(dir, configFileName)

	// Load config.
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("sync: load config: %w", err)
	}

	_, conn, err := cfg.Active()
	if err != nil {
		return fmt.Errorf("sync: %w\n\nRun `heydb connect` to add a connection first.", err)
	}

	if Verbose {
		fmt.Fprintf(os.Stderr, "[debug] active connection: host=%s port=%d database=%s\n",
			conn.Host, conn.Port, conn.Database)
	}

	// Build DSN.
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?parseTime=true&timeout=10s&readTimeout=30s&writeTimeout=30s",
		conn.Username, conn.Password, conn.Host, conn.Port, conn.Database)

	// Extract annotations from an existing heydb.md (if any) to preserve them.
	var annotations map[string]string
	mdPath := filepath.Join(dir, "heydb.md")
	if existingContent, err := os.ReadFile(mdPath); err == nil {
		if parsed, err := markdown.Parse(string(existingContent)); err == nil {
			annotations = parsed.Annotations
			if Verbose && len(annotations) > 0 {
				fmt.Fprintf(os.Stderr, "[debug] preserved %d annotation block(s) from existing heydb.md\n",
					len(annotations))
			}
		}
	}

	// Open SQLite store.
	sqlitePath := filepath.Join(dir, "heydb.sqlite")
	store, err := sqlite.Open(sqlitePath)
	if err != nil {
		return fmt.Errorf("sync: open sqlite store: %w", err)
	}
	defer store.Close()

	// Build MySQL introspector.
	introspector := mysqlAdapter.New(dsn)
	if err := introspector.Connect(ctx); err != nil {
		return handleIntrospectionError(err)
	}
	defer introspector.Close()

	if Verbose {
		fmt.Fprintln(os.Stderr, "[debug] connected to MySQL — starting introspection")
	}

	// Open heydb.md for writing.
	mdFile, err := os.Create(mdPath)
	if err != nil {
		return fmt.Errorf("sync: create heydb.md: %w", err)
	}
	defer mdFile.Close()

	// Build markdown writer (satisfies introspection.SchemaWriter).
	var mdOpts *markdown.WriteOptions
	if len(annotations) > 0 {
		mdOpts = &markdown.WriteOptions{Annotations: annotations}
	}
	mdWriter := &markdownSchemaWriter{w: mdFile, opts: mdOpts}

	// Run sync use-case.
	syncer := introspection.NewSyncer(introspector, store, mdWriter, Verbose)
	result, err := syncer.Run(ctx, conn.Database)
	if err != nil {
		return handleIntrospectionError(err)
	}

	fmt.Printf("Synced %d table(s) from %s\n", result.TablesCount, result.Database)
	fmt.Printf("  heydb.md:     %s\n", mdPath)
	fmt.Printf("  heydb.sqlite: %s\n", sqlitePath)
	fmt.Printf("  schema_hash:  %s\n", result.Hash[:12]+"...")

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
