# Changelog

## [Unreleased]

- `/heydb:learn-code` (and the offer after a sync) spends the agent's notes where they help search most: tables with no comment and no note come first, then commented ones, then those already noted, and within each group cryptic names (short, vowel-less or mostly 3-letter parts), tables many others point to and tables much code uses first. Documentation that defines a table (`` `cst` = … ``, `| tda | Almacenes |`, `cst: …` at the start of a line) is evidence too; passing mentions are not. The agent is asked for one note per table in business words with the synonyms people use, citing `(code: …)` or `(docs: …)`, and to ask instead of guessing.
- `/heydb:learn-code` works in rounds: the agent writes at most one note per listed table (no longer stopping after about 20) and ends by telling the user how many tables used in the code still have no description and that running `/heydb:learn-code` again covers the next ones, since noted tables go last; when none remain it says the code has been fully covered. `bench/learn-code.ts` shows that count.
- `/heydb:learn-code` reads documentation before code: docs get at most a quarter of the file, byte and time limits while code waits (code gets the rest), so a large codebase that comes first in folder order no longer uses up the scan before the docs that define the tables are read.
- `bench/learn-code.ts` prints, without any model, what `/heydb:learn-code` would send for a project: the tables in order, their code and docs, and the message size in tokens, scanning a temporary copy (bench only).
- `heydb_overview` stays small on servers with one database per client: databases with the same tables and columns are one block, "emp_001 (+49 with the same structure: emp_002, emp_003, emp_004, …)", with their tables listed once; at most 20 database blocks, then "… N more databases — use heydb_search with database". The most referenced tables are named in one line per database (their rows and comments are in the table list), and project notes are capped at 20 of up to 300 characters, pointing to `.heydb/knowledge/_project.json` for the rest. Synthetic ERP with 50 companies: ≈8.6k → ≈0.7k tokens.
- The tool definitions sent on every turn are a third shorter (≈1.66k → ≈1.09k tokens): guidelines keep short rules that name their tool, and the longer explanations (note sources, project notes, joins across connections, how search matches) are in the bundled skill.
- `heydb_search` matches words, not a phrase: "facturas de venta cabecera" finds tables whose names, comments, notes or columns hold those words in any order, skipping stopwords, reading abbreviated names (`alb_lin` for "albarán") and ranking by BM25 with more matched words first. Identical tables in several databases are one result, and words that matched nothing are named instead of a bare "No matches".
- `heydb_search` answers in fewer tokens: one line per result with what the table is (its comment or note) and up to 3 matching columns with their comments; the 10 best by default (was 20), with matches scoring under a fifth of the best counted as "… N weaker matches" instead of listed (an explicit `limit` lists them). Only inferred meanings and abbreviation-only names are still marked.
- `heydb_search` learns from the team's notes: a note on a table outranks its name and its columns, whatever its length, so once someone notes that `cst` is the customer master, "clientes" finds it first. The `heydb_annotate` guideline and the skill ask agents to save confirmed meanings in the words people search with.
- `heydb_search` folds copies of a table in its own database (the smaller has 3 columns or more, all of them in the other, and at least 90% of the other's; found from the columns, never from names) into the original's line as "(+3 copies: fac_cab_2019, fac_cab_2020, …)", counted once. A copy matching something of its own (a word of its name, its comment or notes, columns the original lacks) is listed on its own: "rectificación de asistencia" finds `asistencia_rec`.
- The token benchmark compares heydb with the other ways to give an agent a database's schema, on the same questions and policy: a SCHEMA.md read whole or grepped, a grep of the project's code (`--code`), direct SQL with LIKE on names and comments, a Prisma-like ORM schema, a generic database MCP server and the information_schema baselines, reporting tokens, calls, tables found, rank and time per strategy (bench only).
- The token benchmark measures the learning loop with `--learn` (questions, one note per answer, questions again, on a temporary copy of the project), and its synthetic ERP keeps realistic copies of module tables.
- A real-agent benchmark (`bench/agent/run.ts`): a model inside Pi answers each question with one strategy's tools at a time (heydb, heydb with notes, SCHEMA.md, a Prisma schema, the code, direct SQL and a database MCP server against a schema-only MySQL in docker), recording the tokens the provider reports, tool calls, time and whether the expected tables were named (bench only).
- The token benchmarks take `--scenario small`: a synthetic small app (one database, 15 well-named tables with foreign keys, a few comments, its code and 10 questions) next to the legacy ERP, to show where heydb pays off and where it does not (bench only).
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
