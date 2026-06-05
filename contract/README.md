# Tool contract

`tools.json` is the **single source of truth** for the BigQuery MCP tool surface.
Both servers consume it so their interfaces cannot drift:

- **`bigquery-mcp-js`** (Node) is *driven* by the contract: it registers tools by
  iterating `tools.json`, builds input validation (zod) from each `input` schema,
  and validates handler output against each `output` schema in tests.
- **`bigquery-mcp`** (Python) loads tool descriptions from the contract and a
  conformance test asserts its registered tools (names, descriptions, input
  schemas) and sample outputs match the contract.

## Adding or changing a tool

1. Edit `tools.json` (name, `summary`, `input` JSON Schema, `output` JSON Schema).
2. Implement the handler in each server:
   - JS: add an entry to `js/src/tools/handlers.ts`.
   - Python: add the tool in `src/bigquery_mcp/bigquery_tools.py`.
3. Run both test suites — the conformance/output tests fail if either server
   diverges from the contract.

## Distribution

`tools.json` lives here as the canonical copy. The JS package inlines it at build
time (`bun build` bundles the JSON import). The Python package ships a copy as
`bigquery_mcp/contract.json` (via `force-include` in `pyproject.toml`); a test
asserts the shipped copy matches this canonical file.

## Conventions

- Field names on the wire are `snake_case`.
- Every tool returns the envelope: `success: true` + `data` (+ meta fields) on
  success, or `success: false` + `error` + `error_type` on failure.
- `contractVersion` is semver; bump major for backwards-incompatible changes.
