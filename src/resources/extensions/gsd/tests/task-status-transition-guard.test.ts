// Project/App: gsd-pi
// File Purpose: The generic status writer only updates adopted rows and cannot
// bypass the semantic reopen operations.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
  updateSliceStatus,
  updateTaskStatus,
} from "../gsd-db.ts";
import { applyStatusTransition } from "../db/writers/status.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { DomainOperationContext } from "../db/domain-operation.ts";

// The exported milestone wrapper is gone; the guard contract is the shared
// generic writer itself.
const updateMilestoneStatus = (
  milestoneId: string,
  status: string,
  completedAt?: string | null,
  preserveCompletion?: boolean,
): void => applyStatusTransition({ entity: "milestone", milestoneId, status, completedAt, preserveCompletion });

const tempDirs = new Set<string>();
let fixtureSequence = 0;

function openFixture(): void {
  const dir = mkdtempSync(join(tmpdir(), "gsd-task-status-guard-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Guard", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Guard", status: "active" });
  insertTask({
    id: "T01",
    milestoneId: "M001",
    sliceId: "S01",
    title: "Guarded task",
    status: "pending",
  });
}

interface AdoptedFixtureStatuses {
  milestone: string;
  slice: string;
  task: string;
  canonicalMilestone: "ready" | "completed";
  canonicalSlice: "ready" | "completed";
  canonicalTask: "ready" | "completed";
}

function openAdoptedFixture(statuses: AdoptedFixtureStatuses): void {
  openFixture();
  db().prepare("UPDATE milestones SET status = :status WHERE id = 'M001'").run({ ":status": statuses.milestone });
  db().prepare("UPDATE slices SET status = :status WHERE id = 'S01'").run({ ":status": statuses.slice });
  db().prepare("UPDATE tasks SET status = :status WHERE id = 'T01'").run({ ":status": statuses.task });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.fixture.adopt-status-guard",
    idempotencyKey: `test/fixture/status-guard/adopt/${++fixtureSequence}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId: "M001" },
  }, (context: Readonly<DomainOperationContext>) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: statuses.canonicalMilestone });
    adoptOrTransitionLifecycle(context, { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: statuses.canonicalSlice });
    adoptOrTransitionLifecycle(context, { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: statuses.canonicalTask });
    return {
      events: [{ eventType: "test.fixture.adopted", entityType: "milestone", entityId: "M001", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/adopted/status-guard", projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("generic status writes refuse hierarchy rows without a canonical lifecycle row", () => {
  openFixture();

  assert.throws(
    () => updateTaskStatus("M001", "S01", "T01", "in_progress"),
    (error: Error) => {
      assert.match(error.message, /Task T01 has no canonical lifecycle row/);
      assert.match(error.message, /\/gsd db adopt/);
      return true;
    },
  );
  assert.throws(
    () => updateSliceStatus("M001", "S01", "in_progress"),
    (error: Error) => {
      assert.match(error.message, /Slice S01 has no canonical lifecycle row/);
      assert.match(error.message, /\/gsd db adopt/);
      return true;
    },
  );
  assert.throws(
    () => updateMilestoneStatus("M001", "in_progress"),
    (error: Error) => {
      assert.match(error.message, /Milestone M001 has no canonical lifecycle row/);
      assert.match(error.message, /\/gsd db adopt/);
      return true;
    },
  );

  // A refused write never lands.
  assert.equal(getTask("M001", "S01", "T01")?.status, "pending");
  assert.equal(
    (db().prepare("SELECT status FROM milestones WHERE id = 'M001'").get() as { status: string }).status,
    "active",
  );
});

test("adopted closed rows refuse open transitions through the generic writer", () => {
  openAdoptedFixture({
    milestone: "complete",
    slice: "complete",
    task: "complete",
    canonicalMilestone: "completed",
    canonicalSlice: "completed",
    canonicalTask: "completed",
  });

  assert.throws(() => updateTaskStatus("M001", "S01", "T01", "pending"), /canonical lifecycle operation/);
  assert.throws(() => updateSliceStatus("M001", "S01", "in_progress"), /canonical lifecycle operation/);
  assert.throws(() => updateMilestoneStatus("M001", "active"), /canonical lifecycle operation/);

  assert.equal(getTask("M001", "S01", "T01")?.status, "complete");
});

test("adopted aligned transitions still write through the generic writer", () => {
  openAdoptedFixture({
    milestone: "active",
    slice: "active",
    task: "pending",
    canonicalMilestone: "ready",
    canonicalSlice: "ready",
    canonicalTask: "ready",
  });

  updateTaskStatus("M001", "S01", "T01", "in_progress");
  assert.equal(getTask("M001", "S01", "T01")?.status, "in_progress");

  // A status the canonical lifecycle does not back is refused even though the
  // row is adopted: closing goes through the semantic operations.
  assert.throws(() => updateTaskStatus("M001", "S01", "T01", "complete"), /canonical lifecycle operation/);
  assert.equal(getTask("M001", "S01", "T01")?.status, "in_progress");
});
