import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { existsSync } from "node:fs";
import { WorkerBroker, defaultNodeWorker } from "../broker/workerBroker.js";
import { loadConfig } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// {src,dist}/test -> {src,dist} -> js -> js/test-fixtures
const fakeWorker = path.resolve(__dirname, "..", "..", "test-fixtures", "fakeWorker.mjs");

function baseEnv(): void {
  delete process.env.BIGQUERY_MCP_WORKER;
  delete process.env.BIGQUERY_MCP_PYTHON_CMD;
  process.env.BIGQUERY_MCP_NODE_WORKER = fakeWorker;
}

test("selects the node worker when forced", async () => {
  baseEnv();
  const broker = new WorkerBroker(loadConfig({ projectId: "p", location: "US", worker: "node" }));
  try {
    const kind = await broker.start();
    assert.equal(kind, "node");
    const res = await broker.request("run_query", { sql: "SELECT 1" });
    assert.equal(res.ok, true);
  } finally {
    broker.stop();
  }
});

test("resolves the bundled Node worker to a real file", () => {
  // Guards against bundling/layout changes breaking the default worker path.
  const resolved = defaultNodeWorker();
  assert.ok(existsSync(resolved), `expected worker file to exist: ${resolved}`);
  assert.match(resolved, /workers[/\\]node[/\\]main\.(ts|js)$/);
});

test("falls back to node when the python worker is unhealthy", async () => {
  baseEnv();
  // A "python" command that exits immediately => health check fails.
  process.env.BIGQUERY_MCP_PYTHON_CMD = `${process.execPath} -e process.exit(1)`;
  const broker = new WorkerBroker(loadConfig({ projectId: "p", location: "US" }));
  try {
    const kind = await broker.start();
    assert.equal(kind, "node");
  } finally {
    broker.stop();
  }
});

test("forwards contract requests and correlates responses", async () => {
  baseEnv();
  const broker = new WorkerBroker(loadConfig({ projectId: "p", location: "US", worker: "node" }));
  try {
    await broker.start();
    // Issue several concurrent requests to exercise id correlation.
    const results = await Promise.all([
      broker.request("health", {}),
      broker.request("dry_run_query", { sql: "SELECT 1" }),
      broker.request("run_query", { sql: "SELECT 1" }),
    ]);
    assert.deepEqual(
      results.map((r) => r.ok),
      [true, true, true],
    );
  } finally {
    broker.stop();
  }
});
