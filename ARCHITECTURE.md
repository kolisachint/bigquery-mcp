# Architecture: Node control plane + pluggable worker broker

This repository ships **two separately-managed packages** that share one
language-neutral worker contract:

| Package | Lang | Distribution | Role |
|---|---|---|---|
| `bigquery-mcp` (root, `src/bigquery_mcp/`) | Python | pip / PyPI | FastMCP server **and** the preferred stdio worker (`bigquery-mcp-worker`) |
| `bigquery-mcp-node` (`node/`) | TypeScript | npm | MCP control plane + worker broker + bundled Node fallback worker |

```
                    ┌─────────────────────────────────────────────┐
   MCP host  ⇄ stdio │  bigquery-mcp-node (control plane)           │
                     │   • tool schemas, validation                │
                     │   • SQL safety + dry-run cost policy         │
                     │   • worker broker (discovery + fallback)     │
                     └───────────────┬─────────────────────────────┘
                                     │ newline-delimited JSON over stdio
                     ┌───────────────┴───────────────┐
                     ▼                                ▼
          Python worker (preferred)         Node worker (fallback)
          bigquery_mcp.worker               node/.../workers/node/main.ts
                     │                                │
                     └──────────── BigQuery SDK ──────┘
                       (google-cloud-bigquery)  (@google-cloud/bigquery)
```

## Design rationale

- **MCP stays in Node, execution is swappable.** The MCP lifecycle/transport is
  the stable, host-facing surface; the worker is an implementation detail the
  broker picks per runtime availability. We deliberately do **not** make the MCP
  host switch languages.
- **Python preferred, Node fallback.** Python gives headroom for richer query
  analysis/post-processing and reuses the mature `bigquery_tools` logic. Node
  keeps install friction low and works with only npm present.
- **One contract, two implementations.** Both workers implement the same ops, so
  tool output is identical regardless of which one handles a request.

## Worker selection

1. Explicit override: `BIGQUERY_MCP_WORKER=python|node` (or `--worker`).
2. Otherwise prefer Python: spawn it and run a `health` check.
3. Otherwise fall back to the bundled Node worker.

A worker that fails to start (e.g. missing credentials) fails its health check,
and the broker moves on — the control plane still starts.

## Safety & cost path (`run_query`)

1. Reject non-`SELECT`/`WITH` (shared `sqlSafety`, ported from `query_safety.py`).
2. **Dry run** to estimate scanned bytes.
3. Reject if the estimate exceeds `BIGQUERY_MAX_BYTES_BILLED` (fail fast, no
   billable job).
4. Execute with `maximumBytesBilled` as a hard cap.
5. Return bounded rows + metadata.

## The contract

NDJSON over stdio, correlated by `id`:

```jsonc
{ "id": "…", "op": "run_query", "params": { "sql": "SELECT 1" } }
{ "id": "…", "ok": true,  "data": [ … ], "meta": { … } }
{ "id": "…", "ok": false, "error": "…", "code": "…" }
```

Ops: `health`, `list_datasets`, `list_tables`, `get_table`, `dry_run_query`,
`run_query`, `vector_search`.

- TypeScript definition: `node/src/types/worker.ts`
- Python worker: `src/bigquery_mcp/worker.py` + `src/bigquery_mcp/worker_ops.py`
- Node worker: `node/src/workers/node/main.ts`

## Running

```bash
# Node control plane (auto-selects Python worker, falls back to Node)
cd node && npm install && npm run build
node dist/index.js --project YOUR_PROJECT --location US

# Python worker standalone (normally spawned by the broker)
uv run bigquery-mcp-worker        # reads requests on stdin

# Original Python FastMCP server (unchanged, still available)
uv run bigquery-mcp --project YOUR_PROJECT --location US
```
