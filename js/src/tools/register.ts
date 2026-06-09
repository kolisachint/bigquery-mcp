/**
 * Contract-driven tool registration. Iterates the shared contract, builds each
 * tool's input validation from its `input` schema, and wires it to the matching
 * handler. The MCP surface is therefore generated from the contract, not
 * hand-maintained.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BigQueryService } from "../bigquery.js";
import { ToolError } from "../bigquery.js";
import { buildInputShape, tools } from "../contract.js";
import { type ToolArgs, handlers } from "./handlers.js";

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

function jsonResult(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export function registerTools(server: McpServer, service: BigQueryService): void {
  for (const spec of tools) {
    const handler = handlers[spec.name];
    if (!handler) {
      throw new Error(`No handler implemented for contract tool '${spec.name}'`);
    }

    server.tool(spec.name, spec.summary, buildInputShape(spec), async (args: ToolArgs) => {
      try {
        const { data, meta } = await handler(service, args);
        return jsonResult({ success: true, data, ...(meta ?? {}) });
      } catch (err) {
        if (err instanceof ToolError) {
          return jsonResult({ success: false, error: err.message, error_type: err.code }, true);
        }
        const e = err as Error;
        return jsonResult(
          { success: false, error: e.message ?? String(err), error_type: e.name ?? "Error" },
          true,
        );
      }
    });
  }
}
