// Project/App: gsd-pi
// File Purpose: Executable contracts closing generic and planning status bypasses for adopted Tasks and Slices.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
  type LifecycleIdentity,
} from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  getSlice,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  projectCanonicalStatusToLegacy,
  updateSliceStatus,
  updateTaskStatus,
} from "../gsd-db.ts";

let basePath = "";

afterEach(() => {
  closeDatabase();
  if (basePath) rmSync(basePath, { recursive: true, force: true });
  basePath = "";
});

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function fixture(): void {
  basePath = mkdtempSync(join(tmpdir(), "gsd-adopted-bypass-"));
  assert.equal(openDatabase(join(basePath, "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "active" });
}

function adopt(identity: LifecycleIdentity, lifecycleStatus: "in_progress" | "completed"): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.adopt",
    idempotencyKey: `adopt/${identity.itemKind}/${identity.sliceId ?? ""}/${identity.taskId ?? ""}/${lifecycleStatus}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {
      itemKind: identity.itemKind,
      milestoneId: identity.milestoneId,
      sliceId: identity.sliceId ?? null,
      taskId: identity.taskId ?? null,
      lifecycleStatus,
    },
  }, (context) => {
    adoptOrTransitionLifecycle(context, { ...identity, lifecycleStatus });
    return {
      events: [{ eventType: "test.adopted", entityType: identity.itemKind, entityId: "fixture", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/adopted", projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

test("generic Task and Slice status writes cannot change adopted lifecycle meaning", () => {
  fixture();
  adopt({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, "in_progress");
  adopt({ itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" }, "in_progress");

  assert.throws(
    () => updateSliceStatus("M001", "S01", "pending"),
    /adopted Slice S01|canonical lifecycle/i,
  );
  assert.throws(
    () => updateTaskStatus("M001", "S01", "T01", "complete"),
    /adopted Task T01|canonical lifecycle/i,
  );
  assert.equal(getSlice("M001", "S01")?.status, "active");
  assert.equal(getTask("M001", "S01", "T01")?.status, "active");
});

test("generic writes reject pre-existing adopted drift without partially repairing it", () => {
  fixture();
  adopt({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, "in_progress");
  adopt({ itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" }, "in_progress");
  db().prepare("UPDATE slices SET status = 'pending' WHERE milestone_id = 'M001' AND id = 'S01'").run();
  db().prepare("UPDATE tasks SET status = 'pending' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'").run();

  assert.throws(() => updateSliceStatus("M001", "S01", "active"), /mismatch/i);
  assert.throws(() => updateTaskStatus("M001", "S01", "T01", "active"), /mismatch/i);
  assert.equal(getSlice("M001", "S01")?.status, "pending");
  assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
});

test("adopted upserts preserve Task and Slice status and completion time while updating metadata", () => {
  fixture();
  adopt({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, "in_progress");
  adopt({ itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" }, "in_progress");
  const completedAt = "2026-07-14T00:00:00.000Z";
  db().prepare("UPDATE slices SET completed_at = :completed_at WHERE milestone_id = 'M001' AND id = 'S01'").run({ ":completed_at": completedAt });
  db().prepare("UPDATE tasks SET completed_at = :completed_at WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'").run({ ":completed_at": completedAt });

  insertSlice({ id: "S01", milestoneId: "M001", title: "Updated slice", status: "pending", risk: "high" });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Updated task",
    status: "pending",
    planning: { description: "Updated description", estimate: "1h", files: [], verify: "test", inputs: [], expectedOutput: [], observabilityImpact: "none" },
  });

  assert.deepEqual(
    db().prepare("SELECT title, status, completed_at, risk FROM slices WHERE milestone_id = 'M001' AND id = 'S01'").get(),
    { title: "Updated slice", status: "active", completed_at: completedAt, risk: "high" },
  );
  assert.deepEqual(
    db().prepare("SELECT title, status, completed_at, description FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'").get(),
    { title: "Updated task", status: "active", completed_at: completedAt, description: "Updated description" },
  );
});

test("same-status completion timestamp repair remains available when adopted state is aligned", () => {
  fixture();
  db().prepare("UPDATE slices SET status = 'complete' WHERE milestone_id = 'M001' AND id = 'S01'").run();
  db().prepare("UPDATE tasks SET status = 'complete' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'").run();
  adopt({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, "completed");
  adopt({ itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" }, "completed");
  const completedAt = "2026-07-14T01:00:00.000Z";

  updateSliceStatus("M001", "S01", "complete", completedAt);
  updateTaskStatus("M001", "S01", "T01", "complete", completedAt);

  assert.equal(getSlice("M001", "S01")?.completed_at, completedAt);
  assert.equal(getTask("M001", "S01", "T01")?.completed_at, completedAt);

  updateSliceStatus("M001", "S01", "complete");
  updateTaskStatus("M001", "S01", "T01", "complete");
  updateSliceStatus("M001", "S01", "complete", "2026-07-14T02:00:00.000Z");
  updateTaskStatus("M001", "S01", "T01", "complete", "2026-07-14T02:00:00.000Z");

  assert.equal(getSlice("M001", "S01")?.completed_at, completedAt);
  assert.equal(getTask("M001", "S01", "T01")?.completed_at, completedAt);
});

test("same-status writes cannot stamp completion time on an adopted in-progress task", () => {
  fixture();
  adopt({ itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" }, "in_progress");

  updateTaskStatus("M001", "S01", "T01", "active", "2026-07-14T01:00:00.000Z");

  assert.equal(getTask("M001", "S01", "T01")?.status, "active");
  assert.equal(getTask("M001", "S01", "T01")?.completed_at, null);
});

test("sanctioned projection requires the active operation to own the canonical transition", () => {
  fixture();
  const identity = { itemKind: "task" as const, milestoneId: "M001", sliceId: "S01", taskId: "T01" };
  adopt(identity, "in_progress");
  const transition = { entity: "task" as const, milestoneId: "M001", sliceId: "S01", taskId: "T01", status: "skipped" };

  assert.throws(
    () => projectCanonicalStatusToLegacy({
      operationId: "not-active",
      projectId: "not-active",
      resultingRevision: 1,
      resultingAuthorityEpoch: 0,
    }, transition),
    /active Domain Operation/i,
  );

  db().prepare(`
    UPDATE tasks SET status = 'pending'
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  const unrelatedFence = readDomainOperationFence();
  assert.throws(() => executeDomainOperation({
    operationType: "test.unrelated-projection",
    idempotencyKey: "unrelated-projection/T01",
    expectedRevision: unrelatedFence.revision,
    expectedAuthorityEpoch: unrelatedFence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T01" },
  }, (context) => {
    projectCanonicalStatusToLegacy(context, { ...transition, status: "active" });
    return {
      events: [{ eventType: "test.unrelated", entityType: "task", entityId: "T01", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/unrelated", projectionKind: "test", rendererVersion: "1" }],
    };
  }), /canonical lifecycle transition from the active Domain Operation/i);

  const fence = readDomainOperationFence();
  const result = executeDomainOperation({
    operationType: "test.cancel-and-project",
    idempotencyKey: "cancel-and-project/T01",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T01" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, { ...identity, lifecycleStatus: "cancelled" });
    projectCanonicalStatusToLegacy(context, transition);
    return {
      events: [{ eventType: "test.cancelled", entityType: "task", entityId: "T01", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/cancelled", projectionKind: "test", rendererVersion: "1" }],
    };
  });

  assert.equal(getTask("M001", "S01", "T01")?.status, "skipped");
  assert.deepEqual(db().prepare(`
    SELECT lifecycle_status, last_operation_id
    FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S01' AND task_id = 'T01'
  `).get(), { lifecycle_status: "cancelled", last_operation_id: result.operationId });
});

test("a lifecycle row from another project does not guard the current project's generic writer", () => {
  fixture();
  db().exec("PRAGMA foreign_keys = OFF");
  db().prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      'other-project-task', 'other-project', 'task', 'M001', 'S01', 'T01',
      'completed', 0, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z',
      'other-operation', 1, 0
    )
  `).run();
  db().exec("PRAGMA foreign_keys = ON");

  updateTaskStatus("M001", "S01", "T01", "pending");
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Updated", status: "complete" });

  assert.equal(getTask("M001", "S01", "T01")?.status, "complete");
  assert.equal(getTask("M001", "S01", "T01")?.title, "Updated");
});
