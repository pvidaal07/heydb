package tui

import (
	tea "github.com/charmbracelet/bubbletea"

	"github.com/pvidaal07/heydb/internal/config"
	"github.com/pvidaal07/heydb/internal/domain/ports"
)

// Tab is implemented by every top-level tab in the TUI.
type Tab interface {
	tea.Model
	Title() string
	ShortHelp() string
}

// ConfigReloadedMsg is broadcast when the connection config changes (add, edit,
// delete, or switch active). All tabs must handle it to stay consistent.
type ConfigReloadedMsg struct {
	Cfg *config.Config
}

// StoreOpenedMsg carries a freshly opened SchemaStore so the Schema and Search
// tabs can share the same store instance without each tab opening its own.
type StoreOpenedMsg struct {
	Store ports.SchemaStore
}

// SwitchTabMsg instructs the root model to activate the tab at Index.
type SwitchTabMsg struct {
	Index int
}
