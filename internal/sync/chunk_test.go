package sync_test

import (
	"bytes"
	"testing"

	heydbsync "github.com/pvidaal07/heydb/internal/sync"
)

var sampleEntries = []heydbsync.ChunkEntry{
	{
		ID:             "uuid-1",
		Connection:     "local",
		TargetType:     "table",
		TargetName:     "users",
		Content:        "User accounts table",
		Author:         "alice",
		CreatedAt:      "2026-01-01T00:00:00Z",
		UpdatedAt:      "2026-01-01T00:00:00Z",
	},
	{
		ID:             "uuid-2",
		Connection:     "local",
		TargetType:     "column",
		TargetName:     "users.email",
		Content:        "User email address",
		Author:         "bob",
		CreatedAt:      "2026-01-02T00:00:00Z",
		UpdatedAt:      "2026-01-02T00:00:00Z",
	},
}

// TestEncodeChunk_RoundTrip encodes then decodes and verifies entries match.
func TestEncodeChunk_RoundTrip(t *testing.T) {
	data, filename, err := heydbsync.EncodeChunk(sampleEntries)
	if err != nil {
		t.Fatalf("EncodeChunk: %v", err)
	}
	if filename == "" {
		t.Fatal("expected non-empty filename")
	}
	if len(data) == 0 {
		t.Fatal("expected non-empty encoded data")
	}

	decoded, err := heydbsync.DecodeChunk(data)
	if err != nil {
		t.Fatalf("DecodeChunk: %v", err)
	}
	if len(decoded) != len(sampleEntries) {
		t.Fatalf("expected %d entries, got %d", len(sampleEntries), len(decoded))
	}
	for i, entry := range decoded {
		if entry.ID != sampleEntries[i].ID {
			t.Errorf("entry[%d].ID: got %q, want %q", i, entry.ID, sampleEntries[i].ID)
		}
		if entry.Content != sampleEntries[i].Content {
			t.Errorf("entry[%d].Content: got %q, want %q", i, entry.Content, sampleEntries[i].Content)
		}
		if entry.Author != sampleEntries[i].Author {
			t.Errorf("entry[%d].Author: got %q, want %q", i, entry.Author, sampleEntries[i].Author)
		}
	}
}

// TestEncodeChunk_DeterministicHash verifies same input produces same filename.
func TestEncodeChunk_DeterministicHash(t *testing.T) {
	_, filename1, err := heydbsync.EncodeChunk(sampleEntries)
	if err != nil {
		t.Fatalf("first EncodeChunk: %v", err)
	}
	_, filename2, err := heydbsync.EncodeChunk(sampleEntries)
	if err != nil {
		t.Fatalf("second EncodeChunk: %v", err)
	}
	if filename1 != filename2 {
		t.Errorf("expected deterministic filename, got %q and %q", filename1, filename2)
	}
}

// TestDecodeChunk_RejectsCorrupted verifies garbage bytes return an error.
func TestDecodeChunk_RejectsCorrupted(t *testing.T) {
	garbage := bytes.Repeat([]byte{0xFF, 0xFE, 0xAB}, 20)
	_, err := heydbsync.DecodeChunk(garbage)
	if err == nil {
		t.Error("expected error for corrupted data, got nil")
	}
}
