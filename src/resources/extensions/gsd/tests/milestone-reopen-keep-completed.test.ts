// Project/App: gsd-pi
// File Purpose: keepCompleted reopen unlocks a closed milestone without
// wiping completed task timestamps or SUMMARY projections (#1854).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  getMilestone,
  getSlice,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  reopenMilestoneCascade,
} from "../gsd-db.ts";
import { clearPathCache, targetTaskFile } from "../paths.ts";
import { isClosedStatus } from "../status-guards.ts";
import { handleReopenMilestone } from "../tools/reopen-milestone.ts";

const COMPLETED_AT = "2026-08-06T12:00:00.000Z";
const SUMMARY_BODY = "Completed work from August 6. Do not delete.\n";

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function seedClosedMilestone(): { base: string; summaryPath: string } {
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

test("keepCompleted cascade unlocks the milestone without resetting completed tasks", (t) => {
  const { base } = seedClosedMilestone();
  t.after(() => cleanup(base));

  const outcome = reopenMilestoneCascade("M001", true);
  assert.deepEqual(outcome, { ok: true, slicesReset: 0, tasksReset: 0 });

  const milestone = getMilestone("M001");
  assert.ok(milestone);
  assert.equal(isClosedStatus(milestone.status), false);
  assert.equal(milestone.completed_at, null);

  const task = getTask("M001", "S01", "T01");
  assert.ok(task);
  assert.equal(task.status, "complete");
  assert.equal(task.completed_at, COMPLETED_AT);

  const slice = getSlice("M001", "S01");
  assert.ok(slice);
  assert.equal(slice.status, "complete");
  assert.equal(slice.completed_at, COMPLETED_AT);
});

test("keepCompleted handler preserves task completed_at and SUMMARY files", async (t) => {
  const { base, summaryPath } = seedClosedMilestone();
  t.after(() => cleanup(base));

  const result = await handleReopenMilestone({
    milestoneId: "M001",
    reason: "Add one more slice without discarding finished work.",
    keepCompleted: true,
  }, base);

  assert.ok(!("error" in result), `reopen failed: ${"error" in result ? result.error : ""}`);
  assert.equal(result.slicesReset, 0);
  assert.equal(result.tasksReset, 0);

  const milestone = getMilestone("M001");
  assert.ok(milestone);
  assert.equal(isClosedStatus(milestone.status), false);
  assert.equal(milestone.completed_at, null);

  const task = getTask("M001", "S01", "T01");
  assert.ok(task);
  assert.equal(task.status, "complete");
  assert.equal(task.completed_at, COMPLETED_AT);
  assert.equal(existsSync(summaryPath), true, summaryPath);
  assert.match(readFileSync(summaryPath, "utf8"), new RegExp(COMPLETED_AT));
});

test("omitted keepCompleted still resets completed tasks and deletes SUMMARYs", async (t) => {
  const { base, summaryPath } = seedClosedMilestone();
  t.after(() => cleanup(base));

  const result = await handleReopenMilestone({
    milestoneId: "M001",
    reason: "Full redo remains the default.",
  }, base);

  assert.ok(!("error" in result), `reopen failed: ${"error" in result ? result.error : ""}`);
  assert.equal(result.slicesReset, 1);
  assert.equal(result.tasksReset, 1);

  const task = getTask("M001", "S01", "T01");
  assert.ok(task);
  assert.equal(task.status, "pending");
  assert.equal(task.completed_at, null);
  assert.equal(existsSync(summaryPath), false, summaryPath);
});
