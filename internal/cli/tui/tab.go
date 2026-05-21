package tui

import (
	tea "github.com/charmbracelet/bubbletea"

	"github.com/pvidaal07/heydb/internal/domain/ports"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// Tab is implemented by every top-level tab in the TUI.
type Tab interface {
	tea.Model
	Title() string
	ShortHelp() string
}

// ConnectionsChangedMsg is broadcast when the connection list changes (add, edit,
// delete, or switch active). All tabs must handle it to stay consistent.
type ConnectionsChangedMsg struct {
	Connections    []schema.Connection // all connections for current project
	ActiveConnName string              // name of active connection
}

// StoreOpenedMsg carries a freshly opened SchemaStore so the Schema and Search
// tabs can share the same store instance without each tab opening its own.
// Annotations is optional; when the store implements ports.AnnotationStore,
// it is set automatically.
type StoreOpenedMsg struct {
	Store       ports.SchemaStore
	Annotations ports.AnnotationStore
}

// SwitchTabMsg instructs the root model to activate the tab at Index.
// FocusTable optionally tells the target tab to open a specific table's detail.
type SwitchTabMsg struct {
	Index      int
	FocusTable string
}
