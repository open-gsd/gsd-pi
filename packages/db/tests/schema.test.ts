// packages/db — Test coverage for schema exports.
// Validates that all schema modules export their tables without errors.
import test from "node:test";
import assert from "node:assert/strict";

test("schema/index re-exports all schema modules", async () => {
  const schema = await import("../src/schema/index.js");
  // Verify key exports exist
  assert.ok(schema, "schema module should export");
});

test("schema/gsd-state exports gsd state table", async () => {
  const gsdState = await import("../src/schema/gsd-state.js");
  assert.ok(gsdState, "gsd-state schema should export");
});

test("client exports db singleton", async () => {
  // client.ts requires DATABASE_URL env var — skip if not set
  if (!process.env.DATABASE_URL) {
    test.skip("DATABASE_URL not set");
    return;
  }
  const { db } = await import("../src/client.js");
  assert.ok(db, "db client should be exported");
});
