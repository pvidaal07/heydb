package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/pvidaal07/heydb/internal/config"
)

const minWidth = 60

// Model is the root Bubbletea model. It owns tab routing, terminal dimensions,
// and shared configuration state.
type Model struct {
	tabs      []Tab
	activeTab int
	width     int
	height    int
	cfg       *config.Config
	cfgPath   string
	version   string
}

// New creates a root Model with all three tabs initialized.
// Tabs are created in import order: Connections (0), Schema (1), Search (2).
// The actual tab constructors are injected after the tab sub-package is ready;
// this constructor is called from tui_cmd.go via a factory function registered
// by each tab package's init().
func New(cfg *config.Config, cfgPath, version string) Model {
	return Model{
		cfg:     cfg,
		cfgPath: cfgPath,
		version: version,
	}
}

// WithTabs sets the tabs slice on the model. Called by the factory registered
// in tui_cmd.go so that the tab sub-package can be imported without a cycle.
func (m Model) WithTabs(tabs []Tab) Model {
	m.tabs = tabs
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
		return m.fanOut(msg)

	case tea.KeyMsg:
		switch {
		case msg.Type == tea.KeyCtrlC:
			return m, tea.Quit

		case msg.Type == tea.KeyRunes && string(msg.Runes) == "q":
			if len(m.tabs) == 0 {
				return m, tea.Quit
			}
			// Let the active tab decide first; if no overlay is active, quit.
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
		return m.fanOut(msg)

	case SwitchTabMsg:
		if msg.Index >= 0 && msg.Index < len(m.tabs) {
			m.activeTab = msg.Index
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

// View renders the full TUI: tab bar, active tab content, and status bar.
func (m Model) View() string {
	if m.width < minWidth {
		return NarrowWarningStyle.Render(
			fmt.Sprintf("Terminal too narrow (%d cols). Minimum is %d.", m.width, minWidth),
		)
	}

	var b strings.Builder
	b.WriteString(m.renderTabBar())
	b.WriteString("\n")

	if len(m.tabs) > 0 {
		b.WriteString(m.tabs[m.activeTab].View())
	}

	b.WriteString("\n")
	b.WriteString(m.renderStatusBar())

	return b.String()
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
	activeConn := "no active connection"
	if m.cfg != nil && m.cfg.ActiveConnection != "" {
		activeConn = m.cfg.ActiveConnection
	}

	left := StatusBarHighlight.Render(activeConn)
	right := StatusBarStyle.Render(fmt.Sprintf("heydb %s", m.version))

	if m.width > 0 {
		gap := m.width - lipgloss.Width(left) - lipgloss.Width(right)
		if gap > 0 {
			left = StatusBarStyle.Render(activeConn)
			bar := left + strings.Repeat(" ", gap) + right
			return StatusBarStyle.Width(m.width).Render(bar)
		}
	}

	return StatusBarStyle.Render(fmt.Sprintf("%s  %s", activeConn, m.version))
}
