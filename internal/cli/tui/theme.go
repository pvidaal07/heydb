package tui

import (
	catppuccin "github.com/catppuccin/go"
	"github.com/charmbracelet/lipgloss"
)

var palette = catppuccin.Mocha

var (
	colorBase    = lipgloss.Color(palette.Base().Hex)
	colorSurface = lipgloss.Color(palette.Surface0().Hex)
	colorText    = lipgloss.Color(palette.Text().Hex)
	colorSubtext = lipgloss.Color(palette.Subtext1().Hex)
	colorMauve   = lipgloss.Color(palette.Mauve().Hex)
	colorBlue    = lipgloss.Color(palette.Blue().Hex)
	colorOverlay = lipgloss.Color(palette.Overlay0().Hex)
)

var (
	// TabBarStyle wraps the full tab bar row.
	TabBarStyle = lipgloss.NewStyle().
			Background(colorBase).
			PaddingBottom(1)

	// ActiveTabStyle renders the currently selected tab label.
	ActiveTabStyle = lipgloss.NewStyle().
			Foreground(colorMauve).
			Bold(true).
			Padding(0, 2).
			Border(lipgloss.NormalBorder(), false, false, true, false).
			BorderForeground(colorMauve)

	// InactiveTabStyle renders unselected tab labels.
	InactiveTabStyle = lipgloss.NewStyle().
				Foreground(colorSubtext).
				Padding(0, 2)

	// StatusBarStyle styles the bottom status bar.
	StatusBarStyle = lipgloss.NewStyle().
			Background(colorSurface).
			Foreground(colorText).
			Padding(0, 1)

	// StatusBarHighlight styles the active connection name in the status bar.
	StatusBarHighlight = lipgloss.NewStyle().
				Foreground(colorBlue).
				Bold(true)

	// EmptyStateStyle renders the empty-state message in a tab.
	EmptyStateStyle = lipgloss.NewStyle().
			Foreground(colorOverlay).
			Italic(true).
			Padding(2, 4)

	// DetailPanelStyle wraps the connection detail panel on the right.
	DetailPanelStyle = lipgloss.NewStyle().
				Border(lipgloss.RoundedBorder()).
				BorderForeground(colorSurface).
				Padding(1, 2)

	// NarrowWarningStyle renders the "terminal too narrow" guard message.
	NarrowWarningStyle = lipgloss.NewStyle().
				Foreground(colorOverlay).
				Padding(1, 2)
)
