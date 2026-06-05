/**
 * Configuration loading for the MCP control plane.
 *
 * Priority: CLI args > environment variables > defaults. Defaults mirror the
 * Python implementation so behaviour is identical regardless of worker.
 */

export interface Config {
  projectId: string;
  location: string;
  keyFile?: string;
  allowedDatasets?: string[];
  /** Forced worker selection, if any. */
  worker?: "python" | "node";

  listMaxResults: number;
  listMaxResultsDetailed: number;
  sampleRows: number;
  sampleRowsForStats: number;
  maxRecommendedResults: number;
  maxBytesBilled: number;

  vectorSearchEnabled: boolean;
  embeddingModel?: string;
  embeddingColumnContains: string;
  embeddingTables?: string[];
  distanceType: "COSINE" | "EUCLIDEAN" | "DOT_PRODUCT";
}

export const DEFAULTS = {
  listMaxResults: 500,
  listMaxResultsDetailed: 25,
  sampleRows: 3,
  sampleRowsForStats: 500,
  maxRecommendedResults: 1000,
  // ~0.50 USD/query at 5 USD per TiB scanned.
  maxBytesBilled: 109_951_162_777,
  embeddingColumnContains: "embedding",
  distanceType: "COSINE" as const,
};

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["true", "1", "yes", "on"].includes(raw.toLowerCase());
}

function listEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export interface CliOverrides {
  projectId?: string;
  location?: string;
  keyFile?: string;
  allowedDatasets?: string[];
  worker?: "python" | "node";
}

export function loadConfig(overrides: CliOverrides = {}): Config {
  const projectId = overrides.projectId ?? process.env.GCP_PROJECT_ID ?? "";
  const location = overrides.location ?? process.env.BIGQUERY_LOCATION ?? "";

  const distanceRaw = (process.env.BIGQUERY_DISTANCE_TYPE ?? DEFAULTS.distanceType).toUpperCase();
  const distanceType = (["COSINE", "EUCLIDEAN", "DOT_PRODUCT"].includes(distanceRaw)
    ? distanceRaw
    : DEFAULTS.distanceType) as Config["distanceType"];

  const workerEnv = process.env.BIGQUERY_MCP_WORKER?.toLowerCase();
  const worker =
    overrides.worker ??
    (workerEnv === "python" || workerEnv === "node" ? workerEnv : undefined);

  return {
    projectId,
    location,
    keyFile: overrides.keyFile ?? process.env.GOOGLE_APPLICATION_CREDENTIALS,
    allowedDatasets: overrides.allowedDatasets ?? listEnv("BIGQUERY_ALLOWED_DATASETS"),
    worker,

    listMaxResults: intEnv("BIGQUERY_LIST_MAX_RESULTS", DEFAULTS.listMaxResults),
    listMaxResultsDetailed: intEnv(
      "BIGQUERY_LIST_MAX_RESULTS_DETAILED",
      DEFAULTS.listMaxResultsDetailed,
    ),
    sampleRows: intEnv("BIGQUERY_SAMPLE_ROWS", DEFAULTS.sampleRows),
    sampleRowsForStats: intEnv("BIGQUERY_SAMPLE_ROWS_FOR_STATS", DEFAULTS.sampleRowsForStats),
    maxRecommendedResults: intEnv(
      "BIGQUERY_MAX_RECOMMENDED_RESULTS",
      DEFAULTS.maxRecommendedResults,
    ),
    maxBytesBilled: intEnv("BIGQUERY_MAX_BYTES_BILLED", DEFAULTS.maxBytesBilled),

    vectorSearchEnabled: boolEnv("BIGQUERY_VECTOR_SEARCH_ENABLED", true),
    embeddingModel: process.env.BIGQUERY_EMBEDDING_MODEL,
    embeddingColumnContains:
      process.env.BIGQUERY_EMBEDDING_COLUMN_CONTAINS ?? DEFAULTS.embeddingColumnContains,
    embeddingTables: listEnv("BIGQUERY_EMBEDDING_TABLES"),
    distanceType,
  };
}

/**
 * Build the environment a worker subprocess should inherit. We forward the
 * resolved configuration as the same env vars the Python/Node workers read,
 * so CLI overrides reliably reach whichever worker is spawned.
 */
export function workerEnv(config: Config): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.GCP_PROJECT_ID = config.projectId;
  env.BIGQUERY_LOCATION = config.location;
  if (config.keyFile) env.GOOGLE_APPLICATION_CREDENTIALS = config.keyFile;
  if (config.allowedDatasets) env.BIGQUERY_ALLOWED_DATASETS = config.allowedDatasets.join(",");
  env.BIGQUERY_LIST_MAX_RESULTS = String(config.listMaxResults);
  env.BIGQUERY_LIST_MAX_RESULTS_DETAILED = String(config.listMaxResultsDetailed);
  env.BIGQUERY_SAMPLE_ROWS = String(config.sampleRows);
  env.BIGQUERY_SAMPLE_ROWS_FOR_STATS = String(config.sampleRowsForStats);
  env.BIGQUERY_MAX_RECOMMENDED_RESULTS = String(config.maxRecommendedResults);
  env.BIGQUERY_MAX_BYTES_BILLED = String(config.maxBytesBilled);
  env.BIGQUERY_VECTOR_SEARCH_ENABLED = String(config.vectorSearchEnabled);
  if (config.embeddingModel) env.BIGQUERY_EMBEDDING_MODEL = config.embeddingModel;
  env.BIGQUERY_EMBEDDING_COLUMN_CONTAINS = config.embeddingColumnContains;
  if (config.embeddingTables) env.BIGQUERY_EMBEDDING_TABLES = config.embeddingTables.join(",");
  env.BIGQUERY_DISTANCE_TYPE = config.distanceType;
  return env;
}
