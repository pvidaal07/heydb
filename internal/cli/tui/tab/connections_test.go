package tab_test

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/pvidaal07/heydb/internal/cli/tui"
	"github.com/pvidaal07/heydb/internal/cli/tui/tab"
	"github.com/pvidaal07/heydb/internal/config"
)

func twoConnConfig() *config.Config {
	return &config.Config{
		Version: 1,
		Connections: map[string]config.Connection{
			"local": {
				Driver:   "mysql",
				Host:     "127.0.0.1",
				Port:     3306,
				Database: "mydb",
				Username: "root",
				Password: "secret",
				Timeout:  30,
			},
			"staging": {
				Driver:   "mysql",
				Host:     "staging.example.com",
				Port:     3306,
				Database: "stagedb",
				Username: "reader",
				Password: "pass",
				Timeout:  30,
			},
		},
		ActiveConnection: "local",
	}
}

func TestConnectionsTab_ListPopulation(t *testing.T) {
	cfg := twoConnConfig()
	ct := tab.NewConnectionsTab(cfg, "/tmp/test.json")

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
	cfg := &config.Config{
		Version:     1,
		Connections: make(map[string]config.Connection),
	}
	ct := tab.NewConnectionsTab(cfg, "/tmp/test.json")

	view := ct.View()
	if !strings.Contains(view, "No connections configured") {
		t.Errorf("expected empty-state message in view, got:\n%s", view)
	}
}

func TestConnectionsTab_EnterEmitsConfigReloadedMsg(t *testing.T) {
	cfg := twoConnConfig()
	// Set active to local; press Enter on staging.
	ct := tab.NewConnectionsTab(cfg, "/tmp/test.json")

	// Initialize the model.
	ct.Init()

	// Send a window size so the list renders.
	updated, _ := ct.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	ct = updated.(tab.ConnectionsTab)

	// Move cursor down to staging (second item).
	updated, _ = ct.Update(tea.KeyMsg{Type: tea.KeyDown})
	ct = updated.(tab.ConnectionsTab)

	// Press Enter.
	updated, cmds := ct.Update(tea.KeyMsg{Type: tea.KeyEnter})
	_ = updated

	if cmds == nil {
		t.Fatal("expected a command from Enter, got nil")
	}
	msg := cmds()
	if _, ok := msg.(tui.ConfigReloadedMsg); !ok {
		t.Errorf("expected tui.ConfigReloadedMsg, got %T", msg)
	}
}

func TestConnectionsTab_Title(t *testing.T) {
	cfg := &config.Config{Version: 1, Connections: make(map[string]config.Connection)}
	ct := tab.NewConnectionsTab(cfg, "/tmp/test.json")
	if ct.Title() != "Connections" {
		t.Errorf("expected Title() == 'Connections', got %q", ct.Title())
	}
}
