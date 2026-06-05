/**
 * Direct BigQuery access for the standalone MCP server, using the official
 * @google-cloud/bigquery client. Each method maps to one tool in the shared
 * contract (contract/tools.json) and returns a `{ data, meta }` pair that the
 * tool layer wraps into the response envelope.
 *
 * Behaviour mirrors the Python server (src/bigquery_mcp/bigquery_tools.py); the
 * contract conformance tests keep the two from drifting.
 */

import { BigQuery } from "@google-cloud/bigquery";
import type { Config } from "./config.js";
import { isQuerySafe } from "./policy/sqlSafety.js";

type Json = Record<string, unknown>;

/** Expected, user-facing failures. `code` becomes the response `error_type`. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface OpOutput {
  data: unknown;
  meta?: Json;
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

function calcSearchFetchLimit(maxResults: number, search: string): number {
  if (!search) return maxResults;
  let multiplier: number;
  if (maxResults <= 10) multiplier = 20;
  else if (maxResults <= 50) multiplier = 10;
  else multiplier = 5;
  return Math.min(maxResults * multiplier, 1000);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function tableType(meta: Json | undefined, partitionInfo?: unknown): string {
  const baseType = String(meta?.type ?? "TABLE");
  const isPartitioned = Boolean(meta?.timePartitioning || meta?.rangePartitioning || partitionInfo);
  return isPartitioned && baseType === "TABLE" ? "PARTITIONED_TABLE" : baseType;
}

function extractPartitionDetails(meta: Json | undefined): Json | null {
  const tp = meta?.timePartitioning as Json | undefined;
  if (tp) {
    return {
      type: tp.type ?? null,
      field: tp.field ?? "_PARTITIONTIME",
      requires_filter: tp.requirePartitionFilter ?? null,
    };
  }
  const rp = meta?.rangePartitioning as Json | undefined;
  if (rp) {
    return { type: "RANGE", field: rp.field ?? null };
  }
  return null;
}

export class BigQueryService {
  private bq: BigQuery;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.bq = new BigQuery({
      projectId: config.projectId,
      location: config.location || undefined,
      keyFilename: config.keyFile,
    });
  }

  /** Minimal access check used at startup to validate credentials. */
  async validateAccess(): Promise<void> {
    await this.bq.getDatasets({ maxResults: 1 });
  }

  private listMax(detailed: boolean): number {
    return detailed ? this.config.listMaxResultsDetailed : this.config.listMaxResults;
  }

  private datasetAllowed(datasetId: string): boolean {
    return !this.config.allowedDatasets || this.config.allowedDatasets.includes(datasetId);
  }

  private async runQueryJob(
    sql: string,
    opts: { dryRun?: boolean; params?: Json } = {},
  ): Promise<{ rows: Json[]; totalBytesProcessed: number }> {
    const [job] = await this.bq.createQueryJob({
      query: sql,
      location: this.config.location || undefined,
      dryRun: opts.dryRun ?? false,
      maximumBytesBilled: String(this.config.maxBytesBilled),
      params: opts.params,
    });
    const stats = job.metadata?.statistics ?? {};
    const totalBytesProcessed = num(stats.totalBytesProcessed);
    if (opts.dryRun) return { rows: [], totalBytesProcessed };
    const [rows] = await job.getQueryResults();
    return { rows: rows as Json[], totalBytesProcessed };
  }

  async listDatasets(p: {
    search?: string;
    detailed?: boolean;
    max_results?: number | null;
  }): Promise<OpOutput> {
    const search = p.search ?? "";
    const detailed = p.detailed ?? false;
    const maxResults = p.max_results ?? this.listMax(detailed);
    const fetchLimit = calcSearchFetchLimit(maxResults, search);

    const [datasets] = await this.bq.getDatasets({ maxResults: fetchLimit });
    const totalAvailable = datasets.length;

    let list = datasets;
    if (this.config.allowedDatasets) {
      list = list.filter((d) => this.config.allowedDatasets!.includes(d.id ?? ""));
    }
    if (search) {
      const s = search.toLowerCase();
      list = list.filter((d) => (d.id ?? "").toLowerCase().includes(s));
    }
    const totalMatching = list.length;
    list = list.slice(0, maxResults);
    const returnedCount = list.length;

    const meta: Json = {
      total_available: totalAvailable,
      total_matching: search ? totalMatching : totalAvailable,
      returned_count: returnedCount,
    };

    if (detailed) {
      const detailedList: Json[] = [];
      for (const ds of list) {
        let tableCount = 0;
        try {
          const tables = await withTimeout(ds.getTables({ maxResults: 1000 }), 10_000);
          tableCount = tables[0].length;
        } catch (err) {
          process.stderr.write(
            `Warning: Failed to get table count for dataset ${ds.id}: ${(err as Error).message}\n`,
          );
        }
        const [m] = await ds.getMetadata();
        detailedList.push({
          dataset_id: ds.id,
          description: m?.description ?? null,
          table_count: tableCount,
        });
      }
      detailedList.sort((a, b) => String(a.dataset_id).localeCompare(String(b.dataset_id)));
      return { data: detailedList, meta };
    }

    return { data: list.map((d) => d.id ?? "").sort(), meta };
  }

  async listTables(p: {
    dataset_id: string;
    search?: string;
    detailed?: boolean;
    max_results?: number | null;
  }): Promise<OpOutput> {
    const datasetId = p.dataset_id;
    if (!this.datasetAllowed(datasetId)) {
      throw new ToolError(`Access to dataset '${datasetId}' is not allowed`, "AccessDenied");
    }
    const search = p.search ?? "";
    const detailed = p.detailed ?? false;
    const maxResults = p.max_results ?? this.listMax(detailed);
    const fetchLimit = calcSearchFetchLimit(maxResults, search);

    const dataset = this.bq.dataset(datasetId);
    const [dsMeta] = await dataset.getMetadata();
    const [tables] = await dataset.getTables({ maxResults: fetchLimit });
    const totalAvailable = tables.length;

    let list = tables;
    if (search) {
      const s = search.toLowerCase();
      list = list.filter((t) => (t.id ?? "").toLowerCase().includes(s));
    }
    const totalMatching = list.length;
    list = list.slice(0, maxResults);
    const returnedCount = list.length;

    const datasetContext: Json = {
      dataset_id: datasetId,
      description: dsMeta?.description ?? null,
      location: dsMeta?.location ?? null,
      total_table_count: totalAvailable,
    };
    const meta: Json = {
      total_available: totalAvailable,
      total_matching: search ? totalMatching : totalAvailable,
      returned_count: returnedCount,
      dataset_context: datasetContext,
    };

    if (detailed) {
      const detailedList: Json[] = [];
      for (const t of list) {
        const [m] = await t.getMetadata();
        detailedList.push({
          table_id: t.id,
          type: tableType(m),
          description: m?.description ?? null,
          row_count: m?.numRows ? num(m.numRows) : null,
          size_bytes: m?.numBytes ? num(m.numBytes) : null,
        });
      }
      detailedList.sort((a, b) => String(a.table_id).localeCompare(String(b.table_id)));
      return { data: detailedList, meta };
    }

    return { data: list.map((t) => t.id ?? "").sort(), meta };
  }

  async getTable(p: { dataset_id: string; table_id: string }): Promise<OpOutput> {
    const { dataset_id: datasetId, table_id: tableId } = p;
    if (!this.datasetAllowed(datasetId)) {
      throw new ToolError(`Access to dataset '${datasetId}' is not allowed`, "AccessDenied");
    }
    const table = this.bq.dataset(datasetId).table(tableId);
    const [meta] = await table.getMetadata();
    const tablePath = `${datasetId}.${tableId}`;
    const fields = (meta?.schema?.fields ?? []) as Json[];

    const partitionDetails = extractPartitionDetails(meta);
    const primaryKeys = meta?.tableConstraints?.primaryKey?.columns ?? null;

    const sampleSize = this.config.sampleRowsForStats;
    const fillRates = await this.calcFillRates(tablePath, fields, sampleSize);

    let sampleData: Json[] = [];
    try {
      const tsCols = fields
        .filter((f) => ["TIMESTAMP", "DATETIME", "DATE"].includes(String(f.type)))
        .map((f) => String(f.name));
      const orderClause = tsCols.length > 0 ? `ORDER BY \`${tsCols[0]}\` DESC` : "";
      const sampleQuery = `SELECT * FROM \`${tablePath}\` ${orderClause} LIMIT ${this.config.sampleRows}`;
      const { rows } = await this.runQueryJob(sampleQuery);
      sampleData = rows;
    } catch {
      sampleData = [];
    }

    const schemaWithStats = fields.map((f) => ({
      name: f.name,
      type: f.type,
      mode: f.mode ?? null,
      description: f.description ?? null,
      fill_rate_percent: fillRates[String(f.name)] ?? 0.0,
    }));

    return {
      data: {
        table_path: tablePath,
        type: tableType(meta, partitionDetails),
        description: meta?.description ?? null,
        total_row_count: meta?.numRows ? num(meta.numRows) : null,
        size_bytes: meta?.numBytes ? num(meta.numBytes) : null,
        created: meta?.creationTime ? new Date(num(meta.creationTime)).toISOString() : null,
        modified: meta?.lastModifiedTime
          ? new Date(num(meta.lastModifiedTime)).toISOString()
          : null,
        partition_details: partitionDetails,
        primary_key_columns: primaryKeys,
        schema_with_fill_rates: schemaWithStats,
        fill_rate_sample_size: Object.keys(fillRates).length > 0 ? sampleSize : 0,
        sample_data: sampleData,
      },
    };
  }

  private async calcFillRates(
    tablePath: string,
    fields: Json[],
    sampleSize: number,
  ): Promise<Record<string, number>> {
    if (fields.length === 0) return {};
    const checks = fields.map((f) => `COUNTIF(\`${f.name}\` IS NOT NULL) AS \`${f.name}_non_null\``);
    const query = `
    SELECT
        COUNT(*) as total_rows,
        ${checks.join(", ")}
    FROM \`${tablePath}\`
    LIMIT ${sampleSize}
    `;
    try {
      const { rows } = await this.runQueryJob(query);
      if (rows.length === 0) return {};
      const row = rows[0];
      const totalRows = num(row.total_rows);
      if (totalRows === 0) return {};
      const fillRates: Record<string, number> = {};
      for (const f of fields) {
        const nonNull = num(row[`${f.name}_non_null`]);
        fillRates[String(f.name)] = Math.round((nonNull / totalRows) * 1000) / 10;
      }
      return fillRates;
    } catch {
      return {};
    }
  }

  async dryRunQuery(p: { query: string }): Promise<OpOutput> {
    const safety = isQuerySafe(p.query);
    if (!safety.safe) throw new ToolError(safety.error, "UnsafeQuery");
    const { totalBytesProcessed } = await this.runQueryJob(p.query, { dryRun: true });
    return {
      data: { total_bytes_processed: totalBytesProcessed },
      meta: {
        total_bytes_processed: totalBytesProcessed,
        max_bytes_billed: this.config.maxBytesBilled,
      },
    };
  }

  async runQuery(p: { query: string }): Promise<OpOutput> {
    const safety = isQuerySafe(p.query);
    if (!safety.safe) throw new ToolError(safety.error, "UnsafeQuery");
    const { rows, totalBytesProcessed } = await this.runQueryJob(p.query);
    return {
      data: rows,
      meta: {
        total_count: rows.length,
        total_rows_in_result: rows.length,
        bytes_processed: totalBytesProcessed,
        max_bytes_billed: this.config.maxBytesBilled,
      },
    };
  }

  async vectorSearch(p: {
    query_text?: string;
    table_path?: string;
    top_k?: string;
    select_columns?: string;
    embedding_column?: string;
  }): Promise<OpOutput> {
    const queryText = (p.query_text ?? "").trim();
    if (!queryText) return this.discoverEmbeddingTables();

    const tablePath = (p.table_path ?? "").trim();
    if (!tablePath) {
      throw new ToolError(
        "table_path is required for search. Leave query_text empty to discover tables.",
        "ValidationError",
      );
    }
    const model = this.config.embeddingModel;
    if (!model) {
      throw new ToolError(
        "BIGQUERY_EMBEDDING_MODEL environment variable is required for vector search.",
        "ConfigError",
      );
    }
    const topK = Number.parseInt(p.top_k ?? "10", 10);
    if (Number.isNaN(topK)) throw new ToolError(`top_k must be a number, got: '${p.top_k}'`, "ValidationError");
    if (topK < 1 || topK > 1000) throw new ToolError("top_k must be between 1 and 1000", "ValidationError");

    const distanceType = this.config.distanceType;
    const embeddingColumn = (p.embedding_column ?? "embedding").trim() || "embedding";
    const selectColumns = (p.select_columns ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const selectClause =
      selectColumns.length > 0 ? selectColumns.map((c) => `base.\`${c}\``).join(", ") : "base.*";

    const query = `
        WITH query_embedding AS (
            SELECT ml_generate_embedding_result AS embedding
            FROM ML.GENERATE_EMBEDDING(
                MODEL \`${model}\`,
                (SELECT @query_text AS content),
                STRUCT(TRUE AS flatten_json_output)
            )
        )
        SELECT
            ${selectClause},
            ROUND((1 - distance) * 100, 2) AS similarity_pct,
            distance
        FROM VECTOR_SEARCH(
            TABLE \`${tablePath}\`,
            '${embeddingColumn}',
            (SELECT embedding FROM query_embedding),
            top_k => ${topK},
            distance_type => '${distanceType}'
        )
        ORDER BY distance
        `;

    const { rows, totalBytesProcessed } = await this.runQueryJob(query, {
      params: { query_text: queryText },
    });
    const reusableQuery = query.replace("@query_text", `'${queryText}'`).trim();

    return {
      data: rows,
      meta: {
        total_count: rows.length,
        mode: "search",
        query_text: queryText,
        table_path: tablePath,
        embedding_model: model,
        distance_type: distanceType,
        bytes_processed: totalBytesProcessed,
        max_bytes_billed: this.config.maxBytesBilled,
        sql_query: reusableQuery,
      },
    };
  }

  private async discoverEmbeddingTables(): Promise<OpOutput> {
    const pattern = this.config.embeddingColumnContains;

    if (this.config.embeddingTables && this.config.embeddingTables.length > 0) {
      const tables = this.config.embeddingTables
        .map((path): Json | null => {
          const parts = path.split(".");
          if (parts.length !== 2) return null;
          return {
            dataset_id: parts[0],
            table_id: parts[1],
            full_path: path,
            embedding_column_contains: pattern,
          };
        })
        .filter((t): t is Json => t !== null);
      return {
        data: tables,
        meta: { total_count: tables.length, mode: "discovery", source: "BIGQUERY_EMBEDDING_TABLES" },
      };
    }

    const region = this.config.location || "US";
    let query = `
        SELECT table_schema as dataset_id, table_name as table_id, column_name
        FROM \`${this.config.projectId}.region-${region}\`.INFORMATION_SCHEMA.COLUMNS
        WHERE data_type = 'ARRAY<FLOAT64>'
        `;
    if (pattern) query += ` AND LOWER(column_name) LIKE '%${pattern.toLowerCase()}%'`;
    if (this.config.allowedDatasets) {
      query += ` AND table_schema IN ('${this.config.allowedDatasets.join("', '")}')`;
    }
    query += " ORDER BY table_schema, table_name, column_name";

    try {
      const { rows } = await this.runQueryJob(query);
      const tablesDict = new Map<string, Json & { embedding_columns: string[] }>();
      for (const row of rows) {
        const key = `${row.dataset_id}.${row.table_id}`;
        if (!tablesDict.has(key)) {
          tablesDict.set(key, {
            dataset_id: row.dataset_id,
            table_id: row.table_id,
            full_path: key,
            embedding_columns: [],
          });
        }
        tablesDict.get(key)!.embedding_columns.push(String(row.column_name));
      }
      const tables = [...tablesDict.values()];
      return {
        data: tables,
        meta: {
          total_count: tables.length,
          mode: "discovery",
          column_pattern: pattern,
          source: "INFORMATION_SCHEMA",
        },
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("Access Denied") || msg.includes("403")) {
        throw new ToolError(
          "Discovery requires 'BigQuery Metadata Viewer' role on the project, " +
            "or set BIGQUERY_EMBEDDING_TABLES env var to skip discovery. " +
            "Example: BIGQUERY_EMBEDDING_TABLES=dataset.table1,dataset.table2",
          "AccessDenied",
        );
      }
      throw err;
    }
  }
}
