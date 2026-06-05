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

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Walk up from `start` until a directory containing `relativeTarget` is found. */
function findUp(start: string, relativeTarget: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, relativeTarget))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The Python worker package only exists in this monorepo (dev/build), not in a
// standalone npm install. When present, expose its source on PYTHONPATH so
// `-m bigquery_mcp.worker` resolves without an editable install. Resolution is
// layout-agnostic so it works whether we run from bundled `dist/` or `src/`.
const pyAnchor = findUp(moduleDir, path.join("src", "bigquery_mcp", "worker.py"));
const pythonSrc = pyAnchor ? path.join(pyAnchor, "src") : null;

/** Locate the bundled Node worker across bundled-dist / tsc-dist / source layouts. */
export function defaultNodeWorker(): string {
  const candidates = [
    path.resolve(moduleDir, "workers", "node", "main.js"), // bundled: dist/index.js sibling tree
    path.resolve(moduleDir, "..", "workers", "node", "main.js"), // unbundled dist/<dir> layout
    path.resolve(moduleDir, "..", "workers", "node", "main.ts"), // running from src via bun
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

function pythonSpawnSpec(config: Config): SpawnSpec {
  const env = workerEnv(config);
  if (pythonSrc && existsSync(pythonSrc)) {
    env.PYTHONPATH = env.PYTHONPATH ? `${pythonSrc}${path.delimiter}${env.PYTHONPATH}` : pythonSrc;
  }
  const cwd = pyAnchor ?? undefined;
  const custom = process.env.BIGQUERY_MCP_PYTHON_CMD;
  if (custom && custom.trim()) {
    const [command, ...args] = custom.trim().split(/\s+/);
    return { kind: "python", command, args, env, cwd };
  }
  const interpreter = process.env.BIGQUERY_MCP_PYTHON ?? "python3";
  return {
    kind: "python",
    command: interpreter,
    args: ["-m", "bigquery_mcp.worker"],
    env,
    cwd,
  };
}

function nodeSpawnSpec(config: Config): SpawnSpec {
  const env = workerEnv(config);
  const workerPath = process.env.BIGQUERY_MCP_NODE_WORKER ?? defaultNodeWorker();
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
