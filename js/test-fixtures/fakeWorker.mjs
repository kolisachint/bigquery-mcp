#!/usr/bin/env node
// Minimal contract-compliant worker used in tests. No BigQuery involved.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, op } = req;
  switch (op) {
    case "health":
      return out({ id, ok: true, data: { worker: process.env.FAKE_KIND ?? "fake" } });
    case "dry_run_query":
      return out({
        id,
        ok: true,
        data: { total_bytes_processed: 5 },
        meta: { total_bytes_processed: 5, max_bytes_billed: 100 },
      });
    case "run_query":
      return out({ id, ok: true, data: [{ n: 1 }], meta: { total_count: 1 } });
    default:
      return out({ id, ok: false, error: `unknown op ${op}`, code: "BadRequest" });
  }
});

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
