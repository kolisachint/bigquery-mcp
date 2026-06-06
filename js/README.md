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
bun run build      # bun build -> dist/index.js (deps + contract inlined, skill copied)
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

`list_dataset_ids`, `get_dataset_info`, `list_table_ids`, `get_table_info`,
`dry_run_query`, `execute_sql`, and (when enabled) `vector_search` — defined once
in `contract/tools.json`. Names follow Google's BigQuery MCP conventions;
`dry_run_query` and `vector_search` are own additions with no Google equivalent.

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

## Bundled agent skill

The build copies the portable cost-first querying
[Agent Skill](https://code.claude.com/docs) from the repo root
(`.agents/skills/bigquery-cost-first-querying/SKILL.md`) into
`dist/skills/bigquery-cost-first-querying/SKILL.md`, so it ships with the npm
package. See the repo's `ARCHITECTURE.md`.
