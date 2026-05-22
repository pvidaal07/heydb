package schema

import "time"

// ImplicitRelationship represents a user-defined logical foreign key between
// two tables that is not enforced by the database engine. These are discovered
// by users who know the codebase and want to document implicit joins.
// Stored in the global SQLite database as a first-class entity.
type ImplicitRelationship struct {
	ID             string    // UUID v4 primary key
	ProjectID      string    // FK to projects table
	ConnectionName string    // Connection name (not FK — travels across machines)
	FromTable      string    // The "child" or "many" side of the relationship
	FromColumn     string    // The column on FromTable that references ToTable
	ToTable        string    // The "parent" or "one" side of the relationship
	ToColumn       string    // The column on ToTable being referenced
	Label          string    // Optional human-readable description
	Author         string    // Who created this relationship
	CreatedAt      time.Time
}
