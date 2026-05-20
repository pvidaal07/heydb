# heydb

Introspect MySQL databases and expose the schema to AI agents via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

heydb generates human-readable schema docs and a queryable SQLite store from your live database, then serves them to tools like Claude Code and Cursor without granting direct database access.

---

## Install

### Homebrew (macOS & Linux)

```sh
brew tap pvidaal07/tap
brew install heydb
```

To update:

```sh
brew upgrade heydb
```

### Go

Requires [Go 1.21+](https://go.dev/dl/):

```sh
go install github.com/pvidaal07/heydb/cmd/heydb@latest
```

Make sure `$HOME/go/bin` is in your `$PATH`.

### Download binary

Grab the latest release for your platform from [GitHub Releases](https://github.com/pvidaal07/heydb/releases/latest), extract it, and move the binary to a directory in your PATH.

---

## Quickstart

### 1. Initialize

Run once per project. Creates `.heydb/` with a blank config.

```sh
heydb init
```

### 2. Add a connection

Interactive form — prompts for host, port, database, username, and password.

```sh
heydb connect
```

> To list configured connections: `heydb connect --list`
> To switch the active connection: `heydb connect --use <name>`

### 3. Sync the schema

Introspects the active connection and writes schema files per connection.

```sh
heydb sync
```

Each connection gets its own files: `.heydb/{connection}.md` + `.heydb/{connection}.sqlite`.
Commit the `.md` files to your repository — they document your schema in plain Markdown.

> List synced connections: `heydb sync --list`
> Delete schema files: `heydb sync --delete <name>`

### 4. Serve the MCP server

Starts the MCP server over stdio. Point your AI tool at this command.

```sh
heydb serve
```

### 5. Configure your AI assistant (optional)

Inject heydb context into your AI assistant's configuration file. This tells the assistant about your schema files, available MCP tools, and how to use them.

```sh
heydb setup-ai
```

Auto-detects installed assistants (Claude Code, OpenCode) and writes the context block. You can also target specific assistants:

```sh
heydb setup-ai --claude      # Claude Code only
heydb setup-ai --opencode    # OpenCode only
heydb setup-ai --all         # all supported assistants
```

The block is idempotent — running `setup-ai` again updates it in-place without duplicating content.

---

## Interactive TUI

Run `heydb` in an interactive terminal (no arguments) to launch the visual navigator:

```sh
heydb
```

Or explicitly:

```sh
heydb tui
```

Three tabs available:

| Tab | What it does |
|-----|-------------|
| **Connections** | Browse, add, edit, delete, and switch database connections |
| **Schema** | Browse tables with drill-down to columns, indexes, and foreign keys |
| **Search** | Keyword search across table and column names with cross-tab navigation |

> **Tab / Shift+Tab** to switch tabs · **j/k** to navigate · **Enter** to select · **q** to quit

---

## Query the schema

Query your schema directly from the terminal without the MCP server:

```sh
heydb tables                  # list all tables
heydb describe <table>        # columns, indexes, foreign keys
heydb search <keyword>        # search by name or comment
```

---

## Schema drift detection

```sh
heydb review        # exits 0 if up to date, 1 if drifted
heydb diff          # shows exactly what changed
```

Useful in CI to detect unapplied migrations.

---

## MCP tools

The MCP server exposes seven tools. All tools accept an optional `connection` parameter — when omitted, the active connection is used.

| Tool | Description |
|------|-------------|
| `heydb_list_connections` | List all configured connections (name, active status, sync status) |
| `heydb_list_tables` | List all tables with column count and comment |
| `heydb_get_table` | Full details for a table (columns, indexes, FKs, annotations) |
| `heydb_search` | Substring search across table names, column names, and comments |
| `heydb_annotate` | Add or update annotations for a table (persisted across syncs) |
| `heydb_annotate_column` | Annotate a specific column with business context |
| `heydb_annotate_db` | Annotate the database itself (purpose, ownership, constraints) |

---

## Configure MCP in your AI tool

### Claude Code

**Global (recommended)** — available in every project:

```sh
claude mcp add heydb --scope user -- heydb serve
```

**Per project** — only available in the current directory:

```sh
claude mcp add heydb --scope project -- heydb serve
```

> Run `claude mcp list` to verify the server is connected. If it shows up in one
> project but not another, it was added with `--scope project` instead of `--scope user`.

Or add manually to `~/.claude/settings.json` (global) or `.claude/settings.json` (project):

```json
{
  "mcpServers": {
    "heydb": {
      "command": "heydb",
      "args": ["serve"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

### OpenCode

Add to `~/.config/opencode/opencode.json` or `opencode.json` in your project root:

```json
{
  "mcp": {
    "heydb": {
      "enabled": true,
      "type": "local",
      "command": ["heydb", "serve"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "heydb": {
      "command": "heydb",
      "args": ["serve"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

---

## Creating a read-only MySQL user

heydb only needs `SELECT` on `INFORMATION_SCHEMA`. Use the interactive helper to generate the SQL — heydb never executes it:

```sh
heydb create-user
```

This prints a `CREATE USER` + `GRANT` + `FLUSH PRIVILEGES` block that you copy into your MySQL client. Three permission scopes are available:

| Scope | Description |
|-------|-------------|
| `schema_only` | `SELECT` on `information_schema.*` only — minimum required for `heydb sync` |
| `select_all` | `schema_only` + `SELECT` on all tables in a specific database |
| `select_specific` | `schema_only` + `SELECT` on specific tables only |

---

## .heydb/ directory layout

```
.heydb/
├── config.json           # connection config (keep private)
├── .gitignore            # auto-generated
├── {connection}.md       # human-readable schema (commit this)
└── {connection}.sqlite   # local query cache (do not commit)
```

---

## License

MIT
