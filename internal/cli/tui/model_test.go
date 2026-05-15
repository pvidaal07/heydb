package tui_test

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/pvidaal07/heydb/internal/cli/tui"
	"github.com/pvidaal07/heydb/internal/cli/tui/tab"
	"github.com/pvidaal07/heydb/internal/config"
)

// Compile-time check: all three tab types satisfy Tab.
var _ tui.Tab = (*tab.ConnectionsTab)(nil)
var _ tui.Tab = (*tab.SchemaTab)(nil)
var _ tui.Tab = (*tab.SearchTab)(nil)

func newTestModel(t *testing.T) tui.Model {
	t.Helper()
	cfg := &config.Config{
		Version:     1,
		Connections: make(map[string]config.Connection),
	}
	tabs := []tui.Tab{
		tab.NewConnectionsTab(cfg, "/tmp/test-config.json"),
		tab.NewSchemaTab(nil),
		tab.NewSearchTab(),
	}
	return tui.New(cfg, "/tmp/test-config.json", "test").WithTabs(tabs)
}

func TestModel_TabSwitchForward(t *testing.T) {
	m := newTestModel(t)
	initial := m.ActiveTab()

	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m2, ok := updated.(tui.Model)
	if !ok {
		t.Fatal("Update did not return a tui.Model")
	}

	if m2.ActiveTab() == initial {
		t.Errorf("expected activeTab to change from %d, still %d", initial, m2.ActiveTab())
	}
	if m2.ActiveTab() != (initial+1)%3 {
		t.Errorf("expected activeTab %d, got %d", (initial+1)%3, m2.ActiveTab())
	}
}

func TestModel_TabSwitchWraps(t *testing.T) {
	m := newTestModel(t)
	// Tab through all tabs and back to 0.
	var current tea.Model = m
	for i := 0; i < 3; i++ {
		current, _ = current.Update(tea.KeyMsg{Type: tea.KeyTab})
	}
	m2, ok := current.(tui.Model)
	if !ok {
		t.Fatal("Update did not return a tui.Model")
	}
	if m2.ActiveTab() != 0 {
		t.Errorf("expected wrap to 0, got %d", m2.ActiveTab())
	}
}

func TestModel_QuitReturnsTeaQuit(t *testing.T) {
	m := newTestModel(t)
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	if cmd == nil {
		t.Fatal("expected a cmd from 'q' key, got nil")
	}
	msg := cmd()
	if _, ok := msg.(tea.QuitMsg); !ok {
		t.Errorf("expected tea.QuitMsg, got %T", msg)
	}
}
