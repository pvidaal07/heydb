# heydb

Database schema context for AI agents.

heydb reads the structure of your MySQL, MariaDB or PostgreSQL 14+ database (never its data), keeps a local snapshot, lets you and your agent annotate what tables and columns mean, and shares that knowledge with your team through git. Your agent understands the database without ever connecting to it.

> [!IMPORTANT]
> **heydb v2 is under active development.** It is being rebuilt in TypeScript as a [Pi](https://pi.dev) package. Nothing is published yet.
>
> The previous Go version (CLI + MCP server) is archived at tag [`v1.3.1`](https://github.com/pvidaal07/heydb/releases/tag/v1.3.1) and no longer maintained.

## Try it from source

Requires Node.js 22.19+ and pnpm (via `corepack enable`).

```sh
git clone https://github.com/pvidaal07/heydb.git && cd heydb
pnpm install
cd /path/to/your/project
pi -e /path/to/heydb      # loads the extension and the heydb skill
```

## Set up a project

In Pi, from your project folder:

1. `/heydb:init` creates `.heydb/`.
2. `/heydb:connect` asks for name, engine, host, port, user and databases. It never asks for the password.
   For PostgreSQL it asks for exactly one database, because a PostgreSQL connection only reaches the database it opens, and optionally which schemas to capture (empty for every non-system schema). Add one connection per database.
3. Set the password where heydb looks for it, for a connection named `local`:
   ```sh
   export HEYDB_LOCAL_PASSWORD='…'                      # in your shell, or
   echo "HEYDB_LOCAL_PASSWORD='…'" >> .heydb/.env       # ignored by git
   ```
4. `/heydb:sync` captures the schema. Run it again after migrations; the snapshot is only rewritten when the structure changed.

`/heydb:status` compares the live database with the snapshot without writing anything. `/heydb:about` prints the version.

## What your agent gets

| Tool | What it does |
|---|---|
| `heydb_overview` | Databases, warnings and tables, with notes |
| `heydb_table` | One table: columns, keys, indexes, relationships and notes |
| `heydb_search` | Search names, comments, view definitions and notes, ignoring case and accents |
| `heydb_annotate` | Save a note on a database, table or column |
| `heydb_relate` | Record a join that has no foreign key |
| `heydb_edit_note`, `heydb_forget` | Fix or remove a note or relationship by id |

The tools only read and write files in `.heydb/`; they never connect to the database. Notes written by the agent are signed `<your git user.name> (via agent)`. A bundled skill tells the agent when to check heydb and how to write useful notes.

## What gets committed

| Path | Commit it? |
|---|---|
| `.heydb/config.json` | Yes: connections, with passwords only as `env:HEYDB_…` references |
| `.heydb/snapshots/` | Yes: the schema, reviewable in pull requests |
| `.heydb/knowledge/` | Yes: the team's notes and relationships |
| `.heydb/.env` | Never: local passwords; `.heydb/.gitignore` excludes it |

## Development

```sh
pnpm check                 # typecheck + unit tests
node --run db:up           # MySQL, MariaDB and PostgreSQL in Docker
node --run test:integration
```

## License

MIT
