#!/usr/bin/env node
/**
 * CLI entry point for the BigQuery MCP control plane.
 *
 * Priority for configuration: CLI args > environment variables > defaults.
 */

import { type CliOverrides, loadConfig } from "./config.js";
import { runServer } from "./server.js";

const HELP = `bigquery-mcp-js - Node MCP control plane for BigQuery

Usage:
  bigquery-mcp-js [options]

Options:
  --project <id>          Google Cloud project ID (overrides GCP_PROJECT_ID)
  --location <loc>        BigQuery location, e.g. US, EU (overrides BIGQUERY_LOCATION)
  --key-file <path>       Service account JSON key (overrides GOOGLE_APPLICATION_CREDENTIALS)
  --datasets <a,b,c>      Restrict access to specific datasets (comma-separated)
  --worker <python|node>  Force a worker; default prefers python then falls back to node
                          (overrides BIGQUERY_MCP_WORKER)
  -h, --help              Show this help

Worker selection:
  By default the broker prefers the Python worker (if python3 and a healthy
  worker are available) and otherwise uses the bundled Node worker. Both
  implement the same contract, so tool behaviour is identical.
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
      case "--worker": {
        const value = next().toLowerCase();
        if (value !== "python" && value !== "node") {
          throw new Error(`--worker must be 'python' or 'node', got '${value}'`);
        }
        overrides.worker = value;
        break;
      }
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
