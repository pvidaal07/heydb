package cli

import (
	"context"
	"database/sql"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	mysqlAdapter "github.com/pvidaal07/heydb/internal/adapters/mysql"
	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
)

var reviewCmd = &cobra.Command{
	Use:   "review",
	Short: "Check whether the live schema matches the stored schema (drift detection)",
	Long: `Computes the current schema hash from the active database and compares it
against the schema_hash stored in ~/.heydb/heydb.db.

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

	dbPath := GlobalDBPath()
	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		return fmt.Errorf("review: open global DB: %w", err)
	}
	defer gs.Close()

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("review: cannot determine working directory: %w", err)
	}

	connID, conn, name, _, err := resolveActiveGlobalConnection(gs, cwd)
	if err != nil {
		return fmt.Errorf("review: %w", err)
	}

	if Verbose {
		fmt.Fprintf(os.Stderr, "[debug] connection %q: host=%s port=%d database=%s\n",
			name, conn.Host, conn.Port, conn.Database)
	}

	// Read the stored schema hash from GlobalStore.
	storedHash, err := loadStoredHashV2(ctx, gs, connID)
	if err != nil {
		return fmt.Errorf("review: %w", err)
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

// loadStoredHashV2 reads the schema_hash for the given connection from the
// global database. Returns an error if no schema has been synced yet.
func loadStoredHashV2(ctx context.Context, gs *sqlite.GlobalStore, connID string) (string, error) {
	var hash string
	err := gs.DB().QueryRowContext(ctx,
		`SELECT schema_hash FROM schema_meta WHERE connection_id = ?`, connID,
	).Scan(&hash)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf(
			"no schema found for connection %q — run `heydb sync` first", connID)
	}
	if err != nil {
		return "", fmt.Errorf("review: read schema_hash: %w", err)
	}
	if hash == "" {
		return "", fmt.Errorf("review: stored schema_hash is empty — run `heydb sync` to regenerate it")
	}
	return hash, nil
}
