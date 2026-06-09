/**
 * Configuration loading for the BigQuery MCP server.
 *
 * Priority: CLI args > environment variables > defaults. Defaults mirror the
 * Python server so behaviour is identical across the two implementations.
 */

export interface Config {
  projectId: string;
  location: string;
  keyFile?: string;
  allowedDatasets?: string[];

  listMaxResults: number;
  listMaxResultsDetailed: number;
  sampleRows: number;
  sampleRowsForStats: number;
  maxRecommendedResults: number;
  maxBytesBilled: number;
}

export const DEFAULTS = {
  listMaxResults: 500,
  listMaxResultsDetailed: 25,
  sampleRows: 3,
  sampleRowsForStats: 500,
  maxRecommendedResults: 1000,
  // ~0.50 USD/query at 5 USD per TiB scanned.
  maxBytesBilled: 109_951_162_777,
};

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
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
}

export function loadConfig(overrides: CliOverrides = {}): Config {
  const projectId = overrides.projectId ?? process.env.GCP_PROJECT_ID ?? "";
  const location = overrides.location ?? process.env.BIGQUERY_LOCATION ?? "";

  return {
    projectId,
    location,
    keyFile: overrides.keyFile ?? process.env.GOOGLE_APPLICATION_CREDENTIALS,
    allowedDatasets: overrides.allowedDatasets ?? listEnv("BIGQUERY_ALLOWED_DATASETS"),

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
  };
}
