package ports

import (
	"context"

	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// SchemaStore is the port for persisting and querying the captured schema.
// The primary implementation is the SQLite adapter.
type SchemaStore interface {
	// SaveSchema persists the full schema, replacing all existing rows.
	SaveSchema(ctx context.Context, s schema.Schema) error

	// LoadSchema returns the last saved schema in full.
	LoadSchema(ctx context.Context) (schema.Schema, error)

	// GetTable returns a single table by exact name, or an error if not found.
	GetTable(ctx context.Context, name string) (schema.Table, error)

	// SearchTables performs a case-insensitive substring search across
	// table names, column names, comment fields, annotation content, and
	// implicit relationship table/column names.
	// projectID and connectionName scope the annotation and relationship
	// queries; pass empty strings if not available (e.g. from CLI or TUI).
	// Returns an empty (non-nil) slice when there are no matches.
	SearchTables(ctx context.Context, query, projectID, connectionName string) ([]schema.Table, error)

	// Close releases the underlying database connection.
	Close() error
}
