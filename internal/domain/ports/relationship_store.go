package ports

import (
	"context"

	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// RelationshipStore is the port for persisting and querying user-defined
// implicit relationships between tables. GlobalStore implements this port.
// Implicit relationships are not enforced by the database engine — they are
// business knowledge documented by users.
type RelationshipStore interface {
	// AddRelationship inserts a new implicit relationship row. If rel.ID is
	// empty, a UUID v4 is generated. Author must be non-empty. Duplicate
	// from_table/from_column/to_table/to_column tuples per connection are
	// rejected.
	AddRelationship(ctx context.Context, rel schema.ImplicitRelationship) (schema.ImplicitRelationship, error)

	// DeleteRelationship removes the implicit relationship with the given UUID.
	// Returns an error if the UUID does not exist.
	DeleteRelationship(ctx context.Context, id string) error

	// ListRelationships returns all implicit relationships for the given
	// project and connection, ordered by created_at.
	ListRelationships(ctx context.Context, projectID, connectionName string) ([]schema.ImplicitRelationship, error)

	// GetRelationshipsByTable returns all implicit relationships where tableName
	// appears as either from_table OR to_table (bidirectional read).
	GetRelationshipsByTable(ctx context.Context, projectID, connectionName, tableName string) ([]schema.ImplicitRelationship, error)
}
