---
name: bigquery-cost-first-querying
description: >-
  Cost-first decision procedure for invoking the BigQuery MCP tools
  (list_dataset_ids, get_dataset_info, list_table_ids, get_table_info,
  dry_run_query, execute_sql, vector_search). Use whenever you are about to
  explore a BigQuery project, inspect datasets/tables/schemas, or run SQL
  through this MCP server. Enforces a strict optimization order: minimize
  BigQuery bytes scanned first, then minimize LLM tokens, then minimize
  latency — never trading a cheaper goal for a more expensive one.
license: MIT
metadata:
  version: 1.0.0
  standard: agent-skills
  applies-to: bigquery-mcp, bigquery-mcp-js
allowed-tools:
  - mcp__bigquery__list_dataset_ids
  - mcp__bigquery__get_dataset_info
  - mcp__bigquery__list_table_ids
  - mcp__bigquery__get_table_info
  - mcp__bigquery__dry_run_query
  - mcp__bigquery__execute_sql
  - mcp__bigquery__vector_search
---

# BigQuery cost-first querying

This skill governs **how to choose and order BigQuery MCP tool calls**. The tool
surface is built around one rule: when goals conflict, the earlier one wins.

> **Priority order (non-negotiable):**
> **1. Minimize BigQuery cost (bytes scanned)** →
> **2. Minimize LLM cost (tokens)** →
> **3. Minimize latency.**
>
> Never spend more BigQuery cost to save tokens or latency. Never spend more
> tokens to save latency.

## Priority 1 — Minimize BigQuery bytes scanned

Bytes scanned is the dominant cost and the hardest to undo. Default to **not
running a query**.

- **Exhaust metadata tools before any query.** `list_dataset_ids`,
  `get_dataset_info`, `list_table_ids`, and `get_table_info` use BigQuery's
  metadata APIs and scan **zero bytes**. Use them to find the right
  dataset/table/columns before writing SQL.
- **Always `dry_run_query` before `execute_sql`** for any non-trivial query.
  The dry run returns the planner's byte estimate without billing. If the
  estimate is large, narrow the query and dry-run again — iterate on the
  estimate, not on real jobs.
- **Write queries that scan less:**
  - Filter on **partition** and **cluster** columns whenever the table has them
    (check `get_table_info` first).
  - **Never `SELECT *`.** Select only the columns you need.
  - Always add a `LIMIT` when sampling or exploring.
  - Avoid re-scanning: prefer one well-shaped query over several probing ones.
- **Respect the hard cap.** Every real job (`execute_sql`, the `get_table_info`
  fill-rate/sample probes, `vector_search`) runs under `maximum_bytes_billed`.
  If a job is rejected by the cap, that is a signal to scan less — not to raise
  the cap.

## Priority 2 — Minimize LLM tokens

Once a call scans zero (or minimal) bytes, make its **response** as small as it
can be while still answering the question.

- **Names first, details on demand.** List tools return **names only** by
  default. Call them plain to narrow the search space, and only pass
  `detailed=true` (row counts, sizes, descriptions, labels) for the few
  candidates that survive narrowing.
- **One dataset/table at a time** once you have a candidate: prefer
  `get_dataset_info` / `get_table_info` for a single target over pulling
  `detailed=true` across everything.
- **Keep your own output compact.** Responses are structured JSON; summarize
  for the user instead of echoing large payloads back verbatim.

## Priority 3 — Minimize latency

Only after (1) and (2) are satisfied. Latency is optimized inside the server
(worker-thread metadata calls with short timeouts, bounded search-fetch
multipliers, cached embedding-table discovery). Do **not** try to beat it by
scanning more bytes (e.g. one big `SELECT *` instead of metadata + a narrow
query) or by requesting `detailed=true` everywhere "to save a round trip."
A second cheap call beats one expensive call.

## Decision procedure

Walk this top-down and stop at the first step that answers the question:

1. **Which datasets exist?** → `list_dataset_ids` (names only).
2. **Need a dataset's description / table count / location?** →
   `get_dataset_info`, or `list_dataset_ids` with `detailed=true`.
3. **Which tables are in a dataset?** → `list_table_ids` (names only); add
   `detailed=true` only for shortlisted tables.
4. **Need schema, column fill rates, or sample rows?** → `get_table_info`
   (bounded sample scan).
5. **Semantic / embedding search?** → `vector_search` (discovers embedding
   tables via cached metadata, or runs the search).
6. **About to run SQL?** → `dry_run_query` to size it. Acceptable estimate?
   → `execute_sql` (SELECT/WITH only). Too large? → narrow and dry-run again.

## Quick reference

| Tool | BQ bytes | When |
|---|---|---|
| `list_dataset_ids` | 0 | Discover datasets |
| `get_dataset_info` | 0 | One dataset's metadata |
| `list_table_ids` | 0 | Discover tables in a dataset |
| `get_table_info` | bounded sample | Schema, fill rates, sample rows |
| `dry_run_query` | 0 | Estimate a query's cost before running |
| `execute_sql` | capped | Run a read-only `SELECT`/`WITH` |
| `vector_search` | capped (or 0 to discover) | Semantic / embedding search |

## Anti-patterns

- Running `execute_sql` before any metadata exploration or a `dry_run_query`.
- `SELECT *`, or queries with no partition/cluster filter and no `LIMIT`.
- Passing `detailed=true` across a whole list when you only need a few names.
- Raising or bypassing `maximum_bytes_billed` to force a large scan through.
- Issuing one heavy query to "save latency" instead of metadata + a narrow one.
