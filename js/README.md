# bigquery-mcp-js

A Node/TypeScript **MCP control plane** for BigQuery with a **pluggable worker
broker**. The MCP server owns the protocol, validation, and safety/cost policy;
all BigQuery access happens in a *worker* that the broker selects at runtime —
preferring a **Python worker** when available and otherwise falling back to a
bundled **Node worker**.

```
stdio MCP server (Node/TS)  ->  worker broker  ->  Python worker | Node worker  ->  BigQuery SDK
```

## Why this shape

- **Stable MCP surface.** MCP lifecycle/transport stays in Node regardless of
  which worker runs, so publishing, debugging, and host integration stay simple.
- **Better failure model.** The control plane starts even if Python is missing;
  the broker tries Python first, health-checks it, and falls back to Node. Tool
  behaviour is identical because both workers implement the same contract.
- **Shared safety policy.** Read-only `SELECT`/`WITH` enforcement, a dry-run
  cost guard, and a `maximumBytesBilled` hard cap are applied consistently.

## Install & build

Uses [Bun](https://bun.sh) as the package manager and build runner (the compiled
output still targets Node and runs under either runtime).

```bash
bun install
bun run build      # tsc -> dist/
bun run test       # node:test (policy + broker routing, no BigQuery needed)
```

## Run

```bash
# Prefer Python worker, fall back to Node automatically:
node dist/index.js --project YOUR_PROJECT --location US

# Force a worker:
node dist/index.js --project YOUR_PROJECT --location US --worker node
BIGQUERY_MCP_WORKER=python node dist/index.js --project YOUR_PROJECT --location US
```

The Python worker is the `bigquery-mcp-python` package's `bigquery-mcp-worker`
entry point (`python3 -m bigquery_mcp.worker`). In this monorepo it is picked up
automatically from `../src`; when installed standalone, install the Python
package into the same environment (or set `BIGQUERY_MCP_PYTHON_CMD`).

## Tools

`run_query`, `dry_run_query`, `list_datasets_in_project`,
`list_tables_in_dataset`, `get_table`, and (when enabled) `vector_search` —
full parity with the Python FastMCP server.

`run_query` runs the cost flow end to end: SQL safety check → dry run →
compare estimated bytes against `BIGQUERY_MAX_BYTES_BILLED` → execute with the
hard cap → return bounded rows.

## Configuration

Reads the same environment variables as the Python server (`GCP_PROJECT_ID`,
`BIGQUERY_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`, `BIGQUERY_ALLOWED_DATASETS`,
`BIGQUERY_MAX_BYTES_BILLED`, `BIGQUERY_SAMPLE_ROWS*`, vector-search vars, …) plus:

| Variable | Purpose |
|---|---|
| `BIGQUERY_MCP_WORKER` | Force `python` or `node` (default: auto, Python-first) |
| `BIGQUERY_MCP_PYTHON_CMD` | Override the Python worker command |
| `BIGQUERY_MCP_PYTHON` | Override just the Python interpreter (default `python3`) |
| `BIGQUERY_MCP_NODE_WORKER` | Override the Node worker entry path |

## Worker contract

Newline-delimited JSON over stdio, correlated by `id`:

```jsonc
// request
{ "id": "…", "op": "run_query", "params": { "sql": "SELECT 1" } }
// response
{ "id": "…", "ok": true,  "data": [ … ], "meta": { … } }
{ "id": "…", "ok": false, "error": "…", "code": "…" }
```

Ops: `health`, `list_datasets`, `list_tables`, `get_table`, `dry_run_query`,
`run_query`, `vector_search`. See `src/types/worker.ts`.
