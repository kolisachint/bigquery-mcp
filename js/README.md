# bigquery-mcp-js

A standalone Node/TypeScript **MCP server** for BigQuery, using the official
`@google-cloud/bigquery` client. It is independent of the Python `bigquery-mcp`
server; the two share a tool **contract** (`contract/tools.json`) so their tools,
inputs, and outputs stay identical.

## Install & build

Uses [Bun](https://bun.sh) for install, build, and tests (the build targets Node
and runs under either runtime).

```bash
bun install
bun run build      # bun build -> dist/index.js (deps + contract inlined)
bun run test       # bun:test (sqlSafety + contract output validation)
bun run typecheck  # tsc --noEmit
```

## Run

```bash
node dist/index.js --project YOUR_PROJECT --location US
# during development:
bun ./src/index.ts --project YOUR_PROJECT --location US
```

Options: `--project`, `--location`, `--key-file`, `--datasets a,b,c`. Configuration
also comes from the same environment variables as the Python server
(`GCP_PROJECT_ID`, `BIGQUERY_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`,
`BIGQUERY_ALLOWED_DATASETS`, `BIGQUERY_MAX_BYTES_BILLED`, `BIGQUERY_SAMPLE_ROWS*`,
the vector-search vars, …).

## Tools

`run_query`, `dry_run_query`, `list_datasets_in_project`,
`list_tables_in_dataset`, `get_table`, and (when enabled) `vector_search` —
defined once in `contract/tools.json`.

## How the contract drives this server

- `src/contract.ts` loads `contract/tools.json` (bundled at build time) and turns
  each tool's `input` schema into a zod shape.
- `src/tools/register.ts` iterates the contract and registers each tool, wiring
  it to the handler in `src/tools/handlers.ts`.
- `src/bigquery.ts` (`BigQueryService`) performs the actual BigQuery calls.
- `src/test/contract.test.ts` validates each tool's output against the contract's
  `output` schema using a mocked BigQuery client.

To add a tool: edit `contract/tools.json`, add a handler in
`src/tools/handlers.ts`, and run `bun run test`. See the repo's `ARCHITECTURE.md`.
