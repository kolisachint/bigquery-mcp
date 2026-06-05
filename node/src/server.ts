/**
 * BigQuery MCP control plane (Node/TypeScript).
 *
 * Owns the MCP lifecycle and transport, validation, policy and worker
 * discovery. All BigQuery access is delegated to a worker (Python-first, Node
 * fallback) via the broker, so the MCP surface stays stable regardless of which
 * runtime is available.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WorkerBroker } from "./broker/workerBroker.js";
import type { Config } from "./config.js";
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

  const broker = new WorkerBroker(config);
  const selected = await broker.start();
  process.stderr.write(
    `🔌 BigQuery MCP control plane ready (worker: ${selected}, project: ${config.projectId}, location: ${config.location})\n`,
  );

  const server = new McpServer({ name: "bigquery-mcp", version: "0.1.0" });
  registerTools(server, broker, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = (): void => {
    broker.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
