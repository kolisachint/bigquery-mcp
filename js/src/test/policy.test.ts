import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEstimatedBytes } from "../policy/costPolicy.js";
import { isQuerySafe } from "../policy/sqlSafety.js";

test("allows simple SELECT", () => {
  assert.equal(isQuerySafe("SELECT * FROM t").safe, true);
});

test("allows WITH (CTE)", () => {
  assert.equal(isQuerySafe("WITH a AS (SELECT 1) SELECT * FROM a").safe, true);
});

test("rejects empty query", () => {
  assert.equal(isQuerySafe("   ").safe, false);
});

test("rejects DROP", () => {
  const r = isQuerySafe("DROP TABLE users");
  assert.equal(r.safe, false);
  assert.match(r.error, /DROP/);
});

test("rejects dangerous keyword hidden after SELECT", () => {
  assert.equal(isQuerySafe("SELECT 1; DELETE FROM t").safe, false);
});

test("strips comments before validation", () => {
  // The dangerous keyword lives only in a comment, so it is safe.
  assert.equal(isQuerySafe("SELECT * FROM t -- DROP TABLE users").safe, true);
});

test("rejects multiple statements", () => {
  assert.equal(isQuerySafe("SELECT 1; SELECT 2").safe, false);
});

test("allows a single trailing semicolon", () => {
  assert.equal(isQuerySafe("SELECT 1;").safe, true);
});

test("cost policy rejects over-budget estimate", () => {
  const d = checkEstimatedBytes(2_000, 1_000);
  assert.equal(d.allowed, false);
  assert.match(d.message ?? "", /exceeds the configured/);
});

test("cost policy allows under-budget estimate", () => {
  assert.equal(checkEstimatedBytes(500, 1_000).allowed, true);
});

test("cost policy defers when estimate is unknown", () => {
  assert.equal(checkEstimatedBytes(Number.NaN, 1_000).allowed, true);
});
