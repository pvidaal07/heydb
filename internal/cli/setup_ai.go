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

This project uses [heydb](https://github.com/pvidaal07/heydb) to document
and expose MySQL database schemas to AI agents via the Model Context Protocol
(MCP). heydb is read-only — it never modifies the source database.

### How to Use Schema Context

**BEFORE writing SQL queries, reasoning about the database, or suggesting
schema changes, you MUST check the available schema context.** Two sources:

1. **Schema markdown files** in ` + "`" + `.heydb/*.md` + "`" + ` — one file per connection,
   tracked in git. Read these directly for quick offline context.
2. **MCP tools** (when ` + "`" + `heydb serve` + "`" + ` is running) — structured queries for
   precise lookups, searches, and annotation management.

Use the markdown files for broad context (understanding the full schema).
Use MCP tools for targeted queries (specific table details, searching across
tables, or reading/writing annotations).

### MCP Tools Reference

All tools accept an optional ` + "`" + `connection` + "`" + ` parameter. When omitted, the
active connection is used. Call ` + "`" + `heydb_list_connections` + "`" + ` first to discover
available connections.

| Tool | Purpose | When to use |
|------|---------|-------------|
| ` + "`" + `heydb_list_connections` + "`" + ` | List all configured connections (name, active, synced) | Before any multi-connection workflow |
| ` + "`" + `heydb_list_tables` + "`" + ` | List all tables with column counts and comments | Getting an overview of the schema |
| ` + "`" + `heydb_get_table` + "`" + ` | Full detail: columns, types, indexes, FKs, annotations | Before writing queries involving a table |
| ` + "`" + `heydb_search` + "`" + ` | Search tables and columns by keyword | Finding where a concept lives in the schema |
| ` + "`" + `heydb_annotate` + "`" + ` | Annotate a table with business context | Documenting what a table represents |
| ` + "`" + `heydb_annotate_column` + "`" + ` | Annotate a specific column | Documenting field meaning, valid values, gotchas |
| ` + "`" + `heydb_annotate_db` + "`" + ` | Annotate the database itself | Documenting system purpose, ownership, constraints |

### Annotations Are Persistent

Annotations survive ` + "`" + `heydb sync` + "`" + ` runs — they are never overwritten by schema
introspection. Use them freely to document:
- Business meaning ("This table stores invoices for the billing module")
- Implicit relationships ("user_id references auth.users but has no FK constraint")
- Data quality notes ("email column may contain legacy invalid addresses")
- Access patterns ("This table is write-heavy, ~10k inserts/day")

### Multi-Connection Workflows

heydb serves all configured connections simultaneously. Each connection has
its own schema store under ` + "`" + `.heydb/` + "`" + `. Common patterns:

- **Cross-database context**: Pass ` + "`" + `connection` + "`" + ` to query different databases
  within the same session
- **Dev vs production**: Compare schemas across environments
- **Related systems**: Query billing + CRM + accounting schemas together

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
