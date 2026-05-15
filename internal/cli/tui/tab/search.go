package tab

import (
	tea "github.com/charmbracelet/bubbletea"

	"github.com/pvidaal07/heydb/internal/cli/tui"
)

// SearchTab will provide keyword search across table and column names.
// This is a placeholder for PR 1; full implementation is in PR 2.
type SearchTab struct{}

// NewSearchTab creates a SearchTab placeholder.
func NewSearchTab() SearchTab { return SearchTab{} }

func (s SearchTab) Title() string     { return "Search" }
func (s SearchTab) ShortHelp() string { return "search schema" }

func (s SearchTab) Init() tea.Cmd { return nil }

func (s SearchTab) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg.(type) {
	case tui.StoreOpenedMsg:
		// Will receive the shared store. Stub: no-op.
	}
	return s, nil
}

func (s SearchTab) View() string {
	return "Search — coming soon.\n\nType a keyword and press Enter to search tables and columns."
}
