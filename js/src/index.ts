#!/usr/bin/env node
/**
 * CLI entry point for the BigQuery MCP control plane.
 *
 * Priority for configuration: CLI args > environment variables > defaults.
 */

import { type CliOverrides, loadConfig } from "./config.js";
import { runServer } from "./server.js";

const HELP = `bigquery-mcp-js - standalone BigQuery MCP server (Node/TypeScript)

Usage:
  bigquery-mcp-js [options]

Options:
  --project <id>          Google Cloud project ID (overrides GCP_PROJECT_ID)
  --location <loc>        BigQuery location, e.g. US, EU (overrides BIGQUERY_LOCATION)
  --key-file <path>       Service account JSON key (overrides GOOGLE_APPLICATION_CREDENTIALS)
  --datasets <a,b,c>      Restrict access to specific datasets (comma-separated)
  -h, --help              Show this help

This is the standalone JS BigQuery MCP server. The Python server
(bigquery-mcp) is a separate, independent package; both implement the same
tool contract (contract/tools.json).
`;

function parseArgs(argv: string[]): CliOverrides | "help" {
  const overrides: CliOverrides = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        return "help";
      case "--project":
        overrides.projectId = next();
        break;
      case "--location":
        overrides.location = next();
        break;
      case "--key-file":
        overrides.keyFile = next();
        break;
      case "--datasets":
        overrides.allowedDatasets = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return overrides;
}

async function main(): Promise<void> {
  let parsed: CliOverrides | "help";
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`ERROR: ${(err as Error).message}\n\n${HELP}`);
    process.exit(1);
  }
  if (parsed === "help") {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig(parsed);
  try {
    await runServer(config);
  } catch (err) {
    process.stderr.write(`ERROR: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

void main();
