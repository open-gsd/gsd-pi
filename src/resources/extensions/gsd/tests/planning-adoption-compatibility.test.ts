// Project/App: gsd-pi
// File Purpose: RED compatibility contracts for durable lifecycle adoption.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";

import { teardownAutoWorktree } from "../auto-worktree-teardown.ts";
import {
  getActiveWorkspace,
  setActiveWorkspace,
} from "../auto-worktree-session-registry.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  reconcileWorktreeDb,
} from "../gsd-db.ts";
import { copyWorktreeDb } from "./helpers/worktree-db-fixture.ts";
import { reconcileWorktreeDbBeforeManualMerge } from "../worktree-command.ts";
import { worktreePath } from "../worktree-manager.ts";
import { createWorkspace } from "../workspace.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "expected an open database");
  return adapter;
}

function openFixture(t: TestContext): string {
  const path = join(tempDir("gsd-adoption-compat-"), "gsd.db");
  assert.equal(openDatabase(path), true);
  seedLegacyHierarchy();
  t.after(closeDatabase);
  return path;
}

function seedLegacyHierarchy(): void {
  insertMilestone({ id: "M001", title: "Original milestone", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Original slice",
    status: "active",
    sequence: 1,
  });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Original task",
    status: "pending",
    sequence: 1,
  });
}

function adoptHierarchy(): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "planning.compatibility.adopt",
    idempotencyKey: "planning/compatibility/adopt/M001",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload: { milestoneId: "M001" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "planning.compatibility.adopted",
        entityType: "milestone",
        entityId: "M001",
        payload: { milestoneId: "M001" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "planning/m001",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

function advanceTaskLifecycle(): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "planning.compatibility.advance",
    idempotencyKey: "planning/compatibility/advance/M001/S01/T01",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload: { taskId: "T01", lifecycleStatus: "in_progress" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "in_progress",
    });
    return {
      events: [{
        eventType: "planning.compatibility.advanced",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: { lifecycleStatus: "in_progress" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "planning/m001/s01/t01",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

function advanceSliceLifecycle(): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "planning.compatibility.advance-slice",
    idempotencyKey: "planning/compatibility/advance/M001/S01",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload: { sliceId: "S01", lifecycleStatus: "in_progress" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "in_progress",
    });
    return {
      events: [{
        eventType: "planning.compatibility.slice-advanced",
        entityType: "slice",
        entityId: "M001/S01",
        payload: { lifecycleStatus: "in_progress" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "planning/m001/s01",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

function hierarchyIdentitySnapshot(): Record<string, unknown> {
  return {
    milestone: db().prepare("SELECT rowid AS row_id, id, title FROM milestones WHERE id = 'M001'").get(),
    slice: db().prepare("SELECT rowid AS row_id, milestone_id, id, title FROM slices WHERE milestone_id = 'M001' AND id = 'S01'").get(),
    task: db().prepare("SELECT rowid AS row_id, milestone_id, slice_id, id, title, status FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'").get(),
    lifecycles: db().prepare(`
      SELECT lifecycle_id, item_kind, milestone_id, slice_id, task_id,
             lifecycle_status, state_version, last_operation_id,
             last_project_revision, last_authority_epoch
      FROM workflow_item_lifecycles
      ORDER BY item_kind
    `).all(),
  };
}

function taskExecutionSnapshot(): Record<string, unknown> | undefined {
  return db().prepare(`
    SELECT title, description, status, one_liner, narrative, verification_result,
           duration, blocker_discovered, deviations, known_issues, key_files,
           key_decisions, full_summary_md, blocker_source, escalation_pending,
           escalation_awaiting_review, escalation_artifact_path,
           escalation_override_applied_at
    FROM tasks
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).get();
}

function sliceExecutionSnapshot(): Record<string, unknown> | undefined {
  return db().prepare(`
    SELECT status, completed_at, full_summary_md, full_uat_md
    FROM slices
    WHERE milestone_id = 'M001' AND id = 'S01'
  `).get();
}

test("worktree reconcile updates adopted hierarchy in place without deleting lifecycle identity", (t) => {
  const mainDb = openFixture(t);
  adoptHierarchy();
  const before = hierarchyIdentitySnapshot();
  const worktreeDb = join(tempDir("gsd-adoption-worktree-"), "gsd.db");

  closeDatabase();
  assert.equal(copyWorktreeDb(mainDb, worktreeDb), true);
  assert.equal(openDatabase(worktreeDb), true);
  db().exec(`
    UPDATE milestones SET title = 'Worktree milestone' WHERE id = 'M001';
    UPDATE slices SET title = 'Worktree slice' WHERE milestone_id = 'M001' AND id = 'S01';
    UPDATE tasks SET title = 'Worktree task' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01';
  `);
  closeDatabase();

  assert.equal(openDatabase(mainDb), true);
  const result = reconcileWorktreeDb(mainDb, worktreeDb);
  assert.ok(result.milestones > 0 && result.slices > 0 && result.tasks > 0);

  const after = hierarchyIdentitySnapshot();
  assert.deepEqual(after, {
    ...before,
    milestone: { ...(before["milestone"] as object), title: "Worktree milestone" },
    slice: { ...(before["slice"] as object), title: "Worktree slice" },
    task: { ...(before["task"] as object), title: "Worktree task" },
  });
});

function lifecycleRows(): Array<Record<string, unknown>> {
  return db().prepare(`
    SELECT lifecycle.item_kind, lifecycle.milestone_id, lifecycle.slice_id, lifecycle.task_id,
           lifecycle.lifecycle_status, lifecycle.last_project_revision, operation.operation_type
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_operations operation ON operation.operation_id = lifecycle.last_operation_id
    ORDER BY lifecycle.milestone_id, lifecycle.slice_id, lifecycle.task_id
  `).all().map((row) => ({ ...row }));
}

function projectRevision(): number {
  return Number(db().prepare("SELECT revision FROM project_authority WHERE singleton = 1").get()?.["revision"]);
}

test("worktree reconcile adopts every hierarchy row it inserts in one Domain Operation", (t) => {
  const mainDb = openFixture(t);
  const worktreeDb = join(tempDir("gsd-reconcile-adopt-worktree-"), "gsd.db");

  closeDatabase();
  assert.equal(copyWorktreeDb(mainDb, worktreeDb), true);
  assert.equal(openDatabase(worktreeDb), true);
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "Worktree task", status: "pending" });
  insertSlice({ milestoneId: "M001", id: "S02", title: "Worktree slice", status: "pending", sequence: 2 });
  insertMilestone({ id: "M002", title: "Worktree milestone", status: "queued" });
  closeDatabase();

  assert.equal(openDatabase(mainDb), true);
  const revision = projectRevision();
  reconcileWorktreeDb(mainDb, worktreeDb);

  assert.equal(projectRevision(), revision + 1, "the merge is one Domain Operation with one revision bump");
  // The rows that main held before the merge (M001, S01, T01) keep their adoption state.
  const adopted = { last_project_revision: revision + 1, operation_type: "lifecycle.backfill" };
  assert.deepEqual(lifecycleRows(), [
    { item_kind: "task", milestone_id: "M001", slice_id: "S01", task_id: "T02", lifecycle_status: "ready", ...adopted },
    { item_kind: "slice", milestone_id: "M001", slice_id: "S02", task_id: null, lifecycle_status: "pending", ...adopted },
    { item_kind: "milestone", milestone_id: "M002", slice_id: null, task_id: null, lifecycle_status: "ready", ...adopted },
  ]);
});

test("worktree reconcile keeps a row with an unknown status in the worktree database", (t) => {
  const mainDb = openFixture(t);
  const worktreeDb = join(tempDir("gsd-reconcile-unknown-worktree-"), "gsd.db");

  closeDatabase();
  assert.equal(copyWorktreeDb(mainDb, worktreeDb), true);
  assert.equal(openDatabase(worktreeDb), true);
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "Worktree task", status: "not-a-status" });
  db().prepare("UPDATE milestones SET title = 'Must not merge' WHERE id = 'M001'").run();
  closeDatabase();

  assert.equal(openDatabase(mainDb), true);
  const before = hierarchyIdentitySnapshot();
  const revision = projectRevision();
  assert.throws(
    () => reconcileWorktreeDb(mainDb, worktreeDb),
    /canonical worktree divergence.*unknown legacy statuses: task M001\/S01\/T02="not-a-status"/,
  );
  assert.deepEqual(hierarchyIdentitySnapshot(), before, "a refused adoption must roll back the whole merge");
  assert.equal(projectRevision(), revision);
  assert.equal(
    db().prepare("SELECT 1 FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T02'").get(),
    undefined,
  );
});

test("worktree reconcile fails closed when canonical authority advanced in the worktree", (t) => {
  const mainDb = openFixture(t);
  adoptHierarchy();
  const worktreeDb = join(tempDir("gsd-canonical-worktree-"), "gsd.db");

  closeDatabase();
  assert.equal(copyWorktreeDb(mainDb, worktreeDb), true);
  assert.equal(openDatabase(worktreeDb), true);
  advanceTaskLifecycle();
  db().prepare("UPDATE milestones SET title = 'Must not merge' WHERE id = 'M001'").run();
  closeDatabase();

  assert.equal(openDatabase(mainDb), true);
  const before = hierarchyIdentitySnapshot();
  let thrown: unknown;
  try {
    reconcileWorktreeDb(mainDb, worktreeDb);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "canonical divergence must throw before legacy merge");
  assert.match(thrown.message, /canonical worktree divergence.*(?:authority|operation|lifecycle)/i);
  assert.deepEqual(hierarchyIdentitySnapshot(), before, "canonical divergence must prevent every legacy merge");
});

test("worktree reconcile accepts legacy edits when canonical authority advanced only in main", (t) => {
  const mainDb = openFixture(t);
  adoptHierarchy();
  const worktreeDb = join(tempDir("gsd-main-ahead-worktree-"), "gsd.db");

  closeDatabase();
  assert.equal(copyWorktreeDb(mainDb, worktreeDb), true);
  assert.equal(openDatabase(mainDb), true);
  advanceSliceLifecycle();
  advanceTaskLifecycle();
  db().prepare(`
    UPDATE tasks SET status = 'active'
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  db().exec(`
    UPDATE slices SET
      full_summary_md = '# Main slice summary',
      full_uat_md = '# Main slice UAT'
    WHERE milestone_id = 'M001' AND id = 'S01';
    UPDATE tasks SET
      one_liner = 'Main execution result',
      narrative = 'Main execution narrative',
      verification_result = 'passed on main',
      duration = '47m',
      blocker_discovered = 1,
      deviations = 'Main deviation',
      known_issues = 'Main known issue',
      key_files = '["src/main.ts"]',
      key_decisions = '["D-main"]',
      full_summary_md = '# Main task summary',
      blocker_source = 'execution',
      escalation_pending = 1,
      escalation_awaiting_review = 1,
      escalation_artifact_path = '.gsd/escalations/main.md',
      escalation_override_applied_at = '2026-07-12T12:00:00.000Z'
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01';
  `);
  const before = hierarchyIdentitySnapshot();
  const beforeSliceExecution = sliceExecutionSnapshot();
  const beforeExecution = taskExecutionSnapshot();
  closeDatabase();

  assert.equal(openDatabase(worktreeDb), true);
  db().exec(`
    UPDATE milestones SET title = 'Legacy edit from stale worktree' WHERE id = 'M001';
    UPDATE slices SET
      title = 'Worktree slice planning title',
      full_summary_md = '',
      full_uat_md = ''
    WHERE milestone_id = 'M001' AND id = 'S01';
    UPDATE tasks SET
      title = 'Worktree planning title',
      description = 'Worktree planning description',
      verification_result = 'stale verification',
      blocker_discovered = 0,
      full_summary_md = '',
      blocker_source = '',
      escalation_pending = 0,
      escalation_awaiting_review = 0,
      escalation_artifact_path = NULL,
      escalation_override_applied_at = NULL
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01';
  `);
  closeDatabase();

  assert.equal(openDatabase(mainDb), true);
  const result = reconcileWorktreeDb(mainDb, worktreeDb);
  assert.ok(result.milestones > 0);
  assert.deepEqual(hierarchyIdentitySnapshot(), {
    ...before,
    milestone: { ...(before["milestone"] as object), title: "Legacy edit from stale worktree" },
    slice: { ...(before["slice"] as object), title: "Worktree slice planning title" },
    task: { ...(before["task"] as object), title: "Worktree planning title" },
  });
  assert.deepEqual(sliceExecutionSnapshot(), beforeSliceExecution);
  assert.deepEqual(taskExecutionSnapshot(), {
    ...beforeExecution,
    title: "Worktree planning title",
    description: "Worktree planning description",
  }, "newer main lifecycle must retain execution results while accepting planning metadata");
});

test("worktree reconcile rejects extra canonical operations and lifecycle state even with a reset authority fence", (t) => {
  const mainDb = openFixture(t);
  adoptHierarchy();
  const worktreeDb = join(tempDir("gsd-canonical-history-worktree-"), "gsd.db");

  closeDatabase();
  assert.equal(copyWorktreeDb(mainDb, worktreeDb), true);
  assert.equal(openDatabase(worktreeDb), true);
  advanceTaskLifecycle();
  db().prepare("UPDATE project_authority SET revision = 1, authority_epoch = 0 WHERE singleton = 1").run();
  db().prepare("UPDATE milestones SET title = 'Must not merge canonical history' WHERE id = 'M001'").run();
  closeDatabase();

  assert.equal(openDatabase(mainDb), true);
  const before = hierarchyIdentitySnapshot();
  assert.throws(
    () => reconcileWorktreeDb(mainDb, worktreeDb),
    /canonical worktree divergence.*(?:operations|lifecycles)/i,
  );
  assert.deepEqual(hierarchyIdentitySnapshot(), before);
});

test("manual merge preflight propagates canonical divergence instead of continuing", async (t) => {
  const mainDb = openFixture(t);
  adoptHierarchy();
  const worktreeDb = join(tempDir("gsd-manual-merge-worktree-"), "gsd.db");

  closeDatabase();
  assert.equal(copyWorktreeDb(mainDb, worktreeDb), true);
  assert.equal(openDatabase(worktreeDb), true);
  advanceTaskLifecycle();
  closeDatabase();

  assert.equal(openDatabase(mainDb), true);
  await assert.rejects(
    reconcileWorktreeDbBeforeManualMerge(mainDb, worktreeDb),
    /canonical worktree divergence/i,
  );
});

test("auto-worktree teardown preserves canonical divergence when the database starts closed", (t) => {
  const originalCwd = process.cwd();
  const base = tempDir("gsd-teardown-divergence-");
  const mainDb = join(base, ".gsd", "gsd.db");
  const worktreeRoot = worktreePath(base, "M001");
  const worktreeDb = join(worktreeRoot, ".gsd", "gsd.db");
  mkdirSync(join(base, ".gsd"), { recursive: true });
  mkdirSync(join(worktreeRoot, ".gsd"), { recursive: true });

  assert.equal(openDatabase(mainDb), true);
  seedLegacyHierarchy();
  adoptHierarchy();
  closeDatabase();
  assert.equal(copyWorktreeDb(mainDb, worktreeDb), true);
  assert.equal(openDatabase(worktreeDb), true);
  advanceTaskLifecycle();
  closeDatabase();
  assert.equal(openDatabase(mainDb), true);
  closeDatabase();

  try {
    const workspace = createWorkspace(worktreeRoot);
    setActiveWorkspace(workspace);
    process.chdir(worktreeRoot);
    teardownAutoWorktree(base, "M001", { preserveWorktree: true, preserveBranch: true });
    assert.equal(existsSync(worktreeRoot), true, "divergent canonical history must preserve worktree contents");
    assert.equal(getActiveWorkspace(), workspace, "divergent canonical history must keep workspace registered for recovery");
  } finally {
    setActiveWorkspace(null);
    process.chdir(originalCwd);
  }
  t.after(() => process.chdir(originalCwd));
});
