/**
 * MCP tool definitions for the control plane.
 *
 * Tools are intentionally thin: validate input, apply shared policy, forward to
 * the worker via the broker, and format the result. They never touch BigQuery
 * directly — that is the worker's job — which keeps behaviour identical across
 * the Python and Node workers.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkerBroker } from "../broker/workerBroker.js";
import type { Config } from "../config.js";
import { checkEstimatedBytes } from "../policy/costPolicy.js";
import { isQuerySafe } from "../policy/sqlSafety.js";
import type { WorkerResponse } from "../types/worker.js";

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  // The MCP SDK's CallToolResult carries an index signature; mirror it so our
  // return type is assignable to the tool callback's expected shape.
  [key: string]: unknown;
}

function jsonResult(payload: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

/** Flatten a worker response into the structure the legacy Python server returned. */
function formatResponse(res: WorkerResponse): ToolResult {
  if (res.ok) {
    return jsonResult({ success: true, data: res.data, ...(res.meta ?? {}) });
  }
  return jsonResult({ success: false, error: res.error, error_type: res.code ?? "WorkerError" }, true);
}

function errorResult(message: string, code = "ValidationError"): ToolResult {
  return jsonResult({ success: false, error: message, error_type: code }, true);
}

export function registerTools(server: McpServer, broker: WorkerBroker, config: Config): void {
  server.tool(
    "run_query",
    "Execute read-only BigQuery SQL queries with safety validation and a dry-run cost guard. " +
      "Use LIMIT in your query to control result size (recommended: start with LIMIT 20). " +
      "For semantic search, consider using the vector_search tool or write custom VECTOR_SEARCH queries.",
    {
      query: z
        .string()
        .describe(
          "BigQuery SQL SELECT query to execute (only read-only queries allowed). Use LIMIT to control result size.",
        ),
    },
    async ({ query }) => {
      // 1. Shared safety policy: only read-only SELECT / WITH.
      const safety = isQuerySafe(query);
      if (!safety.safe) return errorResult(safety.error, "UnsafeQuery");

      // 2. Dry run first to estimate scanned bytes.
      const dry = await broker.request("dry_run_query", { sql: query });
      if (!dry.ok) return formatResponse(dry);
      const estimated = Number(
        (dry.meta?.total_bytes_processed as number | undefined) ??
          (dry.data as { total_bytes_processed?: number } | null)?.total_bytes_processed ??
          Number.NaN,
      );

      // 3. Enforce the cost policy before creating a billable job.
      const decision = checkEstimatedBytes(estimated, config.maxBytesBilled);
      if (!decision.allowed) return errorResult(decision.message ?? "Query exceeds cost limit.", "CostLimit");

      // 4. Execute for real (worker applies maximumBytesBilled as a hard cap).
      const res = await broker.request("run_query", { sql: query });
      return formatResponse(res);
    },
  );

  server.tool(
    "dry_run_query",
    "Estimate the bytes a BigQuery SQL query would scan without executing it. " +
      "Useful for cost checks before running expensive queries.",
    {
      query: z.string().describe("BigQuery SQL SELECT query to dry-run (only read-only queries allowed)."),
    },
    async ({ query }) => {
      const safety = isQuerySafe(query);
      if (!safety.safe) return errorResult(safety.error, "UnsafeQuery");
      const res = await broker.request("dry_run_query", { sql: query });
      return formatResponse(res);
    },
  );

  server.tool(
    "list_datasets_in_project",
    "List all datasets in BigQuery project with optional search and detailed information",
    {
      search: z
        .string()
        .default("")
        .describe("Filter datasets by name (case-insensitive)"),
      detailed: z
        .boolean()
        .default(false)
        .describe("Include descriptions and table counts for each dataset"),
      max_results: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("(OPTIONAL INTEGER) Maximum number of datasets to return"),
    },
    async ({ search, detailed, max_results }) => {
      const res = await broker.request("list_datasets", {
        search,
        detailed,
        max_results: max_results ?? null,
      });
      return formatResponse(res);
    },
  );

  server.tool(
    "list_tables_in_dataset",
    "List tables in dataset with optional search, detailed information, and dataset context",
    {
      dataset_id: z.string().describe("Dataset ID to list tables from"),
      search: z.string().default("").describe("Filter tables by name (case-insensitive)"),
      detailed: z
        .boolean()
        .default(false)
        .describe("Include table metadata like row count and size"),
      max_results: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("(OPTIONAL INTEGER) Maximum number of tables to return"),
    },
    async ({ dataset_id, search, detailed, max_results }) => {
      const res = await broker.request("list_tables", {
        dataset_id,
        search,
        detailed,
        max_results: max_results ?? null,
      });
      return formatResponse(res);
    },
  );

  server.tool(
    "get_table",
    "Get detailed table information with schema and column fill rate analysis",
    {
      dataset_id: z.string().describe("Dataset ID containing the table"),
      table_id: z.string().describe("Table ID to get detailed information for"),
    },
    async ({ dataset_id, table_id }) => {
      const res = await broker.request("get_table", { dataset_id, table_id });
      return formatResponse(res);
    },
  );

  if (config.vectorSearchEnabled) {
    server.tool(
      "vector_search",
      "Vector search: discover embedding tables (no query_text) or perform semantic search (with query_text). " +
        "Configure BIGQUERY_EMBEDDING_MODEL env var for search mode.",
      {
        query_text: z
          .string()
          .default("")
          .describe("Text to search for semantically. Leave empty to discover embedding tables."),
        table_path: z
          .string()
          .default("")
          .describe("Table path as 'dataset.table'. Required for search mode."),
        top_k: z.string().default("10").describe("Number of results to return (1-1000)."),
        select_columns: z
          .string()
          .default("")
          .describe("Comma-separated columns to return, or empty for all."),
        embedding_column: z
          .string()
          .default("embedding")
          .describe("Name of the embedding column."),
      },
      async ({ query_text, table_path, top_k, select_columns, embedding_column }) => {
        const parsedTopK = Number.parseInt(top_k, 10);
        if (top_k && Number.isNaN(parsedTopK)) {
          return errorResult(`top_k must be a number, got: '${top_k}'`);
        }
        const res = await broker.request("vector_search", {
          query_text,
          table_path,
          top_k: Number.isNaN(parsedTopK) ? 10 : parsedTopK,
          select_columns,
          embedding_column,
        });
        return formatResponse(res);
      },
    );
  }
}
