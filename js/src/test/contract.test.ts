import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { mock, test } from "bun:test";
import { loadConfig } from "../config.js";
import { getTool, tools } from "../contract.js";
import { handlers } from "../tools/handlers.js";

// ---- a minimal in-memory @google-cloud/bigquery stand-in --------------------

const tableMeta = {
  type: "TABLE",
  description: "a table",
  numRows: "100",
  numBytes: "5000",
  creationTime: "1700000000000",
  lastModifiedTime: "1700000000000",
  schema: {
    fields: [
      { name: "id", type: "INTEGER", mode: "NULLABLE", description: null },
      { name: "ts", type: "TIMESTAMP", mode: "NULLABLE", description: null },
    ],
  },
  tableConstraints: null,
};

function fakeTable() {
  return { getMetadata: async () => [tableMeta] };
}
function fakeDataset() {
  return {
    getMetadata: async () => [{ description: "a dataset", location: "US" }],
    getTables: async () => [[{ id: "t1", getMetadata: async () => [tableMeta] }]],
    table: () => fakeTable(),
  };
}

class FakeBigQuery {
  async getDatasets() {
    return [[{ id: "ds1", getMetadata: async () => [{ description: "d" }], getTables: async () => [[{ id: "t1" }]] }]];
  }
  dataset() {
    return fakeDataset();
  }
  async createQueryJob() {
    const job = {
      metadata: { statistics: { totalBytesProcessed: "1234" } },
      getQueryResults: async () => [
        [{ total_rows: 100, id_non_null: 100, ts_non_null: 90, id: 1, name: "x" }],
      ],
    };
    return [job];
  }
}

mock.module("@google-cloud/bigquery", () => ({ BigQuery: FakeBigQuery }));
const { BigQueryService } = await import("../bigquery.js");

// ---- helpers ----------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });

function makeService() {
  const base = loadConfig({ projectId: "p", location: "US" });
  return new BigQueryService({
    ...base,
    embeddingModel: "p.ds.model",
    embeddingTables: ["ds.products"],
  });
}

function envelope(out: { data: unknown; meta?: Record<string, unknown> }) {
  return { success: true, data: out.data, ...(out.meta ?? {}) };
}

function validateOutput(toolName: string, payload: unknown) {
  const schema = getTool(toolName).output;
  const validate = ajv.compile(schema);
  const ok = validate(payload);
  assert.ok(ok, `${toolName} output failed contract: ${JSON.stringify(validate.errors)}`);
}

// ---- tests ------------------------------------------------------------------

test("every contract tool has a handler and vice versa", () => {
  const contractNames = new Set(tools.map((t) => t.name));
  const handlerNames = new Set(Object.keys(handlers));
  assert.deepEqual([...contractNames].sort(), [...handlerNames].sort());
});

test("input shapes build for every tool", async () => {
  const { buildInputShape } = await import("../contract.js");
  for (const spec of tools) {
    const shape = buildInputShape(spec);
    assert.ok(Object.keys(shape).length === Object.keys(spec.input.properties ?? {}).length);
  }
});

test("execute_sql output matches contract", async () => {
  const out = await makeService().runQuery({ query: "SELECT 1" });
  validateOutput("execute_sql", envelope(out));
});

test("dry_run_query output matches contract", async () => {
  const out = await makeService().dryRunQuery({ query: "SELECT 1" });
  validateOutput("dry_run_query", envelope(out));
});

test("list_dataset_ids output matches contract (basic + detailed)", async () => {
  const s = makeService();
  validateOutput("list_dataset_ids", envelope(await s.listDatasets({})));
  validateOutput("list_dataset_ids", envelope(await s.listDatasets({ detailed: true })));
});

test("get_dataset_info output matches contract", async () => {
  const out = await makeService().getDatasetInfo({ dataset_id: "ds1" });
  validateOutput("get_dataset_info", envelope(out));
});

test("list_table_ids output matches contract (basic + detailed)", async () => {
  const s = makeService();
  validateOutput("list_table_ids", envelope(await s.listTables({ dataset_id: "ds1" })));
  validateOutput(
    "list_table_ids",
    envelope(await s.listTables({ dataset_id: "ds1", detailed: true })),
  );
});

test("get_table_info output matches contract", async () => {
  const out = await makeService().getTable({ dataset_id: "ds1", table_id: "t1" });
  validateOutput("get_table_info", envelope(out));
});

test("vector_search discovery output matches contract", async () => {
  const out = await makeService().vectorSearch({});
  validateOutput("vector_search", envelope(out));
});

test("vector_search search output matches contract", async () => {
  const out = await makeService().vectorSearch({ query_text: "hello", table_path: "ds.products" });
  validateOutput("vector_search", envelope(out));
});
