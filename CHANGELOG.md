# Changelog

## [2.0.0-beta.1]

- Documentation, the bundled skill and tests use generic examples only.
- Releases are published from GitHub Actions through npm trusted publishing.

## [2.0.0-beta.0]

heydb is rebuilt from scratch in TypeScript as a [Pi](https://pi.dev) package. The Go CLI and MCP server (v1) are archived at tag `v1.3.1`.

- Read-only introspection of MySQL, MariaDB and PostgreSQL 14+: tables, views, materialized views, columns, keys, indexes, composite and cross-database foreign keys, triggers, routines and view definitions, with warnings for whatever the user's privileges hide.
- Snapshot shared as `.heydb/snapshots/<connection>.json.gz`, rewritten only when the structure changes.
- Notes on the project, databases, tables and columns, and implicit relationships, also across connections, stored in `.heydb/knowledge/` for the team.
- Drift detection with `/heydb:status`.
- Agent tools that never connect to the database: `heydb_overview`, `heydb_table`, `heydb_search`, `heydb_annotate`, `heydb_relate`, `heydb_edit_note`, `heydb_forget`.
- Commands: `/heydb:init`, `/heydb:connect`, `/heydb:password`, `/heydb:connections`, `/heydb:sync`, `/heydb:status`, `/heydb:learn-code`, `/heydb:about`.
- Learning from the project's code after a sync, including legacy code (Harbour, Delphi, VB…), with notes that cite their source file.
- Passwords asked in a masked input and kept in `.heydb/.env`, which git always ignores; `config.json` holds references only.
