package cli

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

// version is injected at build time via -ldflags "-X github.com/pvidaal07/heydb/internal/cli.version=v1.2.3".
var version = "dev"

// Verbose is the global verbose flag value, available to all subcommands.
var Verbose bool

// rootCmd is the top-level Cobra command for the heydb binary.
var rootCmd = &cobra.Command{
	Use:   "heydb",
	Short: "Introspect MySQL schemas and expose them via MCP",
	Long: `heydb introspects MySQL databases, generates schema documentation,
and serves it to AI agents via the Model Context Protocol (MCP).

Setup:
  heydb init                    Create .heydb/ in the current directory
  heydb connect                 Add a database connection (interactive)
  heydb connect --list          List all configured connections
  heydb connect --use <name>    Switch the active connection
  heydb create-user             Generate SQL for a read-only MySQL user

Schema:
  heydb sync                    Introspect the active DB and write schema files
  heydb sync --list             Show which connections have been synced
  heydb sync --delete <name>    Remove schema files for a connection
  heydb review                  Check if the live schema has drifted
  heydb diff                    Show exactly what changed since last sync

Query:
  heydb tables                  List all tables with column counts
  heydb describe <table>        Show columns, indexes, and foreign keys
  heydb search <keyword>        Search tables and columns by name

MCP:
  heydb serve                   Start the MCP stdio server for AI agents`,

	// Silence cobra's built-in error printing so we can format it ourselves.
	SilenceErrors: true,
	SilenceUsage:  true,
}

// Execute is the single entry-point called from main.go.
func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func init() {
	// Global flags available on every subcommand.
	rootCmd.PersistentFlags().BoolVarP(&Verbose, "verbose", "v", false, "enable debug-level logging to stderr")
	rootCmd.Flags().Bool("version", false, "print the heydb version and exit")

	// Handle --version ourselves so we can format it cleanly.
	rootCmd.RunE = func(cmd *cobra.Command, args []string) error {
		showVersion, _ := cmd.Flags().GetBool("version")
		if showVersion {
			fmt.Printf("heydb %s\n", version)
			return nil
		}
		return cmd.Help()
	}
}

// SetVersion allows the build entrypoint (main.go) to override the version
// string at runtime if ldflags injection is not used.
func SetVersion(v string) {
	version = v
}
