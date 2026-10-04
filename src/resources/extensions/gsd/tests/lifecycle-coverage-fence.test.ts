// Project/App: gsd-pi
// File Purpose: Gate for the schema fence that refuses a hierarchy row without a lifecycle row after the Authority Epoch cutover.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { executeDomainOperation, type DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle, readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
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
  reconcileWorktreeDb,
} from "../gsd-db.ts";
import { registerMilestones } from "../milestone-registration.ts";
import { copyWorktreeDb } from "./helpers/worktree-db-fixture.ts";

const OUTSIDE_OPERATION = /a hierarchy row needs a lifecycle row from the same Domain Operation/;
const UNCOVERED = /a hierarchy row has no lifecycle row/;

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function tempDbPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "expected an open database");
  return adapter;
}

function authority(): { revision: number; authority_epoch: number } {
  const row = db().prepare("SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1").get();
  return { revision: Number(row?.["revision"]), authority_epoch: Number(row?.["authority_epoch"]) };
}

function operate(mutate: (context: Readonly<DomainOperationContext>) => void): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.hierarchy",
    idempotencyKey: `test/hierarchy/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    mutate(context);
    return {
      events: [{ eventType: "test.hierarchy", entityType: "project", entityId: "test", payload: {}, destinations: ["db"] }],
      projections: [{ projectionKey: "state", projectionKind: "state", rendererVersion: "1" }],
    };
  });
}

/** One adopted Milestone, Slice and Task: the state of a Project that may cut over. */
function openAdoptedProject(): string {
  const path = tempDbPath("gsd-lifecycle-coverage-");
  assert.equal(openDatabase(path), true);
  operate((context) => {
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "Slice", status: "pending", sequence: 1 });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "ready",
    });
    insertTask({ milestoneId: "M001", sliceId: "S01", id: "T01", title: "Task", status: "pending" });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "ready",
    });
  });
  return path;
}

/** The statement the cutover Domain Operation commits with. */
function advanceAuthorityEpoch(): void {
  db().prepare("UPDATE project_authority SET authority_epoch = authority_epoch + 1 WHERE singleton = 1").run();
}

test("after the cutover a hierarchy row inserted outside a Domain Operation is refused", () => {
  openAdoptedProject();
  advanceAuthorityEpoch();

  assert.throws(() => insertMilestone({ id: "M002", title: "Legacy", status: "queued" }), OUTSIDE_OPERATION);
  assert.throws(
    () => insertSlice({ milestoneId: "M001", id: "S02", title: "Legacy", status: "pending" }),
    OUTSIDE_OPERATION,
  );
  assert.throws(
    () => insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "Legacy", status: "pending" }),
    OUTSIDE_OPERATION,
  );
  assert.equal(getMilestone("M002"), null);
  assert.equal(getSlice("M001", "S02"), null);
  assert.equal(getTask("M001", "S01", "T02"), null);
});

test("after the cutover a Domain Operation cannot commit a hierarchy row without a lifecycle row", () => {
  openAdoptedProject();
  advanceAuthorityEpoch();
  const before = authority();

  assert.throws(
    () => operate(() => { insertMilestone({ id: "M002", title: "No lifecycle", status: "queued" }); }),
    UNCOVERED,
  );
  assert.throws(
    () => operate(() => {
      insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "No lifecycle", status: "pending" });
    }),
    UNCOVERED,
  );
  assert.equal(getMilestone("M002"), null);
  assert.equal(getTask("M001", "S01", "T02"), null);
  assert.deepEqual(authority(), before);
});

test("after the cutover the Domain Operation writers still create hierarchy rows", () => {
  openAdoptedProject();
  advanceAuthorityEpoch();

  assert.deepEqual(registerMilestones([{ id: "M002", title: "Registered" }], "test"), ["M002"]);
  operate((context) => {
    insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "Planned", status: "pending" });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T02", lifecycleStatus: "ready",
    });
  });

  assert.equal(getMilestone("M002")?.title, "Registered");
  assert.equal(getTask("M001", "S01", "T02")?.title, "Planned");
  assert.equal(authority().authority_epoch, 1);
});

test("after the cutover a write to a hierarchy row that exists is not fenced", () => {
  openAdoptedProject();
  advanceAuthorityEpoch();

  // INSERT OR IGNORE of a row that exists, and an upsert that updates one.
  assert.equal(insertMilestone({ id: "M001", title: "Ignored" }), false);
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T01", title: "Retitled", status: "pending" });
  assert.equal(getTask("M001", "S01", "T01")?.title, "Retitled");
});

test("the Authority Epoch cannot advance while a hierarchy row has no lifecycle row", () => {
  openAdoptedProject();
  // Epoch 0 is not fenced: a legacy writer may still insert an unadopted row.
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "Unadopted", status: "pending" });
  assert.equal(getTask("M001", "S01", "T02")?.title, "Unadopted");

  assert.throws(advanceAuthorityEpoch, UNCOVERED);
  assert.equal(authority().authority_epoch, 0);

  operate((context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T02", lifecycleStatus: "ready",
    });
  });
  advanceAuthorityEpoch();
  assert.equal(authority().authority_epoch, 1);
});

test("after the cutover a worktree database merge adopts the rows it inserts", () => {
  const mainDb = openAdoptedProject();
  const worktreeDb = tempDbPath("gsd-lifecycle-coverage-worktree-");
  closeDatabase();
  assert.equal(copyWorktreeDb(mainDb, worktreeDb), true);
  assert.equal(openDatabase(worktreeDb), true);
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "Worktree task", status: "pending" });
  closeDatabase();

  assert.equal(openDatabase(mainDb), true);
  advanceAuthorityEpoch();
  assert.equal(reconcileWorktreeDb(mainDb, worktreeDb).tasks, 2);

  assert.equal(getTask("M001", "S01", "T02")?.title, "Worktree task");
  assert.deepEqual(
    db().prepare(`
      SELECT lifecycle_status FROM workflow_item_lifecycles
      WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S01' AND task_id = 'T02'
    `).get(),
    { lifecycle_status: "ready" },
  );
});

test("a database that lost the fence gets it back on the next open", () => {
  const path = openAdoptedProject();
  advanceAuthorityEpoch();
  db().exec(`
    DROP TRIGGER trg_milestones_lifecycle_coverage;
    DROP TRIGGER trg_project_authority_lifecycle_coverage;
  `);
  closeDatabase();

  assert.equal(openDatabase(path), true);
  assert.throws(() => insertMilestone({ id: "M002", title: "Legacy", status: "queued" }), OUTSIDE_OPERATION);
  assert.throws(
    () => operate(() => {
      insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "No lifecycle", status: "pending" });
    }),
    UNCOVERED,
  );
});
