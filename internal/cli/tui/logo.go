package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

var logoLines = []string{
	"  ╦ ╦╔═╗╦ ╦╔╦╗╔╗ ",
	"  ╠═╣║╣ ╚╦╝ ║║╠╩╗",
	"  ╩ ╩╚═╝ ╩ ═╩╝╚═╝",
}

var logoGradient = []lipgloss.Color{
	ColorMauve,
	ColorLavender,
	ColorGreen,
}

// RenderLogo returns the heydb ASCII logo with a gradient.
func RenderLogo() string {
	total := len(logoLines)
	if total == 0 {
		return ""
	}

	bands := len(logoGradient)
	var b strings.Builder

	for i, line := range logoLines {
		bandIdx := (i * bands) / total
		if bandIdx >= bands {
			bandIdx = bands - 1
		}
		style := lipgloss.NewStyle().Foreground(logoGradient[bandIdx]).Bold(true)
		b.WriteString(style.Render(line))
		if i < total-1 {
			b.WriteByte('\n')
		}
	}

	return b.String()
}
