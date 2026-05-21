package sync_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	heydbsync "github.com/pvidaal07/heydb/internal/sync"
)

// TestManifest_ReadEmpty verifies ReadManifest returns zero Manifest when file doesn't exist.
func TestManifest_ReadEmpty(t *testing.T) {
	dir := t.TempDir()
	m, err := heydbsync.ReadManifest(dir)
	if err != nil {
		t.Fatalf("ReadManifest on missing file: %v", err)
	}
	if m.ProjectID != "" {
		t.Errorf("expected empty ProjectID, got %q", m.ProjectID)
	}
	if len(m.Chunks) != 0 {
		t.Errorf("expected 0 chunks, got %d", len(m.Chunks))
	}
}

// TestManifest_ReadExisting verifies ReadManifest reads valid JSON correctly.
func TestManifest_ReadExisting(t *testing.T) {
	dir := t.TempDir()
	manifest := heydbsync.Manifest{
		ProjectID: "proj-1",
		Chunks:    []string{"abc.jsonl.gz", "def.jsonl.gz"},
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), data, 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	got, err := heydbsync.ReadManifest(dir)
	if err != nil {
		t.Fatalf("ReadManifest: %v", err)
	}
	if got.ProjectID != "proj-1" {
		t.Errorf("ProjectID: got %q, want %q", got.ProjectID, "proj-1")
	}
	if len(got.Chunks) != 2 {
		t.Errorf("Chunks: got %d, want 2", len(got.Chunks))
	}
}

// TestManifest_AppendChunkRef verifies AppendChunk adds new entries and deduplicates.
func TestManifest_AppendChunkRef(t *testing.T) {
	m := heydbsync.Manifest{ProjectID: "proj-1", Chunks: []string{"a.jsonl.gz"}}

	// Append a new chunk.
	m.AppendChunk("b.jsonl.gz")
	if len(m.Chunks) != 2 {
		t.Errorf("expected 2 chunks after append, got %d", len(m.Chunks))
	}

	// Append a duplicate — should be deduplicated.
	m.AppendChunk("a.jsonl.gz")
	if len(m.Chunks) != 2 {
		t.Errorf("expected 2 chunks after dedup append, got %d", len(m.Chunks))
	}
}

// TestWriteManifest_Atomic verifies WriteManifest writes valid JSON that can be read back.
func TestWriteManifest_Atomic(t *testing.T) {
	dir := t.TempDir()
	m := heydbsync.Manifest{
		ProjectID: "proj-atomic",
		Chunks:    []string{"chunk1.jsonl.gz", "chunk2.jsonl.gz"},
	}

	if err := heydbsync.WriteManifest(dir, m); err != nil {
		t.Fatalf("WriteManifest: %v", err)
	}

	// Verify file exists.
	if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err != nil {
		t.Fatalf("manifest.json not created: %v", err)
	}

	// Read back and verify contents.
	got, err := heydbsync.ReadManifest(dir)
	if err != nil {
		t.Fatalf("ReadManifest after write: %v", err)
	}
	if got.ProjectID != m.ProjectID {
		t.Errorf("ProjectID: got %q, want %q", got.ProjectID, m.ProjectID)
	}
	if len(got.Chunks) != len(m.Chunks) {
		t.Errorf("Chunks len: got %d, want %d", len(got.Chunks), len(m.Chunks))
	}
}
