package ports

import (
	"context"

	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// ProjectStore is the port for persisting and querying heydb projects.
// A project corresponds to a repository root that has been initialised
// with `heydb init`.
type ProjectStore interface {
	CreateProject(ctx context.Context, project schema.Project) error
	GetProjectByPath(ctx context.Context, repoPath string) (*schema.Project, error)
	GetProjectByID(ctx context.Context, id string) (*schema.Project, error)
}
