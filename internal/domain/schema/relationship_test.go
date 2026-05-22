package schema_test

import (
	"testing"
	"time"

	"github.com/pvidaal07/heydb/internal/domain/schema"
)

func TestImplicitRelationship_ZeroValues(t *testing.T) {
	var r schema.ImplicitRelationship

	if r.ID != "" {
		t.Errorf("expected empty ID, got %q", r.ID)
	}
	if r.ProjectID != "" {
		t.Errorf("expected empty ProjectID, got %q", r.ProjectID)
	}
	if r.ConnectionName != "" {
		t.Errorf("expected empty ConnectionName, got %q", r.ConnectionName)
	}
	if r.FromTable != "" {
		t.Errorf("expected empty FromTable, got %q", r.FromTable)
	}
	if r.FromColumn != "" {
		t.Errorf("expected empty FromColumn, got %q", r.FromColumn)
	}
	if r.ToTable != "" {
		t.Errorf("expected empty ToTable, got %q", r.ToTable)
	}
	if r.ToColumn != "" {
		t.Errorf("expected empty ToColumn, got %q", r.ToColumn)
	}
	if r.Label != "" {
		t.Errorf("expected empty Label, got %q", r.Label)
	}
	if r.Author != "" {
		t.Errorf("expected empty Author, got %q", r.Author)
	}
	if !r.CreatedAt.IsZero() {
		t.Errorf("expected zero CreatedAt, got %v", r.CreatedAt)
	}
}

func TestImplicitRelationship_Fields(t *testing.T) {
	now := time.Now().UTC()
	r := schema.ImplicitRelationship{
		ID:             "rel-uuid-1",
		ProjectID:      "proj-1",
		ConnectionName: "dev",
		FromTable:      "orders",
		FromColumn:     "client_id",
		ToTable:        "clients",
		ToColumn:       "id",
		Label:          "order belongs to client",
		Author:         "alice",
		CreatedAt:      now,
	}

	if r.ID != "rel-uuid-1" {
		t.Errorf("expected ID=%q, got %q", "rel-uuid-1", r.ID)
	}
	if r.ProjectID != "proj-1" {
		t.Errorf("expected ProjectID=%q, got %q", "proj-1", r.ProjectID)
	}
	if r.ConnectionName != "dev" {
		t.Errorf("expected ConnectionName=%q, got %q", "dev", r.ConnectionName)
	}
	if r.FromTable != "orders" {
		t.Errorf("expected FromTable=%q, got %q", "orders", r.FromTable)
	}
	if r.FromColumn != "client_id" {
		t.Errorf("expected FromColumn=%q, got %q", "client_id", r.FromColumn)
	}
	if r.ToTable != "clients" {
		t.Errorf("expected ToTable=%q, got %q", "clients", r.ToTable)
	}
	if r.ToColumn != "id" {
		t.Errorf("expected ToColumn=%q, got %q", "id", r.ToColumn)
	}
	if r.Label != "order belongs to client" {
		t.Errorf("expected Label=%q, got %q", "order belongs to client", r.Label)
	}
	if r.Author != "alice" {
		t.Errorf("expected Author=%q, got %q", "alice", r.Author)
	}
	if !r.CreatedAt.Equal(now) {
		t.Errorf("expected CreatedAt=%v, got %v", now, r.CreatedAt)
	}
}
