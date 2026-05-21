package ports

import (
	"context"

	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// ConnectionStore is the port for persisting and querying database connections.
// All connections are stored in the global DB, not in per-project config files.
type ConnectionStore interface {
	SaveConnection(ctx context.Context, projectID string, conn schema.Connection) error
	GetConnection(ctx context.Context, projectID, name string) (*schema.Connection, error)
	ListConnections(ctx context.Context, projectID string) ([]schema.Connection, error)
	SetActive(ctx context.Context, projectID, name string) error
	DeleteConnection(ctx context.Context, projectID, name string) error
}
