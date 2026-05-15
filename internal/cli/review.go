package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/markdown"
	mysqlAdapter "github.com/pvidaal07/heydb/internal/adapters/mysql"
)

var reviewCmd = &cobra.Command{
	Use:   "review",
	Short: "Check whether the live schema matches heydb.md (drift detection)",
	Long: `Computes the current schema hash from the active database and compares it
against the schema_hash stored in .heydb/heydb.md.

Exit codes:
  0  schema is up to date
  1  schema drift detected (run heydb sync to update)`,
	RunE: runReview,
}

func init() {
	rootCmd.AddCommand(reviewCmd)
}

func runReview(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	paths, _, conn, err := resolveActivePaths()
	if err != nil {
		return fmt.Errorf("review: %w", err)
	}

	if Verbose {
		fmt.Fprintf(os.Stderr, "[debug] connection %q: host=%s port=%d database=%s\n",
			paths.ConnName, conn.Host, conn.Port, conn.Database)
	}

	// Read the connection's markdown file and parse the stored hash.
	mdContent, err := os.ReadFile(paths.Markdown)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("review: %s not found — run `heydb sync` first", paths.Markdown)
		}
		return fmt.Errorf("review: read %s: %w", paths.Markdown, err)
	}

	parsed, err := markdown.Parse(string(mdContent))
	if err != nil {
		return fmt.Errorf("review: parse heydb.md: %w", err)
	}

	storedHash := parsed.SchemaHash
	if storedHash == "" {
		return fmt.Errorf("review: heydb.md has no schema_hash — run `heydb sync` to regenerate it")
	}

	if Verbose {
		fmt.Fprintf(os.Stderr, "[debug] stored schema_hash: %s\n", storedHash[:12]+"...")
	}

	// Connect to live DB and compute the current hash.
	dsn := conn.DSN()

	introspector := mysqlAdapter.New(dsn)
	if err := introspector.Connect(ctx); err != nil {
		return fmt.Errorf("review: connect to database: %w", err)
	}
	defer introspector.Close()

	if Verbose {
		fmt.Fprintln(os.Stderr, "[debug] connected to MySQL — computing live schema hash")
	}

	liveHash, err := introspector.ComputeHash(ctx)
	if err != nil {
		return handleIntrospectionError(err)
	}

	if Verbose {
		fmt.Fprintf(os.Stderr, "[debug] live schema_hash:   %s\n", liveHash[:12]+"...")
	}

	// Compare and report.
	if liveHash == storedHash {
		fmt.Println("Schema is up to date")
		return nil
	}

	// Drift detected — print to stdout and exit 1.
	fmt.Println("Schema has changed — run `heydb sync` to update")
	os.Exit(1)
	return nil // unreachable but satisfies the compiler
}
