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

var pullCmd = &cobra.Command{
	Use:   "pull",
	Short: "Import annotation chunks from .heydb/",
	Long: `Reads .heydb/manifest.json, finds unprocessed chunks, and imports
the annotations into the local global database.

Already-imported chunks are skipped. Annotations are deduplicated by UUID,
so running pull multiple times is safe.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("pull: cannot determine working directory: %w", err)
		}
		dbPath := GlobalDBPath()
		heydbDir := filepath.Join(cwd, ".heydb")
		return runPull(dbPath, heydbDir)
	},
}

func init() {
	rootCmd.AddCommand(pullCmd)
}

// runPull is the testable core of the pull command.
// globalDBPath is the path to heydb.db; heydbDir is the .heydb/ directory.
func runPull(globalDBPath, heydbDir string) error {
	ctx := context.Background()

	gs, err := sqlite.OpenGlobal(globalDBPath)
	if err != nil {
		return fmt.Errorf("pull: open global DB: %w", err)
	}
	defer gs.Close()

	// Resolve project from heydbDir or its parent.
	proj, err := gs.GetProjectByPath(ctx, heydbDir)
	if err != nil {
		return fmt.Errorf("pull: lookup project: %w", err)
	}
	if proj == nil {
		parentDir := filepath.Dir(heydbDir)
		proj, err = gs.GetProjectByPath(ctx, parentDir)
		if err != nil {
			return fmt.Errorf("pull: lookup project (parent): %w", err)
		}
	}
	if proj == nil {
		return fmt.Errorf("pull: no heydb project found — run `heydb init` first")
	}

	manifest, err := heydbsync.ReadManifest(heydbDir)
	if err != nil {
		return fmt.Errorf("pull: read manifest: %w", err)
	}
	if len(manifest.Chunks) == 0 {
		fmt.Println("Already up to date.")
		return nil
	}

	imported := 0
	total := 0

	for _, chunkFile := range manifest.Chunks {
		alreadyImported, err := gs.IsChunkImported(ctx, chunkFile)
		if err != nil {
			return fmt.Errorf("pull: check chunk %q: %w", chunkFile, err)
		}
		if alreadyImported {
			continue
		}

		chunkPath := filepath.Join(heydbDir, "chunks", chunkFile)
		data, err := os.ReadFile(chunkPath)
		if err != nil {
			return fmt.Errorf("pull: read chunk %q: %w", chunkFile, err)
		}

		entries, err := heydbsync.DecodeChunk(data)
		if err != nil {
			return fmt.Errorf("pull: decode chunk %q: %w", chunkFile, err)
		}

		annotations := chunkEntriesToAnnotations(entries, proj.ID)
		if err := gs.ImportAnnotations(ctx, annotations); err != nil {
			return fmt.Errorf("pull: import annotations from %q: %w", chunkFile, err)
		}

		if err := gs.MarkChunkImported(ctx, chunkFile, proj.ID); err != nil {
			return fmt.Errorf("pull: mark chunk imported %q: %w", chunkFile, err)
		}

		imported++
		total += len(annotations)
	}

	if imported == 0 {
		fmt.Println("Already up to date.")
	} else {
		fmt.Printf("Pulled %d chunk(s), imported %d annotation(s)\n", imported, total)
	}
	return nil
}

// chunkEntriesToAnnotations converts ChunkEntries to schema.Annotation for import.
func chunkEntriesToAnnotations(entries []heydbsync.ChunkEntry, projectID string) []schema.Annotation {
	annotations := make([]schema.Annotation, len(entries))
	for i, e := range entries {
		var createdAt, updatedAt time.Time
		if t, err := time.Parse(time.RFC3339, e.CreatedAt); err == nil {
			createdAt = t
		}
		if t, err := time.Parse(time.RFC3339, e.UpdatedAt); err == nil {
			updatedAt = t
		}
		annotations[i] = schema.Annotation{
			ID:             e.ID,
			ProjectID:      projectID,
			ConnectionName: e.Connection,
			TargetType:     e.TargetType,
			TargetName:     e.TargetName,
			Content:        e.Content,
			Author:         e.Author,
			CreatedAt:      createdAt,
			UpdatedAt:      updatedAt,
		}
	}
	return annotations
}
