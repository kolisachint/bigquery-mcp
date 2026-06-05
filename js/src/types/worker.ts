/**
 * Language-neutral worker contract.
 *
 * The MCP control plane talks to a worker (Python or Node) over stdio using
 * newline-delimited JSON. Every request is a single JSON object on one line,
 * and every response is a single JSON object on one line correlated by `id`.
 *
 * Both the Python worker (`bigquery_mcp.worker`) and the Node worker
 * (`workers/node/main.ts`) implement this exact contract, which is what lets
 * the broker swap them transparently per runtime availability.
 */

export type WorkerOp =
  | "health"
  | "list_datasets"
  | "list_tables"
  | "get_table"
  | "dry_run_query"
  | "run_query"
  | "vector_search";

/** Parameters carried by each op. Field names are snake_case on the wire so
 *  the Python and Node workers can consume them without translation. */
export interface OpParams {
  health: Record<string, never>;
  list_datasets: { search?: string; detailed?: boolean; max_results?: number | null };
  list_tables: {
    dataset_id: string;
    search?: string;
    detailed?: boolean;
    max_results?: number | null;
  };
  get_table: { dataset_id: string; table_id: string };
  dry_run_query: { sql: string };
  run_query: { sql: string };
  vector_search: {
    query_text?: string;
    table_path?: string;
    top_k?: number;
    select_columns?: string;
    embedding_column?: string;
  };
}

export interface WorkerRequest<O extends WorkerOp = WorkerOp> {
  id: string;
  op: O;
  params: OpParams[O];
}

export interface WorkerSuccess {
  id: string;
  ok: true;
  data: unknown;
  meta?: Record<string, unknown>;
}

export interface WorkerError {
  id: string;
  ok: false;
  error: string;
  code?: string;
}

export type WorkerResponse = WorkerSuccess | WorkerError;

export type WorkerKind = "python" | "node";

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.ok === "boolean";
}
