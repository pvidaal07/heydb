// Package mcp — registry manages the pool of open database connections.
// Each entry pairs a SchemaStore with an AnnotationStore for the same SQLite file.
package mcp

import (
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/pvidaal07/heydb/internal/domain/ports"
)

// ConnEntry holds the store interfaces for a single connection.
type ConnEntry struct {
	Schema        ports.SchemaStore
	Annotations   ports.AnnotationStore
	Relationships ports.RelationshipStore
}

// ConnectionInfo is the wire shape returned by heydb_list_connections.
type ConnectionInfo struct {
	Name   string `json:"name"`
	Active bool   `json:"is_active"`
	Synced bool   `json:"is_synced"`
}

// Registry maps connection names to open store pairs.
// All connections from config are tracked in allNames (sorted); only
// successfully opened ones appear in entries.
type Registry struct {
	entries    map[string]*ConnEntry
	allNames   []string
	activeConn string
}

// NewRegistry creates a Registry from pre-built entries, the full name list,
// and the active connection name.
// allNames MUST include every connection name regardless of sync status.
// entries MUST only include successfully opened connections.
func NewRegistry(entries map[string]*ConnEntry, allNames []string, activeConn string) *Registry {
	return &Registry{
		entries:    entries,
		allNames:   allNames,
		activeConn: activeConn,
	}
}

// Resolve looks up the ConnEntry for the given connection name.
// If name is empty, it defaults to the active connection.
// Returns (entry, resolvedName, error).
// Errors: unknown name → lists available names; known but unsynced → instructs to run sync.
func (r *Registry) Resolve(name string) (*ConnEntry, string, error) {
	if name == "" {
		name = r.activeConn
	}

	// Check if the name is in the known list at all.
	known := false
	for _, n := range r.allNames {
		if n == name {
			known = true
			break
		}
	}

	if !known {
		return nil, "", fmt.Errorf(
			"unknown connection %q — available: %s",
			name, r.availableNames(),
		)
	}

	entry, ok := r.entries[name]
	if !ok {
		return nil, "", fmt.Errorf(
			"connection %q not synced — run `heydb sync`",
			name,
		)
	}

	return entry, name, nil
}

// List returns a ConnectionInfo slice for every configured connection,
// sorted alphabetically by Name.
func (r *Registry) List() []ConnectionInfo {
	result := make([]ConnectionInfo, 0, len(r.allNames))
	for _, name := range r.allNames {
		_, synced := r.entries[name]
		result = append(result, ConnectionInfo{
			Name:   name,
			Active: name == r.activeConn,
			Synced: synced,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})
	return result
}

// CloseAll closes every open store that implements io.Closer.
// It collects all errors and returns a combined one if any occurred.
func (r *Registry) CloseAll() error {
	var errs []string
	for name, entry := range r.entries {
		if c, ok := entry.Schema.(io.Closer); ok {
			if err := c.Close(); err != nil {
				errs = append(errs, fmt.Sprintf("close %q schema: %v", name, err))
			}
		}
		if c, ok := entry.Annotations.(io.Closer); ok {
			if err := c.Close(); err != nil {
				errs = append(errs, fmt.Sprintf("close %q annotations: %v", name, err))
			}
		}
		if c, ok := entry.Relationships.(io.Closer); ok {
			if err := c.Close(); err != nil {
				errs = append(errs, fmt.Sprintf("close %q relationships: %v", name, err))
			}
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("CloseAll errors: %s", strings.Join(errs, "; "))
	}
	return nil
}

// availableNames returns a human-readable comma-separated list of all
// configured connection names, for use in error messages.
func (r *Registry) availableNames() string {
	sorted := make([]string, len(r.allNames))
	copy(sorted, r.allNames)
	sort.Strings(sorted)
	return strings.Join(sorted, ", ")
}
