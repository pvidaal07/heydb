package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/charmbracelet/huh"
	_ "github.com/go-sql-driver/mysql"
	"github.com/spf13/cobra"

	"database/sql"

	"github.com/pvidaal07/heydb/internal/config"
)

var connectCmd = &cobra.Command{
	Use:   "connect",
	Short: "Add or manage database connections",
	Long: `Interactively add a new database connection via a form (name, host, port,
database, username, password). The connection is verified with a PING before
it is saved to .heydb/config.json.

Flags:
  --list        List all configured connections (passwords hidden)
  --use <name>  Switch the active connection`,
	RunE: runConnect,
}

func init() {
	connectCmd.Flags().Bool("list", false, "list all configured connections")
	connectCmd.Flags().String("use", "", "switch the active connection to <name>")
	rootCmd.AddCommand(connectCmd)
}

func runConnect(cmd *cobra.Command, args []string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("connect: cannot determine working directory: %w", err)
	}

	dir := filepath.Join(cwd, heydbDir)
	cfgPath := filepath.Join(dir, configFileName)

	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("connect: load config: %w", err)
	}

	// ── --list flag ──────────────────────────────────────────────────────────
	listFlag, _ := cmd.Flags().GetBool("list")
	if listFlag {
		return listConnections(cfg)
	}

	// ── --use <name> flag ────────────────────────────────────────────────────
	useName, _ := cmd.Flags().GetString("use")
	if useName != "" {
		return switchConnection(cfg, cfgPath, useName)
	}

	// ── Interactive form ─────────────────────────────────────────────────────
	return addConnection(cfg, cfgPath)
}

// listConnections prints all configured connections, masking passwords.
func listConnections(cfg *config.Config) error {
	if len(cfg.Connections) == 0 {
		fmt.Println("No connections configured. Run `heydb connect` to add one.")
		return nil
	}
	fmt.Println("Configured connections:")
	fmt.Println()
	for name, conn := range cfg.Connections {
		active := ""
		if name == cfg.ActiveConnection {
			active = " (active)"
		}
		fmt.Printf("  %s%s\n", name, active)
		fmt.Printf("    host:     %s:%d\n", conn.Host, conn.Port)
		fmt.Printf("    database: %s\n", conn.Database)
		fmt.Printf("    username: %s\n", conn.Username)
		fmt.Printf("    password: ****\n")
		fmt.Println()
	}
	return nil
}

// switchConnection sets a named connection as the active one.
func switchConnection(cfg *config.Config, cfgPath, name string) error {
	if _, ok := cfg.Connections[name]; !ok {
		names := make([]string, 0, len(cfg.Connections))
		for n := range cfg.Connections {
			names = append(names, n)
		}
		return fmt.Errorf(
			"connect: connection %q not found\n\nConfigured connections: %s",
			name, strings.Join(names, ", "),
		)
	}
	cfg.ActiveConnection = name
	if err := config.Save(cfgPath, cfg); err != nil {
		return fmt.Errorf("connect: save config: %w", err)
	}
	fmt.Printf("Active connection switched to %q.\n", name)
	return nil
}

// addConnection runs the interactive Huh form to add a new connection.
func addConnection(cfg *config.Config, cfgPath string) error {
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

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Connection name").
				Description("A unique label for this connection (e.g. local, staging, prod)").
				Placeholder("mydb").
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return fmt.Errorf("connection name is required")
					}
					if _, exists := cfg.Connections[strings.TrimSpace(s)]; exists {
						return fmt.Errorf("connection %q already exists — choose a different name", s)
					}
					return nil
				}).
				Value(&name),

			huh.NewInput().
				Title("Host").
				Placeholder("127.0.0.1").
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
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return fmt.Errorf("database name is required")
					}
					return nil
				}).
				Value(&database),

			huh.NewInput().
				Title("Username").
				Placeholder("heydb_reader").
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return fmt.Errorf("username is required")
					}
					return nil
				}).
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

	if err := db.PingContext(context.Background()); err != nil {
		fmt.Println("failed")
		return fmt.Errorf(
			"connect: ping failed — check your credentials and that the server is reachable\n\nError: %w", err)
	}
	fmt.Println("OK")

	// Save connection.
	conn := config.Connection{
		Driver:   "mysql",
		Host:     host,
		Port:     port,
		Database: database,
		Username: username,
		Password: password,
		Timeout:  30,
	}

	cfg.Connections[name] = conn

	// Set as active if it's the first connection, otherwise ask.
	if cfg.ActiveConnection == "" {
		cfg.ActiveConnection = name
		fmt.Printf("Connection %q saved and set as active.\n", name)
	} else {
		var setActive bool
		confirm := huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title(fmt.Sprintf("Set %q as the active connection?", name)).
					Description(fmt.Sprintf("Current active: %s", cfg.ActiveConnection)).
					Value(&setActive),
			),
		)
		if err := confirm.Run(); err == nil && setActive {
			cfg.ActiveConnection = name
			fmt.Printf("Connection %q saved and set as active.\n", name)
		} else {
			fmt.Printf("Connection %q saved. Active connection unchanged (%s).\n", name, cfg.ActiveConnection)
		}
	}

	if err := config.Save(cfgPath, cfg); err != nil {
		return fmt.Errorf("connect: save config: %w", err)
	}

	// Security warning — always shown.
	fmt.Println()
	fmt.Println("WARNING: The password is stored in plaintext in .heydb/config.json.")
	fmt.Println("         This file is excluded from git by .heydb/.gitignore, but be")
	fmt.Println("         careful not to expose it in backups or shared environments.")

	return nil
}
