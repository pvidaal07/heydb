package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

var annotateCmd = &cobra.Command{
	Use:   "annotate <table> <text>",
	Short: "Annotate a table with business context",
	Long: `Creates a table annotation on the active connection using the configured author.

Examples:
  heydb annotate orders "Stores customer purchase orders"
  heydb annotate orders "Text" --connection legacy`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("annotate: cannot determine working directory: %w", err)
		}

		dbPath := GlobalDBPath()
		gs, err := sqlite.OpenGlobal(dbPath)
		if err != nil {
			return fmt.Errorf("annotate: open global DB: %w", err)
		}
		defer gs.Close()

		ctx := context.Background()

		proj, err := gs.GetProjectByPath(ctx, cwd)
		if err != nil {
			return fmt.Errorf("annotate: lookup project: %w", err)
		}
		if proj == nil {
			return fmt.Errorf("annotate: no heydb project found for %q — run `heydb init` first", cwd)
		}

		connName, _ := cmd.Flags().GetString("connection")
		if connName == "" {
			conns, err := gs.ListConnections(ctx, proj.ID)
			if err != nil {
				return fmt.Errorf("annotate: list connections: %w", err)
			}
			for _, c := range conns {
				if c.Active {
					connName = c.Name
					break
				}
			}
		}
		if connName == "" {
			return fmt.Errorf("annotate: no active connection — run `heydb connect --use <name>` to set one")
		}

		tableName := args[0]
		text := args[1]

		if err := runAnnotateTable(ctx, gs, proj.ID, connName, tableName, text); err != nil {
			return fmt.Errorf("annotate: %w", err)
		}

		fmt.Printf("Annotation added to table %q on connection %q.\n", tableName, connName)
		return nil
	},
}

var annotateColumnCmd = &cobra.Command{
	Use:   "annotate-column <table> <column> <text>",
	Short: "Annotate a specific column with business context",
	Long: `Creates a column annotation on the active connection using the configured author.

Examples:
  heydb annotate-column orders total "The total amount in cents"
  heydb annotate-column orders total "Text" --connection legacy`,
	Args: cobra.ExactArgs(3),
	RunE: func(cmd *cobra.Command, args []string) error {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("annotate-column: cannot determine working directory: %w", err)
		}

		dbPath := GlobalDBPath()
		gs, err := sqlite.OpenGlobal(dbPath)
		if err != nil {
			return fmt.Errorf("annotate-column: open global DB: %w", err)
		}
		defer gs.Close()

		ctx := context.Background()

		proj, err := gs.GetProjectByPath(ctx, cwd)
		if err != nil {
			return fmt.Errorf("annotate-column: lookup project: %w", err)
		}
		if proj == nil {
			return fmt.Errorf("annotate-column: no heydb project found for %q — run `heydb init` first", cwd)
		}

		connName, _ := cmd.Flags().GetString("connection")
		if connName == "" {
			conns, err := gs.ListConnections(ctx, proj.ID)
			if err != nil {
				return fmt.Errorf("annotate-column: list connections: %w", err)
			}
			for _, c := range conns {
				if c.Active {
					connName = c.Name
					break
				}
			}
		}
		if connName == "" {
			return fmt.Errorf("annotate-column: no active connection — run `heydb connect --use <name>` to set one")
		}

		tableName := args[0]
		columnName := args[1]
		text := args[2]

		if err := runAnnotateColumn(ctx, gs, proj.ID, connName, tableName, columnName, text); err != nil {
			return fmt.Errorf("annotate-column: %w", err)
		}

		fmt.Printf("Annotation added to column %q on table %q (connection %q).\n", columnName, tableName, connName)
		return nil
	},
}

func init() {
	annotateCmd.Flags().String("connection", "", "target a specific connection instead of the active one")
	annotateColumnCmd.Flags().String("connection", "", "target a specific connection instead of the active one")
	rootCmd.AddCommand(annotateCmd)
	rootCmd.AddCommand(annotateColumnCmd)
}

// runAnnotateTable is the testable core: annotates a table on the given connection.
// The author must be configured; error is returned otherwise.
func runAnnotateTable(ctx context.Context, gs *sqlite.GlobalStore, projectID, connName, tableName, text string) error {
	author, err := gs.GetConfig(ctx, "author")
	if err != nil {
		return fmt.Errorf("get author config: %w", err)
	}
	if author == "" {
		return fmt.Errorf("no author configured — run `heydb config set author <name>` first")
	}

	ann := schema.Annotation{
		ProjectID:      projectID,
		ConnectionName: connName,
		TargetType:     "table",
		TargetName:     tableName,
		Content:        text,
		Author:         author,
	}
	_, err = gs.AddAnnotation(ctx, ann)
	return err
}

// runAnnotateColumn is the testable core: annotates a column on the given connection.
// The author must be configured; error is returned otherwise.
func runAnnotateColumn(ctx context.Context, gs *sqlite.GlobalStore, projectID, connName, tableName, columnName, text string) error {
	author, err := gs.GetConfig(ctx, "author")
	if err != nil {
		return fmt.Errorf("get author config: %w", err)
	}
	if author == "" {
		return fmt.Errorf("no author configured — run `heydb config set author <name>` first")
	}

	ann := schema.Annotation{
		ProjectID:      projectID,
		ConnectionName: connName,
		TargetType:     "column",
		TargetName:     tableName + "." + columnName,
		Content:        text,
		Author:         author,
	}
	_, err = gs.AddAnnotation(ctx, ann)
	return err
}

