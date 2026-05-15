package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/pvidaal07/heydb/internal/config"
	"github.com/pvidaal07/heydb/internal/domain/ports"
)

const minWidth = 60

// StoreOpener is a function that opens a SchemaStore for the given connection
// name. It returns nil, nil when no store is available (e.g. no sync data yet).
type StoreOpener func(connName string) (ports.SchemaStore, error)

// Model is the root Bubbletea model. It owns tab routing, terminal dimensions,
// and shared configuration state.
type Model struct {
	tabs        []Tab
	activeTab   int
	width       int
	height      int
	cfg         *config.Config
	cfgPath     string
	version     string
	storeOpener StoreOpener
}

// New creates a root Model with all three tabs initialized.
func New(cfg *config.Config, cfgPath, version string) Model {
	return Model{
		cfg:     cfg,
		cfgPath: cfgPath,
		version: version,
	}
}

// WithTabs sets the tabs slice on the model.
func (m Model) WithTabs(tabs []Tab) Model {
	m.tabs = tabs
	return m
}

// WithStoreOpener sets the function used to open a SchemaStore when the active
// connection changes.
func (m Model) WithStoreOpener(opener StoreOpener) Model {
	m.storeOpener = opener
	return m
}

// ActiveTab returns the index of the currently active tab.
func (m Model) ActiveTab() int {
	return m.activeTab
}

// Init satisfies tea.Model; delegates to each tab's Init.
func (m Model) Init() tea.Cmd {
	var cmds []tea.Cmd
	for _, t := range m.tabs {
		if cmd := t.Init(); cmd != nil {
			cmds = append(cmds, cmd)
		}
	}
	return tea.Batch(cmds...)
}

// Update handles top-level keyboard events and delegates the rest to the
// active tab.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		// Tell tabs how much space they actually have.
		innerW := msg.Width - 6 // 2 border + 2*2 padding
		innerH := msg.Height - chromeLines
		if innerW < 0 {
			innerW = 0
		}
		if innerH < 5 {
			innerH = 5
		}
		innerMsg := tea.WindowSizeMsg{Width: innerW, Height: innerH}
		return m.fanOut(innerMsg)

	case tea.KeyMsg:
		switch {
		case msg.Type == tea.KeyCtrlC:
			return m, tea.Quit

		case msg.Type == tea.KeyRunes && string(msg.Runes) == "q":
			if len(m.tabs) == 0 {
				return m, tea.Quit
			}
			updated, cmd := m.tabs[m.activeTab].Update(msg)
			m.tabs[m.activeTab] = updated.(Tab)
			if cmd != nil {
				return m, cmd
			}
			return m, tea.Quit

		case msg.Type == tea.KeyTab:
			if len(m.tabs) > 0 {
				m.activeTab = (m.activeTab + 1) % len(m.tabs)
			}
			return m, nil

		case msg.Type == tea.KeyShiftTab:
			if len(m.tabs) > 0 {
				m.activeTab = (m.activeTab - 1 + len(m.tabs)) % len(m.tabs)
			}
			return m, nil
		}

	case ConfigReloadedMsg:
		m.cfg = msg.Cfg
		// First fan-out the ConfigReloadedMsg so tabs clear their old state.
		m2, batchCmd := m.fanOut(msg)
		m = m2.(Model)
		// Then open the new store (if any) and broadcast StoreOpenedMsg.
		if m.storeOpener != nil && m.cfg != nil && m.cfg.ActiveConnection != "" {
			store, _ := m.storeOpener(m.cfg.ActiveConnection)
			m2, storeCmd := m.fanOut(StoreOpenedMsg{Store: store})
			m = m2.(Model)
			return m, tea.Batch(batchCmd, storeCmd)
		}
		// No active connection — broadcast nil store so tabs show empty state.
		m2, storeCmd := m.fanOut(StoreOpenedMsg{Store: nil})
		m = m2.(Model)
		return m, tea.Batch(batchCmd, storeCmd)

	case SwitchTabMsg:
		if msg.Index >= 0 && msg.Index < len(m.tabs) {
			m.activeTab = msg.Index
			// Forward to the target tab so it can handle FocusTable, etc.
			updated, cmd := m.tabs[m.activeTab].Update(msg)
			m.tabs[m.activeTab] = updated.(Tab)
			return m, cmd
		}
		return m, nil
	}

	if len(m.tabs) == 0 {
		return m, nil
	}
	updated, cmd := m.tabs[m.activeTab].Update(msg)
	m.tabs[m.activeTab] = updated.(Tab)
	return m, cmd
}

// fanOut sends msg to ALL tabs and collects their commands.
func (m Model) fanOut(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd
	for i, t := range m.tabs {
		updated, cmd := t.Update(msg)
		m.tabs[i] = updated.(Tab)
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
	}
	return m, tea.Batch(cmds...)
}

// chromeLines is the number of lines consumed by the root model's chrome
// (frame border, padding, logo, tagline, tab bar, status bar, help line,
// and the blank lines between them). Tab content gets the remainder.
const chromeLines = 30

// View renders the full TUI: logo, tab bar, active tab content, and status bar.
func (m Model) View() string {
	if m.width < minWidth {
		return NarrowWarningStyle.Render(
			fmt.Sprintf("Terminal too narrow (%d cols). Minimum is %d.", m.width, minWidth),
		)
	}

	var b strings.Builder

	// Logo + tagline.
	b.WriteString(RenderLogo())
	b.WriteString("\n")
	b.WriteString(SubtextStyle.Render(fmt.Sprintf("Database schema navigator — v%s", m.version)))
	b.WriteString("\n\n")

	// Tab bar.
	b.WriteString(m.renderTabBar())
	b.WriteString("\n\n")

	// Active tab content.
	if len(m.tabs) > 0 {
		b.WriteString(m.tabs[m.activeTab].View())
	}

	b.WriteString("\n\n")

	// Status bar.
	b.WriteString(m.renderStatusBar())
	b.WriteString("\n")

	// Help line.
	b.WriteString(HelpStyle.Render("Tab/Shift+Tab: switch tabs • j/k: navigate • enter: select • q: quit"))

	return FrameStyle.Width(m.width - 2).Render(b.String())
}


func (m Model) renderTabBar() string {
	var parts []string
	for i, t := range m.tabs {
		if i == m.activeTab {
			parts = append(parts, ActiveTabStyle.Render(t.Title()))
		} else {
			parts = append(parts, InactiveTabStyle.Render(t.Title()))
		}
	}
	return TabBarStyle.Render(lipgloss.JoinHorizontal(lipgloss.Left, parts...))
}

func (m Model) renderStatusBar() string {
	activeConn := SubtextStyle.Render("no active connection")
	if m.cfg != nil && m.cfg.ActiveConnection != "" {
		activeConn = StatusBarHighlight.Render(m.cfg.ActiveConnection)
	}

	return StatusBarStyle.Render(fmt.Sprintf("connection: %s", activeConn))
}
