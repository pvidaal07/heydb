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
// Two modes: input (textinput focused) and browsing (results navigation).
type SearchTab struct {
	store   ports.SchemaStore
	input   textinput.Model
	results []schema.Table
	cursor  int

	hasSearched bool
	lastQuery   string
	browsing    bool
	scrollOff   int

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

// maxVisibleResults returns how many result items fit.
// Chrome: heading(1) + blank(1) + input(1) + blank(1) + results header(1) + blank(1) + help(1) = 7
// Each result = 2 lines (name + col hint).
func (s SearchTab) maxVisibleResults() int {
	n := (s.height - 7) / 2
	if n < 1 {
		n = 1
	}
	return n
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
		s.scrollOff = 0
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
		s.scrollOff = 0
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

	var cmd tea.Cmd
	s.input, cmd = s.input.Update(msg)
	return s, cmd
}

func (s SearchTab) updateInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.Type == tea.KeyEnter {
		return s.executeSearch()
	}

	var cmd tea.Cmd
	s.input, cmd = s.input.Update(msg)
	return s, cmd
}

func (s SearchTab) updateBrowsing(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case msg.Type == tea.KeyEsc:
		s.browsing = false
		s.input.Focus()
		return s, nil

	case msg.Type == tea.KeyEnter:
		if len(s.results) > 0 && s.cursor < len(s.results) {
			tableName := s.results[s.cursor].Name
			return s, func() tea.Msg {
				return tui.SwitchTabMsg{Index: 1, FocusTable: tableName}
			}
		}
		return s, nil

	case msg.Type == tea.KeyUp || (msg.Type == tea.KeyRunes && string(msg.Runes) == "k"):
		if s.cursor > 0 {
			s.cursor--
			if s.cursor < s.scrollOff {
				s.scrollOff = s.cursor
			}
		}
		return s, nil

	case msg.Type == tea.KeyDown || (msg.Type == tea.KeyRunes && string(msg.Runes) == "j"):
		if s.cursor < len(s.results)-1 {
			s.cursor++
			vis := s.maxVisibleResults()
			if s.cursor >= s.scrollOff+vis {
				s.scrollOff = s.cursor - vis + 1
			}
		}
		return s, nil

	case msg.Type == tea.KeyRunes:
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

	vis := s.maxVisibleResults()
	start := s.scrollOff
	end := start + vis
	if end > len(s.results) {
		end = len(s.results)
	}

	for i := start; i < end; i++ {
		t := s.results[i]
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
		} else {
			b.WriteString(tui.UnselectedStyle.Render("  " + t.Name))
		}
		b.WriteString("\n")
		if colHint != "" {
			b.WriteString(tui.SubtextStyle.Render("    " + colHint))
			b.WriteString("\n")
		}
	}

	if len(s.results) > vis {
		b.WriteString(tui.SubtextStyle.Render(fmt.Sprintf("  %d–%d of %d results", start+1, end, len(s.results))))
		b.WriteString("\n")
	}

	if s.browsing {
		b.WriteString(tui.HelpStyle.Render("Enter: go to Schema tab  Esc: new search  j/k: navigate"))
	} else {
		b.WriteString(tui.HelpStyle.Render("j/k: browse results  Enter: search again"))
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
	s.scrollOff = 0

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

	if len(results) > 0 {
		s.browsing = true
		s.input.Blur()
	}

	return s, nil
}
