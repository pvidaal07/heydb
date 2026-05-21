package schema

import "time"

// Annotation represents a human-authored note attached to a database entity
// (database, table, or column). Annotations are accumulative — multiple
// annotations per entity are allowed and tracked by UUID.
type Annotation struct {
	ID             string    // UUID v4 primary key
	ProjectID      string    // FK to projects table
	ConnectionName string    // Connection name (not FK — travels across machines)
	TargetType     string    // "db" | "table" | "column"
	TargetName     string    // "" for db, "users" for table, "users.email" for column
	Content        string    // free-form annotation text
	Author         string    // from user_config.author
	CreatedAt      time.Time
	UpdatedAt      time.Time
}
