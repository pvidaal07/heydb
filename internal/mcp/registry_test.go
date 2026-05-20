package mcp_test

import (
	"context"
	"strings"
	"testing"

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
func (m *mockSchemaStore) SearchTables(_ context.Context, _ string) ([]schema.Table, error) {
	return nil, nil
}
func (m *mockSchemaStore) Close() error {
	m.closed = true
	return nil
}

// Ensure interface compliance.
var _ ports.SchemaStore = (*mockSchemaStore)(nil)

// mockAnnotationStore is a minimal in-memory implementation of ports.AnnotationStore.
type mockAnnotationStore struct {
	closed bool
}

func (m *mockAnnotationStore) SaveAnnotation(_ context.Context, _, _ string) error { return nil }
func (m *mockAnnotationStore) GetAnnotation(_ context.Context, _ string) (string, error) {
	return "", nil
}
func (m *mockAnnotationStore) GetAllAnnotations(_ context.Context) (map[string]string, error) {
	return nil, nil
}
func (m *mockAnnotationStore) SaveColumnAnnotation(_ context.Context, _, _, _ string) error {
	return nil
}
func (m *mockAnnotationStore) GetColumnAnnotation(_ context.Context, _, _ string) (string, error) {
	return "", nil
}
func (m *mockAnnotationStore) GetAllColumnAnnotations(_ context.Context, _ string) (map[string]string, error) {
	return nil, nil
}
func (m *mockAnnotationStore) SaveDBAnnotation(_ context.Context, _ string) error { return nil }
func (m *mockAnnotationStore) GetDBAnnotation(_ context.Context) (string, error)  { return "", nil }
func (m *mockAnnotationStore) Close() error {
	m.closed = true
	return nil
}

// Ensure interface compliance.
var _ ports.AnnotationStore = (*mockAnnotationStore)(nil)

// ── helper ───────────────────────────────────────────────────────────────────

// makeEntry creates a ConnEntry with fresh mocks.
func makeEntry() *mcp.ConnEntry {
	return &mcp.ConnEntry{
		Schema:      &mockSchemaStore{},
		Annotations: &mockAnnotationStore{},
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
