package cli

import (
	"context"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/cli/tui"
	"github.com/pvidaal07/heydb/internal/cli/tui/tab"
	"github.com/pvidaal07/heydb/internal/domain/ports"
	"github.com/pvidaal07/heydb/internal/domain/schema"
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

	dbPath := GlobalDBPath()
	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		return fmt.Errorf("tui: open global DB: %w", err)
	}
	defer gs.Close()

	m, err := buildTUIModel(gs, cwd)
	if err != nil {
		return fmt.Errorf("tui: %w", err)
	}

	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("tui: %w", err)
	}
	return nil
}

// buildTUIModel assembles the root model with all tabs using GlobalStore directly.
// gs is used to resolve connections and schema stores.
// cwd is used to resolve the active project.
func buildTUIModel(gs *sqlite.GlobalStore, cwd string) (tui.Model, error) {
	ctx := context.Background()

	proj, err := gs.GetProjectByPath(ctx, cwd)
	if err != nil {
		return tui.Model{}, fmt.Errorf("lookup project: %w", err)
	}

	var conns []schema.Connection
	var activeConnName string
	var projectID string

	if proj != nil {
		projectID = proj.ID
		conns, err = gs.ListConnections(ctx, projectID)
		if err != nil {
			return tui.Model{}, fmt.Errorf("list connections: %w", err)
		}
		for _, c := range conns {
			if c.Active {
				activeConnName = c.Name
				break
			}
		}
	}

	// StoreOpener opens the ConnSchemaStore for the given connection name.
	opener := func(connName string) (ports.SchemaStore, error) {
		if proj == nil {
			return nil, fmt.Errorf("tui: no project found for %q", cwd)
		}
		connID := proj.ID + "/" + connName
		return gs.ForConnection(connID), nil
	}

	// Try to open the store for the active connection at startup.
	var initialStore ports.SchemaStore
	var initialAnnotations ports.AnnotationStore
	if activeConnName != "" {
		if s, err := opener(activeConnName); err == nil {
			initialStore = s
			if ann, ok := s.(ports.AnnotationStore); ok {
				initialAnnotations = ann
			}
		}
	}

	schemaTab := tab.NewSchemaTab(initialStore, initialAnnotations)
	searchTab := tab.NewSearchTab()
	if initialStore != nil {
		updated, _ := searchTab.Update(tui.StoreOpenedMsg{Store: initialStore, Annotations: initialAnnotations})
		if st, ok := updated.(tab.SearchTab); ok {
			searchTab = st
		}
	}

	tabs := []tui.Tab{
		tab.NewConnectionsTab(conns, activeConnName, projectID, gs),
		schemaTab,
		searchTab,
	}

	return tui.New(activeConnName, version).
		WithTabs(tabs).
		WithStoreOpener(opener), nil
}
