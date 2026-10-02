// Project/App: gsd-pi
// File Purpose: Proves legacy rows are adopted through one mapping that never yields in_progress.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  upsertTaskPlanning,
} from "../gsd-db.ts";
import { compareLifecycleShadow } from "../db/lifecycle-shadow-comparison.ts";
import { internalPlanningInvocation } from "../planning-invocation.ts";
import {
  RAW_CLOSED_STATUSES,
  UnknownLegacyStatusError,
  adoptionLifecycleStatus,
  normalizeLegacyLifecycleStatus,
} from "../status-guards.ts";
import { handlePlanSlice } from "../tools/plan-slice.ts";
import { handlePlanTask } from "../tools/plan-task.ts";
import { handleReassessRoadmap } from "../tools/reassess-roadmap.ts";
import { handleReplanSlice } from "../tools/replan-slice.ts";
import { handleReplanTask } from "../tools/replan-task.ts";

test("an adopted legacy row keeps its meaning, except that in-flight adopts as ready", () => {
  const expected: ReadonlyArray<readonly [legacy: string, adopted: string]> = [
    ["pending", "pending"],
    ["queued", "pending"],
    ["planned", "pending"],
    ["active", "ready"],
    ["in_progress", "ready"],
    ["in-progress", "ready"],
    ["blocked", "paused"],
    ["parked", "paused"],
    ["complete", "completed"],
    ["done", "completed"],
    ["closed", "completed"],
    ["skipped", "cancelled"],
    ["deferred", "cancelled"],
    ["cancelled", "cancelled"],
    ["blocker-accepted", "blocker-accepted"],
  ];
  for (const [legacy, adopted] of expected) {
    assert.equal(adoptionLifecycleStatus("task M001/S01/T01", legacy), adopted, `legacy ${legacy}`);
  }
});

test("a seam that plans the row adopts every open status as its open status", () => {
  for (const legacy of ["pending", "queued", "planned", "active", "in_progress", "blocked", "parked"]) {
    assert.equal(adoptionLifecycleStatus("slice M001/S01", legacy, "ready"), "ready", `legacy ${legacy}`);
    assert.equal(adoptionLifecycleStatus("slice M001/S01", legacy, "pending"), "pending", `sketch ${legacy}`);
  }
  assert.equal(adoptionLifecycleStatus("slice M001/S01", "complete", "pending"), "completed");
  assert.equal(adoptionLifecycleStatus("slice M001/S01", "skipped", "ready"), "cancelled");
});

test("an unknown or null legacy status refuses and names the row and the raw value", () => {
  for (const openStatus of [undefined, "ready"] as const) {
    for (const raw of ["not-a-status", null]) {
      assert.throws(
        () => adoptionLifecycleStatus("task M001/S01/T01", raw, openStatus),
        (err: unknown) => {
          assert.ok(err instanceof UnknownLegacyStatusError);
          assert.equal(err.row, "task M001/S01/T01");
          assert.equal(err.rawStatus, raw);
          assert.match(err.message, /task M001\/S01\/T01/);
          return true;
        },
      );
    }
  }
});

test("every raw closed status has a terminal canonical status", () => {
  for (const status of RAW_CLOSED_STATUSES) {
    const normalized = normalizeLegacyLifecycleStatus(status);
    assert.ok(
      normalized === "completed" || normalized === "cancelled" || normalized === "blocker-accepted",
      `${status} normalizes to ${normalized}`,
    );
  }
});

test("a legacy cancelled row matches a canonical cancelled lifecycle", () => {
  assert.equal(compareLifecycleShadow("cancelled", "cancelled").kind, "match");
  assert.equal(compareLifecycleShadow("cancelled", "completed").kind, "status_mismatch");
});

function lifecycleStatuses(): Array<{ item_kind: string; lifecycle_status: string }> {
  return _getAdapter()!
    .prepare("SELECT item_kind, lifecycle_status FROM workflow_item_lifecycles ORDER BY item_kind")
    .all() as Array<{ item_kind: string; lifecycle_status: string }>;
}

function runningAttemptCount(): number {
  const row = _getAdapter()!
    .prepare("SELECT COUNT(*) AS count FROM workflow_execution_attempts")
    .get() as { count: number };
  return Number(row.count);
}

function seedLegacyInFlightHierarchy(t: { after(fn: () => void): void }): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-adoption-status-"));
  mkdirSync(join(base, ".gsd", "phases", "01-test"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  // Legacy-only rows that claim in-flight work. No Attempt exists for them.
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "in_progress", demo: "Demo." });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "active" });
  upsertTaskPlanning("M001", "S01", "T01", {
    description: "Original task description.",
    estimate: "30m",
    files: ["src/original.ts"],
    verify: "node --test original.test.ts",
    inputs: ["src/original.ts"],
    expectedOutput: ["src/original.ts"],
  });
  return base;
}

function assertNoInProgressWithoutAttempt(): void {
  const rows = lifecycleStatuses();
  assert.ok(rows.length > 0, "the seam adopted lifecycle rows");
  assert.equal(runningAttemptCount(), 0, "fixture has no Attempt");
  assert.deepEqual(
    rows.filter((row) => row.lifecycle_status === "in_progress"),
    [],
    "no lifecycle is in_progress without an Attempt",
  );
}

test("replan-task adopts legacy in-flight rows as ready, never in_progress", async (t) => {
  const base = seedLegacyInFlightHierarchy(t);

  const result = await handleReplanTask({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    title: "Replanned Task",
    description: "Updated task description with blocking rework scope.",
    estimate: "45m",
    files: ["src/replanned.ts"],
    verify: "node --test replanned.test.ts",
    inputs: ["src/original.ts"],
    expectedOutput: ["src/replanned.ts"],
    requiredWorkflowTools: [],
    reworkBriefRef: "RB-001",
  }, base, internalPlanningInvocation());

  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  assertNoInProgressWithoutAttempt();
  assert.deepEqual(lifecycleStatuses(), [
    { item_kind: "slice", lifecycle_status: "ready" },
    { item_kind: "task", lifecycle_status: "ready" },
  ]);
});

test("plan-task adopts legacy in-flight rows as ready, never in_progress", async (t) => {
  const base = seedLegacyInFlightHierarchy(t);

  const result = await handlePlanTask({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    title: "Planned Task",
    description: "Task description for the adoption seam.",
    estimate: "45m",
    files: ["src/planned.ts"],
    verify: "node --test planned.test.ts",
    inputs: ["src/original.ts"],
    expectedOutput: ["src/planned.ts"],
  }, base, internalPlanningInvocation());

  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  assertNoInProgressWithoutAttempt();
});

test("replan-slice adopts a legacy in-flight slice and task as ready, never in_progress", async (t) => {
  const base = seedLegacyInFlightHierarchy(t);
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Blocker", status: "complete" });

  const result = await handleReplanSlice({
    milestoneId: "M001",
    sliceId: "S01",
    blockerTaskId: "T02",
    blockerDescription: "T02 discovered a blocker.",
    whatChanged: "Updated T01 for the new scope.",
    updatedTasks: [{
      taskId: "T01",
      title: "Replanned Task",
      description: "Revised description for T01.",
      estimate: "1h",
      files: ["src/replanned.ts"],
      verify: "node --test replanned.test.ts",
      inputs: ["src/original.ts"],
      expectedOutput: ["src/replanned.ts"],
      requiredWorkflowTools: [],
    }],
    removedTaskIds: [],
  }, base, internalPlanningInvocation());

  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  assertNoInProgressWithoutAttempt();
});

test("reassess-roadmap adopts a legacy in-flight milestone and slice as ready, never in_progress", async (t) => {
  const base = seedLegacyInFlightHierarchy(t);
  insertSlice({ id: "S00", milestoneId: "M001", title: "Finished Slice", status: "complete", demo: "Demo." });

  const result = await handleReassessRoadmap({
    milestoneId: "M001",
    completedSliceId: "S00",
    verdict: "confirmed",
    assessment: "S00 completed. S01 needs a wider scope.",
    sliceChanges: {
      modified: [{ sliceId: "S01", title: "Updated Slice", risk: "high", depends: ["S00"], demo: "Updated demo." }],
      added: [],
      removed: [],
    },
  }, base, internalPlanningInvocation());

  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  assertNoInProgressWithoutAttempt();
});

test("plan-slice adopts an existing legacy in-flight task as ready, never in_progress", async (t) => {
  const base = seedLegacyInFlightHierarchy(t);
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(join(base, "src", "original.ts"), "// fixture\n", "utf-8");

  const result = await handlePlanSlice({
    milestoneId: "M001",
    sliceId: "S01",
    goal: "Re-plan a slice that has a legacy in-flight task.",
    successCriteria: "- The task is planned again",
    proofLevel: "integration",
    integrationClosure: "Planning handlers write DB rows.",
    observabilityImpact: "- None",
    tasks: [{
      taskId: "T01",
      title: "Planned Task",
      description: "Task description for the adoption seam.",
      estimate: "45m",
      files: ["src/planned.ts"],
      verify: "node --test planned.test.ts",
      inputs: ["src/original.ts"],
      expectedOutput: ["src/planned.ts"],
      requiredWorkflowTools: [],
      observabilityImpact: "None.",
    }],
  }, base, internalPlanningInvocation());

  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  assertNoInProgressWithoutAttempt();
});

test("replan-task refuses a legacy task with an unknown status and writes no lifecycle row", async (t) => {
  const base = seedLegacyInFlightHierarchy(t);
  _getAdapter()!.prepare("UPDATE tasks SET status = 'wip' WHERE id = 'T01'").run();

  const result = await handleReplanTask({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    title: "Replanned Task",
    description: "Updated task description with blocking rework scope.",
    estimate: "45m",
    files: ["src/replanned.ts"],
    verify: "node --test replanned.test.ts",
    inputs: ["src/original.ts"],
    expectedOutput: ["src/replanned.ts"],
    requiredWorkflowTools: [],
    reworkBriefRef: "RB-001",
  }, base, internalPlanningInvocation());

  assert.ok("error" in result, "the seam refuses");
  assert.equal(result.error, 'cannot adopt task M001/S01/T01: unknown legacy status "wip"');
  assert.deepEqual(lifecycleStatuses(), [], "no lifecycle row is written");
});

test("replan-task keeps a legacy pending slice and task as pending", async (t) => {
  const base = seedLegacyInFlightHierarchy(t);
  _getAdapter()!.prepare("UPDATE slices SET status = 'pending'").run();
  _getAdapter()!.prepare("UPDATE tasks SET status = 'pending'").run();

  const result = await handleReplanTask({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    title: "Replanned Task",
    description: "Updated task description with blocking rework scope.",
    estimate: "45m",
    files: ["src/replanned.ts"],
    verify: "node --test replanned.test.ts",
    inputs: ["src/original.ts"],
    expectedOutput: ["src/replanned.ts"],
    requiredWorkflowTools: [],
    reworkBriefRef: "RB-001",
  }, base, internalPlanningInvocation());

  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  assert.deepEqual(lifecycleStatuses(), [
    { item_kind: "slice", lifecycle_status: "pending" },
    { item_kind: "task", lifecycle_status: "pending" },
  ]);
});
