# heydb

Database schema context for AI agents.

heydb reads the structure of your MySQL, MariaDB or PostgreSQL database (never its data), keeps a local snapshot, lets you and your agent annotate what tables and columns mean, and shares that knowledge with your team through git. Your agent understands the database without ever connecting to it.

> [!IMPORTANT]
> **heydb v2 is under active development.** It is being rebuilt in TypeScript as a [Pi](https://pi.dev) package. Nothing is published yet.
>
> The previous Go version (CLI + MCP server) is archived at tag [`v1.3.1`](https://github.com/pvidaal07/heydb/releases/tag/v1.3.1) and no longer maintained.

## Planned for the first release

- Introspection of MySQL 5.7/8, MariaDB 10/11 and PostgreSQL 14+.
- A schema snapshot and annotated knowledge stored as plain files in `.heydb/`, reviewable in pull requests.
- Schema drift detection.
- Pi tools so your agent can explore the schema and record what it learns.
- Connection secrets referenced from environment variables, never stored by heydb.

## Development

Requires Node.js 22.19+ and pnpm (via `corepack enable`).

```sh
pnpm install
pnpm check        # typecheck + tests
```

Try the extension in Pi:

```sh
pi -e ./extensions/heydb.ts
# then run /heydb:about
```

## License

MIT
