---
name: heydb
description: Consult and enrich the database schema of a heydb project (.heydb/ folder) with the heydb_* tools. Use before writing, reviewing or debugging SQL, queries, migrations or ORM models; when asked what a table or column means or how tables join; and when you learn business meaning (valid values, units, legacy quirks) or a join without a foreign key that the team should keep.
---

# heydb

heydb keeps a snapshot of the project's database structure (`.heydb/snapshots/`) and the team's notes about it (`.heydb/knowledge/`). The team shares them only if the project commits `.heydb/`; some projects ignore it, so do not promise that a note reaches anyone else. The tools read those files; they never connect to the database.

## Read before you write SQL

1. Looking for a concept ("invoices", "fecha de baja"): `heydb_search`. It matches each word on its own, in any order (stopwords skipped, abbreviated names such as `fac_cab` for "factura" found), ignores case, accents and simple plurals, says which words matched nothing, lists identical tables of other databases once, folds copies of a table in its own database (same columns: yearly, backup, temporary tables) into its line as `(+3 copies: …)` unless the query names something only the copy has, lists tables (with their matching columns) before anything else, and can keep to one `database`. Each result is one line: what the table is (its comment or note) and up to 3 matching columns with their comments, often enough to answer without opening the table. It shows the 10 best and only counts the far weaker matches; pass `limit` to list more. `(abbreviated name)` means only an abbreviation in the name matched: check the table before trusting it. Results also include tables whose meaning is inferred from the columns that reference them, marked `(inferred)`: `cus` has no comment, but columns pointing to it say "Cliente Habitual". Present those as inferences, never as facts.
2. Before using a table: `heydb_table`. Use the real column names, types and joins it shows, including implicit relationships and notes. One line per column (`- num_fac int(11) PK — "Factura"`; `null`, `=default` and `auto` only when they apply). On wide tables it lists the 60 most telling columns; ask for `columns: "all"` or a `column_filter` when you need the rest. Long column comments and notes are cut at 100 characters; a `column_filter` shows them whole.
3. Need a map of an unknown schema, or the project notes: `heydb_overview`, once. It shows, per database, how many tables have comments and which tables the rest point to (the core), then the tables with their comments or notes. Databases with the same structure (same tables and columns, one database per company) are shown once, `emp_001 (+49 with the same structure: emp_002, …)`, and their tables listed once; after 20 database blocks it says how many are left: reach them with `heydb_search` and `database`. Project notes past 20, or longer than 300 characters, are cut: the whole text is in `.heydb/knowledge/_project.json`. Do not open it just to look up one concept: search does that cheaper.

Never guess table or column names from memory when heydb can answer.

## Never guess a meaning from a table name

Legacy names lie. A table named `art` looks like artwork; it holds the articles. Before you say what a table is, read the `heydb_table` header, strongest evidence first:

1. Team notes and the table comment.
2. Who points to it ("Referenced by"): foreign keys, documented relationships and the comments of columns like `ref_art`, `cod_art`. `Referencing columns are commented as: "Artículo" ×12` is strong evidence. Name-pattern guesses are not enforced; treat them as clues.
3. Its own columns.

When the meaning comes from 2 or 3, say it is an inference and ask the user to confirm. Once confirmed, save it with `heydb_annotate` so nobody has to guess again. When the overview says most tables have no comment, do not infer anything from names alone.

## Warnings mean the picture is incomplete

The overview lists warnings from the last sync. Take them literally:

- hidden triggers or routines: the user that synced could not see them. Writes may fire logic you cannot see; say so before relying on "nothing else happens".
- a view whose definition is not visible: do not assume what it selects.
- a stale snapshot: if a table or column you need is missing, the database may have changed. Ask the user to run `/heydb:sync`.

## Save what you learn

When the conversation or the code teaches you something the schema does not say, save it so the next person (or agent) does not have to rediscover it.

- `heydb_annotate` for meaning: valid values, units, encodings, who writes the column, legacy quirks.
- Notes steer `heydb_search`: a table's note outranks its name and its columns. When the user confirms what a cryptic table means, or you settle which table holds a concept, note it in the words people will search with: the business term, its synonyms, both languages when the team mixes them (`Customer master (clientes): one row per customer`). Next time "clientes" finds that table first.
- `heydb_relate` for joins without a foreign key, found in code, queries or data: `orders.customer_id → customers.id`. Give `to_columns` in the same order and count as `from_columns`, and say how you know in `note`.
- `heydb_annotate` with `scope: "project"` and no `target` for facts above any one database: "the ERP uses one database per client; the central one is acme". `heydb_overview` shows them first. A table called `project` is still `target: "project"`.
- `heydb_relate` with `to_connection` when the referenced table is in another connection of the project (`crm.clientes.cod_erp → erp`'s `cus.cod`). Call it from the referencing connection; `heydb_table` on the other side shows it too, prefixed with the connection.
- A name without a dot is a table: `heydb_annotate` with `art` notes the table even if some column is also called `art`; write `pos.art` for the column.
- If the save result says git ignores the notes, tell the user: the note stays on their machine until the project shares `.heydb/knowledge/`.
- End every note with its source: `(code: src/Models/Order.php)` when code shows it, `(docs: docs/tables.md)` when the project's docs say it, `(told by the user)` when the user said it. An inference is saved only after the user confirms it.
- After `/heydb:sync` (or `/heydb:learn-code`) the user may ask you to read the project's code and docs. That message lists the tables that most need a note first: go down it, one note per table in business words and synonyms as above, follow its rules and stop after about 20 notes. What the code or docs do not make explicit is a question for the user, not a note.
- Read the existing notes first (`heydb_table`). Fix a wrong note with `heydb_edit_note`; remove an obsolete one with `heydb_forget`. Do not add a second note that contradicts the first.

Good notes are short, factual and verifiable:

| Good | Bad |
|---|---|
| `status: 0 draft, 1 paid, 2 refunded (code: src/OrderStatus.php)` | `Status of the order.` (the name already says it) |
| `Amount in cents, VAT included.` | `Probably the price.` (a guess) |
| `Legacy: 0000-00-00 means "never". Filter it out.` | A paragraph retelling the conversation |
| `Joined to customers.id by app code; no FK because the table is MyISAM.` | `I think this links to users.` |

Never invent. If you are not sure, ask the user or leave it unsaved. Notes you write are signed `<author> (via agent)` so readers know a person did not type them.

## Setup is the user's job

If a tool says the project is not initialized, has no connections or was never synced, tell the user which command to run: `/heydb:init`, `/heydb:connect`, `/heydb:sync`. You cannot run them.

A project may have several connections (say `dev` and `prod`), each with its own snapshot and notes. Tools use the default one when `connection` is omitted; pass `connection` to read another, and save a note on the connection it is true for. `/heydb:connections` (the user's) lists them and changes the default.

Never ask for, repeat or store database passwords, not in notes, files, commands or chat. If one is missing, tell the user to run `/heydb:password <connection>`: it asks for it hidden and keeps it in `.heydb/.env`, which is never committed.
