/**
 * Worker broker: discovers and selects the execution worker, then forwards
 * contract requests to it.
 *
 * Selection rules (matching the architecture):
 *   1. Explicit override via `BIGQUERY_MCP_WORKER=python|node` (or CLI) wins.
 *   2. Otherwise prefer Python when it spawns and its health check succeeds.
 *   3. Otherwise fall back to the Node worker.
 *
 * The broker keeps a single long-lived worker process and re-exposes the
 * worker contract, so the MCP tools stay thin and language-agnostic.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, workerEnv } from "../config.js";
import {
  type OpParams,
  type WorkerKind,
  type WorkerOp,
  type WorkerResponse,
} from "../types/worker.js";
import { type SpawnSpec, WorkerProcess } from "./workerProcess.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/broker -> dist -> node -> <repo root>
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const pythonSrc = path.join(repoRoot, "src");

function pythonSpawnSpec(config: Config): SpawnSpec {
  const env = workerEnv(config);
  // Prepend the in-repo Python source so `-m bigquery_mcp.worker` resolves in
  // development without an editable install. An installed package still wins
  // via its console entry point if BIGQUERY_MCP_PYTHON_CMD is overridden.
  if (existsSync(pythonSrc)) {
    env.PYTHONPATH = env.PYTHONPATH ? `${pythonSrc}${path.delimiter}${env.PYTHONPATH}` : pythonSrc;
  }
  const custom = process.env.BIGQUERY_MCP_PYTHON_CMD;
  if (custom && custom.trim()) {
    const [command, ...args] = custom.trim().split(/\s+/);
    return { kind: "python", command, args, env, cwd: repoRoot };
  }
  const interpreter = process.env.BIGQUERY_MCP_PYTHON ?? "python3";
  return {
    kind: "python",
    command: interpreter,
    args: ["-m", "bigquery_mcp.worker"],
    env,
    cwd: repoRoot,
  };
}

function nodeSpawnSpec(config: Config): SpawnSpec {
  const env = workerEnv(config);
  // dist/broker -> dist -> dist/workers/node/main.js
  const defaultWorker = path.resolve(__dirname, "..", "workers", "node", "main.js");
  const workerPath = process.env.BIGQUERY_MCP_NODE_WORKER ?? defaultWorker;
  return {
    kind: "node",
    command: process.execPath,
    args: [workerPath],
    env,
  };
}

export class WorkerBroker {
  private config: Config;
  private worker: WorkerProcess | null = null;
  private selected: WorkerKind | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  get kind(): WorkerKind | null {
    return this.selected;
  }

  /** Resolve, spawn and health-check the worker. Returns the selected kind. */
  async start(): Promise<WorkerKind> {
    if (this.worker && this.worker.alive && this.selected) return this.selected;

    const forced = this.config.worker;
    if (forced === "node") {
      await this.spawnAndCheck(nodeSpawnSpec(this.config), /* required */ true);
      return this.selected as WorkerKind;
    }
    if (forced === "python") {
      await this.spawnAndCheck(pythonSpawnSpec(this.config), /* required */ true);
      return this.selected as WorkerKind;
    }

    // Auto: prefer Python, fall back to Node.
    const python = await this.trySpawn(pythonSpawnSpec(this.config));
    if (python) {
      this.worker = python;
      this.selected = "python";
      return "python";
    }
    process.stderr.write("[broker] Python worker unavailable; falling back to Node worker.\n");
    await this.spawnAndCheck(nodeSpawnSpec(this.config), /* required */ true);
    return this.selected as WorkerKind;
  }

  private async trySpawn(spec: SpawnSpec): Promise<WorkerProcess | null> {
    let proc: WorkerProcess;
    try {
      proc = new WorkerProcess(spec);
    } catch {
      return null;
    }
    const healthy = await proc.health();
    if (!healthy) {
      proc.stop();
      return null;
    }
    return proc;
  }

  private async spawnAndCheck(spec: SpawnSpec, required: boolean): Promise<void> {
    const proc = await this.trySpawn(spec);
    if (!proc) {
      if (required) {
        throw new Error(
          `Failed to start the ${spec.kind} worker (health check failed). ` +
            `Check that its runtime and credentials are available.`,
        );
      }
      return;
    }
    this.worker = proc;
    this.selected = spec.kind;
  }

  /** Forward a contract request to the active worker, restarting if it died. */
  async request<O extends WorkerOp>(
    op: O,
    params: OpParams[O],
    timeoutMs?: number,
  ): Promise<WorkerResponse> {
    if (!this.worker || !this.worker.alive) {
      this.worker = null;
      this.selected = null;
      await this.start();
    }
    return this.worker!.request(op, params, timeoutMs);
  }

  stop(): void {
    this.worker?.stop();
    this.worker = null;
    this.selected = null;
  }
}
