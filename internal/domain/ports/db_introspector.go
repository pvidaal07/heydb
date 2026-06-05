package ports

import (
	"context"

	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// MultiDBIntrospector is an optional interface that adapters MAY implement when
// the database engine supports listing all databases on the server.
// Use a type assertion to check:
//
//	if mdi, ok := introspector.(ports.MultiDBIntrospector); ok {
//	    dbs, err := mdi.ListDatabases(ctx)
//	}
type MultiDBIntrospector interface {
	// ListDatabases returns user-accessible databases, excluding system databases.
	ListDatabases(ctx context.Context) ([]string, error)
}

// DBIntrospector is the port that any database introspection adapter must implement.
// Implementations are responsible for their own connection lifecycle.
//
// Usage order: Connect → ListTables / GetTable / ComputeHash → Close.
type DBIntrospector interface {
	// Connect establishes and verifies the database connection.
	Connect(ctx context.Context) error

	// ListTables returns the names of all user-created tables in the target database.
	ListTables(ctx context.Context) ([]string, error)

	// GetTable returns the full schema definition for a single table.
	GetTable(ctx context.Context, name string) (schema.Table, error)

	// ComputeHash returns the canonical schema hash for the target database,
	// using the same algorithm as schema.ComputeHash so it can be compared
	// against the hash stored in heydb.md.
	ComputeHash(ctx context.Context) (string, error)

	// Close releases the underlying connection and any held resources.
	Close() error
}
