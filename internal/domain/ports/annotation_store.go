package ports

import (
	"context"
	"time"

	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// AnnotationStore is the v2 accumulative port for persisting and querying
// annotations. Multiple annotations per entity are allowed (no upsert
// semantics). Each annotation is identified by a UUID and tracked by author.
type AnnotationStore interface {
	// AddAnnotation inserts a new annotation row and returns the created
	// annotation with its generated UUID and timestamps populated.
	AddAnnotation(ctx context.Context, ann schema.Annotation) (schema.Annotation, error)

	// GetAnnotations returns all annotations for a specific entity within a
	// connection, filtered by project, connection name, target type, and target name.
	GetAnnotations(ctx context.Context, projectID, connectionName, targetType, targetName string) ([]schema.Annotation, error)

	// GetAllAnnotations returns every annotation for a connection, regardless
	// of target type or name.
	GetAllAnnotations(ctx context.Context, projectID, connectionName string) ([]schema.Annotation, error)

	// EditAnnotation updates the content and updated_at of the annotation with
	// the given UUID. Returns the updated annotation, or an error if not found.
	EditAnnotation(ctx context.Context, id string, newContent string) (schema.Annotation, error)

	// DeleteAnnotation removes the annotation with the given UUID.
	// Returns an error if the UUID does not exist.
	DeleteAnnotation(ctx context.Context, id string) error

	// GetAnnotationsSince returns all annotations for a project whose
	// updated_at is strictly after since. Used by heydb push.
	GetAnnotationsSince(ctx context.Context, projectID string, since time.Time) ([]schema.Annotation, error)

	// ImportAnnotations bulk-inserts annotations using ON CONFLICT(id) DO UPDATE
	// semantics, so re-importing the same UUID is idempotent (updates content).
	ImportAnnotations(ctx context.Context, annotations []schema.Annotation) error
}
