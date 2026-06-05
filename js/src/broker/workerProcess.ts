/**
 * A single long-lived worker subprocess speaking newline-delimited JSON.
 *
 * One request line in, one response line out, correlated by `id`. Stderr from
 * the worker is forwarded to our stderr for visibility (never stdout, which is
 * reserved for the MCP stdio transport / the NDJSON channel).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import {
  type OpParams,
  type WorkerKind,
  type WorkerOp,
  type WorkerResponse,
  isWorkerResponse,
} from "../types/worker.js";

const DEFAULT_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (value: WorkerResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SpawnSpec {
  kind: WorkerKind;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

export class WorkerProcess {
  readonly kind: WorkerKind;
  private child: ChildProcessWithoutNullStreams;
  private rl: readline.Interface;
  private pending = new Map<string, Pending>();
  private exited = false;
  private exitError: Error | null = null;

  constructor(spec: SpawnSpec) {
    this.kind = spec.kind;
    this.child = spawn(spec.command, spec.args, {
      env: spec.env,
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => this.onLine(line));

    this.child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[${this.kind}-worker] ${chunk.toString()}`);
    });

    this.child.on("error", (err) => this.fail(new Error(`worker spawn error: ${err.message}`)));
    this.child.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      this.fail(new Error(`${this.kind} worker exited (${reason})`));
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[${this.kind}-worker] non-JSON output: ${trimmed}\n`);
      return;
    }
    if (!isWorkerResponse(parsed)) {
      process.stderr.write(`[${this.kind}-worker] malformed response: ${trimmed}\n`);
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);
    pending.resolve(parsed);
  }

  private fail(err: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.exitError = err;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  get alive(): boolean {
    return !this.exited;
  }

  request<O extends WorkerOp>(
    op: O,
    params: OpParams[O],
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<WorkerResponse> {
    if (this.exited) {
      return Promise.reject(this.exitError ?? new Error(`${this.kind} worker is not running`));
    }
    const id = randomUUID();
    const payload = `${JSON.stringify({ id, op, params })}\n`;
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker request '${op}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async health(timeoutMs = 10_000): Promise<boolean> {
    try {
      const res = await this.request("health", {}, timeoutMs);
      return res.ok === true;
    } catch {
      return false;
    }
  }

  stop(): void {
    if (this.exited) return;
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      /* ignore */
    }
  }
}
