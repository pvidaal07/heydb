package ports

import "context"

// AnnotationStore is the port for persisting and querying annotations
// at three levels: database, table, and column.
// The primary implementation is the SQLite adapter.
type AnnotationStore interface {
	// --- Table-level (existing behaviour) ---

	SaveAnnotation(ctx context.Context, tableName, content string) error
	GetAnnotation(ctx context.Context, tableName string) (string, error)
	GetAllAnnotations(ctx context.Context) (map[string]string, error)

	// --- Column-level ---

	SaveColumnAnnotation(ctx context.Context, tableName, columnName, content string) error
	GetColumnAnnotation(ctx context.Context, tableName, columnName string) (string, error)
	GetAllColumnAnnotations(ctx context.Context, tableName string) (map[string]string, error)

	// --- Database-level ---

	SaveDBAnnotation(ctx context.Context, content string) error
	GetDBAnnotation(ctx context.Context) (string, error)
}
