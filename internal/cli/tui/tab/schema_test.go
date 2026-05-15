package tab_test

import (
	"context"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/pvidaal07/heydb/internal/cli/tui"
	"github.com/pvidaal07/heydb/internal/cli/tui/tab"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// mockStore is a test double for ports.SchemaStore.
type mockStore struct {
	tables  []schema.Table
	loadErr error
}

func (m *mockStore) SaveSchema(_ context.Context, _ schema.Schema) error {
	return nil
}

func (m *mockStore) LoadSchema(_ context.Context) (schema.Schema, error) {
	if m.loadErr != nil {
		return schema.Schema{}, m.loadErr
	}
	return schema.Schema{Tables: m.tables}, nil
}

func (m *mockStore) GetTable(_ context.Context, name string) (schema.Table, error) {
	for _, t := range m.tables {
		if t.Name == name {
			return t, nil
		}
	}
	return schema.Table{}, nil
}

func (m *mockStore) SearchTables(_ context.Context, query string) ([]schema.Table, error) {
	var result []schema.Table
	for _, t := range m.tables {
		if strings.Contains(strings.ToLower(t.Name), strings.ToLower(query)) {
			result = append(result, t)
			continue
		}
		for _, c := range t.Columns {
			if strings.Contains(strings.ToLower(c.Name), strings.ToLower(query)) {
				result = append(result, t)
				break
			}
		}
	}
	if result == nil {
		result = []schema.Table{}
	}
	return result, nil
}

func (m *mockStore) Close() error { return nil }

func threeTableStore() *mockStore {
	return &mockStore{
		tables: []schema.Table{
			{
				Name: "users",
				Columns: []schema.Column{
					{Name: "id", Type: "bigint unsigned", Nullable: false, Extra: "auto_increment"},
					{Name: "email", Type: "varchar(255)", Nullable: false},
					{Name: "created_at", Type: "datetime", Nullable: false},
				},
				Indexes: []schema.Index{
					{Name: "idx_email", Columns: []string{"email"}, Unique: true, Type: "BTREE"},
				},
				ForeignKeys: []schema.ForeignKey{},
			},
			{
				Name: "orders",
				Columns: []schema.Column{
					{Name: "id", Type: "bigint unsigned", Nullable: false, Extra: "auto_increment"},
					{Name: "user_id", Type: "bigint unsigned", Nullable: false},
					{Name: "total", Type: "decimal(10,2)", Nullable: false},
				},
				ForeignKeys: []schema.ForeignKey{
					{Name: "fk_orders_user", Column: "user_id", ReferencedTable: "users", ReferencedColumn: "id"},
				},
			},
			{
				Name: "products",
				Columns: []schema.Column{
					{Name: "id", Type: "bigint unsigned", Nullable: false, Extra: "auto_increment"},
					{Name: "name", Type: "varchar(255)", Nullable: false},
				},
			},
		},
	}
}

func TestSchemaTab_Title(t *testing.T) {
	st := tab.NewSchemaTab(nil)
	if st.Title() != "Schema" {
		t.Errorf("expected Title() == 'Schema', got %q", st.Title())
	}
}

func TestSchemaTab_NilStore_EmptyState(t *testing.T) {
	st := tab.NewSchemaTab(nil)
	view := st.View()
	if !strings.Contains(view, "active connection") {
		t.Errorf("expected empty-state message about active connection, got:\n%s", view)
	}
}

func TestSchemaTab_WithStore_ShowsTables(t *testing.T) {
	store := threeTableStore()
	st := tab.NewSchemaTab(store)

	// Trigger load by sending WindowSizeMsg.
	updated, _ := st.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	st = updated.(tab.SchemaTab)

	view := st.View()
	if !strings.Contains(view, "users") {
		t.Errorf("expected 'users' in view, got:\n%s", view)
	}
	if !strings.Contains(view, "orders") {
		t.Errorf("expected 'orders' in view, got:\n%s", view)
	}
	if !strings.Contains(view, "products") {
		t.Errorf("expected 'products' in view, got:\n%s", view)
	}
}

func TestSchemaTab_EnterOpensDetailView(t *testing.T) {
	store := threeTableStore()
	st := tab.NewSchemaTab(store)

	// Trigger load.
	updated, _ := st.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	st = updated.(tab.SchemaTab)

	// Press Enter on the first item.
	updated, _ = st.Update(tea.KeyMsg{Type: tea.KeyEnter})
	st = updated.(tab.SchemaTab)

	view := st.View()
	// Detail view should show the column name of the first table's first column.
	if !strings.Contains(view, "id") {
		t.Errorf("expected column 'id' in detail view, got:\n%s", view)
	}
}

func TestSchemaTab_EscReturnsToList(t *testing.T) {
	store := threeTableStore()
	st := tab.NewSchemaTab(store)

	// Trigger load.
	updated, _ := st.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	st = updated.(tab.SchemaTab)

	// Enter detail view.
	updated, _ = st.Update(tea.KeyMsg{Type: tea.KeyEnter})
	st = updated.(tab.SchemaTab)

	// Esc to go back.
	updated, _ = st.Update(tea.KeyMsg{Type: tea.KeyEsc})
	st = updated.(tab.SchemaTab)

	// Should be back to showing list (multiple tables visible).
	view := st.View()
	if !strings.Contains(view, "orders") {
		t.Errorf("expected to be back in list view with 'orders', got:\n%s", view)
	}
}

func TestSchemaTab_ConfigReloadedMsg_ClearsStore(t *testing.T) {
	store := threeTableStore()
	st := tab.NewSchemaTab(store)

	// Load tables.
	updated, _ := st.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	st = updated.(tab.SchemaTab)

	// ConfigReloadedMsg with nil cfg clears the store (handled by tui_cmd store reopen).
	updated, _ = st.Update(tui.StoreOpenedMsg{Store: nil})
	st = updated.(tab.SchemaTab)

	view := st.View()
	if !strings.Contains(view, "active connection") {
		t.Errorf("expected empty-state after store cleared, got:\n%s", view)
	}
}
