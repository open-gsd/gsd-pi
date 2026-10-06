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

import { openDatabase, executeDomainOperation, closeDatabase, isDbAvailable, insertMilestone, readDomainOperationFence } from "../gsd-db.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import { openWorkflowDatabase } from "../db-workspace.ts";
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

      // Seed the project the way production holds it. The open after the one
      // that created the database adopts the milestone row and advances the
      // Authority Epoch, and the started milestone reaches in_progress through
      // the Domain Operation layer. Then close it — this is the cold-start
      // state: the DB file exists on disk but nothing is open in-process.
      const dbPath = join(base, ".gsd", "gsd.db");
      assert.equal(openDatabase(dbPath), true);
      insertMilestone({ id: "M001", title: "Cold start milestone", status: "active" });
      closeDatabase();
      assert.equal(openWorkflowDatabase(base).ok, true);
      const fence = readDomainOperationFence();
      executeDomainOperation({
        operationType: "test.start-milestone",
        idempotencyKey: "discuss-cold-start/start-milestone",
        expectedRevision: fence.revision,
        expectedAuthorityEpoch: fence.authorityEpoch,
        actorType: "test",
        sourceTransport: "test",
        payload: {},
      }, (context) => {
        adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "in_progress" });
        return {
          events: [{ eventType: "test.milestone-started", entityType: "milestone", entityId: "M001", payload: {}, destinations: ["test"] }],
          projections: [{ projectionKey: "test/start-milestone", projectionKind: "test", rendererVersion: "1" }],
        };
      });
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
