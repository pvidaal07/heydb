package sync

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Manifest tracks which chunks have been produced for a project.
// manifest.json lives inside the .heydb/ directory and is committed to git.
type Manifest struct {
	ProjectID string   `json:"project_id"`
	Chunks    []string `json:"chunks"`
}

const manifestFile = "manifest.json"

// ReadManifest reads .heydb/manifest.json from dir.
// Returns an empty Manifest (zero value) if the file does not exist.
func ReadManifest(dir string) (Manifest, error) {
	path := filepath.Join(dir, manifestFile)
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Manifest{}, nil
		}
		return Manifest{}, fmt.Errorf("manifest: read %q: %w", path, err)
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return Manifest{}, fmt.Errorf("manifest: parse %q: %w", path, err)
	}
	return m, nil
}

// WriteManifest writes the manifest atomically (write to .tmp, then rename).
func WriteManifest(dir string, m Manifest) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return fmt.Errorf("manifest: marshal: %w", err)
	}

	path := filepath.Join(dir, manifestFile)
	tmp := path + ".tmp"

	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return fmt.Errorf("manifest: write tmp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("manifest: rename tmp: %w", err)
	}
	return nil
}

// AppendChunk adds filename to the manifest's Chunks list if not already present.
func (m *Manifest) AppendChunk(filename string) {
	for _, c := range m.Chunks {
		if c == filename {
			return
		}
	}
	m.Chunks = append(m.Chunks, filename)
}
