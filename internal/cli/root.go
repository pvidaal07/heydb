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
	Long: `heydb introspects MySQL databases, generates heydb.md and heydb.sqlite,
and serves the schema to AI agents via the Model Context Protocol (MCP).

Get started:
  heydb init          Initialise .heydb/ in the current directory
  heydb connect       Add a database connection
  heydb sync          Introspect the active connection and update heydb.md
  heydb serve         Start the MCP server (reads heydb.sqlite)`,

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
