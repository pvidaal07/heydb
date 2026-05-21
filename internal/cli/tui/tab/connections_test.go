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

// ── test doubles ─────────────────────────────────────────────────────────────

// mockConnectionStore is an in-memory ConnectionStore for testing.
type mockConnectionStore struct {
	conns     []schema.Connection
	activeSet string
	deleted   string
}

func (m *mockConnectionStore) SaveConnection(_ context.Context, _ string, conn schema.Connection) error {
	for i, c := range m.conns {
		if c.Name == conn.Name {
			m.conns[i] = conn
			return nil
		}
	}
	m.conns = append(m.conns, conn)
	return nil
}

func (m *mockConnectionStore) GetConnection(_ context.Context, _, name string) (*schema.Connection, error) {
	for _, c := range m.conns {
		if c.Name == name {
			cp := c
			return &cp, nil
		}
	}
	return nil, nil
}

func (m *mockConnectionStore) ListConnections(_ context.Context, _ string) ([]schema.Connection, error) {
	return m.conns, nil
}

func (m *mockConnectionStore) SetActive(_ context.Context, _, name string) error {
	m.activeSet = name
	for i := range m.conns {
		m.conns[i].Active = m.conns[i].Name == name
	}
	return nil
}

func (m *mockConnectionStore) DeleteConnection(_ context.Context, _, name string) error {
	m.deleted = name
	filtered := m.conns[:0]
	for _, c := range m.conns {
		if c.Name != name {
			filtered = append(filtered, c)
		}
	}
	m.conns = filtered
	return nil
}

// ── fixtures ─────────────────────────────────────────────────────────────────

func twoConnSlice() []schema.Connection {
	return []schema.Connection{
		{
			ID:        1,
			ProjectID: "proj-1",
			Name:      "local",
			Host:      "127.0.0.1",
			Port:      3306,
			Database:  "mydb",
			User:      "root",
			Password:  "secret",
			Active:    true,
		},
		{
			ID:        2,
			ProjectID: "proj-1",
			Name:      "staging",
			Host:      "staging.example.com",
			Port:      3306,
			Database:  "stagedb",
			User:      "reader",
			Password:  "pass",
			Active:    false,
		},
	}
}

// ── tests ─────────────────────────────────────────────────────────────────────

func TestConnectionsTab_ListPopulation(t *testing.T) {
	store := &mockConnectionStore{conns: twoConnSlice()}
	ct := tab.NewConnectionsTab(twoConnSlice(), "local", "proj-1", store)

	// Send a window size so the viewport can fit both connections.
	updated, _ := ct.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	ct = updated.(tab.ConnectionsTab)

	view := ct.View()
	if !strings.Contains(view, "local") {
		t.Error("expected 'local' in view")
	}
	if !strings.Contains(view, "staging") {
		t.Error("expected 'staging' in view")
	}
}

func TestConnectionsTab_EmptyState(t *testing.T) {
	store := &mockConnectionStore{}
	ct := tab.NewConnectionsTab(nil, "", "proj-1", store)

	view := ct.View()
	if !strings.Contains(view, "No connections configured") {
		t.Errorf("expected empty-state message in view, got:\n%s", view)
	}
}

// TestConnectionsTab_EnterEmitsConnectionsChangedMsg verifies Enter emits the
// new ConnectionsChangedMsg with the switched active connection name.
func TestConnectionsTab_EnterEmitsConnectionsChangedMsg(t *testing.T) {
	store := &mockConnectionStore{conns: twoConnSlice()}
	ct := tab.NewConnectionsTab(twoConnSlice(), "local", "proj-1", store)

	ct.Init()

	// Send a window size so the list renders.
	updated, _ := ct.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	ct = updated.(tab.ConnectionsTab)

	// Move cursor down to staging (second item after sort — local, staging).
	updated, _ = ct.Update(tea.KeyMsg{Type: tea.KeyDown})
	ct = updated.(tab.ConnectionsTab)

	// Press Enter to switch active connection.
	_, cmds := ct.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if cmds == nil {
		t.Fatal("expected a command from Enter, got nil")
	}
	msg := cmds()
	ccm, ok := msg.(tui.ConnectionsChangedMsg)
	if !ok {
		t.Errorf("expected tui.ConnectionsChangedMsg, got %T", msg)
	}
	if ccm.ActiveConnName != "staging" {
		t.Errorf("expected ActiveConnName == 'staging', got %q", ccm.ActiveConnName)
	}
}

func TestConnectionsTab_Title(t *testing.T) {
	store := &mockConnectionStore{}
	ct := tab.NewConnectionsTab(nil, "", "proj-1", store)
	if ct.Title() != "Connections" {
		t.Errorf("expected Title() == 'Connections', got %q", ct.Title())
	}
}

// TestConnectionsTab_ConnectionsChangedMsg_Updates verifies that receiving
// ConnectionsChangedMsg refreshes the tab's connection list.
func TestConnectionsTab_ConnectionsChangedMsg_Updates(t *testing.T) {
	store := &mockConnectionStore{conns: twoConnSlice()}
	ct := tab.NewConnectionsTab(twoConnSlice(), "local", "proj-1", store)

	updated, _ := ct.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	ct = updated.(tab.ConnectionsTab)

	// Simulate a reload with only one connection.
	newConns := []schema.Connection{twoConnSlice()[0]}
	updated, _ = ct.Update(tui.ConnectionsChangedMsg{
		Connections:    newConns,
		ActiveConnName: "local",
	})
	ct = updated.(tab.ConnectionsTab)

	view := ct.View()
	if strings.Contains(view, "staging") {
		t.Error("staging should have been removed after ConnectionsChangedMsg")
	}
	if !strings.Contains(view, "local") {
		t.Error("expected 'local' to still be in view")
	}
}
