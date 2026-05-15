package tab

import (
	"context"
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/pvidaal07/heydb/internal/cli/tui"
	"github.com/pvidaal07/heydb/internal/domain/ports"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// SearchTab provides keyword search across table and column names.
// It has two modes:
//   - input mode: textinput is focused, typing works, Enter executes search
//   - results mode: textinput is blurred, j/k navigates results, Enter goes to
//     schema tab, Esc returns to input mode for a new search
type SearchTab struct {
	store   ports.SchemaStore
	input   textinput.Model
	results []schema.Table
	cursor  int

	hasSearched bool
	lastQuery   string

	// browsing is true when viewing results (input blurred).
	browsing bool

	width, height int
}

// NewSearchTab creates a SearchTab with an empty text input.
func NewSearchTab() SearchTab {
	ti := textinput.New()
	ti.Placeholder = "Type a keyword and press Enter..."
	ti.Focus()
	return SearchTab{input: ti}
}

func (s SearchTab) Title() string     { return "Search" }
func (s SearchTab) ShortHelp() string { return "enter: search / select  esc: new search" }

func (s SearchTab) Init() tea.Cmd {
	return textinput.Blink
}

func (s SearchTab) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.width = msg.Width
		s.height = msg.Height
		return s, nil

	case tui.StoreOpenedMsg:
		s.store = msg.Store
		s.results = nil
		s.hasSearched = false
		s.lastQuery = ""
		s.cursor = 0
		s.browsing = false
		s.input.SetValue("")
		s.input.Focus()
		return s, nil

	case tui.ConfigReloadedMsg:
		s.store = nil
		s.results = nil
		s.hasSearched = false
		s.lastQuery = ""
		s.cursor = 0
		s.browsing = false
		s.input.SetValue("")
		s.input.Focus()
		return s, nil

	case tea.KeyMsg:
		if s.browsing {
			return s.updateBrowsing(msg)
		}
		return s.updateInput(msg)
	}

	// Delegate remaining messages to the text input.
	var cmd tea.Cmd
	s.input, cmd = s.input.Update(msg)
	return s, cmd
}

// updateInput handles keys when the text input is focused.
func (s SearchTab) updateInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.Type == tea.KeyEnter {
		return s.executeSearch()
	}

	// Let textinput handle everything else (typing, backspace, etc.).
	var cmd tea.Cmd
	s.input, cmd = s.input.Update(msg)
	return s, cmd
}

// updateBrowsing handles keys when navigating search results.
func (s SearchTab) updateBrowsing(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case msg.Type == tea.KeyEsc:
		// Back to input mode for a new search.
		s.browsing = false
		s.input.Focus()
		return s, nil

	case msg.Type == tea.KeyEnter:
		if len(s.results) > 0 {
			return s, func() tea.Msg { return tui.SwitchTabMsg{Index: 1} }
		}
		return s, nil

	case msg.Type == tea.KeyUp || (msg.Type == tea.KeyRunes && string(msg.Runes) == "k"):
		if s.cursor > 0 {
			s.cursor--
		}
		return s, nil

	case msg.Type == tea.KeyDown || (msg.Type == tea.KeyRunes && string(msg.Runes) == "j"):
		if s.cursor < len(s.results)-1 {
			s.cursor++
		}
		return s, nil

	case msg.Type == tea.KeyRunes:
		// Any other typing — switch back to input mode and forward the key.
		s.browsing = false
		s.input.Focus()
		var cmd tea.Cmd
		s.input, cmd = s.input.Update(msg)
		return s, cmd
	}

	return s, nil
}

func (s SearchTab) View() string {
	if s.store == nil {
		return tui.EmptyStateStyle.Render(
			"No active connection.\n\nSet an active connection in the Connections tab.",
		)
	}

	var b strings.Builder

	b.WriteString(tui.HeadingStyle.Render("Search"))
	b.WriteString("\n\n")
	b.WriteString(s.input.View())
	b.WriteString("\n\n")

	if !s.hasSearched {
		b.WriteString(tui.EmptyStateStyle.Render("Type a keyword and press Enter to search tables and columns."))
		return b.String()
	}

	if len(s.results) == 0 {
		b.WriteString(tui.EmptyStateStyle.Render(
			fmt.Sprintf("No tables or columns matching %q found.", s.lastQuery),
		))
		return b.String()
	}

	b.WriteString(tui.SubtextStyle.Render(fmt.Sprintf("%d result(s) for %q", len(s.results), s.lastQuery)))
	b.WriteString("\n\n")

	for i, t := range s.results {
		var matchingCols []string
		for _, c := range t.Columns {
			if strings.Contains(strings.ToLower(c.Name), strings.ToLower(s.lastQuery)) {
				matchingCols = append(matchingCols, c.Name)
			}
		}

		colHint := ""
		if len(matchingCols) > 0 {
			colHint = "cols: " + strings.Join(matchingCols, ", ")
		}

		if i == s.cursor && s.browsing {
			b.WriteString(tui.SelectedStyle.Render(tui.Cursor + t.Name))
			b.WriteString("\n")
			if colHint != "" {
				b.WriteString(tui.SubtextStyle.Render("    " + colHint))
				b.WriteString("\n")
			}
		} else {
			b.WriteString(tui.UnselectedStyle.Render("  " + t.Name))
			b.WriteString("\n")
			if colHint != "" {
				b.WriteString(tui.SubtextStyle.Render("    " + colHint))
				b.WriteString("\n")
			}
		}
	}

	b.WriteString("\n")
	if s.browsing {
		b.WriteString(tui.HelpStyle.Render("Enter: go to Schema tab  Esc: new search  j/k: navigate"))
	} else {
		b.WriteString(tui.HelpStyle.Render("j/k: browse results  Enter: search again  Esc: clear"))
	}

	return b.String()
}

func (s SearchTab) executeSearch() (tea.Model, tea.Cmd) {
	query := strings.TrimSpace(s.input.Value())
	if query == "" {
		return s, nil
	}

	s.lastQuery = query
	s.hasSearched = true
	s.cursor = 0

	if s.store == nil {
		s.results = nil
		return s, nil
	}

	results, err := s.store.SearchTables(context.Background(), query)
	if err != nil {
		s.results = nil
		return s, nil
	}
	s.results = results

	// If we got results, switch to browsing mode.
	if len(results) > 0 {
		s.browsing = true
		s.input.Blur()
	}

	return s, nil
}
