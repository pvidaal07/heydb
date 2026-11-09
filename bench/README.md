# Token benchmark

How much context an agent spends to find the tables that answer a question,
through the heydb tools or by querying `information_schema` itself.

```bash
node bench/run.ts                     # synthetic legacy ERP, 10 company databases
node bench/run.ts --companies 50      # the same with 50
node bench/run.ts --json              # raw numbers
node bench/run.ts --project ../app --questions questions.json [--connection erp]
```

`--project` reads a real heydb project: only its stored snapshot and notes,
never the database. The questions and the report of a real project name real
tables: keep them out of this repository.

## What it measures

The heydb side runs the real tools, so every character counted is one the
model would read. The agent follows a fixed policy, the same in every run:

1. `heydb_search` with each of the question's queries, in order, until every
   expected table shows up;
2. `heydb_overview` if one is still missing;
3. `heydb_table` on each expected table, with the default options.

A questions file is a JSON array:

```json
[{ "id": "unpaid-invoices", "ask": "Qué facturas tiene pendientes de cobro un cliente", "queries": ["facturas pendientes de cobro", "vencimiento"], "expect": ["fac_cab", "fac_ven"] }]
```

`expect` holds bare table names (any database's copy counts) or
`database.table`.

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
