package tui

import "github.com/charmbracelet/lipgloss"

// Rose Pine color palette — matching gentle-ai ecosystem aesthetics.
var (
	ColorBase     = lipgloss.Color("#191724")
	ColorSurface  = lipgloss.Color("#1f1d2e")
	ColorOverlay  = lipgloss.Color("#6e6a86")
	ColorText     = lipgloss.Color("#e0def4")
	ColorSubtext  = lipgloss.Color("#908caa")
	ColorLavender = lipgloss.Color("#c4a7e7")
	ColorGreen    = lipgloss.Color("#9ccfd8")
	ColorPeach    = lipgloss.Color("#f6c177")
	ColorRed      = lipgloss.Color("#eb6f92")
	ColorBlue     = lipgloss.Color("#31748f")
	ColorMauve    = lipgloss.Color("#ebbcba")
	ColorGold     = lipgloss.Color("#f6c177")
)

// Cursor is the prefix for the currently focused item.
const Cursor = "▸ "

var (
	// TitleStyle for headings and section titles.
	TitleStyle = lipgloss.NewStyle().
			Foreground(ColorLavender).
			Bold(true)

	// HeadingStyle for sub-headings.
	HeadingStyle = lipgloss.NewStyle().
			Foreground(ColorMauve).
			Bold(true)

	// SelectedStyle for the active/focused item.
	SelectedStyle = lipgloss.NewStyle().
			Foreground(ColorLavender).
			Bold(true)

	// UnselectedStyle for non-focused items.
	UnselectedStyle = lipgloss.NewStyle().
			Foreground(ColorText)

	// HelpStyle for keyboard hints at the bottom.
	HelpStyle = lipgloss.NewStyle().
			Foreground(ColorSubtext)

	// SubtextStyle for secondary information.
	SubtextStyle = lipgloss.NewStyle().
			Foreground(ColorSubtext)

	// SuccessStyle for positive indicators.
	SuccessStyle = lipgloss.NewStyle().
			Foreground(ColorGreen)

	// FrameStyle wraps the entire TUI view.
	FrameStyle = lipgloss.NewStyle().
			Border(lipgloss.DoubleBorder()).
			BorderForeground(ColorLavender).
			Padding(1, 2)

	// PanelStyle for content panels within tabs.
	PanelStyle = lipgloss.NewStyle().
			Border(lipgloss.NormalBorder()).
			BorderForeground(ColorOverlay).
			Padding(0, 1)

	// TabBarStyle wraps the tab bar row.
	TabBarStyle = lipgloss.NewStyle().
			PaddingBottom(1)

	// ActiveTabStyle renders the currently selected tab label.
	ActiveTabStyle = lipgloss.NewStyle().
			Foreground(ColorLavender).
			Bold(true).
			Padding(0, 2).
			Border(lipgloss.NormalBorder(), false, false, true, false).
			BorderForeground(ColorLavender)

	// InactiveTabStyle renders unselected tab labels.
	InactiveTabStyle = lipgloss.NewStyle().
				Foreground(ColorSubtext).
				Padding(0, 2)

	// StatusBarStyle styles the bottom status bar.
	StatusBarStyle = lipgloss.NewStyle().
			Foreground(ColorSubtext)

	// StatusBarHighlight styles the active connection name in the status bar.
	StatusBarHighlight = lipgloss.NewStyle().
				Foreground(ColorGreen).
				Bold(true)

	// EmptyStateStyle renders placeholder messages.
	EmptyStateStyle = lipgloss.NewStyle().
			Foreground(ColorOverlay).
			Italic(true).
			Padding(1, 2)

	// DetailLabelStyle for detail panel labels.
	DetailLabelStyle = lipgloss.NewStyle().
				Foreground(ColorSubtext)

	// DetailValueStyle for detail panel values.
	DetailValueStyle = lipgloss.NewStyle().
				Foreground(ColorText)

	// DetailPanelStyle wraps the connection detail panel.
	DetailPanelStyle = lipgloss.NewStyle().
				Border(lipgloss.RoundedBorder()).
				BorderForeground(ColorOverlay).
				Padding(1, 2)

	// NarrowWarningStyle renders the "terminal too narrow" guard message.
	NarrowWarningStyle = lipgloss.NewStyle().
				Foreground(ColorOverlay).
				Padding(1, 2)
)
