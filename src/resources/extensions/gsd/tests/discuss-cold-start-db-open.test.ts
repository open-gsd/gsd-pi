/**
 * Behavioural regression test for #5837.
 *
 * /gsd discuss and /gsd auto can cold-start with a DB file on disk but no
 * in-process connection yet. State derivation must open that existing DB
 * before it decides whether DB-backed state is available.
 *
 * This test pins that behavioural contract: with a milestone living only in
 * the DB, deriveState() surfaces it even when the process begins with no DB
 * handle open.
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDatabase, closeDatabase, isDbAvailable, insertMilestone } from "../gsd-db.ts";
import { deriveState, invalidateStateCache } from "../state.ts";

afterEach(() => {
  if (isDbAvailable()) closeDatabase();
  invalidateStateCache();
});

describe("discuss cold-start DB ordering (#5837)", () => {
  test("deriveState opens an existing DB before reading a DB-resident milestone", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-discuss-cold-")));
    try {
      mkdirSync(join(base, ".gsd"), { recursive: true });

      // Seed a milestone into the DB, then close it — this is the cold-start
      // state: the DB file exists on disk but nothing is open in-process.
      const dbPath = join(base, ".gsd", "gsd.db");
      assert.equal(openDatabase(dbPath), true);
      insertMilestone({ id: "M001", title: "Cold start milestone", status: "active" });
      closeDatabase();
      invalidateStateCache();

      const coldState = await deriveState(base);
      assert.equal(
        coldState.activeMilestone?.id,
        "M001",
        "cold-start deriveState must open and read the existing workflow DB",
      );
      assert.equal(isDbAvailable(), true, "deriveState must leave the existing DB open for downstream reads");
    } finally {
      if (isDbAvailable()) closeDatabase();
      invalidateStateCache();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
