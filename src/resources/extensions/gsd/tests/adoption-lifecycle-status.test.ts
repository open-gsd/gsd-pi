// Project/App: gsd-pi
// File Purpose: Proves legacy rows are adopted through one mapping that never yields in_progress.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
  adoptionLifecycleStatus,
  normalizeLegacyLifecycleStatus,
} from "../status-guards.ts";
import { handlePlanTask } from "../tools/plan-task.ts";
import { handleReplanTask } from "../tools/replan-task.ts";

test("adoptionLifecycleStatus maps each legacy status to one canonical adoption status", () => {
  const expected: ReadonlyArray<readonly [legacy: string | null, adopted: string]> = [
    ["pending", "ready"],
    ["queued", "ready"],
    ["planned", "ready"],
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
    ["not-a-status", "ready"],
    [null, "ready"],
  ];
  for (const [legacy, adopted] of expected) {
    assert.equal(adoptionLifecycleStatus(legacy), adopted, `legacy ${legacy}`);
  }
});

test("a sketch Slice adopts as pending while it is open, and keeps a terminal status", () => {
  assert.equal(adoptionLifecycleStatus("active", "pending"), "pending");
  assert.equal(adoptionLifecycleStatus("pending", "pending"), "pending");
  assert.equal(adoptionLifecycleStatus("complete", "pending"), "completed");
  assert.equal(adoptionLifecycleStatus("skipped", "pending"), "cancelled");
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
