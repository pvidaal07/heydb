# heydb

Introspect MySQL databases and expose the schema to AI agents via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

heydb generates a human-readable `heydb.md` and a queryable `heydb.sqlite` from your live database, then serves them to tools like Claude Code and Cursor without granting direct database access.

---

## Install

Requires [Go 1.21+](https://go.dev/dl/):

```sh
go install github.com/pvidaal07/heydb/cmd/heydb@latest
```

Make sure `$HOME/go/bin` is in your `$PATH`:

```sh
export PATH="$PATH:$HOME/go/bin"
```

To update, run the same `go install` command again.

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

Introspects the active MySQL connection and writes `.heydb/heydb.md` + `.heydb/heydb.sqlite`.

```sh
heydb sync
```

Commit `heydb.md` to your repository — it documents your schema in plain Markdown.
The `.heydb/heydb.sqlite` file is in `.gitignore` by default (local cache only).

### 4. Serve the MCP server

Starts the MCP server over stdio. Point your AI tool at this command.

```sh
heydb serve
```

---

## Check for schema drift

```sh
heydb review
```

Exits `0` if the live database matches the last sync, `1` if the schema has changed.
Useful in CI to detect unapplied migrations.

---

## MCP tools

The MCP server exposes three tools:

| Tool | Description |
|------|-------------|
| `heydb_list_tables` | List all tables with column count and comment |
| `heydb_get_table` | Get full details for a specific table (columns, indexes, foreign keys) |
| `heydb_search` | Full-text LIKE search across table names, column names, and comments |

---

## Configure in Claude Code

Add to `.claude/mcp.json` (or `~/.claude/mcp.json` for global config):

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

## Configure in Cursor

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
├── config.json      # connection config (keep private)
├── .gitignore       # auto-generated, excludes sqlite and tmp files
├── heydb.md         # human-readable schema (commit this)
└── heydb.sqlite     # local query cache (do not commit)
```

---

## License

MIT
