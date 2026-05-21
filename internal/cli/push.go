package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
	heydbsync "github.com/pvidaal07/heydb/internal/sync"
)

var pushCmd = &cobra.Command{
	Use:   "push",
	Short: "Export new annotations as a sync chunk",
	Long: `Reads annotations added since the last push, encodes them as a gzipped
JSONL chunk, writes the chunk to .heydb/chunks/, and updates .heydb/manifest.json.

Share the .heydb/ directory (committed to git) with teammates so they can
run 'heydb pull' to import the annotations.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("push: cannot determine working directory: %w", err)
		}
		dbPath := GlobalDBPath()
		heydbDir := filepath.Join(cwd, ".heydb")
		return runPush(dbPath, heydbDir)
	},
}

func init() {
	rootCmd.AddCommand(pushCmd)
}

// runPush is the testable core of the push command.
// globalDBPath is the path to heydb.db; heydbDir is the .heydb/ directory.
func runPush(globalDBPath, heydbDir string) error {
	ctx := context.Background()

	gs, err := sqlite.OpenGlobal(globalDBPath)
	if err != nil {
		return fmt.Errorf("push: open global DB: %w", err)
	}
	defer gs.Close()

	// Resolve project from heydbDir (used as the repo path during init).
	proj, err := gs.GetProjectByPath(ctx, heydbDir)
	if err != nil {
		return fmt.Errorf("push: lookup project: %w", err)
	}
	// Fallback: try directory containing heydbDir (cwd when heydbDir = cwd/.heydb).
	if proj == nil {
		parentDir := filepath.Dir(heydbDir)
		proj, err = gs.GetProjectByPath(ctx, parentDir)
		if err != nil {
			return fmt.Errorf("push: lookup project (parent): %w", err)
		}
	}
	if proj == nil {
		return fmt.Errorf("push: no heydb project found — run `heydb init` first")
	}

	// Determine since-time from last exported chunk.
	since, err := gs.LatestExportedAt(ctx, proj.ID)
	if err != nil {
		return fmt.Errorf("push: determine last export time: %w", err)
	}
	if since.IsZero() {
		since = time.Time{} // all annotations
	}

	// Get annotations since last push.
	annotations, err := gs.GetAnnotationsSince(ctx, proj.ID, since)
	if err != nil {
		return fmt.Errorf("push: get annotations: %w", err)
	}

	if len(annotations) == 0 {
		fmt.Println("Nothing to push.")
		return nil
	}

	// Convert to ChunkEntries.
	entries := annotationsToChunkEntries(annotations)

	// Encode chunk.
	data, filename, err := heydbsync.EncodeChunk(entries)
	if err != nil {
		return fmt.Errorf("push: encode chunk: %w", err)
	}

	// Ensure chunks/ directory exists.
	chunksDir := filepath.Join(heydbDir, "chunks")
	if err := os.MkdirAll(chunksDir, 0755); err != nil {
		return fmt.Errorf("push: create chunks dir: %w", err)
	}

	// Write chunk file.
	chunkPath := filepath.Join(chunksDir, filename)
	if err := os.WriteFile(chunkPath, data, 0644); err != nil {
		return fmt.Errorf("push: write chunk file: %w", err)
	}

	// Update manifest.
	manifest, err := heydbsync.ReadManifest(heydbDir)
	if err != nil {
		return fmt.Errorf("push: read manifest: %w", err)
	}
	if manifest.ProjectID == "" {
		manifest.ProjectID = proj.ID
	}
	manifest.AppendChunk(filename)
	if err := heydbsync.WriteManifest(heydbDir, manifest); err != nil {
		return fmt.Errorf("push: write manifest: %w", err)
	}

	// Record the export in GlobalStore.
	if err := gs.MarkChunkExported(ctx, filename, proj.ID); err != nil {
		return fmt.Errorf("push: mark chunk exported: %w", err)
	}

	fmt.Printf("Pushed %d annotation(s) in chunk %s\n", len(annotations), filename)
	return nil
}

// annotationsToChunkEntries converts schema.Annotation to ChunkEntry for serialization.
func annotationsToChunkEntries(annotations []schema.Annotation) []heydbsync.ChunkEntry {
	entries := make([]heydbsync.ChunkEntry, len(annotations))
	for i, ann := range annotations {
		entries[i] = heydbsync.ChunkEntry{
			ID:         ann.ID,
			Connection: ann.ConnectionName,
			TargetType: ann.TargetType,
			TargetName: ann.TargetName,
			Content:    ann.Content,
			Author:     ann.Author,
			CreatedAt:  ann.CreatedAt.UTC().Format(time.RFC3339),
			UpdatedAt:  ann.UpdatedAt.UTC().Format(time.RFC3339),
		}
	}
	return entries
}
