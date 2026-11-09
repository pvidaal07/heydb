# Changelog

## [Unreleased]

- `heydb_search` matches words, not a phrase: "facturas de venta cabecera" finds tables whose names, comments, notes or columns hold those words in any order, skipping stopwords, reading abbreviated names (`alb_lin` for "albarán") and ranking by BM25 with more matched words first. Identical tables in several databases are one result, and words that matched nothing are named instead of a bare "No matches".
- `heydb_search` answers in fewer tokens: one line per result with what the table is (its comment or note) and up to 3 matching columns with their comments; the 10 best by default (was 20), with matches scoring under a fifth of the best counted as "… N weaker matches" instead of listed (an explicit `limit` lists them). Only inferred meanings and abbreviation-only names are still marked.
- `heydb_search` learns from the team's notes: a note on a table outranks its name and its columns, whatever its length, so once someone notes that `cst` is the customer master, "clientes" finds it first. The `heydb_annotate` guideline and the skill ask agents to save confirmed meanings in the words people search with.
- `heydb_search` folds copies of a table in its own database (the smaller has 3 columns or more, all of them in the other, and at least 90% of the other's; found from the columns, never from names) into the original's line as "(+3 copies: fac_cab_2019, fac_cab_2020, …)", counted once. A copy matching something of its own (a word of its name, its comment or notes, columns the original lacks) is listed on its own: "rectificación de asistencia" finds `asistencia_rec`.
- The token benchmark measures the learning loop with `--learn` (questions, one note per answer, questions again, on a temporary copy of the project), and its synthetic ERP keeps realistic copies of module tables.
- `heydb_table` lists one line per column (`- num_fac int(11) PK — "Factura"`, with `null`, `=default` and `auto` only when they apply) instead of a mostly empty table, cuts column comments and notes at 100 characters unless a `column_filter` asks for them, and lists at most 10 foreign keys, triggers and indexes with "… N more".

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
