---
name: heydb
description: Consult and enrich the database schema of a heydb project (.heydb/ folder) with the heydb_* tools. Use before writing, reviewing or debugging SQL, queries, migrations or ORM models; when asked what a table or column means or how tables join; and when you learn business meaning (valid values, units, legacy quirks) or a join without a foreign key that the team should keep.
---

# heydb

heydb keeps a snapshot of the project's database structure (`.heydb/snapshots/`) and the team's notes about it (`.heydb/knowledge/`). The team shares them only if the project commits `.heydb/`; some projects ignore it, so do not promise that a note reaches anyone else. The tools read those files; they never connect to the database.

## Read before you write SQL

1. Looking for a concept ("invoices", "fecha de baja"): `heydb_search`. It matches each word on its own, in any order (stopwords skipped, abbreviated names such as `fac_cab` for "factura" found, and a word that is a table name also finds the tables whose name starts with it: `exh` finds `exhl`), ignores case, accents and simple plurals, says which words matched nothing, lists identical tables of other databases once, folds copies of a table in its own database (same columns: yearly, backup, temporary tables) into its line as `(+3 copies: …)` unless the query names something only the copy has, lists tables (with their matching columns) before anything else, and can keep to one `database`. Each result is one line: what the table is (its comment or the note that covers the most query words) and up to 3 matching columns with their comments, often enough to answer without opening the table. The top 3 tables add a `related:` line with the tables they join (foreign keys and team relationships, both ways) and the tables named after them (`exh` → `exhl`, `exh_doc`), so a process can be followed from one table. It shows the 10 best and only counts the far weaker matches; pass `limit` to list more. `(abbreviated name)` or `(name starts with the query)` means only that part of the name matched: check the table before trusting it. Results also include tables whose meaning is inferred from the columns that reference them, marked `(inferred)`: `cus` has no comment, but columns pointing to it say "Cliente final". Present those as inferences, never as facts.
2. Before using a table: `heydb_table`. Use the real column names, types and joins it shows, including implicit relationships and notes. One line per column (`- num_fac int(11) PK — "Factura"`; `null`, `=default` and `auto` only when they apply). On wide tables it lists the 60 most telling columns and says what the rest weigh; to read more, pass a `column_filter` with the words you need (it matches names and comments), and ask for `columns: "all"` only when you need every column: on a wide table it costs many KB. Long column comments and notes are cut at 100 characters; a `column_filter` shows them whole.
3. Only to map an unknown schema: `heydb_overview`, once; never for a question that names a table or concept. Project notes are also found by `heydb_search`, as `project note` results with their id. It shows, per database, how many tables have comments and which tables the rest point to (the core), then the tables with their comments or notes. Databases with the same structure (same tables and columns, one database per company) are shown once, `emp_001 (+49 with the same structure: emp_002, …)`, and their tables listed once; after 20 database blocks it says how many are left: reach them with `heydb_search` and `database`. Project notes past 20, or longer than 300 characters, are cut: the whole text is in `.heydb/knowledge/_project.json`. Do not open it just to look up one concept: search does that cheaper.

Never guess table or column names from memory when heydb can answer.

When a note answers the question, use it. If it cites `(docs: …)` or `(code: …)` and you can read files, read that source only for what the note does not cover, instead of asking `heydb_table` for every column.

## Learn while you work

Save only what you had to leave heydb to find: in the code, the docs or from the user. Never save what `heydb_table` already shows, and never a guess.

| You had to… | Save |
|---|---|
| read code to follow a process (an invoice, a stock move) | a process note on its main table with `heydb_annotate` |
| find in code or queries how two tables join without a foreign key | `heydb_relate` with the joining columns, plus any extra condition (`tipo = 'F'`) and how you know in `note` |
| learn what a table or column means | a meaning note in the words people search with |
| hit a trap (a value that means "never", a column the app no longer writes) | a warning in the team's language, `Ojo: …` |

How:

- Process, in the team's language: `Process: <name in business words> (entry: file:function). Reads: table (columns), … Writes: table (columns), … (code: src/…)`. A Spanish-speaking team writes `Proceso: alta de factura (entrada: …). Lee: … Escribe: …`.
- Meaning: what it holds, with the synonyms people use (see "Save what you learn").
- Warning: one sentence with what goes wrong and what to do instead.
- Always end with the source. Read the table's notes first; if a note on the same thing exists (the same process, the same meaning), extend it with `heydb_edit_note` instead of adding another. A process goes in its own note, never appended to the table's meaning.

Recall: before reading code about the database, search heydb (`heydb_search`, then `heydb_table`). Use a note that answers the question. A note that only says what a table holds does not answer what a process does: for a process question with no process note, read the code and save the process. If you still had to read code, complete that note with what it lacked.

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
- `heydb_annotate` with `scope: "project"` and no `target` for facts above any one database: "the ERP uses one database per client; the central one is acme". `heydb_overview` shows them first, and `heydb_search` finds them. A table called `project` is still `target: "project"`.
- `heydb_relate` with `to_connection` when the referenced table is in another connection of the project (`crm.clientes.cod_erp → erp`'s `cus.cod`). Call it from the referencing connection; `heydb_table` on the other side shows it too, prefixed with the connection.
- A name without a dot is a table: `heydb_annotate` with `art` notes the table even if some column is also called `art`; write `pos.art` for the column.
- If the save result says git ignores the notes, tell the user: the note stays on their machine until the project shares `.heydb/knowledge/`.
- End every note with its source: `(code: src/Models/Order.php)` when code shows it, `(docs: docs/tables.md)` when the project's docs say it, `(told by the user)` when the user said it. An inference is saved only after the user confirms it.
- After `/heydb:sync` (or `/heydb:learn-code`) the user may ask you to read the project's code and docs. That message lists the tables that most need a note first: go down it, at most one note per listed table in business words and synonyms as above, and follow its rules. What the code or docs do not make explicit is a question for the user, not a note. End by telling the user, in one line, how many tables still need a note and that running `/heydb:learn-code` again covers the next ones (noted tables go last), or that the code has been fully covered.
- Read the existing notes first (`heydb_table`). Fix or extend a note with `heydb_edit_note`; remove an obsolete one with `heydb_forget`. Do not add a second note that repeats or contradicts the first.

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
