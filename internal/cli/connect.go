package cli

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/charmbracelet/huh"
	_ "github.com/go-sql-driver/mysql"
	"github.com/spf13/cobra"

	"github.com/pvidaal07/heydb/internal/adapters/sqlite"
	"github.com/pvidaal07/heydb/internal/domain/schema"
	"github.com/pvidaal07/heydb/internal/validation"
)

var connectCmd = &cobra.Command{
	Use:   "connect",
	Short: "Add or manage database connections",
	Long: `Interactively add a new database connection via a form (name, host, port,
database, username, password). The connection is verified with a PING before
it is saved to the global heydb database (~/.heydb/heydb.db).

Flags:
  --list          List all configured connections (passwords hidden)
  --use <name>    Switch the active connection
  --delete <name> Delete a connection`,
	RunE: runConnect,
}

func init() {
	connectCmd.Flags().Bool("list", false, "list all configured connections")
	connectCmd.Flags().String("use", "", "switch the active connection to <name>")
	connectCmd.Flags().String("delete", "", "delete a connection by name")
	rootCmd.AddCommand(connectCmd)
}

func runConnect(cmd *cobra.Command, args []string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("connect: cannot determine working directory: %w", err)
	}

	dbPath := GlobalDBPath()
	gs, err := sqlite.OpenGlobal(dbPath)
	if err != nil {
		return fmt.Errorf("connect: open global DB: %w", err)
	}
	defer gs.Close()

	ctx := context.Background()

	proj, err := gs.GetProjectByPath(ctx, cwd)
	if err != nil {
		return fmt.Errorf("connect: lookup project: %w", err)
	}
	if proj == nil {
		return fmt.Errorf("connect: no heydb project found for %q — run `heydb init` first", cwd)
	}

	// ── --list flag ──────────────────────────────────────────────────────────
	listFlag, _ := cmd.Flags().GetBool("list")
	if listFlag {
		return listConnectionsV2(ctx, gs, proj.ID)
	}

	// ── --use <name> flag ────────────────────────────────────────────────────
	useName, _ := cmd.Flags().GetString("use")
	if useName != "" {
		return switchConnectionV2(ctx, gs, proj.ID, useName)
	}

	// ── --delete <name> flag ─────────────────────────────────────────────────
	deleteName, _ := cmd.Flags().GetString("delete")
	if deleteName != "" {
		return deleteConnectionV2(ctx, gs, proj.ID, deleteName)
	}

	// ── Interactive form ─────────────────────────────────────────────────────
	return addConnectionV2(ctx, gs, proj.ID)
}

// listConnectionsV2 prints all connections for the project, masking passwords.
func listConnectionsV2(ctx context.Context, gs *sqlite.GlobalStore, projectID string) error {
	list, err := gs.ListConnections(ctx, projectID)
	if err != nil {
		return fmt.Errorf("connect: list: %w", err)
	}
	if len(list) == 0 {
		fmt.Println("No connections configured. Run `heydb connect` to add one.")
		return nil
	}
	fmt.Println("Configured connections:")
	fmt.Println()
	for _, conn := range list {
		active := ""
		if conn.Active {
			active = " (active)"
		}
		fmt.Printf("  %s%s\n", conn.Name, active)
		fmt.Printf("    host:     %s:%d\n", conn.Host, conn.Port)
		fmt.Printf("    database: %s\n", conn.Database)
		fmt.Printf("    username: %s\n", conn.User)
		fmt.Printf("    password: ****\n")
		fmt.Println()
	}
	return nil
}

// switchConnectionV2 sets a named connection as the active one.
func switchConnectionV2(ctx context.Context, gs *sqlite.GlobalStore, projectID, name string) error {
	if err := gs.SetActive(ctx, projectID, name); err != nil {
		return fmt.Errorf("connect: switch active: %w", err)
	}
	fmt.Printf("Active connection switched to %q.\n", name)
	return nil
}

// deleteConnectionV2 removes a connection by name.
func deleteConnectionV2(ctx context.Context, gs *sqlite.GlobalStore, projectID, name string) error {
	conn, err := gs.GetConnection(ctx, projectID, name)
	if err != nil {
		return fmt.Errorf("connect: delete: lookup: %w", err)
	}
	if conn == nil {
		return fmt.Errorf("connect: connection %q not found", name)
	}
	if err := gs.DeleteConnection(ctx, projectID, name); err != nil {
		return fmt.Errorf("connect: delete: %w", err)
	}
	fmt.Printf("Connection %q deleted.\n", name)
	return nil
}

// addConnectionV2 runs the interactive Huh form to add a new connection.
func addConnectionV2(ctx context.Context, gs *sqlite.GlobalStore, projectID string) error {
	var (
		name     string
		host     string
		portStr  string
		database string
		username string
		password string
	)

	// Pre-fill sensible defaults.
	host = "127.0.0.1"
	portStr = "3306"

	// Load existing connections to validate duplicate names.
	existing, err := gs.ListConnections(ctx, projectID)
	if err != nil {
		return fmt.Errorf("connect: load existing connections: %w", err)
	}
	existingNames := make(map[string]bool, len(existing))
	for _, c := range existing {
		existingNames[c.Name] = true
	}

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Connection name").
				Description("A unique label for this connection (e.g. local, staging, prod)").
				Placeholder("mydb").
				Validate(func(s string) error {
					if err := validation.ValidateConnectionName(strings.TrimSpace(s)); err != nil {
						return err
					}
					if existingNames[strings.TrimSpace(s)] {
						return fmt.Errorf("connection %q already exists — choose a different name", s)
					}
					return nil
				}).
				Value(&name),

			huh.NewInput().
				Title("Host").
				Placeholder("127.0.0.1").
				Validate(func(s string) error {
					return validation.ValidateHost(strings.TrimSpace(s))
				}).
				Value(&host),

			huh.NewInput().
				Title("Port").
				Placeholder("3306").
				Validate(func(s string) error {
					p, err := strconv.Atoi(strings.TrimSpace(s))
					if err != nil || p < 1 || p > 65535 {
						return fmt.Errorf("port must be a number between 1 and 65535")
					}
					return nil
				}).
				Value(&portStr),

			huh.NewInput().
				Title("Database").
				Placeholder("myapp").
				Validate(validation.ValidateMySQLIdentifier).
				Value(&database),

			huh.NewInput().
				Title("Username").
				Placeholder("heydb_reader").
				Validate(validation.ValidateMySQLIdentifier).
				Value(&username),

			huh.NewInput().
				Title("Password").
				EchoMode(huh.EchoModePassword).
				Value(&password),
		),
	)

	if err := form.Run(); err != nil {
		return fmt.Errorf("connect: form cancelled: %w", err)
	}

	name = strings.TrimSpace(name)
	host = strings.TrimSpace(host)
	port, _ := strconv.Atoi(strings.TrimSpace(portStr))
	database = strings.TrimSpace(database)
	username = strings.TrimSpace(username)

	if port == 0 {
		port = 3306
	}

	// Verify connectivity.
	fmt.Printf("Verifying connection to %s:%d/%s ... ", host, port, database)
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?parseTime=true", username, password, host, port, database)
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		fmt.Println("failed")
		return fmt.Errorf("connect: open connection: %w", err)
	}
	defer db.Close()

	if err := db.PingContext(ctx); err != nil {
		fmt.Println("failed")
		return fmt.Errorf(
			"connect: ping failed — check your credentials and that the server is reachable\n\nError: %w", err)
	}
	fmt.Println("OK")

	// Determine if this is the first connection (will be set as active).
	isFirst := len(existing) == 0

	conn := schema.Connection{
		Name:     name,
		Host:     host,
		Port:     port,
		Database: database,
		User:     username,
		Password: password,
		Active:   isFirst,
	}

	if err := gs.SaveConnection(ctx, projectID, conn); err != nil {
		return fmt.Errorf("connect: save: %w", err)
	}

	if isFirst {
		fmt.Printf("Connection %q saved and set as active.\n", name)
	} else {
		// Ask if the user wants to set this as active.
		var setActive bool
		activeConn := ""
		for _, c := range existing {
			if c.Active {
				activeConn = c.Name
				break
			}
		}
		confirm := huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title(fmt.Sprintf("Set %q as the active connection?", name)).
					Description(fmt.Sprintf("Current active: %s", activeConn)).
					Value(&setActive),
			),
		)
		if err := confirm.Run(); err == nil && setActive {
			if err := gs.SetActive(ctx, projectID, name); err != nil {
				return fmt.Errorf("connect: set active: %w", err)
			}
			fmt.Printf("Connection %q saved and set as active.\n", name)
		} else {
			fmt.Printf("Connection %q saved. Active connection unchanged (%s).\n", name, activeConn)
		}
	}

	// Encryption notice — always shown.
	fmt.Println()
	fmt.Println("NOTE: The password is encrypted at rest in ~/.heydb/heydb.db.")
	fmt.Println("      Be careful with backups and shared environments.")

	return nil
}
