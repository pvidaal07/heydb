package cli

import (
	"fmt"
	"os"
	"path/filepath"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/cli/tui"
	"github.com/pvidaal07/heydb/internal/cli/tui/tab"
	"github.com/pvidaal07/heydb/internal/config"
)

var tuiCmd = &cobra.Command{
	Use:   "tui",
	Short: "Launch the interactive terminal UI",
	Long:  "Open the interactive terminal navigator (Connections, Schema, Search tabs).",
	RunE:  runTUI,
}

func init() {
	rootCmd.AddCommand(tuiCmd)
}

func runTUI(_ *cobra.Command, _ []string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("tui: cannot determine working directory: %w", err)
	}

	cfgPath := filepath.Join(cwd, heydbDir, configFileName)
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("tui: load config: %w", err)
	}

	m := buildTUIModel(cfg, cfgPath)
	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("tui: %w", err)
	}
	return nil
}

// buildTUIModel assembles the root model with all tabs.
func buildTUIModel(cfg *config.Config, cfgPath string) tui.Model {
	tabs := []tui.Tab{
		tab.NewConnectionsTab(cfg, cfgPath),
		tab.NewSchemaTab(nil),
		tab.NewSearchTab(),
	}
	return tui.New(cfg, cfgPath, version).WithTabs(tabs)
}
