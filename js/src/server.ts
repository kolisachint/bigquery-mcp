/**
 * BigQuery MCP server (Node/TypeScript) — standalone.
 *
 * Owns the MCP lifecycle/transport and talks to BigQuery directly via
 * BigQueryService. Its tool surface is generated from the shared contract
 * (contract/tools.json), which is also what the Python server implements.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BigQueryService } from "./bigquery.js";
import type { Config } from "./config.js";
import { contractVersion } from "./contract.js";
import { registerTools } from "./tools/register.js";

export async function runServer(config: Config): Promise<void> {
  if (!config.projectId) {
    throw new Error(
      "Google Cloud project ID is required. Set --project or the GCP_PROJECT_ID environment variable.",
    );
  }
  if (!config.location) {
    throw new Error(
      "BigQuery location is required. Set --location or the BIGQUERY_LOCATION environment variable.",
    );
  }

  const service = new BigQueryService(config);

  // Validate credentials up front so failures surface clearly at startup.
  try {
    await service.validateAccess();
  } catch (err) {
    throw new Error(`BigQuery authentication failed: ${(err as Error).message}`);
  }
  process.stderr.write(
    `🔌 BigQuery MCP server ready (project: ${config.projectId}, location: ${config.location}, contract v${contractVersion})\n`,
  );

  const server = new McpServer({ name: "bigquery-mcp", version: "0.1.0" });
  registerTools(server, service, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
