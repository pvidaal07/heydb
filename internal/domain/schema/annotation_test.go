package schema_test

import (
	"testing"
	"time"

	"github.com/pvidaal07/heydb/internal/domain/schema"
)

func TestAnnotationZeroValue(t *testing.T) {
	var a schema.Annotation
	if a.ID != "" {
		t.Errorf("expected empty ID, got %q", a.ID)
	}
	if a.ProjectID != "" {
		t.Errorf("expected empty ProjectID, got %q", a.ProjectID)
	}
	if a.ConnectionName != "" {
		t.Errorf("expected empty ConnectionName, got %q", a.ConnectionName)
	}
	if a.TargetType != "" {
		t.Errorf("expected empty TargetType, got %q", a.TargetType)
	}
	if a.TargetName != "" {
		t.Errorf("expected empty TargetName, got %q", a.TargetName)
	}
	if a.Content != "" {
		t.Errorf("expected empty Content, got %q", a.Content)
	}
	if a.Author != "" {
		t.Errorf("expected empty Author, got %q", a.Author)
	}
	if !a.CreatedAt.IsZero() {
		t.Errorf("expected zero CreatedAt, got %v", a.CreatedAt)
	}
	if !a.UpdatedAt.IsZero() {
		t.Errorf("expected zero UpdatedAt, got %v", a.UpdatedAt)
	}
}

func TestAnnotationFields(t *testing.T) {
	now := time.Now().UTC()
	a := schema.Annotation{
		ID:             "uuid-1",
		ProjectID:      "proj-1",
		ConnectionName: "local",
		TargetType:     "table",
		TargetName:     "users",
		Content:        "This table holds user accounts.",
		Author:         "alice",
		CreatedAt:      now,
		UpdatedAt:      now,
	}

	if a.ID != "uuid-1" {
		t.Errorf("expected ID=%q, got %q", "uuid-1", a.ID)
	}
	if a.ProjectID != "proj-1" {
		t.Errorf("expected ProjectID=%q, got %q", "proj-1", a.ProjectID)
	}
	if a.ConnectionName != "local" {
		t.Errorf("expected ConnectionName=%q, got %q", "local", a.ConnectionName)
	}
	if a.TargetType != "table" {
		t.Errorf("expected TargetType=%q, got %q", "table", a.TargetType)
	}
	if a.TargetName != "users" {
		t.Errorf("expected TargetName=%q, got %q", "users", a.TargetName)
	}
	if a.Content != "This table holds user accounts." {
		t.Errorf("unexpected Content: %q", a.Content)
	}
	if a.Author != "alice" {
		t.Errorf("expected Author=%q, got %q", "alice", a.Author)
	}
	if !a.CreatedAt.Equal(now) {
		t.Errorf("expected CreatedAt=%v, got %v", now, a.CreatedAt)
	}
	if !a.UpdatedAt.Equal(now) {
		t.Errorf("expected UpdatedAt=%v, got %v", now, a.UpdatedAt)
	}
}
