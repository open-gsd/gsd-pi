// Project/App: gsd-pi
// File Purpose: keepCompleted reopen unlocks a closed milestone without
// wiping completed task timestamps or SUMMARY projections (#1854).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { _getAdapter, closeDatabase, executeDomainOperation, insertMilestone, insertSlice, insertTask, openDatabase, readDomainOperationFence } from "../gsd-db.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import { clearPathCache, targetTaskFile } from "../paths.ts";
import { isClosedStatus } from "../status-guards.ts";
import { handleReopenMilestone } from "../tools/reopen-milestone.ts";
import type { DomainOperationContext } from "../db/domain-operation.ts";

const COMPLETED_AT = "2026-08-06T12:00:00.000Z";
const SUMMARY_BODY = "Completed work from August 6. Do not delete.\n";

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function adoptTerminalMilestoneFixture(): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.fixture.adopt-terminal-milestone",
    idempotencyKey: "test/fixture/adopt-terminal/M001",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId: "M001" },
  }, (context: Readonly<DomainOperationContext>) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed" });
    adoptOrTransitionLifecycle(context, { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed" });
    adoptOrTransitionLifecycle(context, { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "completed" });
    return {
      events: [{ eventType: "test.fixture.adopted", entityType: "milestone", entityId: "M001", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/adopted-terminal/m001", projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

function seedClosedAdoptedMilestone(): { base: string; summaryPath: string } {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-reopen-keep-completed-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Partial reopen", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Finished slice", status: "complete" });
  insertTask({
    id: "T01",
    milestoneId: "M001",
    sliceId: "S01",
    title: "Finished task",
    status: "complete",
    fullSummaryMd: SUMMARY_BODY,
  });
  db().exec(`
    UPDATE milestones SET completed_at = '${COMPLETED_AT}' WHERE id = 'M001';
    UPDATE slices SET completed_at = '${COMPLETED_AT}' WHERE milestone_id = 'M001' AND id = 'S01';
    UPDATE tasks SET completed_at = '${COMPLETED_AT}' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01';
  `);
  adoptTerminalMilestoneFixture();
  const summaryPath = targetTaskFile(base, "M001", "S01", "T01", "SUMMARY", "Partial reopen");
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, SUMMARY_BODY);
  return { base, summaryPath };
}

function cleanup(base: string): void {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

test("keepCompleted handler preserves task completed_at and SUMMARY files", async (t) => {
  const { base, summaryPath } = seedClosedAdoptedMilestone();
  t.after(() => cleanup(base));

  const result = await handleReopenMilestone({
    milestoneId: "M001",
    reason: "Add one more slice without discarding finished work.",
    keepCompleted: true,
  }, base, internalExecutionInvocation("test/reopen-keep-completed/kept"));

  assert.ok(!("error" in result), `reopen failed: ${"error" in result ? result.error : ""}`);
  assert.equal(result.slicesReset, 0);
  assert.equal(result.tasksReset, 0);

  const milestone = db().prepare("SELECT status, completed_at FROM milestones WHERE id = 'M001'").get() as { status: string; completed_at: string | null };
  assert.equal(isClosedStatus(milestone.status), false);
  assert.equal(milestone.completed_at, null);

  const task = db().prepare("SELECT status, completed_at FROM tasks WHERE id = 'T01'").get() as { status: string; completed_at: string | null };
  assert.equal(task.status, "complete");
  assert.equal(task.completed_at, COMPLETED_AT);
  assert.equal(existsSync(summaryPath), true, summaryPath);
  // The SUMMARY projection is the stored summary; completed_at stays on the task row.
  assert.ok(
    readFileSync(summaryPath, "utf8").startsWith(SUMMARY_BODY),
    "SUMMARY keeps the stored summary",
  );
  const reopenOperations = db().prepare(
    "SELECT COUNT(*) AS n FROM workflow_operations WHERE operation_type = 'milestone.reopen'",
  ).get() as { n: number };
  assert.equal(reopenOperations.n, 1, "the reopen commits one milestone.reopen Domain Operation");
});

test("omitted keepCompleted still resets completed tasks and deletes SUMMARYs", async (t) => {
  const { base, summaryPath } = seedClosedAdoptedMilestone();
  t.after(() => cleanup(base));

  const result = await handleReopenMilestone({
    milestoneId: "M001",
    reason: "Full redo remains the default.",
  }, base, internalExecutionInvocation("test/reopen-keep-completed/reset"));

  assert.ok(!("error" in result), `reopen failed: ${"error" in result ? result.error : ""}`);
  assert.equal(result.slicesReset, 1);
  assert.equal(result.tasksReset, 1);

  const task = db().prepare("SELECT status, completed_at FROM tasks WHERE id = 'T01'").get() as { status: string; completed_at: string | null };
  assert.equal(task.status, "pending");
  assert.equal(task.completed_at, null);
  assert.equal(existsSync(summaryPath), false, summaryPath);
});

test("reopen refuses a milestone without a canonical lifecycle row", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-reopen-unadopted-"));
  t.after(() => {
    clearPathCache();
    clearParseCache();
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Legacy import", status: "complete" });

  const result = await handleReopenMilestone({
    milestoneId: "M001",
    reason: "Legacy reopen attempt",
  }, base, internalExecutionInvocation("test/reopen-keep-completed/unadopted"));

  assert.ok("error" in result && result.error, "expected the loud adoption error");
  assert.match(result.error, /no canonical lifecycle row/);
  assert.match(result.error, /\/gsd db adopt/);
});
