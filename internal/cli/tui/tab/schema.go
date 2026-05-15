package tab

import (
	tea "github.com/charmbracelet/bubbletea"

	"github.com/pvidaal07/heydb/internal/cli/tui"
	"github.com/pvidaal07/heydb/internal/domain/ports"
)

// SchemaTab will show the schema browser (table list + detail drill-down).
// This is a placeholder for PR 1; full implementation is in PR 2.
type SchemaTab struct {
	store ports.SchemaStore
}

// NewSchemaTab creates a SchemaTab. store may be nil until a connection is active.
func NewSchemaTab(store ports.SchemaStore) SchemaTab {
	return SchemaTab{store: store}
}

func (s SchemaTab) Title() string     { return "Schema" }
func (s SchemaTab) ShortHelp() string { return "browse schema" }

func (s SchemaTab) Init() tea.Cmd { return nil }

func (s SchemaTab) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg.(type) {
	case tui.ConfigReloadedMsg:
		// Will close + reopen store on connection switch. Stub: no-op.
	}
	return s, nil
}

func (s SchemaTab) View() string {
	return "Schema browser — coming soon.\n\nNavigate to the Connections tab to set an active connection, then run `heydb sync`."
}
