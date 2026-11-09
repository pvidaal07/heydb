# heydb

**Database schema context for AI agents, built for legacy databases.**

heydb reads the structure of your MySQL, MariaDB or PostgreSQL database (never its data), keeps a snapshot in your repository, and lets you and your agent write down what tables and columns really mean. Your agent understands the database without ever connecting to it, and your team gets that knowledge with a `git pull`.

It is a [Pi](https://pi.dev) package: Pi gets agent tools, slash commands and a skill.

> [!NOTE]
> **v2 is in beta.** The previous Go CLI and MCP server (v1) are archived at tag [`v1.3.1`](https://github.com/pvidaal07/heydb/releases/tag/v1.3.1) and no longer maintained.

## Why

On a legacy database the agent guesses. A table called `art` "looks like" artwork and turns out to hold the articles; `estado = 3` means something only the team knows; half the joins have no foreign key. heydb gives the agent the evidence instead of the name:

- the structure, read-only and complete, with warnings for anything your privileges hide;
- who references each table and how those columns are commented (`ref_art` "Artículo" ×12 says more than the name `art`);
- the notes your team and your agent saved, each with its author and its source.

The agent is told to present inferences as inferences and ask before saving them.

## Install

```sh
pi install npm:@pvidaal07/heydb
```

npm only accepts the name under its owner's scope (plain `heydb` is too close to an existing package); the package, its commands and tools are still called heydb.

From the repository instead (latest commit): `pi install git:github.com/pvidaal07/heydb`.

Requires Pi and Node.js 22.19 or later.

## Quick start

In Pi, from your project folder:

1. `/heydb:init` creates `.heydb/`.
2. `/heydb:connect` asks for a name, engine, host, port, user and databases, and last for the password in a masked input.
3. `/heydb:sync` captures the schema and, if the project contains code that queries those tables, offers to let the agent read it and take notes.

Then just work: ask your agent about the database. It reads the snapshot with the heydb tools and saves what it learns from you and from the code.

## Supported databases

| Engine | Tested in CI | Notes |
|---|---|---|
| MySQL | 8.0 | 5.7 used on a schema with about 1,500 tables |
| MariaDB | 10.6 | 10.2 or later expected |
| PostgreSQL | 16 | 14 or later expected; one connection reaches one database, choose schemas inside it |

Captured: databases and schemas; tables, views and materialized views with their SQL; columns (type, nullability, default, comment, collation, auto-increment or identity, generated); primary keys in key order; indexes; foreign keys, composite and across databases, with `ON DELETE`/`ON UPDATE`; triggers; routine names; approximate row counts. Never row data.

Every session is read-only, even for a user with write privileges.

## Commands

| Command | What it does |
|---|---|
| `/heydb:init` | Create `.heydb/` in the project |
| `/heydb:connect` | Add a connection; the password goes to `.heydb/.env` |
| `/heydb:password [connection]` | Change a connection's password |
| `/heydb:connections [use <name> \| remove <name>]` | List connections, set the default, remove one (its snapshot and notes stay) |
| `/heydb:sync [connection]` | Capture the schema; the snapshot is rewritten only when the structure changed |
| `/heydb:status [connection]` | Show whether the live database drifted from the snapshot, and what changed |
| `/heydb:learn-code [connection] [path]` | Let the agent read the code that queries the tables and note what it shows |
| `/heydb:about` | Show the version |

## Agent tools

None of them connects to the database; they read and write files in `.heydb/`.

| Tool | What it does |
|---|---|
| `heydb_overview` | Size, comment coverage, name prefixes, most referenced tables, warnings and project notes; databases with the same structure shown once |
| `heydb_table` | One table: evidence of meaning first (comment, notes, who references it), then keys, relationships and up to 60 columns, with a column filter |
| `heydb_search` | Search by words, not exact phrases: names (abbreviations too), comments, notes and view definitions, ignoring case, accents and plurals; noted tables rank first, copies of a table fold under it, and tables found only through what references them are marked as inferred |
| `heydb_annotate` | Save a note on the project, a database, table or column |
| `heydb_relate` | Record a join that has no foreign key, also across connections |
| `heydb_edit_note`, `heydb_forget` | Fix or remove a note or relationship by id |

Notes saved by the agent are signed `<your git user.name> (via agent)` and end with their source: `(code: src/Models/Order.php)`, `(docs: docs/tables.md)` or `(told by the user)`.

## Learning from code

After a sync, heydb looks for code in the project that uses the synced tables. It walks the folders, including ones git ignores (a reference copy of another repository, for example), and skips `node_modules`, `vendor`, build output, CI folders and lockfiles. It reads modern and legacy languages: PHP, TypeScript, JavaScript, Python, Java, C#, Go, Ruby, SQL, Kotlin, Scala, Harbour/Clipper, Delphi, Visual Basic, COBOL, ABL and RPG.

A table only counts in database context: SQL with its statement verb (`SELECT … FROM art`, `UPDATE art … SET`, `INSERT INTO art`), including SQL whose database prefix is built by code (`"FROM " + cDb + ".art"`), or a table declaration (`protected $table = 'art'`, `cTabla := "art"`, `@Table(name = "art")`, `__tablename__`, `DB::table('art')`…). A table called `config` is not matched by every comment that says "config".

Documentation counts too, where it defines a table: a markdown or text file that writes the name in backticks (`` `cst` ``), alone in a table cell (`| tda | Almacenes |`) or at the start of a line followed by `=`, `:` or a dash and words (`cst = maestro de clientes`). A passing mention in prose does not.

If it finds such code it asks first, because reading it costs tokens. The tables come in the order a note helps most: those with no comment and no note first, then commented ones, then those that already have a note; within each group, cryptic names (`cst`, `fac_cab`), tables many others point to and tables much code uses come first. The agent writes one note per table saying what it holds in business words, with the synonyms people use (both languages when the team mixes them), since that is what search finds tables by; valid values, units and joins without a foreign key only when the code makes them explicit. Every note cites its source, nothing is guessed, it stops after about 20 notes and leaves what remains unclear as questions. `/heydb:learn-code acme ../legacy-app` reads code that lives in another folder. The scan stops after 10 seconds or 50 MB on very large codebases; documentation is read first, with at most a quarter of that budget while code waits, so a large codebase never leaves the docs unread.

Without such code, notes come from your conversations: tell the agent what a table means and it saves it.

## heydb is as good as what it knows

heydb does not guess. It finds a table through its name, its comments, the columns that reference it and, above all, the notes your team and your agent saved. On a schema where names say nothing (`cst`, `t_aux2`), comments are empty and nobody has written a note yet, a search for "customers" has nothing to match: the agent gets weak results and falls back to slower ways, such as reading the overview, opening tables one by one or searching the code.

It gets better as you work. Each time you confirm what a table or column means, or decide which table holds a concept, the agent saves a note in the words people will search with, and the next search on that concept returns that table first. Measured on a real legacy ERP of about 1,500 tables, one note per table that answered a question raised the right table into the first five results from 16 to 33 of 36 cases (see [bench/](bench/README.md)).

To get there sooner:

- run `/heydb:learn-code` when the project has code that queries the database;
- tell the agent what the important tables are in your own words, synonyms included, in every language your team uses;
- commit `.heydb/` so everyone, and every agent, starts from what the team already knows.

## Several connections

A project can have as many connections as it needs: `dev` and `prod`, or one per service. Commands and tools use the default unless you name one (`/heydb:sync prod`). Each connection has its own snapshot and notes.

- **Across connections:** when `crm.clientes.cod_erp` holds codes of `erp`'s `cus.cod`, the agent records it with `heydb_relate` and `to_connection: "erp"`, and `heydb_table cus` on `erp` shows it.
- **Project notes:** facts about the whole system ("one database per client; the central one is acme") are saved with `scope: "project"` and shown first by `heydb_overview`.
- **Microservices:** give each service its own `.heydb/`; heydb uses the nearest one above the folder Pi runs in.

## Passwords

`/heydb:connect` and `/heydb:password` save the password in `.heydb/.env` as `HEYDB_<NAME>_PASSWORD`, readable only by your user. heydb makes sure git ignores that file before writing, and refuses to write if git already tracks it. `config.json` only names the variable. You can also set it in your shell, which wins over the file:

```sh
export HEYDB_PROD_PASSWORD='…'
```

This keeps passwords out of git and out of the chat, not away from your own user account.

## What gets committed

| Path | Commit it? |
|---|---|
| `.heydb/config.json` | Yes: connections, with password references only |
| `.heydb/snapshots/*.json.gz` | Yes: the schema, compressed (a schema with about 1,500 tables is about 470 KB) |
| `.heydb/knowledge/` | Yes: the team's notes and relationships |
| `.heydb/.env` | Never: local passwords |

If your project's `.gitignore` excludes `.heydb/`, notes stay on your machine; heydb tells you when it saves one. To see snapshot diffs in git, add `*.json.gz diff=gzip` to `.gitattributes` and run `git config diff.gzip.textconv "gzip -dc"`.

## Not yet

- Running queries or reading row data.
- Redis and other engines (Redis is next).
- A CLI or MCP server for agents outside Pi.
- Suggesting relationships on its own, beyond the name-pattern hints in `heydb_table`.
- Listing orphaned notes (notes whose table or column disappeared) from a tool.
- Storing passwords in the system keychain.

Ideas and bugs are welcome in [issues](https://github.com/pvidaal07/heydb/issues).

## Contributing

Contributions are welcome: open an issue, wait for `status:approved`, then fork and send a pull request to `main` that says `Closes #<issue>`. [CONTRIBUTING.md](CONTRIBUTING.md) explains the workflow, the setup and how the code is organized. Security problems go to a [private advisory](https://github.com/pvidaal07/heydb/security/advisories/new).

## Development

```sh
corepack enable
pnpm install
pnpm check                 # typecheck + unit tests
node --run db:up           # MySQL 8.0, MariaDB 10.6 and PostgreSQL 16 in Docker
node --run test:integration
node --run db:down
pi -e .                    # try the local copy in Pi
```

Releases (maintainers): bump `version` in `package.json`, add the entry to `CHANGELOG.md`, merge, and push a tag `vX.Y.Z` on `main`; the publish workflow tests, stages the version on npm through trusted publishing and creates the GitHub release. The version becomes public once a maintainer approves it on npmjs.com (Staged Packages) with 2FA.

## License

MIT
