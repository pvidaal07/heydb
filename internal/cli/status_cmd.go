package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show project info, connections, annotation and relationship counts",
	Long: `Displays a summary of the current heydb project:
  - Project name and path
  - All connections with host:port/db, active flag, and last sync time
  - Total annotation count, pending push count, total relationship count
  - Hint to run heydb review for schema drift detection

This command is offline — it does NOT attempt a MySQL connection.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("status: cannot determine working directory: %w", err)
		}

		dbPath := GlobalDBPath()
		gs, err := sqlite.OpenGlobal(dbPath)
		if err != nil {
			return fmt.Errorf("status: open global DB: %w", err)
		}
		defer gs.Close()

		ctx := context.Background()

		proj, err := gs.GetProjectByPath(ctx, cwd)
		if err != nil {
			return fmt.Errorf("status: lookup project: %w", err)
		}
		if proj == nil {
			return fmt.Errorf("status: no heydb project found for %q — run `heydb init` first", cwd)
		}

		return runStatus(ctx, gs, proj, os.Stdout)
	},
}

func init() {
	rootCmd.AddCommand(statusCmd)
}

// runStatus is the testable core: prints the project status to w.
func runStatus(ctx context.Context, gs *sqlite.GlobalStore, proj *schema.Project, w io.Writer) error {
	// Project header.
	fmt.Fprintf(w, "Project: %s\n", proj.Name)
	fmt.Fprintf(w, "Path:    %s\n", proj.RepoPath)
	fmt.Fprintln(w)

	// Connections table.
	conns, err := gs.ListConnections(ctx, proj.ID)
	if err != nil {
		return fmt.Errorf("status: list connections: %w", err)
	}

	fmt.Fprintln(w, "Connections:")
	if len(conns) == 0 {
		fmt.Fprintln(w, "  (none — run `heydb connect` to add one)")
	} else {
		for _, c := range conns {
			activeMarker := ""
			if c.Active {
				activeMarker = " (active)"
			}

			// Query synced_at from schema_meta for this connection.
			connID := proj.ID + "/" + c.Name
			syncedAt := lastSyncTime(ctx, gs, connID)

			syncStr := "never"
			if !syncedAt.IsZero() {
				syncStr = syncedAt.Format(time.RFC3339)
			}

			fmt.Fprintf(w, "  %-20s  %s:%d/%s%s  last sync: %s\n",
				c.Name, c.Host, c.Port, c.Database, activeMarker, syncStr)
		}
	}
	fmt.Fprintln(w)

	// Annotation counts across all connections.
	totalAnnotations := 0
	for _, c := range conns {
		anns, err := gs.GetAllAnnotations(ctx, proj.ID, c.Name)
		if err != nil {
			return fmt.Errorf("status: get annotations for %q: %w", c.Name, err)
		}
		totalAnnotations += len(anns)
	}

	// Pending push count: annotations since last exported chunk.
	since, err := gs.LatestExportedAt(ctx, proj.ID)
	if err != nil {
		return fmt.Errorf("status: latest exported at: %w", err)
	}
	pending, err := gs.GetAnnotationsSince(ctx, proj.ID, since)
	if err != nil {
		return fmt.Errorf("status: get annotations since: %w", err)
	}

	// Relationship counts across all connections.
	totalRels := 0
	for _, c := range conns {
		rels, err := gs.ListRelationships(ctx, proj.ID, c.Name)
		if err != nil {
			return fmt.Errorf("status: list relationships for %q: %w", c.Name, err)
		}
		totalRels += len(rels)
	}

	fmt.Fprintf(w, "Annotations:    %d total, %d pending push\n", totalAnnotations, len(pending))
	fmt.Fprintf(w, "Relationships:  %d\n", totalRels)
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Hint: run heydb review to check for schema drift")

	return nil
}

// lastSyncTime returns the synced_at timestamp from schema_meta for the given connID.
// Returns a zero time.Time if no row exists (never synced).
func lastSyncTime(ctx context.Context, gs *sqlite.GlobalStore, connID string) time.Time {
	var ts string
	err := gs.DB().QueryRowContext(ctx,
		`SELECT synced_at FROM schema_meta WHERE connection_id = ?`, connID,
	).Scan(&ts)
	if err != nil {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return time.Time{}
	}
	return t
}
