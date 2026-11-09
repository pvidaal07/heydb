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
2. `/heydb:connect` asks for name, engine, host, port, user and databases, and last for the password, in an input that shows `•` instead of what you type.
   For PostgreSQL it asks for exactly one database, because a PostgreSQL connection only reaches the database it opens, and optionally which schemas to capture (empty for every non-system schema). Add one connection per database.
3. `/heydb:sync` captures the schema. Run it again after migrations; the snapshot is only rewritten when the structure changed.

`/heydb:status` compares the live database with the snapshot without writing anything. `/heydb:about` prints the version.

### Passwords

The password you type is saved in `.heydb/.env` as `HEYDB_<NAME>_PASSWORD` (for a connection `local`, `HEYDB_LOCAL_PASSWORD`). That file is ignored by git (heydb checks `.heydb/.gitignore` before writing) and readable only by your user (permissions `600`; on Windows it keeps the folder's permissions). `config.json` only names the variable, never the value. Change it later with `/heydb:password [connection]`.

Leave the password empty, or use Pi without its terminal UI (RPC), and set the variable yourself:

```sh
export HEYDB_LOCAL_PASSWORD='…'   # in your shell; it wins over .heydb/.env
```

Anyone who can read your files can read `.heydb/.env`: it keeps the password out of git and out of the chat, not away from your own user account.

### Several connections

A project can have as many connections as it needs, for example `dev` and `prod`. `/heydb:connections` lists them (default, whether the password is set, whether it was synced); `/heydb:connections use prod` changes the default; `/heydb:connections remove prod` removes one and its password, and keeps its snapshot and notes on disk. Commands and tools use the default unless you name a connection: `/heydb:sync prod`.

Each connection has its own snapshot and its own notes, also `dev` and `prod` of the same application: a note is about the database you looked at.

Two connections can be related: when `crm.clientes.cod_erp` holds codes of `erp`'s `gcl.cod`, the agent records it with `heydb_relate` and `to_connection: "erp"`. The relationship is stored with the `crm` notes, and `heydb_table gcl` on `erp` lists it as `crm: crm.clientes(cod_erp) → (cod)`. If `erp` is removed, unsynced or drops the column, heydb treats the relationship as an orphan; it is never deleted.

Some facts are about the whole project, not one database: "the ERP uses one database per client; the central one is eagle". Those are project notes, saved with `heydb_annotate` and `scope: "project"` in `.heydb/knowledge/_project.json`, and shown first by `heydb_overview`.

Microservices with a database each: give every service its own `.heydb/` (run `/heydb:init` in its folder). heydb uses the `.heydb/` nearest to the folder Pi runs in, going up, so starting Pi in a service picks that service's connections. A single `.heydb/` at the repository root with one connection per service also works.

## What your agent gets

| Tool | What it does |
|---|---|
| `heydb_overview` | Databases, warnings and tables, with notes |
| `heydb_table` | One table: columns, keys, indexes, relationships and notes |
| `heydb_search` | Search names, comments, view definitions and notes, ignoring case and accents |
| `heydb_annotate` | Save a note on the project, a database, table or column |
| `heydb_relate` | Record a join that has no foreign key, also across connections |
| `heydb_edit_note`, `heydb_forget` | Fix or remove a note or relationship by id |

### Learning from code

After `/heydb:sync`, heydb looks for source files in the project that name the synced tables (`git ls-files`, or a walk that skips `node_modules`, `vendor`, `.heydb` and build output; at most 5,000 files, 50 MB and 3 seconds). If it finds some, it asks whether the agent should read them and note what the code makes explicit: valid values, units, joins without a foreign key. Each note cites its file, like `(code: src/Models/Order.php)`. It costs tokens, so it only starts when you say yes; `/heydb:learn-code [connection]` asks again later. Without such code nothing is asked, and the notes come from your conversations instead, marked `(told by the user)`.

The tools only read and write files in `.heydb/`; they never connect to the database. Notes written by the agent are signed `<your git user.name> (via agent)`. A bundled skill tells the agent when to check heydb and how to write useful notes.

## What gets committed

| Path | Commit it? |
|---|---|
| `.heydb/config.json` | Yes: connections, with passwords only as `env:HEYDB_…` references |
| `.heydb/snapshots/*.json.gz` | Yes: the schema, gzip-compressed |
| `.heydb/knowledge/` | Yes: the team's notes and relationships |
| `.heydb/.env` | Never: local passwords; `.heydb/.gitignore` excludes it |

The snapshot is compressed because a large schema is hundreds of thousands of lines of JSON that nobody reviews; `/heydb:sync` prints what changed instead. It is rewritten only when the structure changed, so syncing an unchanged database leaves git clean. Snapshots written by earlier versions as plain `.json` are still read and replaced by the `.json.gz` on the next change. To see snapshot diffs in git anyway, add `*.json.gz diff=gzip` to `.gitattributes` and run `git config diff.gzip.textconv "gzip -dc"`.

Removing a connection keeps its files in `.heydb/snapshots/` and `.heydb/knowledge/`; delete them yourself if you no longer need them.

## Development

```sh
pnpm check                 # typecheck + unit tests
node --run db:up           # MySQL, MariaDB and PostgreSQL in Docker
node --run test:integration
```

## License

MIT
