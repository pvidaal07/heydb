package mcp_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/pvidaal07/heydb/internal/domain/ports"
	"github.com/pvidaal07/heydb/internal/domain/schema"
	"github.com/pvidaal07/heydb/internal/mcp"
)

// ── mock stores ───────────────────────────────────────────────────────────────

// mockSchemaStore is a minimal in-memory implementation of ports.SchemaStore
// used only in registry and server tests.
type mockSchemaStore struct {
	tables []schema.Table
	closed bool
}

func (m *mockSchemaStore) SaveSchema(_ context.Context, _ schema.Schema) error { return nil }
func (m *mockSchemaStore) LoadSchema(_ context.Context) (schema.Schema, error) {
	return schema.Schema{Tables: m.tables}, nil
}
func (m *mockSchemaStore) GetTable(_ context.Context, name string) (schema.Table, error) {
	for _, t := range m.tables {
		if t.Name == name {
			return t, nil
		}
	}
	return schema.Table{}, context.DeadlineExceeded // any non-nil error
}
func (m *mockSchemaStore) SearchTables(_ context.Context, query, _, _ string) ([]schema.Table, error) {
	if query == "" {
		return nil, nil
	}
	lower := strings.ToLower(query)
	var result []schema.Table
	for _, t := range m.tables {
		if strings.Contains(strings.ToLower(t.Name), lower) {
			result = append(result, t)
			continue
		}
		for _, c := range t.Columns {
			if strings.Contains(strings.ToLower(c.Name), lower) {
				result = append(result, t)
				break
			}
		}
	}
	return result, nil
}
func (m *mockSchemaStore) Close() error {
	m.closed = true
	return nil
}

// Ensure interface compliance.
var _ ports.SchemaStore = (*mockSchemaStore)(nil)

// mockAnnotationStore is an in-memory implementation of the v2 ports.AnnotationStore.
// It stores annotations in a slice so tests can assert accumulative behaviour.
type mockAnnotationStore struct {
	annotations []schema.Annotation
	closed      bool
}

func (m *mockAnnotationStore) AddAnnotation(_ context.Context, ann schema.Annotation) (schema.Annotation, error) {
	if ann.ID == "" {
		ann.ID = fmt.Sprintf("mock-uuid-%d", len(m.annotations)+1)
	}
	now := time.Now()
	ann.CreatedAt = now
	ann.UpdatedAt = now
	m.annotations = append(m.annotations, ann)
	return ann, nil
}

func (m *mockAnnotationStore) GetAnnotations(_ context.Context, projectID, connectionName, targetType, targetName string) ([]schema.Annotation, error) {
	var result []schema.Annotation
	for _, a := range m.annotations {
		if a.ProjectID == projectID && a.ConnectionName == connectionName &&
			a.TargetType == targetType && a.TargetName == targetName {
			result = append(result, a)
		}
	}
	if result == nil {
		result = []schema.Annotation{}
	}
	return result, nil
}

func (m *mockAnnotationStore) GetAllAnnotations(_ context.Context, projectID, connectionName string) ([]schema.Annotation, error) {
	var result []schema.Annotation
	for _, a := range m.annotations {
		if a.ProjectID == projectID && a.ConnectionName == connectionName {
			result = append(result, a)
		}
	}
	if result == nil {
		result = []schema.Annotation{}
	}
	return result, nil
}

func (m *mockAnnotationStore) EditAnnotation(_ context.Context, id, newContent string) (schema.Annotation, error) {
	for i, a := range m.annotations {
		if a.ID == id {
			m.annotations[i].Content = newContent
			m.annotations[i].UpdatedAt = time.Now()
			return m.annotations[i], nil
		}
	}
	return schema.Annotation{}, fmt.Errorf("annotation %q not found", id)
}

func (m *mockAnnotationStore) DeleteAnnotation(_ context.Context, id string) error {
	for i, a := range m.annotations {
		if a.ID == id {
			m.annotations = append(m.annotations[:i], m.annotations[i+1:]...)
			return nil
		}
	}
	return fmt.Errorf("annotation %q not found", id)
}

func (m *mockAnnotationStore) GetAnnotationsSince(_ context.Context, projectID string, since time.Time) ([]schema.Annotation, error) {
	var result []schema.Annotation
	for _, a := range m.annotations {
		if a.ProjectID == projectID && a.UpdatedAt.After(since) {
			result = append(result, a)
		}
	}
	return result, nil
}

func (m *mockAnnotationStore) ImportAnnotations(_ context.Context, annotations []schema.Annotation) error {
	for _, ann := range annotations {
		found := false
		for i, a := range m.annotations {
			if a.ID == ann.ID {
				m.annotations[i] = ann
				found = true
				break
			}
		}
		if !found {
			m.annotations = append(m.annotations, ann)
		}
	}
	return nil
}

func (m *mockAnnotationStore) Close() error {
	m.closed = true
	return nil
}

// Ensure interface compliance.
var _ ports.AnnotationStore = (*mockAnnotationStore)(nil)

// mockRelationshipStore is a minimal in-memory implementation of ports.RelationshipStore.
type mockRelationshipStore struct {
	relationships []schema.ImplicitRelationship
	closed        bool
}

func (m *mockRelationshipStore) AddRelationship(_ context.Context, rel schema.ImplicitRelationship) (schema.ImplicitRelationship, error) {
	if rel.ID == "" {
		rel.ID = fmt.Sprintf("mock-rel-uuid-%d", len(m.relationships)+1)
	}
	rel.CreatedAt = time.Now()
	m.relationships = append(m.relationships, rel)
	return rel, nil
}

func (m *mockRelationshipStore) DeleteRelationship(_ context.Context, id string) error {
	for i, r := range m.relationships {
		if r.ID == id {
			m.relationships = append(m.relationships[:i], m.relationships[i+1:]...)
			return nil
		}
	}
	return fmt.Errorf("relationship %q not found", id)
}

func (m *mockRelationshipStore) ListRelationships(_ context.Context, projectID, connectionName string) ([]schema.ImplicitRelationship, error) {
	var result []schema.ImplicitRelationship
	for _, r := range m.relationships {
		if r.ProjectID == projectID && r.ConnectionName == connectionName {
			result = append(result, r)
		}
	}
	if result == nil {
		result = []schema.ImplicitRelationship{}
	}
	return result, nil
}

func (m *mockRelationshipStore) GetRelationshipsByTable(_ context.Context, projectID, connectionName, tableName string) ([]schema.ImplicitRelationship, error) {
	var result []schema.ImplicitRelationship
	for _, r := range m.relationships {
		if r.ProjectID == projectID && r.ConnectionName == connectionName &&
			(r.FromTable == tableName || r.ToTable == tableName) {
			result = append(result, r)
		}
	}
	if result == nil {
		result = []schema.ImplicitRelationship{}
	}
	return result, nil
}

func (m *mockRelationshipStore) Close() error {
	m.closed = true
	return nil
}

// Ensure interface compliance.
var _ ports.RelationshipStore = (*mockRelationshipStore)(nil)

// ── helper ───────────────────────────────────────────────────────────────────

// makeEntry creates a ConnEntry with fresh mocks.
func makeEntry() *mcp.ConnEntry {
	return &mcp.ConnEntry{
		Schema:        &mockSchemaStore{},
		Annotations:   &mockAnnotationStore{},
		Relationships: &mockRelationshipStore{},
	}
}

// ── TestConnEntry_RelationshipsField ─────────────────────────────────────────

func TestConnEntry_RelationshipsField(t *testing.T) {
	rel := &mockRelationshipStore{}
	entry := &mcp.ConnEntry{
		Schema:        &mockSchemaStore{},
		Annotations:   &mockAnnotationStore{},
		Relationships: rel,
	}

	if entry.Relationships == nil {
		t.Error("ConnEntry.Relationships should be non-nil when set")
	}
	if entry.Relationships != rel {
		t.Error("ConnEntry.Relationships should return the assigned store")
	}
}

// TestRegistry_CloseAll_ClosesRelationshipStore verifies that CloseAll closes
// the Relationships store if it implements io.Closer.
func TestRegistry_CloseAll_ClosesRelationshipStore(t *testing.T) {
	relStore := &mockRelationshipStore{}
	reg := mcp.NewRegistry(
		map[string]*mcp.ConnEntry{
			"conn1": {
				Schema:        &mockSchemaStore{},
				Annotations:   &mockAnnotationStore{},
				Relationships: relStore,
			},
		},
		[]string{"conn1"},
		"conn1",
	)

	if err := reg.CloseAll(); err != nil {
		t.Fatalf("CloseAll() unexpected error: %v", err)
	}

	if !relStore.closed {
		t.Error("conn1 relationship store was not closed")
	}
}

// ── TestRegistry_Resolve ──────────────────────────────────────────────────────

func TestRegistry_Resolve(t *testing.T) {
	production := makeEntry()
	staging := makeEntry()

	reg := mcp.NewRegistry(
		map[string]*mcp.ConnEntry{
			"production": production,
			"staging":    staging,
		},
		[]string{"analytics", "production", "staging"},
		"production",
	)

	tests := []struct {
		name       string
		input      string
		wantEntry  *mcp.ConnEntry
		wantName   string
		wantErrSub string
	}{
		{
			name:      "empty name defaults to active connection",
			input:     "",
			wantEntry: production,
			wantName:  "production",
		},
		{
			name:      "named synced connection resolves correctly",
			input:     "staging",
			wantEntry: staging,
			wantName:  "staging",
		},
		{
			name:       "unknown name returns error listing available connections",
			input:      "typo",
			wantErrSub: `unknown connection "typo"`,
		},
		{
			name:       "unknown name error message lists available names",
			input:      "typo",
			wantErrSub: "analytics",
		},
		{
			name:       "known but unsynced connection returns not-synced error",
			input:      "analytics",
			wantErrSub: `connection "analytics" not synced`,
		},
		{
			name:       "unsynced error instructs user to run heydb sync",
			input:      "analytics",
			wantErrSub: "heydb sync",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, gotName, err := reg.Resolve(tc.input)
			if tc.wantErrSub != "" {
				if err == nil {
					t.Fatalf("Resolve(%q) expected error containing %q; got nil", tc.input, tc.wantErrSub)
				}
				if !contains(err.Error(), tc.wantErrSub) {
					t.Errorf("Resolve(%q) error = %q; want it to contain %q", tc.input, err.Error(), tc.wantErrSub)
				}
				return
			}
			if err != nil {
				t.Fatalf("Resolve(%q) unexpected error: %v", tc.input, err)
			}
			if got != tc.wantEntry {
				t.Errorf("Resolve(%q) returned wrong entry", tc.input)
			}
			if gotName != tc.wantName {
				t.Errorf("Resolve(%q) name = %q; want %q", tc.input, gotName, tc.wantName)
			}
		})
	}
}

// ── TestRegistry_List ─────────────────────────────────────────────────────────

func TestRegistry_List_SortedAlphabetically(t *testing.T) {
	reg := mcp.NewRegistry(
		map[string]*mcp.ConnEntry{
			"production": makeEntry(),
			"analytics":  makeEntry(),
		},
		[]string{"production", "analytics", "staging"}, // unsorted intentionally
		"production",
	)

	got := reg.List()

	if len(got) != 3 {
		t.Fatalf("List() returned %d entries; want 3", len(got))
	}
	wantOrder := []string{"analytics", "production", "staging"}
	for i, name := range wantOrder {
		if got[i].Name != name {
			t.Errorf("List()[%d].Name = %q; want %q", i, got[i].Name, name)
		}
	}
}

func TestRegistry_List_ActiveAndSyncedFlags(t *testing.T) {
	reg := mcp.NewRegistry(
		map[string]*mcp.ConnEntry{
			"production": makeEntry(), // active + synced
			"analytics":  makeEntry(), // inactive + synced
			// staging: inactive + NOT synced (no entry)
		},
		[]string{"analytics", "production", "staging"},
		"production",
	)

	got := reg.List()

	// After sort: analytics, production, staging
	assertConnectionInfo(t, got[0], "analytics", false, true)
	assertConnectionInfo(t, got[1], "production", true, true)
	assertConnectionInfo(t, got[2], "staging", false, false)
}

func TestRegistry_List_SingleConnection(t *testing.T) {
	entry := makeEntry()
	reg := mcp.NewRegistry(
		map[string]*mcp.ConnEntry{"main": entry},
		[]string{"main"},
		"main",
	)

	got := reg.List()

	if len(got) != 1 {
		t.Fatalf("List() returned %d entries; want 1", len(got))
	}
	assertConnectionInfo(t, got[0], "main", true, true)
}

// ── TestRegistry_CloseAll ─────────────────────────────────────────────────────

func TestRegistry_CloseAll_ClosesAllOpenStores(t *testing.T) {
	schema1 := &mockSchemaStore{}
	ann1 := &mockAnnotationStore{}
	schema2 := &mockSchemaStore{}
	ann2 := &mockAnnotationStore{}

	reg := mcp.NewRegistry(
		map[string]*mcp.ConnEntry{
			"conn1": {Schema: schema1, Annotations: ann1},
			"conn2": {Schema: schema2, Annotations: ann2},
		},
		[]string{"conn1", "conn2"},
		"conn1",
	)

	if err := reg.CloseAll(); err != nil {
		t.Fatalf("CloseAll() unexpected error: %v", err)
	}

	if !schema1.closed {
		t.Error("conn1 schema store was not closed")
	}
	if !ann1.closed {
		t.Error("conn1 annotation store was not closed")
	}
	if !schema2.closed {
		t.Error("conn2 schema store was not closed")
	}
	if !ann2.closed {
		t.Error("conn2 annotation store was not closed")
	}
}

func TestRegistry_CloseAll_EmptyRegistryNoError(t *testing.T) {
	reg := mcp.NewRegistry(
		map[string]*mcp.ConnEntry{},
		[]string{"unsynced"},
		"unsynced",
	)

	if err := reg.CloseAll(); err != nil {
		t.Errorf("CloseAll() on empty entries returned error: %v", err)
	}
}

// ── test helpers ──────────────────────────────────────────────────────────────

func assertConnectionInfo(t *testing.T, got mcp.ConnectionInfo, name string, active, synced bool) {
	t.Helper()
	if got.Name != name {
		t.Errorf("ConnectionInfo.Name = %q; want %q", got.Name, name)
	}
	if got.Active != active {
		t.Errorf("ConnectionInfo[%q].Active = %v; want %v", name, got.Active, active)
	}
	if got.Synced != synced {
		t.Errorf("ConnectionInfo[%q].Synced = %v; want %v", name, got.Synced, synced)
	}
}

func contains(s, sub string) bool {
	return strings.Contains(s, sub)
}
