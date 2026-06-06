/**
 * Tool handlers: one entry per contract tool, mapping validated arguments to a
 * BigQueryService call. Adding a tool means adding its contract entry plus an
 * entry here — registration, validation and descriptions come from the contract.
 */

import type { BigQueryService, OpOutput } from "../bigquery.js";

export type ToolArgs = Record<string, unknown>;
export type ToolHandler = (service: BigQueryService, args: ToolArgs) => Promise<OpOutput>;

export const handlers: Record<string, ToolHandler> = {
  execute_sql: (s, a) => s.runQuery({ query: a.query as string }),

  dry_run_query: (s, a) => s.dryRunQuery({ query: a.query as string }),

  list_dataset_ids: (s, a) =>
    s.listDatasets({
      search: a.search as string | undefined,
      detailed: a.detailed as boolean | undefined,
      max_results: (a.max_results ?? null) as number | null,
    }),

  get_dataset_info: (s, a) => s.getDatasetInfo({ dataset_id: a.dataset_id as string }),

  list_table_ids: (s, a) =>
    s.listTables({
      dataset_id: a.dataset_id as string,
      search: a.search as string | undefined,
      detailed: a.detailed as boolean | undefined,
      max_results: (a.max_results ?? null) as number | null,
    }),

  get_table_info: (s, a) =>
    s.getTable({ dataset_id: a.dataset_id as string, table_id: a.table_id as string }),

  vector_search: (s, a) =>
    s.vectorSearch({
      query_text: a.query_text as string | undefined,
      table_path: a.table_path as string | undefined,
      top_k: a.top_k as string | undefined,
      select_columns: a.select_columns as string | undefined,
      embedding_column: a.embedding_column as string | undefined,
    }),
};
