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

// fakeMultiDBFactory implements introspection.MultiDBFactory for testing.
type fakeMultiDBFactory struct {
	databases   []string
	perDBTables map[string][]string
	created     []string
}

func (f *fakeMultiDBFactory) ListDatabases(ctx context.Context) ([]string, error) {
	return f.databases, nil
}

func (f *fakeMultiDBFactory) ForDatabase(database string) introspection.DBLite {
	f.created = append(f.created, database)
	tables := f.perDBTables[database]
	return &fakeIntrospector{tables: tables}
}

// ── RunMultiDB ───────────────────────────────────────────────────────────────

func TestRunMultiDB_ThreeDatabases(t *testing.T) {
	factory := &fakeMultiDBFactory{
		databases: []string{"shop", "analytics", "billing"},
		perDBTables: map[string][]string{
			"shop":      {"products", "orders"},
			"analytics": {"events"},
			"billing":   {"invoices", "payments", "refunds"},
		},
	}
	store := &fakeSchemaStore{}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	results, err := introspection.RunMultiDB(ctx, factory, store, false)
	if err != nil {
		t.Fatalf("RunMultiDB: %v", err)
	}

	if len(results) != 3 {
		t.Fatalf("len(results): got %d, want 3", len(results))
	}

	counts := map[string]int{}
	for _, r := range results {
		counts[r.Database] = r.TablesCount
	}
	if counts["shop"] != 2 {
		t.Errorf("shop: got %d, want 2", counts["shop"])
	}
	if counts["analytics"] != 1 {
		t.Errorf("analytics: got %d, want 1", counts["analytics"])
	}
	if counts["billing"] != 3 {
		t.Errorf("billing: got %d, want 3", counts["billing"])
	}

	if len(factory.created) != 3 {
		t.Errorf("ForDatabase calls: got %d, want 3", len(factory.created))
	}
}

func TestRunMultiDB_NoDatabases(t *testing.T) {
	factory := &fakeMultiDBFactory{databases: []string{}}
	store := &fakeSchemaStore{}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	results, err := introspection.RunMultiDB(ctx, factory, store, false)
	if err != nil {
		t.Fatalf("RunMultiDB with 0 DBs: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}
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
