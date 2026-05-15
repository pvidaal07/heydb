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

	tables []schema.Table
	loaded bool

	// List state.
	cursor int

	// Detail view state.
	inDetail      bool
	selectedTable *schema.Table
	detailScroll  int // scroll offset within the detail view
	detailLines   int // total rendered lines in detail

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
		if s.store != nil {
			_ = s.store.Close()
		}
		s.store = msg.Store
		s.loaded = false
		s.tables = nil
		s.inDetail = false
		s.selectedTable = nil
		s.detailScroll = 0
		s.cursor = 0
		if s.store != nil {
			s = s.loadSchema()
		}
		return s, nil

	case tui.ConfigReloadedMsg:
		if s.store != nil {
			_ = s.store.Close()
		}
		s.store = nil
		s.loaded = false
		s.tables = nil
		s.inDetail = false
		s.selectedTable = nil
		s.detailScroll = 0
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
			s.detailScroll = 0
		}
	}
	return s, nil
}

func (s SchemaTab) updateDetail(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case msg.Type == tea.KeyEsc:
		s.inDetail = false
		s.selectedTable = nil
		s.detailScroll = 0
	case msg.Type == tea.KeyUp || (msg.Type == tea.KeyRunes && string(msg.Runes) == "k"):
		if s.detailScroll > 0 {
			s.detailScroll--
		}
	case msg.Type == tea.KeyDown || (msg.Type == tea.KeyRunes && string(msg.Runes) == "j"):
		maxScroll := s.detailLines - s.viewportHeight()
		if maxScroll < 0 {
			maxScroll = 0
		}
		if s.detailScroll < maxScroll {
			s.detailScroll++
		}
	}
	return s, nil
}

// viewportHeight returns available lines for the detail content.
func (s SchemaTab) viewportHeight() int {
	// Reserve space for header area in the root model (logo, tabs, status, help).
	h := s.height - 2
	if h < 5 {
		h = 5
	}
	return h
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

	// Viewport scroll for table list.
	visible := s.viewportHeight() - 3 // heading + blank + help
	if visible < 1 {
		visible = len(s.tables)
	}

	start := 0
	if s.cursor >= start+visible {
		start = s.cursor - visible + 1
	}
	if start < 0 {
		start = 0
	}
	end := start + visible
	if end > len(s.tables) {
		end = len(s.tables)
	}

	for i := start; i < end; i++ {
		t := s.tables[i]
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

	if len(s.tables) > visible {
		b.WriteString("\n")
		b.WriteString(tui.SubtextStyle.Render(fmt.Sprintf("  showing %d–%d of %d tables", start+1, end, len(s.tables))))
	}

	return b.String()
}

func (s *SchemaTab) renderDetail() string {
	t := s.selectedTable

	// Build full content first, then apply scroll viewport.
	var lines []string

	lines = append(lines, tui.TitleStyle.Render(t.Name))
	lines = append(lines, "")

	// Columns.
	lines = append(lines, tui.HeadingStyle.Render(fmt.Sprintf("Columns (%d)", len(t.Columns))))
	if len(t.Columns) == 0 {
		lines = append(lines, tui.SubtextStyle.Render("  (none)"))
	} else {
		for _, c := range t.Columns {
			nullable := " NOT NULL"
			if c.Nullable {
				nullable = " NULL"
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
			lines = append(lines, tui.UnselectedStyle.Render(line))
		}
	}

	// Indexes.
	if len(t.Indexes) > 0 {
		lines = append(lines, "")
		lines = append(lines, tui.HeadingStyle.Render(fmt.Sprintf("Indexes (%d)", len(t.Indexes))))
		for _, idx := range t.Indexes {
			unique := ""
			if idx.Unique {
				unique = " UNIQUE"
			}
			line := fmt.Sprintf("  %-20s %s%s (%s)", idx.Name, idx.Type, unique, strings.Join(idx.Columns, ", "))
			lines = append(lines, tui.SubtextStyle.Render(line))
		}
	}

	// Foreign keys.
	if len(t.ForeignKeys) > 0 {
		lines = append(lines, "")
		lines = append(lines, tui.HeadingStyle.Render(fmt.Sprintf("Foreign Keys (%d)", len(t.ForeignKeys))))
		for _, fk := range t.ForeignKeys {
			line := fmt.Sprintf("  %-20s %s → %s(%s)", fk.Name, fk.Column, fk.ReferencedTable, fk.ReferencedColumn)
			lines = append(lines, tui.SubtextStyle.Render(line))
		}
	}

	lines = append(lines, "")
	lines = append(lines, tui.HelpStyle.Render("j/k: scroll  Esc: back to list"))

	// Store total lines for scroll bounds.
	s.detailLines = len(lines)

	// Apply scroll viewport.
	vpHeight := s.viewportHeight()
	start := s.detailScroll
	if start >= len(lines) {
		start = max(0, len(lines)-1)
	}
	end := start + vpHeight
	if end > len(lines) {
		end = len(lines)
	}

	visible := lines[start:end]

	// Scroll indicator.
	if s.detailLines > vpHeight {
		scrollPct := 0
		maxScroll := s.detailLines - vpHeight
		if maxScroll > 0 {
			scrollPct = (s.detailScroll * 100) / maxScroll
		}
		indicator := tui.SubtextStyle.Render(fmt.Sprintf("  [scroll %d%%]", scrollPct))
		visible = append(visible, indicator)
	}

	content := strings.Join(visible, "\n")

	detailW := s.width - 4
	if detailW < 20 {
		detailW = 60
	}
	return lipgloss.NewStyle().Width(detailW).Render(content)
}

func (s SchemaTab) loadSchema() SchemaTab {
	sc, err := s.store.LoadSchema(context.Background())
	if err == nil {
		s.tables = sc.Tables
	}
	s.loaded = true
	return s
}
