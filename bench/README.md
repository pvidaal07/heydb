# Token benchmark

How much context an agent spends to find the tables that answer a question,
through the heydb tools or through the other ways people give an agent
knowledge of a database: a schema document, a grep of the code, direct SQL,
an ORM schema, a generic database MCP server.

```bash
node bench/run.ts                     # synthetic legacy ERP, 10 company databases, and its code
node bench/run.ts --companies 50      # the same with 50
node bench/run.ts --scenario small    # synthetic small app: one database, 15 tables, and its code
node bench/run.ts --json              # raw numbers
node bench/run.ts --project ../app --questions questions.json [--connection erp] [--code ../app/src]
node bench/run.ts --learn             # any of the above, adding heydb after noting each answer
```

`--project` reads a real heydb project: only its stored snapshot and notes,
never the database. `--code` is the folder the code-grep strategy searches;
without it that strategy is skipped (the synthetic run generates a tiny code
and docs tree, `synthetic-code.ts`). The questions and the report of a real
project name real tables: keep them out of this repository.

The report is one table comparing every strategy (≈tokens, calls, expected
tables found, their rank in the first call's output, time), then heydb's
per-question report.

## What it measures

The heydb side runs the real tools, so every character counted is one the
model would read. The agent follows a fixed policy, the same in every run:

1. `heydb_search` with each of the question's queries, in order, until every
   expected table shows up in the text the tool returned (a result the tool
   cut or left beyond its default limit does not count);
2. `heydb_overview` if one is still missing;
3. `heydb_table` on each expected table, with the default options.

A questions file is a JSON array:

```json
[{ "id": "unpaid-invoices", "ask": "Qué facturas tiene pendientes de cobro un cliente", "queries": ["facturas pendientes de cobro", "vencimiento"], "expect": ["fac_cab", "fac_ven"] }]
```

`expect` holds bare table names (any database's copy counts) or
`database.table`.

`--learn` measures the learning loop: it copies the project to a temporary
folder (the connection's config, its snapshot, every knowledge file), runs the
questions, notes on each table read for a question the question's `ask`, as
an agent does once the user confirms which table holds a concept, and runs
them again. The project measured is only read.

The `information_schema` side is what `mysql --batch` would print:

- **guided**: list the databases, list one database's tables with their
  comments, then the columns of the expected tables. An optimistic lower
  bound: it assumes the model picks the right tables from names alone.
- **columns of every table**: one `SELECT … FROM information_schema.columns`
  over the whole connection.

Tokens are characters / 4: good enough to compare two runs, not a bill.

## Strategies

Each strategy is a module under `strategies/` with one interface,
`run(question) → steps`, and runs every question with the same policy:

1. search with each of the question's queries, in order, until every
   expected table is named by what the search printed;
2. if one never was, fall back to that strategy's way of browsing;
3. read the definitions of the expected tables (the agent goes straight to the
   right ones, however it got there).

| strategy | simulates | search | fallback | read |
|---|---|---|---|---|
| heydb | the heydb tools, run for real | `heydb_search` | `heydb_overview` | `heydb_table` per table |
| heydb-notes (`--learn`) | the same after one note per answer | as above | as above | as above |
| schema-doc-full | a SCHEMA.md as schema-to-markdown tools write it (per table a heading, its comment and a column table name, type, null, key, comment), loaded whole | none: one read per question | — | — |
| schema-doc-grep | the same file, grepped | `rg -i -n -C2` with the query's words | `rg -n '^## '`: every heading | the table's section, heading to next heading |
| code-grep | `rg` over the project's code and docs (`--code`) | `rg -i -n` with the query's words | list the databases, then one database's tables with their comments (SQL) | the table's columns from information_schema |
| db-smart | direct SQL as a capable agent writes it (simulated) | tables, then columns, whose name or comment is `LIKE '%word%'`, `LIMIT 100` each, in one call | one database's tables with their comments | the tables' columns from information_schema |
| orm-schema | a Prisma-like `schema.prisma` generated from the snapshot: a model per table with `@@map`, typed fields, `@id`, `///` comments (the best case for an ORM) | `rg -i -n -C2` with the query's words | `rg -n '^model '`: every model | the model block |
| db-mcp | a generic database MCP server (simulated): no search | `list_tables` of the database (names only; `list_databases` first when there are several) | — | `describe_table` per table |
| info-schema-guided | the guided baseline (simulated) | list the databases, one database's tables with their comments | — | the tables' columns, one query |
| info-schema-columns | one query over information_schema.columns (simulated) | none: one query per question | — | — |

What the columns of the comparison mean:

- **≈tokens**: characters returned to the model / 4, every call of every
  question. heydb's tool definitions (≈1.1k tokens, sent every turn) are not
  in it; grep, read and bash come with any agent, and a database MCP server's
  tool definitions cost their own, also not counted.
- **calls**: tool calls, each one a model round trip.
- **found**: expected tables named by what the model read before reading their
  definitions, whole name (letters, digits, `_`): `fac_cab_2019` does not name
  `fac_cab`. A file or a query that holds the whole schema finds everything.
  A pick from a list of names (db-mcp, and the guided listing, which also
  shows comments) counts only by the **name-pick rule**: a part of the table's
  name (split on `_` and digits) is a word of the question's queries, or is 3
  letters or more and starts one (`fac` for "facturas"), or a listed comment
  holds one; accents and plurals folded. It says the table is among the
  candidates, not that the model would pick it: see the rank.
- **first call: top 1 / top 5**: expected tables first, or in the first five,
  of the tables the first call's output names, in the order it names them; for
  a name pick, of the candidates in list order; for SQL, rows in snapshot
  order, standing for the order a server returns them in (it promises none
  without `ORDER BY`). `—` where the whole schema is in context.
- **time**: wall clock of the calls on this machine. heydb and the file
  strategies run for real (generating SCHEMA.md or schema.prisma once is not
  counted); the database strategies (`*`) are simulated over the snapshot, so
  their time is local work only: a real server adds a network round trip per
  call, not included and not invented here.

Words a search uses: the query's words of 3 letters or more, without a few
stopwords, as typed. grep folds neither accents nor plurals, so "almacen"
does not find "Almacén", as with `rg -i`; SQL `LIKE` ignores case and accents,
as the usual `_ci` collations do. Every grep stops at 100 lines (as an agent
piping to `head -100`) and cuts lines at 200 characters. code-grep is written
in Node (no `rg` needed): it reads one file at a time, stops at the cap, and
skips binary files (a NUL in the first 8 KB), files over 2 MB, `node_modules`,
`.git`, `.heydb` (heydb's own notes) and `.env` files (secrets). Generated
files go to a temporary folder; the measured project and the code folder are
only read.

### Honest limits

- No real model: every strategy follows a fixed policy, and after a fallback
  goes straight to the right table. A real agent makes more calls on all of
  them, and may read around a grep hit instead of falling back.
- The simulation favors strategies that work on exact names: a found by name
  pick is a candidate, not a choice; ranks show how many candidates came first.
- `-C2` rarely reaches a table's heading from a hit in its column table, so
  schema-doc-grep and orm-schema mostly find tables through table comments.
- The documents cover every database of the connection, as the tools generate
  them; a hand-written doc might cover one company database.
- Database latency is not included; heydb never connects to the database.
- The synthetic schema, its comments and its code were written by hand: they
  show trends, not truth. Run it on a real project too.

## Limits (heydb side)

- The simulated agent is generous to both sides: after the overview it goes
  straight to the right table, and the guided baseline never picks a wrong
  one. Real agents make more calls on both.
- The synthetic schema is generic and its comments were written by hand, so
  its search numbers show trends, not truth. Run it on a real project too.

## Baseline (2.0.0-beta.1, synthetic ERP)

| companies | heydb, 10 questions | info_schema guided | info_schema, every column | overview | expected table in first search |
|---|---|---|---|---|---|
| 1 | ≈5.8k tokens | ≈11.2k | ≈34k | ≈0.8k | 0 of 11 |
| 10 | ≈11.4k | ≈11.4k | ≈336k | ≈2.1k | 0 of 11 |
| 50 | ≈31.2k | ≈12.2k | ≈1.7M | ≈8.5k | 0 of 11 |

Fixed tool text sent every turn: ≈1.6k tokens.

## After word-level search (synthetic ERP)

Words in any order, stopwords skipped, abbreviated names read, BM25 ranking,
identical company databases grouped, unmatched words named.

| companies | heydb, 10 questions | info_schema guided | overview | heydb_search, average | expected table in first search (top 1 / top 5 / anywhere) | needed the overview |
|---|---|---|---|---|---|---|
| 1 | ≈6.6k tokens (was ≈5.8k) | ≈11.2k | ≈0.8k | ≈239 | 9 / 9 / 10 of 11 (was 0 / 0 / 0) | 1 of 10 (was 3) |
| 10 | ≈8.6k (was ≈11.4k) | ≈11.4k | ≈2.1k | ≈299 (was ≈96) | 9 / 9 / 10 of 11 (was 0 / 0 / 0) | 1 of 10 (was 3) |
| 50 | ≈15.0k (was ≈31.2k) | ≈12.2k | ≈8.5k | ≈303 (was ≈131) | 9 / 9 / 10 of 11 (was 0 / 0 / 0) | 1 of 10 (was 3) |

Tool calls for the 10 questions: 23 (was 34), so 11 fewer model round trips,
each one also paying the fixed tool text (≈1.6k tokens). A search now returns
results instead of nothing, so it costs more per call: with one company that
outweighs the calls saved. The miss left is the English question ("customer
invoice"): no table or comment is in English, so only a vocabulary bridge
(layer 2) can find it; the overview still costs ≈8.5k at 50 databases.

## After compact output (synthetic ERP)

`heydb_search` prints one line per result (what the table is, up to 3
matching columns with their comments), lists the 10 best (was 20) and only
counts matches scoring under a fifth of the best; `heydb_table` prints one
line per column and caps foreign keys, triggers and indexes at 10. "Before" is
the word-level search above, re-run with the stricter rule that a table counts
as found only when the text the tool returned names it (same numbers: it
showed 20 results).

| companies | heydb, 10 questions | heydb_search, average | heydb_table, average / max | expected table in first search (top 1 / top 5 / anywhere) | needed the overview |
|---|---|---|---|---|---|
| 1 | ≈4.9k tokens (was ≈6.6k) | ≈104 (was ≈239) | ≈193 / ≈410 (was ≈291 / ≈635) | 9 / 9 / 9 of 11 (was 9 / 9 / 10) | 2 of 10 (was 1) |
| 10 | ≈7.9k (was ≈8.6k) | ≈133 (was ≈299) | ≈193 / ≈410 | 9 / 9 / 9 of 11 | 2 of 10 |
| 50 | ≈20.7k (was ≈15.0k) | ≈135 (was ≈303) | ≈193 / ≈410 | 9 / 9 / 9 of 11 | 2 of 10 |

Searches cost less than half and tables a third less. The cost: `fac_cab` for
"facturas pendientes de cobro" ranked 13th, so it is no longer shown and that
question falls back to the overview, which is what grows the total at 50
companies (≈8.5k for the overview alone). `fac_cab` has no comment and matches
only as an abbreviation, behind nine filler tables `int_cob_rem_*` that match
"cobro" the same way: a ranking problem for the vocabulary layer, not one the
output can fix.

## After learning loop and copies (synthetic ERP)

Search folds copies of a table in its own database (same columns, found from
the data, never from names) into the original's line, unless the query
matches something only the copy has; a team note on a table outranks its name
and columns. The synthetic schema changed too: the `tmp_`, `aux_` and `bak_`
filler tables are now copies of their module table (same columns, as
`CREATE TABLE … LIKE` leaves them), the `log_`, `cfg_` and `int_` ones keep
columns of their own, and every module gets fillers of every kind. So
"info_schema, every column" grows (≈34k → ≈59k tokens with 1 company) and
the overview slightly.

| companies | heydb, 10 questions | heydb_search, average | overview | expected table in first search (top 1 / top 5 / anywhere) | needed the overview |
|---|---|---|---|---|---|
| 1 | ≈4.7k tokens (was ≈4.9k) | ≈87 (was ≈104) | ≈0.8k | 9 / 9 / 9 of 11 | 2 of 10 |
| 10 | ≈7.6k (was ≈7.9k) | ≈101 (was ≈133) | ≈2.1k | 9 / 9 / 9 of 11 | 2 of 10 |
| 50 | ≈20.6k (was ≈20.7k) | ≈102 (was ≈135) | ≈8.6k | 9 / 9 / 9 of 11 | 2 of 10 |

Searches cost a quarter less: yearly, backup and temporary copies cost one
`(+3 copies: fac_cab_2019, fac_cab_2020, …)` instead of a line each. For
"facturas pendientes de cobro", `fac_cab` is now 8th of all matches (was 13th,
behind nine `int_cob_rem_*`), but it still matches one word of three, by
abbreviation, and scores under a fifth of `fac_ven`, so the default output
counts it as weaker and that question still opens the overview. The other
overview is the English question, as before.

`--learn`, one note per expected table with the question as asked:

| companies | heydb, 10 questions, before → after notes | first search (top 1 / top 5 / anywhere) | needed the overview |
|---|---|---|---|
| 1 | ≈4.7k → ≈3.0k tokens | 9 / 9 / 9 → 10 / 11 / 11 of 11 | 2 → 0 of 10 |
| 10 | ≈7.6k → ≈3.2k | 9 / 9 / 9 → 10 / 11 / 11 of 11 | 2 → 0 of 10 |
| 50 | ≈20.6k → ≈3.2k | 9 / 9 / 9 → 10 / 11 / 11 of 11 | 2 → 0 of 10 |

Mean reciprocal rank 0.82 → 0.95; `heydb_table` grows ≈193 → ≈198 tokens on
average (the note it now shows). The one expected table not first is `fac_cab`
for "facturas pendientes de cobro", second behind `fac_ven`, which carries the
same note. The notes repeat the questions word for word, so this is the upper
bound of what a note buys; real notes use other words than the next question.
Fixed tool text is ≈1.65k tokens (was ≈1.62k): the `heydb_annotate` guideline
now asks for confirmed meanings in the words people search with.

## Competitive comparison (synthetic ERP)

`node bench/run.ts --learn`, 10 company databases (2,560 tables, 56,170
columns), 10 questions, 11 expected tables, the synthetic code tree:

| strategy | ≈tokens | calls | found | first call: top 1 / top 5 | time |
|---|---|---|---|---|---|
| heydb | ≈7.6k | 25 | 9 of 11 | 9 / 9 | ≈2.0 s |
| heydb, one note per answer | ≈3.2k | 21 | 11 of 11 | 10 / 11 | ≈1.6 s |
| schema-doc-full | ≈5.8M | 10 | 11 of 11 | — | ≈20 ms |
| schema-doc-grep | ≈205k | 41 | 0 of 11 | 0 / 0 | ≈160 ms |
| code-grep | ≈7.5k | 35 | 5 of 11 | 4 / 5 | ≈13 ms |
| db-smart * | ≈11.1k | 27 | 8 of 11 | 0 / 3 | ≈185 ms |
| orm-schema | ≈144k | 36 | 3 of 11 | 1 / 2 | ≈186 ms |
| db-mcp * | ≈10.6k | 31 | 10 of 11 (name pick) | 0 / 3 | ≈0.2 ms |
| info-schema-guided * | ≈11.4k | 30 | 10 of 11 (name pick) | 0 / 3 | ≈0.7 ms |
| info-schema-columns * | ≈5.9M | 10 | 11 of 11 | — | ≈60 ms |

`*` simulated: no network round trips in the time.

With 1 and 50 companies, ≈tokens:

| companies | heydb | heydb, notes | code-grep | db-smart | db-mcp | info-schema guided | schema-doc-grep | orm-schema | schema-doc-full |
|---|---|---|---|---|---|---|---|---|---|
| 1 | ≈4.7k | ≈3.0k | ≈7.4k | ≈6.4k | ≈10.4k | ≈11.2k | ≈25k | ≈16k | ≈581k |
| 10 | ≈7.6k | ≈3.2k | ≈7.5k | ≈11.1k | ≈10.6k | ≈11.4k | ≈205k | ≈144k | ≈5.8M |
| 50 | ≈20.6k | ≈3.2k | ≈7.9k | ≈13.1k | ≈11.4k | ≈12.2k | ≈1.0M | ≈717k | ≈29M |

What it says:

- Loading the schema whole (a SCHEMA.md or every column) finds everything and
  costs everything: 580k tokens with one company, beyond any context window
  with ten.
- Grepping a schema document or an ORM schema finds little (a hit in a column
  table does not show which table it is) and falls back to listing every
  heading or model, which grows with the schema.
- The cheap alternatives (code-grep, db-smart, db-mcp, guided) cost about the
  same as heydb without notes, but rank the right table first far less often
  (0 to 4 of 11 against 9 of 11) and need more calls (27 to 35 against 25).
  Their "found" comes from exact words: code-grep finds what the code names on
  the same line as the words, a name pick finds a candidate among dozens.
- heydb's weak spot is the overview fallback, which grows with the number of
  databases (≈20.6k tokens at 50 companies); with notes it stays at ≈3.2k,
  ranks 10 of 11 first and needs no fallback. Those notes repeat the questions
  word for word: the upper bound of what notes buy.
- heydb is the slowest in time, ≈80 ms per call with 10 companies and ≈450 ms
  with 50: each tool call reads and parses the stored snapshot again. Still
  below one model round trip, but the next thing to make faster.

## Competitive comparison (small app)

`node bench/run.ts --scenario small --learn`: the other end from the ERP, a
personal or small-team project (`small-app.ts`): one database of 15 tables
and 124 columns with clear English names, InnoDB, 16 declared foreign keys,
3 table and 4 column comments, a small code tree, 10 questions (3 in Spanish,
2 about one column, 1 needing two tables), 11 expected tables:

| strategy | ≈tokens | calls | found | first call: top 1 / top 5 | time |
|---|---|---|---|---|---|
| heydb | ≈2.9k | 22 | 11 of 11 | 9 / 10 | ≈10 ms |
| heydb, one note per answer | ≈3.0k | 21 | 11 of 11 | 10 / 11 | ≈6 ms |
| schema-doc-full | ≈15.8k | 10 | 11 of 11 | — | ≈0.1 ms |
| schema-doc-grep | ≈4.0k | 26 | 10 of 11 | 4 / 7 | ≈1.5 ms |
| code-grep | ≈2.5k | 34 | 7 of 11 | 4 / 5 | ≈8 ms |
| db-smart * | ≈1.6k | 22 | 11 of 11 | 5 / 9 | ≈1 ms |
| orm-schema | ≈3.8k | 24 | 11 of 11 | 4 / 8 | ≈0.8 ms |
| db-mcp * | ≈1.4k | 21 | 9 of 11 (name pick) | 7 / 9 | ≈0.1 ms |
| info-schema-guided * | ≈1.8k | 30 | 10 of 11 (name pick) | 8 / 10 | ≈0.1 ms |
| info-schema-columns * | ≈12.1k | 10 | 11 of 11 | — | ≈0.2 ms |

Clear names and declared keys make every approach cheap and mostly right:
nothing costs more than ≈16k tokens, even loading the whole schema, and a
plain list of 15 table names (db-mcp, guided) or a `LIKE` on names (db-smart)
costs about half of heydb, before heydb's ≈1.7k tokens of tool definitions per
turn, which here weigh as much as a question's work. Where heydb still wins is
the rank, the right table first in 9 of 11 first searches (10 with notes)
against 4 to 8, and tables whose name is not the word asked: `reviews` for
"product rating" (a column) and `audit_log` for "cambios panel administracion"
(its comment), which a pick from the names misses. Notes add a little text
here instead of saving it: there was little left to find.

## After overview and fixed-text trims (synthetic)

`heydb_overview` shows databases with the same tables and columns once
(`emp_001 (+49 with the same structure: emp_002, emp_003, emp_004, …)`) and
lists their tables once, stops at 20 database blocks with "… N more
databases", names the most referenced tables in one line (their rows and
comments are already in the table list) and caps project notes at 20 of up to
300 characters. The tool definitions say less: long explanations (note
sources, project scope, cross-connection joins, what search matches) live in
the skill, and `connection` has no description. Same questions and policy;
`node bench/run.ts [--companies N]` and `--scenario small`:

| scenario | heydb_overview | fixed tool text, every turn | heydb, 10 questions |
|---|---|---|---|
| ERP, 1 company | ≈679 tokens (was ≈763) | ≈1,093 (was ≈1,656) | ≈4.5k (was ≈4.7k) |
| ERP, 10 companies | ≈706 (was ≈2,132) | ≈1,093 | ≈4.7k (was ≈7.6k) |
| ERP, 50 companies | ≈707 (was ≈8,623) | ≈1,093 | ≈4.8k (was ≈20.6k) |
| small app | ≈269 (was ≈362) | ≈1,093 | ≈2.9k (no question needs the overview) |

The overview no longer grows with the number of identical company databases,
so the 50-company total falls back to the 1-company one. Found tables and
ranks are unchanged (9 of 11 on the ERP, 11 of 11 on the small app). On the
small app one overview call lists all 15 tables with their comments: a full
map for ≈270 tokens. The fixed text is not in the totals; it is paid on every
turn of every conversation, ≈560 tokens less now.

## Real-agent benchmark

The comparison above simulates the agent. `bench/agent/run.ts` runs a real
one: a model inside Pi answers each question with exactly one strategy's tools,
and every run records what the provider says it spent and whether the model
named the expected tables.

```bash
node bench/agent/run.ts --limit 2                      # pilot on the synthetic ERP: every strategy, 2 questions
node bench/agent/run.ts --estimate-from <pilot>/runs.jsonl          # plan and cost estimate, then stop
node bench/agent/run.ts --yes --repeat 3 --out <dir>              # the full run
node bench/agent/run.ts --project ../app --questions q.json [--connection erp] [--code ../app/src] --yes --out <dir>
node bench/agent/run.ts --report <dir>                 # render report.md again from <dir>/runs.jsonl
```

Other options: `--strategies heydb,code,db`, `--model claude-bridge/claude-sonnet-5-5`
(default `claude-bridge/claude-haiku-5-5`), `--thinking` (default `low`),
`--timeout` seconds per run (default 300), `--resume` (skip the runs already in
`<out>/runs.jsonl`), `--provider-extension <file>` (the extension that
registers the model's provider; for `claude-bridge/` models it is found in Pi's
packages), `--mysql-image` (default `mysql:8.0`), `--companies` (synthetic ERP),
`--scenario small` (the synthetic small app instead of the ERP).

Without `--yes` it prints the plan (strategies × questions × repeats = runs)
and, with `--estimate-from`, the tokens a pilot spent per run times the runs
planned, then stops; a pilot (`--limit 3` or fewer, one repeat) needs no
`--yes`. Results go to `--out` (a new temporary folder by default):
`runs.jsonl`, one line per run written as it goes, `meta.json` and
`report.md`. A real project's questions and `runs.jsonl` name real tables:
keep them out of this repository.

| strategy | what the model gets | tools |
|---|---|---|
| heydb | a copy of the project's `.heydb/` (config, snapshot, notes; no `.env`) and the heydb extension | `heydb_overview`, `heydb_search`, `heydb_table` (no notes written during the run) |
| heydb-notes | the same plus one note per expected table with the question as asked, as `--learn` writes them | the same |
| schema-doc | `SCHEMA.md` as written above | Pi's `read`, `grep`, `find` |
| orm-schema | `schema.prisma` as written above | `read`, `grep`, `find` |
| code | a copy of `--code` without `node_modules`, `.git`, `.heydb`, `.env` files, files over 2 MB and symbolic links; skipped without `--code` | `read`, `grep`, `find` |
| db | a MySQL server in docker holding the snapshot's schema, no rows | `sql`: one SELECT, SHOW or DESCRIBE, printed as `mysql --batch`, at most 200 rows then "… N more rows" |
| db-mcp | the same server | `list_tables(database?)` (names only; the databases when there are several and none is named), `describe_table(table)` (DESCRIBE) |

Fairness rules, the same for every run:

- Pi starts with nothing discovered: `--no-extensions --no-skills
  --no-context-files --no-mcp --no-prompt-templates --no-themes --no-approve`,
  then loads only the provider's extension, the strategy's extension and
  `bench/agent/probe.ts`, and `--tools` allows only the strategy's tools. The
  probe adds no tool and no prompt text; it records the tools declared and the
  prompt's size per run, shown in the report ("What each strategy was given").
  heydb adds its one prompt line ("This project has a heydb schema snapshot…"),
  as it does for its users.
- The same model, thinking level, timeout and instructions for every strategy,
  appended to Pi's system prompt: find which tables hold the data that answers
  the question with the available tools, change nothing, and end with exactly
  one line `TABLES: t1, t2` of bare table names. The question as asked is the
  user message.
- Each strategy works in its own temporary folder holding only its material,
  prepared once: never the measured project, which is only read.
- The database is built from the snapshot: `CREATE TABLE` with the captured
  types, primary keys, indexes, comments and storage engine, foreign keys as
  declared, views from their definitions; what MySQL rejects is retried
  without defaults and secondary indexes, then skipped, and the report counts
  both. The model's user has only `SELECT` and `SHOW VIEW` on those databases,
  and the `sql` tool refuses anything but one SELECT, SHOW or DESCRIBE. The
  container keeps its data in tmpfs and is removed at the end, interrupted or not.
- Runs go one at a time; for each question every strategy runs in turn.
- Tokens are the provider's, summed over every model call of the run: total =
  input + output + cache read + cache write. "% fewer" compares two
  strategies over the questions both ran, each question the mean of its repeats.
- Correct: every expected table (bare name, any case, database prefix ignored)
  is in the reply's last `TABLES:` line. The report also counts expected
  tables named (partial credit) and extra tables named; a reply without the
  line names nothing.

Honest limits:

- One model at a time; another model makes other choices. Tool choice varies
  between runs of the same question: use `--repeat` and read the spread.
- Every model call carries the provider's own fixed prompt (with the
  claude-bridge provider, about 3–4k tokens before any tool), the same for
  every strategy; it is in the totals.
- The database is schema only: the model cannot sample rows to tell two
  similar tables apart, as it could on a real server.
- The synthetic code tree is ten small files, so code search is cheap and
  precise there; a real project's code is not.
- heydb-notes' notes repeat the questions word for word: the upper bound of
  what notes buy.
- It costs real tokens: about 15k to 90k per run in the pilot below.

Pilot, synthetic ERP (10 company databases, 2,560 tables, 56,170 columns), the
first 2 questions, `claude-bridge/claude-haiku-5-5`, thinking low, one repeat:

| strategy | tokens per run | tool calls per run | time per run | correct |
|---|---|---|---|---|
| heydb | ≈24.7k | 5.0 | 9.2 s | 2 of 2 |
| heydb-notes | ≈25.5k | 3.5 | 7.3 s | 2 of 2 |
| schema-doc | ≈85.2k | 7.0 | 14.4 s | 2 of 2 |
| orm-schema | ≈92.1k | 10.0 | 17.6 s | 2 of 2 |
| code | ≈15.9k | 3.5 | 6.1 s | 2 of 2 |
| db | ≈55.7k | 7.0 | 15.4 s | 2 of 2 |
| db-mcp | ≈47.5k | 10.0 | 10.3 s | 2 of 2 |

Two questions and one repeat show the harness works, not who wins.
