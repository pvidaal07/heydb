package cli

import (
	"fmt"
	"os"
	"path/filepath"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/cli/tui"
	"github.com/pvidaal07/heydb/internal/cli/tui/tab"
	"github.com/pvidaal07/heydb/internal/config"
	"github.com/pvidaal07/heydb/internal/domain/ports"
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

	m := buildTUIModel(cfg, cfgPath, cwd)
	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("tui: %w", err)
	}
	return nil
}

// buildTUIModel assembles the root model with all tabs.
// cwd is used to resolve the .heydb/ store paths.
func buildTUIModel(cfg *config.Config, cfgPath, cwd string) tui.Model {
	heydbDirPath := filepath.Join(cwd, heydbDir)

	// StoreOpener opens the SQLite schema store for the given connection name.
	opener := func(connName string) (ports.SchemaStore, error) {
		storePath := filepath.Join(heydbDirPath, connName+".sqlite")
		store, err := sqlite.OpenReadOnly(storePath)
		if err != nil {
			return nil, err
		}
		return store, nil
	}

	// Try to open the store for the active connection at startup.
	var initialStore ports.SchemaStore
	if cfg.ActiveConnection != "" {
		initialStore, _ = opener(cfg.ActiveConnection)
	}

	tabs := []tui.Tab{
		tab.NewConnectionsTab(cfg, cfgPath),
		tab.NewSchemaTab(initialStore),
		tab.NewSearchTab(),
	}

	// Send the initial store to SearchTab if available.
	searchTab := tab.NewSearchTab()
	if initialStore != nil {
		updated, _ := searchTab.Update(tui.StoreOpenedMsg{Store: initialStore})
		if st, ok := updated.(tab.SearchTab); ok {
			tabs[2] = st
		}
	}

	return tui.New(cfg, cfgPath, version).
		WithTabs(tabs).
		WithStoreOpener(opener)
}
