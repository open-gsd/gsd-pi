// Project/App: gsd-pi
// File Purpose: Gate for the schema fence of the hierarchy tables after the Authority Epoch cutover: no row without a lifecycle row, no status change outside a Domain Operation.

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
import { forwardRepairRecreate } from "./helpers/legacy-import-writer-harness.ts";
import { copyWorktreeDb } from "./helpers/worktree-db-fixture.ts";

const OUTSIDE_OPERATION = /a hierarchy row needs a lifecycle row from the same Domain Operation/;
const UNCOVERED = /a hierarchy row has no lifecycle row/;
const STATUS_OUTSIDE_OPERATION = /the status of a hierarchy row changes only in a Domain Operation/;
const HIERARCHY_TABLES = ["milestones", "slices", "tasks"];

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

function hierarchyStatuses(): unknown {
  return [getMilestone("M001")?.status, getSlice("M001", "S01")?.status, getTask("M001", "S01", "T01")?.status];
}

test("after the cutover a status change of a hierarchy row outside a Domain Operation is refused", () => {
  openAdoptedProject();
  advanceAuthorityEpoch();

  for (const table of HIERARCHY_TABLES) {
    assert.throws(() => db().prepare(`UPDATE ${table} SET status = 'complete'`).run(), STATUS_OUTSIDE_OPERATION);
  }
  assert.deepEqual(hierarchyStatuses(), ["active", "pending", "pending"]);
});

test("after the cutover a Domain Operation still changes the status of a hierarchy row", () => {
  openAdoptedProject();
  advanceAuthorityEpoch();

  operate(() => {
    for (const table of HIERARCHY_TABLES) db().prepare(`UPDATE ${table} SET status = 'in_progress'`).run();
  });

  assert.deepEqual(hierarchyStatuses(), ["in_progress", "in_progress", "in_progress"]);
});

test("before the cutover a status change outside a Domain Operation is not fenced", () => {
  openAdoptedProject();

  for (const table of HIERARCHY_TABLES) db().prepare(`UPDATE ${table} SET status = 'complete'`).run();

  assert.deepEqual(hierarchyStatuses(), ["complete", "complete", "complete"]);
});

test("after the cutover the status of a row with no lifecycle row can be fixed for the backfill", () => {
  openAdoptedProject();
  advanceAuthorityEpoch();
  insertTaskAsEarlierBuild("T02", "wip-custom");

  db().prepare("UPDATE tasks SET status = 'pending' WHERE id = 'T02'").run();

  assert.equal(getTask("M001", "S01", "T02")?.status, "pending");
});

function recreatedTask(id: string, status: string): Parameters<typeof forwardRepairRecreate>[0][number] {
  return {
    rowSet: "tasks",
    identity: { milestone_id: "M001", slice_id: "S01", id },
    values: { milestone_id: "M001", slice_id: "S01", id, title: "Deleted by an import", status },
  };
}

test("after the cutover a Forward Repair adopts the hierarchy row that it puts back", () => {
  openAdoptedProject();
  advanceAuthorityEpoch();

  forwardRepairRecreate([recreatedTask("T02", "pending")]);

  assert.equal(getTask("M001", "S01", "T02")?.title, "Deleted by an import");
  assert.deepEqual(
    db().prepare(`
      SELECT lifecycle_status FROM workflow_item_lifecycles
      WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S01' AND task_id = 'T02'
    `).get(),
    { lifecycle_status: "ready" },
  );
});

test("after the cutover a Forward Repair refuses to put back a row with an unknown legacy status", () => {
  openAdoptedProject();
  advanceAuthorityEpoch();

  assert.throws(
    () => forwardRepairRecreate([recreatedTask("T02", "mystery")]),
    /unknown legacy statuses: task M001\/S01\/T02="mystery"/,
  );
  assert.equal(getTask("M001", "S01", "T02"), null);
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

/** A worktree copy of the adopted project, taken before the cutover of main, with `seed` applied to it. */
function worktreeCopy(mainDb: string, seed: () => void): string {
  const worktreeDb = tempDbPath("gsd-lifecycle-coverage-worktree-");
  closeDatabase();
  assert.equal(copyWorktreeDb(mainDb, worktreeDb), true);
  assert.equal(openDatabase(worktreeDb), true);
  seed();
  closeDatabase();
  assert.equal(openDatabase(mainDb), true);
  return worktreeDb;
}

function taskState(sliceId: string, taskId: string): { status: unknown; lifecycle: unknown } {
  return {
    status: getTask("M001", sliceId, taskId)?.status,
    lifecycle: db().prepare(`
      SELECT lifecycle_status FROM workflow_item_lifecycles
      WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = :slice_id AND task_id = :task_id
    `).get({ ":slice_id": sliceId, ":task_id": taskId })?.["lifecycle_status"],
  };
}

test("after the cutover a worktree database merge applies the status changes of adoption and reports them", () => {
  const mainDb = openAdoptedProject();
  const worktreeDb = worktreeCopy(mainDb, () => {
    // A completion with no summary and no verification in the database.
    insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "Unproven", status: "complete" });
    // Open work under a cancelled parent.
    insertSlice({ milestoneId: "M001", id: "S02", title: "Skipped slice", status: "skipped", sequence: 2 });
    insertTask({ milestoneId: "M001", sliceId: "S02", id: "T01", title: "Open task", status: "pending" });
  });
  advanceAuthorityEpoch();

  const result = reconcileWorktreeDb(mainDb, worktreeDb);

  assert.deepEqual([...result.adoptionStatusChanges].sort(), [
    'task M001/S01/T02 "complete" -> "pending" (legacy-complete-unproven)',
    'task M001/S02/T01 "pending" -> "skipped" (cancelled-with-parent)',
  ]);
  assert.deepEqual(taskState("S01", "T02"), { status: "pending", lifecycle: "ready" });
  assert.deepEqual(taskState("S02", "T01"), { status: "skipped", lifecycle: "cancelled" });
  assert.equal(getSlice("M001", "S02")?.status, "skipped");
  assert.deepEqual(
    { ...db().prepare(`
      SELECT lifecycle_status FROM workflow_item_lifecycles
      WHERE item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S02'
    `).get() },
    { lifecycle_status: "cancelled" },
  );
});

test("after the cutover a worktree database merge refuses an unknown status and names the row and the fix", () => {
  const mainDb = openAdoptedProject();
  const worktreeDb = worktreeCopy(mainDb, () => {
    insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "Unknown", status: "not-a-status" });
  });
  advanceAuthorityEpoch();
  const before = authority();

  assert.throws(
    () => reconcileWorktreeDb(mainDb, worktreeDb),
    (error: Error) => {
      assert.match(error.message, /canonical worktree divergence/);
      assert.match(error.message, /unknown legacy statuses: task M001\/S01\/T02="not-a-status"/);
      assert.ok(error.message.includes(
        `sqlite3 '${worktreeDb}' "UPDATE tasks SET status = 'pending' ` +
          `WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T02'"`,
      ));
      return true;
    },
  );
  assert.equal(getTask("M001", "S01", "T02"), null);
  assert.deepEqual(authority(), before);

  // The named statement makes the same merge pass.
  closeDatabase();
  assert.equal(openDatabase(worktreeDb), true);
  db().prepare(
    "UPDATE tasks SET status = 'pending' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T02'",
  ).run();
  closeDatabase();
  assert.equal(openDatabase(mainDb), true);
  reconcileWorktreeDb(mainDb, worktreeDb);
  assert.deepEqual(taskState("S01", "T02"), { status: "pending", lifecycle: "ready" });
});

/** A hierarchy row that a build with no coverage fence left in the cut-over project. */
function insertTaskAsEarlierBuild(id: string, status: string): void {
  db().exec(`
    DROP TRIGGER trg_tasks_lifecycle_coverage;
    DROP TRIGGER trg_project_authority_lifecycle_coverage;
  `);
  insertTask({ milestoneId: "M001", sliceId: "S01", id, title: "Earlier build", status });
}

test("after the cutover a worktree database merge also adopts a row that main held with no lifecycle row", () => {
  const mainDb = openAdoptedProject();
  const worktreeDb = worktreeCopy(mainDb, () => {
    insertTask({ milestoneId: "M001", sliceId: "S01", id: "T03", title: "Worktree task", status: "pending" });
  });
  advanceAuthorityEpoch();
  insertTaskAsEarlierBuild("T02", "pending");
  closeDatabase();
  assert.equal(openDatabase(mainDb), true);

  reconcileWorktreeDb(mainDb, worktreeDb);

  assert.deepEqual(taskState("S01", "T02"), { status: "pending", lifecycle: "ready" });
  assert.deepEqual(taskState("S01", "T03"), { status: "pending", lifecycle: "ready" });
});

test("after the cutover a worktree database merge that the coverage fence refuses is a divergence, not a silent zero", () => {
  const mainDb = openAdoptedProject();
  const worktreeDb = worktreeCopy(mainDb, () => {
    insertTask({ milestoneId: "M001", sliceId: "S01", id: "T03", title: "Worktree task", status: "pending" });
  });
  advanceAuthorityEpoch();
  insertTaskAsEarlierBuild("T02", "not-a-status");
  closeDatabase();
  assert.equal(openDatabase(mainDb), true);
  const before = authority();

  assert.throws(
    () => reconcileWorktreeDb(mainDb, worktreeDb),
    (error: Error) => {
      assert.equal(error.name, "CanonicalWorktreeDivergenceError");
      assert.match(error.message, /a hierarchy row has no lifecycle row: task M001\/S01\/T02="not-a-status"/);
      assert.match(error.message, /\/gsd db adopt/);
      return true;
    },
  );
  assert.equal(getTask("M001", "S01", "T03"), null, "nothing is merged");
  assert.deepEqual(authority(), before);
});

test("a refused Domain Operation names each hierarchy row that has no lifecycle row and the command that adopts it", () => {
  openAdoptedProject();
  advanceAuthorityEpoch();

  assert.throws(
    () => operate(() => {
      insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "No lifecycle", status: "pending" });
    }),
    /a hierarchy row has no lifecycle row: task M001\/S01\/T02="pending"\. .*\/gsd db adopt/,
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
