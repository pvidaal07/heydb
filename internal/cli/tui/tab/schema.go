package tab

import (
	"context"
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/pvidaal07/heydb/internal/cli/tui"
	"github.com/pvidaal07/heydb/internal/domain/ports"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// SchemaTab shows the schema browser: a table list with drill-down to detail view.
type SchemaTab struct {
	store ports.SchemaStore

	// tables holds the loaded schema tables.
	tables []schema.Table
	loaded bool

	// List state.
	cursor int

	// inDetail is true when showing the detail view for selectedTable.
	inDetail      bool
	selectedTable *schema.Table

	width, height int
}

// NewSchemaTab creates a SchemaTab. store may be nil until a connection is active.
func NewSchemaTab(store ports.SchemaStore) SchemaTab {
	return SchemaTab{store: store}
}

func (s SchemaTab) Title() string     { return "Schema" }
func (s SchemaTab) ShortHelp() string { return "enter: detail  esc: back  j/k: navigate" }

func (s SchemaTab) Init() tea.Cmd { return nil }

func (s SchemaTab) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.width = msg.Width
		s.height = msg.Height
		if s.store != nil && !s.loaded {
			s = s.loadSchema()
		}
		return s, nil

	case tui.StoreOpenedMsg:
		// Receive a new store (or nil to clear).
		if s.store != nil {
			_ = s.store.Close()
		}
		s.store = msg.Store
		s.loaded = false
		s.tables = nil
		s.inDetail = false
		s.selectedTable = nil
		s.cursor = 0
		if s.store != nil {
			s = s.loadSchema()
		}
		return s, nil

	case tui.ConfigReloadedMsg:
		// Connection changed — clear the store and schema data. The root model
		// will send a StoreOpenedMsg with the new store.
		if s.store != nil {
			_ = s.store.Close()
		}
		s.store = nil
		s.loaded = false
		s.tables = nil
		s.inDetail = false
		s.selectedTable = nil
		s.cursor = 0
		return s, nil

	case tea.KeyMsg:
		if s.inDetail {
			return s.updateDetail(msg)
		}
		return s.updateList(msg)
	}

	return s, nil
}

func (s SchemaTab) updateList(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case msg.Type == tea.KeyUp || (msg.Type == tea.KeyRunes && string(msg.Runes) == "k"):
		if s.cursor > 0 {
			s.cursor--
		}
	case msg.Type == tea.KeyDown || (msg.Type == tea.KeyRunes && string(msg.Runes) == "j"):
		if s.cursor < len(s.tables)-1 {
			s.cursor++
		}
	case msg.Type == tea.KeyEnter:
		if len(s.tables) > 0 && s.cursor < len(s.tables) {
			t := s.tables[s.cursor]
			s.selectedTable = &t
			s.inDetail = true
		}
	}
	return s, nil
}

func (s SchemaTab) updateDetail(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.Type == tea.KeyEsc {
		s.inDetail = false
		s.selectedTable = nil
	}
	return s, nil
}

func (s SchemaTab) View() string {
	if s.store == nil {
		return tui.EmptyStateStyle.Render(
			"No active connection.\n\nSet an active connection in the Connections tab.",
		)
	}

	if s.loaded && len(s.tables) == 0 {
		return tui.EmptyStateStyle.Render(
			"No schema data found.\n\nRun `heydb sync` to introspect the active database.",
		)
	}

	if s.inDetail && s.selectedTable != nil {
		return s.renderDetail()
	}

	return s.renderList()
}

// ── rendering ─────────────────────────────────────────────────────────────────

func (s *SchemaTab) renderList() string {
	var b strings.Builder
	b.WriteString(tui.HeadingStyle.Render("Tables"))
	b.WriteString("\n\n")

	for i, t := range s.tables {
		colCount := len(t.Columns)
		desc := fmt.Sprintf("%d column", colCount)
		if colCount != 1 {
			desc += "s"
		}

		if i == s.cursor {
			b.WriteString(tui.SelectedStyle.Render(tui.Cursor + t.Name))
			b.WriteString("\n")
			b.WriteString(tui.SubtextStyle.Render("    " + desc))
		} else {
			b.WriteString(tui.UnselectedStyle.Render("  " + t.Name))
			b.WriteString("\n")
			b.WriteString(tui.SubtextStyle.Render("    " + desc))
		}
		b.WriteString("\n")
	}

	return b.String()
}

func (s *SchemaTab) renderDetail() string {
	t := s.selectedTable
	var b strings.Builder

	b.WriteString(tui.TitleStyle.Render(t.Name))
	b.WriteString("\n\n")

	// Columns section.
	b.WriteString(tui.HeadingStyle.Render("Columns"))
	b.WriteString("\n")
	if len(t.Columns) == 0 {
		b.WriteString(tui.SubtextStyle.Render("  (none)"))
		b.WriteString("\n")
	} else {
		for _, c := range t.Columns {
			nullable := ""
			if c.Nullable {
				nullable = " NULL"
			} else {
				nullable = " NOT NULL"
			}
			extra := ""
			if c.Extra != "" {
				extra = " [" + c.Extra + "]"
			}
			comment := ""
			if c.Comment != "" {
				comment = " — " + c.Comment
			}
			line := fmt.Sprintf("  %-20s %s%s%s%s", c.Name, c.Type, nullable, extra, comment)
			b.WriteString(tui.UnselectedStyle.Render(line))
			b.WriteString("\n")
		}
	}

	// Indexes section.
	if len(t.Indexes) > 0 {
		b.WriteString("\n")
		b.WriteString(tui.HeadingStyle.Render("Indexes"))
		b.WriteString("\n")
		for _, idx := range t.Indexes {
			unique := ""
			if idx.Unique {
				unique = " UNIQUE"
			}
			line := fmt.Sprintf("  %-20s %s%s (%s)", idx.Name, idx.Type, unique, strings.Join(idx.Columns, ", "))
			b.WriteString(tui.SubtextStyle.Render(line))
			b.WriteString("\n")
		}
	}

	// Foreign keys section.
	if len(t.ForeignKeys) > 0 {
		b.WriteString("\n")
		b.WriteString(tui.HeadingStyle.Render("Foreign Keys"))
		b.WriteString("\n")
		for _, fk := range t.ForeignKeys {
			line := fmt.Sprintf("  %-20s %s → %s(%s)", fk.Name, fk.Column, fk.ReferencedTable, fk.ReferencedColumn)
			b.WriteString(tui.SubtextStyle.Render(line))
			b.WriteString("\n")
		}
	}

	// Help hint.
	b.WriteString("\n")
	b.WriteString(tui.HelpStyle.Render("Esc: back to list"))

	detailW := s.width - 4
	if detailW < 20 {
		detailW = 60
	}
	return lipgloss.NewStyle().Width(detailW).Render(b.String())
}

// loadSchema calls store.LoadSchema and populates s.tables. Returns updated s.
func (s SchemaTab) loadSchema() SchemaTab {
	sc, err := s.store.LoadSchema(context.Background())
	if err == nil {
		s.tables = sc.Tables
	}
	s.loaded = true
	return s
}
