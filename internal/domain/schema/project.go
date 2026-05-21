package schema

// Project represents a heydb-initialised repository.
// It is registered in the global DB on `heydb init`.
type Project struct {
	ID       string // UUID v4 primary key
	Name     string // derived from repo directory basename
	RepoPath string // absolute path to the repository root
}
