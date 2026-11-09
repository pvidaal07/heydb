# Token benchmark

How much context an agent spends to find the tables that answer a question,
through the heydb tools or by querying `information_schema` itself.

```bash
node bench/run.ts                     # synthetic legacy ERP, 10 company databases
node bench/run.ts --companies 50      # the same with 50
node bench/run.ts --json              # raw numbers
node bench/run.ts --project ../app --questions questions.json [--connection erp]
node bench/run.ts --learn             # any of the above, before and after noting each answer
```

`--project` reads a real heydb project: only its stored snapshot and notes,
never the database. The questions and the report of a real project name real
tables: keep them out of this repository.

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

## Limits

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
