package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

var relationshipCmd = &cobra.Command{
	Use:   "relationship",
	Short: "Manage implicit (logical) relationships between tables",
	Long: `Document implicit foreign-key relationships that are not enforced by the database engine.

Subcommands:
  add <from_table.column> <to_table.column>   Add a new relationship
  delete <uuid>                               Delete a relationship by UUID
  list                                        List all relationships`,
}

var relationshipAddCmd = &cobra.Command{
	Use:   "add <from_table.column> <to_table.column>",
	Short: "Add an implicit relationship",
	Long: `Add a logical foreign-key relationship between two columns.

Example:
  heydb relationship add orders.user_id users.id
  heydb relationship add orders.user_id users.id --label "Order owner"
  heydb relationship add orders.user_id users.id --connection legacy`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("relationship add: cannot determine working directory: %w", err)
		}

		dbPath := GlobalDBPath()
		gs, err := sqlite.OpenGlobal(dbPath)
		if err != nil {
			return fmt.Errorf("relationship add: open global DB: %w", err)
		}
		defer gs.Close()

		ctx := context.Background()

		proj, err := gs.GetProjectByPath(ctx, cwd)
		if err != nil {
			return fmt.Errorf("relationship add: lookup project: %w", err)
		}
		if proj == nil {
			return fmt.Errorf("relationship add: no heydb project found for %q — run `heydb init` first", cwd)
		}

		connName, _ := cmd.Flags().GetString("connection")
		if connName == "" {
			conns, err := gs.ListConnections(ctx, proj.ID)
			if err != nil {
				return fmt.Errorf("relationship add: list connections: %w", err)
			}
			for _, c := range conns {
				if c.Active {
					connName = c.Name
					break
				}
			}
		}
		if connName == "" {
			return fmt.Errorf("relationship add: no active connection — run `heydb connect --use <name>` to set one")
		}

		fromTable, fromColumn, err := parseDotNotation(args[0])
		if err != nil {
			return fmt.Errorf("relationship add: from argument: %w", err)
		}
		toTable, toColumn, err := parseDotNotation(args[1])
		if err != nil {
			return fmt.Errorf("relationship add: to argument: %w", err)
		}

		label, _ := cmd.Flags().GetString("label")

		id, err := runRelationshipAdd(ctx, gs, proj.ID, connName, fromTable, fromColumn, toTable, toColumn, label)
		if err != nil {
			return fmt.Errorf("relationship add: %w", err)
		}

		fmt.Printf("Relationship added (UUID: %s).\n", id)
		return nil
	},
}

var relationshipDeleteCmd = &cobra.Command{
	Use:   "delete <uuid>",
	Short: "Delete a relationship by UUID",
	Long: `Delete an implicit relationship by its UUID.

Example:
  heydb relationship delete 550e8400-e29b-41d4-a716-446655440000`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		dbPath := GlobalDBPath()
		gs, err := sqlite.OpenGlobal(dbPath)
		if err != nil {
			return fmt.Errorf("relationship delete: open global DB: %w", err)
		}
		defer gs.Close()

		ctx := context.Background()

		if err := runRelationshipDelete(ctx, gs, args[0]); err != nil {
			return fmt.Errorf("relationship delete: %w", err)
		}

		fmt.Printf("Relationship %q deleted.\n", args[0])
		return nil
	},
}

var relationshipListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all relationships for the active connection",
	Long: `List all implicit relationships stored for the active (or specified) connection.

Example:
  heydb relationship list
  heydb relationship list --connection legacy`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("relationship list: cannot determine working directory: %w", err)
		}

		dbPath := GlobalDBPath()
		gs, err := sqlite.OpenGlobal(dbPath)
		if err != nil {
			return fmt.Errorf("relationship list: open global DB: %w", err)
		}
		defer gs.Close()

		ctx := context.Background()

		proj, err := gs.GetProjectByPath(ctx, cwd)
		if err != nil {
			return fmt.Errorf("relationship list: lookup project: %w", err)
		}
		if proj == nil {
			return fmt.Errorf("relationship list: no heydb project found for %q — run `heydb init` first", cwd)
		}

		connName, _ := cmd.Flags().GetString("connection")
		if connName == "" {
			conns, err := gs.ListConnections(ctx, proj.ID)
			if err != nil {
				return fmt.Errorf("relationship list: list connections: %w", err)
			}
			for _, c := range conns {
				if c.Active {
					connName = c.Name
					break
				}
			}
		}
		if connName == "" {
			return fmt.Errorf("relationship list: no active connection — run `heydb connect --use <name>` to set one")
		}

		return runRelationshipList(ctx, gs, proj.ID, connName, os.Stdout)
	},
}

func init() {
	relationshipAddCmd.Flags().String("label", "", "optional description for this relationship")
	relationshipAddCmd.Flags().String("connection", "", "target a specific connection instead of the active one")
	relationshipDeleteCmd.Flags().String("connection", "", "target a specific connection (informational only)")
	relationshipListCmd.Flags().String("connection", "", "target a specific connection instead of the active one")

	relationshipCmd.AddCommand(relationshipAddCmd)
	relationshipCmd.AddCommand(relationshipDeleteCmd)
	relationshipCmd.AddCommand(relationshipListCmd)
	rootCmd.AddCommand(relationshipCmd)
}

// parseDotNotation splits "table.column" into (table, column).
// Returns an error if the input does not have exactly one dot
// or if either part is empty.
func parseDotNotation(s string) (table, column string, err error) {
	parts := strings.SplitN(s, ".", 3)
	if len(parts) != 2 {
		return "", "", fmt.Errorf("invalid format %q — expected table.column (exactly one dot)", s)
	}
	table = parts[0]
	column = parts[1]
	if table == "" || column == "" {
		return "", "", fmt.Errorf("invalid format %q — table and column must both be non-empty", s)
	}
	return table, column, nil
}

// runRelationshipAdd is the testable core: persists a relationship and returns its UUID.
func runRelationshipAdd(ctx context.Context, gs *sqlite.GlobalStore, projectID, connName, fromTable, fromColumn, toTable, toColumn, label string) (string, error) {
	author, err := gs.GetConfig(ctx, "author")
	if err != nil {
		return "", fmt.Errorf("get author config: %w", err)
	}
	if author == "" {
		return "", fmt.Errorf("no author configured — run `heydb config set author <name>` first")
	}

	rel := schema.ImplicitRelationship{
		ProjectID:      projectID,
		ConnectionName: connName,
		FromTable:      fromTable,
		FromColumn:     fromColumn,
		ToTable:        toTable,
		ToColumn:       toColumn,
		Label:          label,
		Author:         author,
	}

	saved, err := gs.AddRelationship(ctx, rel)
	if err != nil {
		return "", err
	}
	return saved.ID, nil
}

// runRelationshipDelete is the testable core: removes a relationship by UUID.
func runRelationshipDelete(ctx context.Context, gs *sqlite.GlobalStore, id string) error {
	return gs.DeleteRelationship(ctx, id)
}

// runRelationshipList is the testable core: prints relationships to w.
func runRelationshipList(ctx context.Context, gs *sqlite.GlobalStore, projectID, connName string, w io.Writer) error {
	rels, err := gs.ListRelationships(ctx, projectID, connName)
	if err != nil {
		return fmt.Errorf("list relationships: %w", err)
	}

	if len(rels) == 0 {
		fmt.Fprintln(w, "no relationships defined")
		return nil
	}

	for _, r := range rels {
		if r.Label != "" {
			fmt.Fprintf(w, "%s  %s.%s -> %s.%s  (%s)\n",
				r.ID, r.FromTable, r.FromColumn, r.ToTable, r.ToColumn, r.Label)
		} else {
			fmt.Fprintf(w, "%s  %s.%s -> %s.%s\n",
				r.ID, r.FromTable, r.FromColumn, r.ToTable, r.ToColumn)
		}
	}
	return nil
}
