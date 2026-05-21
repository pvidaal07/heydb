package schema_test

import (
	"testing"

	"github.com/pvidaal07/heydb/internal/domain/schema"
)

func TestProjectZeroValue(t *testing.T) {
	var p schema.Project
	if p.ID != "" {
		t.Errorf("expected empty ID, got %q", p.ID)
	}
	if p.Name != "" {
		t.Errorf("expected empty Name, got %q", p.Name)
	}
	if p.RepoPath != "" {
		t.Errorf("expected empty RepoPath, got %q", p.RepoPath)
	}
}

func TestProjectFields(t *testing.T) {
	p := schema.Project{
		ID:       "uuid-proj-1",
		Name:     "heydb",
		RepoPath: "/home/alice/projects/heydb",
	}

	if p.ID != "uuid-proj-1" {
		t.Errorf("expected ID=%q, got %q", "uuid-proj-1", p.ID)
	}
	if p.Name != "heydb" {
		t.Errorf("expected Name=%q, got %q", "heydb", p.Name)
	}
	if p.RepoPath != "/home/alice/projects/heydb" {
		t.Errorf("expected RepoPath=%q, got %q", "/home/alice/projects/heydb", p.RepoPath)
	}
}
