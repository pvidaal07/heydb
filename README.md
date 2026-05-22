# heydb

Introspect MySQL databases and expose the schema to AI agents via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

heydb syncs your live database schema into a local SQLite store, lets your team annotate tables and columns with business context, and serves everything to AI tools like Claude Code and Cursor — without granting them direct database access.

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

Run once per project. Creates `.heydb/` in the current directory and registers the project.

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

Introspects the active connection and stores the schema in `~/.heydb/heydb.db`.

```sh
heydb sync
```

> List synced connections: `heydb sync --list`
> Remove a connection's schema: `heydb sync --delete <name>`

### 4. Serve the MCP server

Starts the MCP server over stdio. Point your AI tool at this command.

```sh
heydb serve
```

### 5. Push / pull annotations (optional — for teams)

Share annotations with teammates by committing the `.heydb/` directory to git.

```sh
heydb push     # export new annotations as a chunk into .heydb/chunks/
heydb pull     # import chunks from .heydb/chunks/ into the local store
```

Commit `.heydb/manifest.json` and `.heydb/chunks/` to git. Each teammate runs `heydb pull` after a `git pull` to receive the latest annotations.

### 6. Configure your AI assistant (optional)

Inject heydb context into your AI assistant's configuration file:

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
heydb diff          # shows exactly what changed since last sync
```

Useful in CI to detect unapplied migrations.

---

## Generate documentation

```sh
heydb docs                        # write .heydb/{connection}.md
heydb docs --connection <name>    # specific connection
heydb docs --stdout               # print to stdout
```

Generates a Markdown file with the full schema (tables, columns, indexes, foreign keys) plus all accumulated annotations, including author and date.

---

## Collaborative annotations

Annotations are accumulative — multiple annotations per table or column are allowed. Each annotation records the author and timestamp so you can see who wrote what and when.

```
> **Annotation** by pvidal (2026-05-21): This table stores user accounts
> **Annotation** by jsmith (2026-05-20): Contains both active and deleted users
```

Annotations survive `heydb sync` runs — they are never overwritten by schema introspection.

### Team workflow

1. Add annotations via `heydb serve` (MCP tools) or TUI
2. Run `heydb push` to export them as a chunk into `.heydb/chunks/`
3. Commit `.heydb/manifest.json` and `.heydb/chunks/`
4. Teammates run `git pull` then `heydb pull` to import the annotations

---

## MCP tools

The MCP server exposes twelve tools. All tools accept an optional `connection` parameter — when omitted, the active connection is used.

| Tool | Description |
|------|-------------|
| `heydb_list_connections` | List all configured connections (name, active status, sync status) |
| `heydb_list_tables` | List all tables with column count and comment |
| `heydb_get_table` | Full details for a table (columns, indexes, FKs including implicit, annotations) |
| `heydb_search` | Search across table/column names, annotation content, and implicit relationships |
| `heydb_annotate` | Add an annotation for a table with business context |
| `heydb_annotate_column` | Annotate a specific column with business context |
| `heydb_annotate_db` | Annotate the database itself (purpose, ownership, constraints) |
| `heydb_edit_annotation` | Edit the content of an existing annotation by UUID |
| `heydb_delete_annotation` | Delete an annotation by UUID |
| `heydb_add_relationship` | Document an implicit (undocumented) FK relationship between two tables |
| `heydb_delete_relationship` | Delete an implicit relationship by UUID |
| `heydb_list_relationships` | List all implicit relationships for the active connection |

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
├── manifest.json         # chunk manifest (commit this)
├── chunks/               # annotation chunks (commit this)
│   └── {hash}.chunk.gz   # gzipped JSONL annotation chunk
└── .gitignore            # auto-generated
```

**Never committed** — lives in `~/.heydb/heydb.db`:
- All connection config (host, port, credentials)
- Schema cache (tables, columns, indexes, foreign keys)
- Annotation store (source of truth before push)

---

## License

MIT
