/**
 * Cost policy for query execution.
 *
 * Implements the "dry run first" guard described in the architecture: estimate
 * bytes processed via a dry run, compare against the configured cap, reject if
 * it would exceed the limit, then let the worker execute the real query with
 * `maximumBytesBilled` set as a hard cap.
 */

export interface CostDecision {
  allowed: boolean;
  /** Human-readable explanation, present when not allowed. */
  message?: string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return `${bytes}`;
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 2 : 0)} ${units[unit]}`;
}

/**
 * Decide whether a query whose dry run estimates `estimatedBytes` may run.
 * The cap is the same `maximumBytesBilled` that the worker applies, so a query
 * rejected here is one BigQuery would have failed anyway — we just fail fast
 * with a friendlier message and without creating a billable job.
 */
export function checkEstimatedBytes(estimatedBytes: number, maxBytesBilled: number): CostDecision {
  if (!Number.isFinite(estimatedBytes) || estimatedBytes < 0) {
    // No usable estimate (e.g. some scripts/DDL); defer to the worker's hard cap.
    return { allowed: true };
  }
  if (estimatedBytes > maxBytesBilled) {
    return {
      allowed: false,
      message:
        `Query would scan ${formatBytes(estimatedBytes)}, which exceeds the configured ` +
        `limit of ${formatBytes(maxBytesBilled)} (BIGQUERY_MAX_BYTES_BILLED). ` +
        `Add filters or a more selective WHERE/partition clause, or raise the limit.`,
    };
  }
  return { allowed: true };
}
