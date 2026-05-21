package introspection_test

import (
	"context"
	"testing"
	"time"

	"github.com/pvidaal07/heydb/internal/domain/schema"
	"github.com/pvidaal07/heydb/internal/introspection"
)

// ── fakes ────────────────────────────────────────────────────────────────────

// fakeIntrospector implements ports.DBIntrospector with fixed data.
type fakeIntrospector struct {
	tables []string
}

func (f *fakeIntrospector) Connect(ctx context.Context) error { return nil }
func (f *fakeIntrospector) Close() error                      { return nil }
func (f *fakeIntrospector) ListTables(ctx context.Context) ([]string, error) {
	return f.tables, nil
}
func (f *fakeIntrospector) GetTable(ctx context.Context, name string) (schema.Table, error) {
	return schema.Table{Name: name}, nil
}
func (f *fakeIntrospector) ComputeHash(ctx context.Context) (string, error) {
	return "fakehash", nil
}

// fakeSchemaStoreWriter captures the last saved schema.
type fakeSchemaStore struct {
	saved *schema.Schema
}

func (f *fakeSchemaStore) SaveSchema(ctx context.Context, s schema.Schema) error {
	sc := s
	f.saved = &sc
	return nil
}

// ── T-13: nil SchemaWriter ────────────────────────────────────────────────────

func TestSyncer_NilMarkdownWriter_DoesNotPanic(t *testing.T) {
	introspector := &fakeIntrospector{tables: []string{"users", "orders"}}
	store := &fakeSchemaStore{}

	// Pass nil writer — must not panic.
	syncer := introspection.NewSyncer(introspector, store, nil, false)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result, err := syncer.Run(ctx, "myapp")
	if err != nil {
		t.Fatalf("Run with nil writer: %v", err)
	}
	if result.TablesCount != 2 {
		t.Errorf("TablesCount: got %d, want 2", result.TablesCount)
	}
	if result.Database != "myapp" {
		t.Errorf("Database: got %q, want %q", result.Database, "myapp")
	}
	if store.saved == nil {
		t.Error("expected schema to be saved to store, but it wasn't")
	}
}
