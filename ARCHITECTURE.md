# Architecture: two independent servers, one shared contract

This repository ships **two independent MCP servers** that talk to BigQuery
directly. They do not call each other and there is no broker or worker layer.
What keeps them from drifting is a single shared **tool contract**.

| Package | Lang | Distribution | Entry |
|---|---|---|---|
| `bigquery-mcp-python` (root, `src/bigquery_mcp/`) | Python | PyPI: `bigquery-mcp-python` (`uvx bigquery-mcp-python`) | command `bigquery-mcp` (FastMCP, stdio) |
| `bigquery-mcp-js` (`js/`) | TypeScript | npm (built with Bun) | command `bigquery-mcp-js` (MCP SDK, stdio) |

> Naming: the Python **PyPI package is `bigquery-mcp-python`** but the **command it
> installs is `bigquery-mcp`** (with a `bigquery-mcp-python` alias). The import
> package is `bigquery_mcp`. `pip install bigquery-mcp` will **not** find this project.

```
        ┌─────────────────────────────┐        ┌─────────────────────────────┐
MCP host│  bigquery-mcp  (Python)     │   OR   │  bigquery-mcp-js  (Node)    │
  ⇄stdio│  FastMCP + bigquery_tools   │        │  MCP SDK + BigQueryService  │
        └──────────────┬──────────────┘        └──────────────┬──────────────┘
                       │ google-cloud-bigquery                │ @google-cloud/bigquery
                       └──────────────┬───────────────────────┘
                                      ▼
                                  BigQuery

                 both implement ─►  contract/tools.json  ◄─ single source of truth
```

Pick whichever server fits your runtime. They expose the same tools with the
same inputs and outputs.

## The shared contract

`contract/tools.json` is the **single source of truth** for the tool surface:
each tool's `name`, `summary` (description), `input` JSON Schema, and `output`
JSON Schema. See `contract/README.md`.

- **JS is generated from the contract.** `js/src/tools/register.ts` iterates the
  contract, builds each tool's input validation (zod) from its `input` schema,
  and wires it to the handler in `js/src/tools/handlers.ts`. Descriptions come
  straight from the contract.
- **Python is checked against the contract.** `src/bigquery_mcp/bigquery_tools.py`
  reads tool descriptions from the contract, and `tests/test_contract.py` asserts
  that the registered tools (names, descriptions, input parameter names/types/
  required-ness/descriptions) match it.
- **Outputs are validated both sides.** `tests/test_contract.py` (Python,
  `jsonschema`) and `js/src/test/contract.test.ts` (JS, `ajv`) run each tool
  against a mocked BigQuery client and validate the result against the contract's
  `output` schema.

### Adding or changing a tool

1. Edit `contract/tools.json` (name, `summary`, `input`, `output`).
2. JS: add a handler in `js/src/tools/handlers.ts` (registration + validation are
   generated from the contract).
3. Python: add the tool in `src/bigquery_mcp/bigquery_tools.py`, reading its
   description from `contract.description("<name>")`.
4. Run both suites — the conformance/output tests fail if either side diverges.

### Distribution of the contract

The canonical file lives at `contract/tools.json`.

- The JS package **inlines** it at build time (`bun build` bundles the JSON
  import in `js/src/contract.ts`).
- The Python package **ships a copy** as `bigquery_mcp/contract.json` via
  `force-include` in `pyproject.toml`; `contract.py` loads the packaged copy when
  installed and the canonical file in a source checkout.

## Bundled agent skills & agents

This repo ships portable [Agent Skills](https://code.claude.com/docs) and agent
definitions under `.agents/`. Like the contract, each has a single canonical copy
at the repo root that both packages bundle, so the published artifacts carry them.

**Skills** (`.agents/skills/`):
- `bigquery-cost-first-querying` — the cost-first decision procedure (the
  priority ordering below) for invoking the tools. This is the authoritative
  cost guidance; everything else defers to it.
- `secure-context-reducer` — GDPR/PCI-DSS-aware data minimization that reduces
  retrieved data to a compact, prompt-safe fact map before it reaches a reasoning
  model; defers the BigQuery half to the cost-first skill.

**Agents** (`.agents/agents/`):
- `bigquery-table-analyst` — explores datasets/tables and reports schemas, fill
  rates, and relationships, driving the tools cost-first per the skill.
- `cost-first-compliant-agent` — queries cost-first, runs results through
  `secure-context-reducer`, then reasons over the safe facts. Both agents declare
  the skills they obey via a `required-skills` frontmatter field.

Bundling:
- Python ships them in the wheel under `bigquery_mcp/skills/...` and
  `bigquery_mcp/agents/...` via `force-include` in `pyproject.toml` (the sdist
  includes them via VCS).
- JS copies them into `dist/skills/...` and `dist/agents/...` at build time
  (`js/scripts/copy-agent-assets.ts`), shipped through the package's
  `files: ["dist"]`.

When changing this guidance, edit the canonical copy under `.agents/`; both
packages pick it up at build time.

## Tools

`list_dataset_ids`, `get_dataset_info`, `list_table_ids`, `get_table_info`,
`dry_run_query`, `execute_sql`.

Names follow Google's [BigQuery MCP / MCP Toolbox](https://googleapis.github.io/genai-toolbox/resources/tools/bigquery/)
conventions (`execute_sql`, `list_dataset_ids`, `get_dataset_info`,
`list_table_ids`, `get_table_info`). Tools with no Google equivalent are this
project's own addition: `dry_run_query`. When a capability maps to a Google
tool, match its name; only invent a name when Google has none.

Both servers implement each tool identically: `execute_sql` executes with a
`maximumBytesBilled` hard cap; `dry_run_query` returns the planner's byte
estimate without scanning; read-only `SELECT`/`WITH` safety validation is applied
the same way (`query_safety.py` / `policy/sqlSafety.ts`).

## Design priorities: BigQuery cost > LLM cost > latency

The tool surface is designed around an explicit ordering — when goals conflict,
the earlier one wins. The contract orders tools cheapest-first to reinforce it.

1. **BigQuery cost (bytes scanned) first.** Discovery (`list_dataset_ids`,
   `get_dataset_info`, `list_table_ids`, `get_table_info`) uses the metadata APIs
   (`list_datasets`/`get_dataset`/`list_tables`/`get_table`) and scans **zero
   bytes**. `dry_run_query` runs a dry-run job (`dry_run=true`,
   `use_query_cache=false`) to read the planner's estimate without billing.
   Every job that does scan — `execute_sql` and the `get_table_info` fill-rate +
   sample probes — goes through `_create_query_job_config` / `runQueryJob`,
   which always sets `maximum_bytes_billed`. The probes in
   `get_table_info` are bounded by a sampled `LIMIT`. Tool descriptions push the
   model toward partition/cluster filters, narrow column lists, and `LIMIT`.
2. **LLM (token) cost second.** List tools return **names only** unless
   `detailed=true`, so the agent narrows the search space cheaply before
   requesting heavier metadata. All responses are compact, structured JSON.
3. **Latency last — never at the expense of (1) or (2).** Metadata calls run in
   worker threads with short timeouts; list+search uses a bounded fetch
   multiplier (`_calculate_search_fetch_limit` / `calcSearchFetchLimit`).

## Running

```bash
# Python server
uv run bigquery-mcp --project YOUR_PROJECT --location US

# JS server
cd js && bun install && bun run build
node dist/index.js --project YOUR_PROJECT --location US
```

## Releasing

Both packages are versioned in lockstep and published by a label-driven workflow.
See **RELEASING.md**.
