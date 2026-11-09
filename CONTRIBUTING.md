# Contributing to heydb

Thanks for helping. heydb works issue first: every change starts as an approved issue, so nobody spends time on work that will not be merged.

## How a change gets in

1. **Open an issue** with the bug or feature template. It starts with `status:needs-review`.
2. **Wait for approval.** A maintainer labels it `status:approved` (or asks for details with `status:needs-info`). Comment on the issue if you want to take it, so it gets `status:in-progress` and nobody duplicates work.
3. **Fork** the repository and create a branch from `main`: `fix/search-plurals`, `feat/redis-engine`, `docs/quick-start`.
4. **Make the change** with tests (see below), in small commits that follow [Conventional Commits](https://www.conventionalcommits.org): `fix(search): match plurals`, `feat(engines): read Redis key patterns`.
5. **Open a pull request to `main`** using the template. Its title follows Conventional Commits and its description says `Closes #<issue>`; the "PR check" workflow verifies both.
6. **CI runs** typecheck and tests on Linux, macOS and Windows, plus integration tests against real MySQL, MariaDB and PostgreSQL. For first contributions a maintainer approves the run.
7. **A maintainer reviews and merges.**

Small fixes to documentation can skip the approval step, but still link an issue.

## Development setup

Requires Node.js 22.19 or later and Docker for integration tests.

```sh
corepack enable
pnpm install
pnpm check                   # typecheck + unit tests: must pass
node --run db:up             # MySQL 8.0, MariaDB 10.6, PostgreSQL 16 in Docker
node --run test:integration  # engine tests against real servers
node --run db:down
pi -e .                      # try your copy in Pi
```

## How the code is organized

| Folder | What lives there |
|---|---|
| `lib/model/` | The snapshot types, canonical names, ordering, hash, diff, validation. Pure functions. |
| `lib/engines/` | One folder per database engine: `catalog.ts` turns catalog rows into a snapshot (pure, unit tested), `introspect.ts` runs the queries (integration tested). |
| `lib/store/` | Files under `.heydb/`: atomic writes, stable JSON, path and symlink guards. |
| `lib/knowledge/` | Notes and relationships. |
| `lib/usecases/` | Operations that combine the above (sync, status, annotate, code scan…). |
| `extensions/` | The Pi glue: tools, commands, prompt context. Thin; logic belongs in `lib/`. |
| `skills/heydb/` | The skill that teaches the agent to use heydb. |

Rules that reviews check:

- `lib/` never imports Pi (`@earendil-works/*`); a test enforces it. The core must stay usable from a future CLI or MCP server.
- Tests come with the behavior: write the failing test first, then the code. Engine changes need an integration test case in the legacy fixtures.
- Database sessions stay read-only, and agent tools never connect to a database.
- No new runtime dependency without discussing it in the issue first; no native modules.
- TypeScript strict, ESM, tabs, double quotes. Comments explain why, not what.

## Adding a database engine

Open an issue first. An engine adds `lib/engines/<engine>/catalog.ts` and `introspect.ts`, a case in `lib/engines/index.ts`, config support in `lib/config/`, a service and fixture in `tests/integration/`, and loads its driver lazily so other engines never pay for it.

## Security

Never put real passwords, tokens, connection strings, `.heydb/.env` content or customer data in issues, code, tests or fixtures. Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Code of conduct

Be respectful and constructive. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
