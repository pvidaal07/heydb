package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

// Block marker constants used to identify the heydb AI context block.
const (
	blockStart = "<!-- heydb:ai-block:start -->"
	blockEnd   = "<!-- heydb:ai-block:end -->"
)

// AssistantTarget represents a detected AI assistant configuration file.
type AssistantTarget struct {
	// Name is the human-readable assistant name (e.g. "Claude Code").
	Name string
	// Path is the absolute path to the assistant's configuration file.
	Path string
}

// generateBlockContent returns the full heydb AI context block as a string,
// including the opening and closing markers.
func generateBlockContent() string {
	return blockStart + `

## heydb — Database Schema Context

heydb introspects your MySQL databases and exposes their schema to AI agents
via the Model Context Protocol (MCP).

Schema markdown files are stored in .heydb/*.md — one file per connection.
These files are intentionally tracked in git so AI agents can reference them
without a live database connection.

### MCP Tools

heydb exposes the following MCP tools when running heydb serve.
All tools accept an optional "connection" parameter; when omitted, the active
connection is used.

- **heydb_list_connections** — list all configured database connections
- **heydb_list_tables** — list all tables with column counts
- **heydb_get_table** — get full table detail (columns, indexes, foreign keys, annotations)
- **heydb_search** — search tables and columns by keyword
- **heydb_annotate** — annotate a table with business context
- **heydb_annotate_column** — annotate a specific column
- **heydb_annotate_db** — annotate the database itself

### Multi-Connection Support

heydb supports multiple database connections. Use heydb_list_connections to
discover available connections, then pass the "connection" parameter to any
tool to target a specific database. Each connection has its own schema store
under .heydb/.

` + blockEnd + "\n"
}

// stripExistingBlock removes the heydb AI block (from blockStart to blockEnd,
// inclusive) from content. If no block is present, content is returned
// unchanged. Content outside the markers is always preserved verbatim.
func stripExistingBlock(content string) string {
	start := strings.Index(content, blockStart)
	if start == -1 {
		return content
	}
	end := strings.Index(content[start:], blockEnd)
	if end == -1 {
		// Malformed: opening marker without closing marker — leave unchanged.
		return content
	}
	// end is relative to content[start:], so absolute position is start+end.
	// We want to remove from start to start+end+len(blockEnd).
	endAbs := start + end + len(blockEnd)
	return content[:start] + content[endAbs:]
}

// writeAIBlock atomically writes the heydb AI block to path. If the file
// already contains a heydb block, it is replaced in-place. Existing content
// outside the markers is preserved verbatim. Parent directories are created
// automatically. The write is atomic: a .tmp sibling is written first, then
// renamed to the final path.
func writeAIBlock(path string, block string) error {
	// Ensure parent directory exists.
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("writeAIBlock: mkdir %s: %w", filepath.Dir(path), err)
	}

	// Read existing content if the file exists.
	existing := ""
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("writeAIBlock: read %s: %w", path, err)
	}
	if err == nil {
		existing = string(data)
	}

	// Strip any existing block, then append the new block.
	stripped := stripExistingBlock(existing)
	final := stripped + block

	// Write to a .tmp sibling and rename atomically.
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, []byte(final), 0o644); err != nil {
		return fmt.Errorf("writeAIBlock: write tmp %s: %w", tmpPath, err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		// Best-effort cleanup.
		_ = os.Remove(tmpPath)
		return fmt.Errorf("writeAIBlock: rename %s -> %s: %w", tmpPath, path, err)
	}
	return nil
}

// detectAssistants inspects homeDir for known AI assistant configuration files
// and returns a slice of AssistantTarget for each detected assistant. The
// order is deterministic: Claude Code always precedes OpenCode.
// If homeDir is empty, an empty slice is returned.
func detectAssistants(homeDir string) []AssistantTarget {
	if homeDir == "" {
		return nil
	}

	var targets []AssistantTarget

	// Claude Code: ~/.claude/CLAUDE.md
	claudePath := filepath.Join(homeDir, ".claude", "CLAUDE.md")
	if _, err := os.Stat(claudePath); err == nil {
		targets = append(targets, AssistantTarget{
			Name: "Claude Code",
			Path: claudePath,
		})
	}

	// OpenCode: detect by directory ~/.config/opencode/ existence.
	// The target config file is ~/.config/opencode/AGENTS.md but we check the
	// directory so OpenCode is detected even before AGENTS.md is created.
	opencodeDir := filepath.Join(homeDir, ".config", "opencode")
	opencodePath := filepath.Join(opencodeDir, "AGENTS.md")
	if _, err := os.Stat(opencodeDir); err == nil {
		targets = append(targets, AssistantTarget{
			Name: "OpenCode",
			Path: opencodePath,
		})
	}

	return targets
}

// runSetupAIWithHome is the testable core of the setup-ai command. It accepts
// a homeDir parameter instead of calling os.UserHomeDir(), and writes output
// to the provided writers. This enables deterministic unit testing without
// touching real home directories.
func runSetupAIWithHome(homeDir string, flagClaude, flagOpenCode, flagAll bool, stdout, stderr io.Writer) error {
	block := generateBlockContent()

	var targets []AssistantTarget

	switch {
	case flagAll:
		// Write to all known targets regardless of detection.
		targets = []AssistantTarget{
			{Name: "Claude Code", Path: filepath.Join(homeDir, ".claude", "CLAUDE.md")},
			{Name: "OpenCode", Path: filepath.Join(homeDir, ".config", "opencode", "AGENTS.md")},
		}
	case flagClaude:
		targets = []AssistantTarget{
			{Name: "Claude Code", Path: filepath.Join(homeDir, ".claude", "CLAUDE.md")},
		}
	case flagOpenCode:
		targets = []AssistantTarget{
			{Name: "OpenCode", Path: filepath.Join(homeDir, ".config", "opencode", "AGENTS.md")},
		}
	default:
		// Auto-detect: only write to assistants that have their sentinel file.
		targets = detectAssistants(homeDir)
	}

	if len(targets) == 0 {
		fmt.Fprintln(stderr, "No AI assistants detected. Use --claude or --opencode to write manually.")
		return nil
	}

	var errs []error
	for _, target := range targets {
		if err := writeAIBlock(target.Path, block); err != nil {
			fmt.Fprintf(stderr, "error: %v\n", err)
			errs = append(errs, err)
			continue
		}
		fmt.Fprintf(stdout, "Wrote heydb context to %s (%s)\n", target.Path, target.Name)
	}

	return errors.Join(errs...)
}

// NewSetupAICmd creates and returns the setup-ai Cobra command.
func NewSetupAICmd() *cobra.Command {
	var flagClaude, flagOpenCode, flagAll bool

	cmd := &cobra.Command{
		Use:   "setup-ai",
		Short: "Inject heydb schema context into AI assistant config files",
		Long: `Writes a heydb context block into your AI assistant configuration files.

Supported targets:
  Claude Code  ~/.claude/CLAUDE.md
  OpenCode     ~/.config/opencode/AGENTS.md

By default, setup-ai auto-detects which assistants you have installed and
updates only those configuration files. Use flags to target specific assistants.

The block is idempotent: running setup-ai again updates the block in-place
without duplicating it or modifying content outside the markers.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			homeDir, err := os.UserHomeDir()
			if err != nil {
				return fmt.Errorf("setup-ai: cannot determine home directory: %w", err)
			}
			return runSetupAIWithHome(homeDir, flagClaude, flagOpenCode, flagAll, cmd.OutOrStdout(), cmd.ErrOrStderr())
		},
	}

	cmd.Flags().BoolVar(&flagClaude, "claude", false, "write to ~/.claude/CLAUDE.md (Claude Code)")
	cmd.Flags().BoolVar(&flagOpenCode, "opencode", false, "write to ~/.config/opencode/AGENTS.md (OpenCode)")
	cmd.Flags().BoolVar(&flagAll, "all", false, "write to all supported assistant config files")

	return cmd
}

func init() {
	rootCmd.AddCommand(NewSetupAICmd())
}
