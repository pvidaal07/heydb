// Package sync implements push/pull sync primitives for heydb annotation chunks.
// Chunks are gzip-compressed JSONL files with content-hash filenames.
package sync

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
)

// ChunkEntry is a single annotation serialized for transport.
type ChunkEntry struct {
	ID         string `json:"id"`
	Connection string `json:"connection"`
	TargetType string `json:"target_type"`
	TargetName string `json:"target_name"`
	Content    string `json:"content"`
	Author     string `json:"author"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}

// EncodeChunk writes entries as gzipped JSONL to a byte buffer.
// Returns the bytes and a content-hash filename (first 16 hex chars of SHA-256 + ".jsonl.gz").
func EncodeChunk(entries []ChunkEntry) ([]byte, string, error) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)

	enc := json.NewEncoder(gz)
	for _, e := range entries {
		if err := enc.Encode(e); err != nil {
			return nil, "", fmt.Errorf("chunk: encode entry %q: %w", e.ID, err)
		}
	}

	if err := gz.Close(); err != nil {
		return nil, "", fmt.Errorf("chunk: close gzip writer: %w", err)
	}

	data := buf.Bytes()
	hash := sha256.Sum256(data)
	filename := fmt.Sprintf("%x.jsonl.gz", hash[:8]) // 16 hex chars = 8 bytes

	return data, filename, nil
}

// DecodeChunk reads gzipped JSONL bytes and returns the entries.
func DecodeChunk(data []byte) ([]ChunkEntry, error) {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("chunk: open gzip reader: %w", err)
	}
	defer gz.Close()

	var entries []ChunkEntry
	dec := json.NewDecoder(gz)
	for {
		var e ChunkEntry
		if err := dec.Decode(&e); err == io.EOF {
			break
		} else if err != nil {
			return nil, fmt.Errorf("chunk: decode entry: %w", err)
		}
		entries = append(entries, e)
	}

	return entries, nil
}
