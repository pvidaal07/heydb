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
	store       ports.SchemaStore
	annotations ports.AnnotationStore

	tables []schema.Table
	loaded bool

	cursor    int
	scrollOff int // first visible item index in list view

	inDetail      bool
	selectedTable *schema.Table
	detailScroll  int
	detailLines   int

	width, height int
}

// NewSchemaTab creates a SchemaTab. store may be nil until a connection is active.
// annotations is optional; when provided, column annotations are shown in detail view.
func NewSchemaTab(store ports.SchemaStore, annotations ports.AnnotationStore) SchemaTab {
	return SchemaTab{store: store, annotations: annotations}
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
		s.annotations = msg.Annotations
		s.loaded = false
		s.tables = nil
		s.inDetail = false
		s.selectedTable = nil
		s.detailScroll = 0
		s.cursor = 0
		s.scrollOff = 0
		if s.store != nil {
			s = s.loadSchema()
		}
		return s, nil

	case tui.ConnectionsChangedMsg:
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
		s.scrollOff = 0
		return s, nil

	case tui.SwitchTabMsg:
		if msg.FocusTable != "" {
			for i, t := range s.tables {
				if t.Name == msg.FocusTable {
					s.cursor = i
					s.selectedTable = &s.tables[i]
					s.inDetail = true
					s.detailScroll = 0
					s.detailLines = s.countDetailLines()
					break
				}
			}
		}
		return s, nil

	case tea.KeyMsg:
		if s.inDetail {
			return s.updateDetail(msg)
		}
		return s.updateList(msg)
	}

	return s, nil
}

// maxVisibleItems returns how many list items fit in the available height.
// Each item takes 2 lines (name + description). We reserve 2 lines for
// the heading and 1 for the scroll indicator.
func (s SchemaTab) maxVisibleItems() int {
	n := (s.height - 3) / 2 // 3 = heading(1) + blank(1) + indicator(1)
	if n < 1 {
		n = 1
	}
	return n
}

func (s SchemaTab) updateList(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case msg.Type == tea.KeyUp || (msg.Type == tea.KeyRunes && string(msg.Runes) == "k"):
		if s.cursor > 0 {
			s.cursor--
			if s.cursor < s.scrollOff {
				s.scrollOff = s.cursor
			}
		}
	case msg.Type == tea.KeyDown || (msg.Type == tea.KeyRunes && string(msg.Runes) == "j"):
		if s.cursor < len(s.tables)-1 {
			s.cursor++
			vis := s.maxVisibleItems()
			if s.cursor >= s.scrollOff+vis {
				s.scrollOff = s.cursor - vis + 1
			}
		}
	case msg.Type == tea.KeyEnter:
		if len(s.tables) > 0 && s.cursor < len(s.tables) {
			t := s.tables[s.cursor]
			s.selectedTable = &t
			s.inDetail = true
			s.detailScroll = 0
			s.detailLines = s.countDetailLines()
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
		maxScroll := s.detailLines - s.height
		if maxScroll < 0 {
			maxScroll = 0
		}
		if s.detailScroll < maxScroll {
			s.detailScroll++
		}
	}
	return s, nil
}

// countDetailLines calculates how many lines the detail view will render.
func (s SchemaTab) countDetailLines() int {
	if s.selectedTable == nil {
		return 0
	}
	t := s.selectedTable
	n := 2 // title + blank
	n++    // columns heading
	if len(t.Columns) == 0 {
		n++
	} else {
		n += len(t.Columns)
		// NOTE: column annotations display deferred to PR-5 (v2 annotation redesign).
	}
	if len(t.Indexes) > 0 {
		n += 1 + 1 + len(t.Indexes) // blank + heading + items
	}
	if len(t.ForeignKeys) > 0 {
		n += 1 + 1 + len(t.ForeignKeys)
	}
	n += 2 // blank + help line
	return n
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

func (s SchemaTab) renderList() string {
	var b strings.Builder
	b.WriteString(tui.HeadingStyle.Render("Tables"))
	b.WriteString("\n\n")

	vis := s.maxVisibleItems()
	start := s.scrollOff
	end := start + vis
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
		} else {
			b.WriteString(tui.UnselectedStyle.Render("  " + t.Name))
		}
		b.WriteString("\n")
		b.WriteString(tui.SubtextStyle.Render("    " + desc))
		b.WriteString("\n")
	}

	if len(s.tables) > vis {
		b.WriteString(tui.SubtextStyle.Render(fmt.Sprintf("  %d–%d of %d tables", start+1, end, len(s.tables))))
	}

	return b.String()
}

func (s SchemaTab) renderDetail() string {
	t := s.selectedTable

	// Build all content lines first.
	var lines []string
	lines = append(lines, tui.TitleStyle.Render(t.Name))
	lines = append(lines, "")

	// NOTE: column annotations display deferred to PR-5 (v2 annotation redesign).

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

	// Viewport: slice the lines to fit s.height.
	vpHeight := s.height
	if vpHeight < 1 {
		vpHeight = 1
	}
	start := s.detailScroll
	if start > len(lines)-vpHeight {
		start = max(0, len(lines)-vpHeight)
	}
	end := start + vpHeight
	if end > len(lines) {
		end = len(lines)
	}

	visible := lines[start:end]

	// Scroll indicator when content doesn't fit.
	if len(lines) > vpHeight && vpHeight > 1 {
		maxScroll := len(lines) - vpHeight
		pct := 0
		if maxScroll > 0 {
			pct = (s.detailScroll * 100) / maxScroll
		}
		// Replace last visible line with the indicator.
		visible[len(visible)-1] = tui.SubtextStyle.Render(fmt.Sprintf("  [scroll %d%%] j/k: scroll  Esc: back", pct))
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
