// Project/App: gsd-pi
// File Purpose: RED compatibility contracts for durable lifecycle adoption.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";

import { computeProjectionSha, readCompatMarker, writeCompatMarker } from "../compat/compat-marker.ts";
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
  bulkInsertLegacyHierarchy,
  clearEngineHierarchy,
  closeDatabase,
  copyWorktreeDb,
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  reconcileWorktreeDb,
  restoreManifest,
  updateSliceStatus,
  updateTaskStatus,
} from "../gsd-db.ts";
import { discardMilestone } from "../milestone-actions.ts";
import type { StateManifest } from "../workflow-manifest.ts";
import { reconcileWorktreeDbBeforeManualMerge } from "../worktree-command.ts";
import { worktreePath } from "../worktree-manager.ts";
import { createWorkspace } from "../workspace.ts";
import {
  renderPlanProjection,
  renderRoadmapProjection,
} from "../workflow-projections.ts";

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

function legacyManifest(): StateManifest {
  const milestones = getAllMilestones();
  const slices = milestones.flatMap((milestone) => getMilestoneSlices(milestone.id));
  const tasks = slices.flatMap((slice) => getSliceTasks(slice.milestone_id, slice.id));
  return {
    version: 1,
    exported_at: "2026-07-12T00:00:00.000Z",
    milestones,
    slices,
    tasks,
    decisions: [],
    verification_evidence: [],
  };
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

function explicitAdoptionGuardError(action: () => void): Error {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "destructive compatibility path must reject adopted hierarchy");
  assert.match(
    thrown.message,
    /(?:adopted|canonical).*lifecycle|lifecycle.*(?:adopted|canonical)/i,
    "rejection must explain that canonical lifecycle history prevents destructive restore",
  );
  return thrown;
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

test("manifest restore rejects adopted hierarchy before changing either authority surface", (t) => {
  openFixture(t);
  const manifest = legacyManifest();
  adoptHierarchy();
  const before = hierarchyIdentitySnapshot();

  explicitAdoptionGuardError(() => restoreManifest(manifest));

  assert.deepEqual(hierarchyIdentitySnapshot(), before, "failed restore must leave hierarchy and lifecycles unchanged");
});

test("recover hierarchy clear rejects adopted rows before deleting legacy state", (t) => {
  openFixture(t);
  adoptHierarchy();
  const before = hierarchyIdentitySnapshot();

  explicitAdoptionGuardError(clearEngineHierarchy);

  assert.deepEqual(hierarchyIdentitySnapshot(), before, "failed recover clear must leave adopted state unchanged");
});

test("legacy markdown bulk restore rejects adopted rows before replacing identities", (t) => {
  openFixture(t);
  adoptHierarchy();
  const before = hierarchyIdentitySnapshot();

  explicitAdoptionGuardError(() => bulkInsertLegacyHierarchy({
    milestones: [{ id: "M001", title: "Imported milestone", status: "active" }],
    slices: [{ id: "S01", milestoneId: "M001", title: "Imported slice", status: "active", risk: "low", sequence: 1 }],
    tasks: [{ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Imported task", status: "pending", sequence: 1 }],
    clearMilestoneIds: ["M001"],
    createdAt: "2026-07-12T00:00:00.000Z",
  }));

  assert.deepEqual(hierarchyIdentitySnapshot(), before, "failed bulk restore must leave adopted state unchanged");
});

test("legacy markdown bulk restore may replace an unrelated unadopted milestone", (t) => {
  openFixture(t);
  insertMilestone({ id: "M002", title: "Replace me", status: "active" });
  insertSlice({ milestoneId: "M002", id: "S02", title: "Replace me", status: "pending" });
  insertTask({ milestoneId: "M002", sliceId: "S02", id: "T02", title: "Replace me", status: "pending" });
  adoptHierarchy();
  const adoptedBefore = hierarchyIdentitySnapshot();

  bulkInsertLegacyHierarchy({
    milestones: [{ id: "M002", title: "Imported milestone", status: "active" }],
    slices: [{ id: "S02", milestoneId: "M002", title: "Imported slice", status: "pending", risk: "medium", sequence: 2 }],
    tasks: [{ id: "T02", sliceId: "S02", milestoneId: "M002", title: "Imported task", status: "pending", sequence: 3 }],
    clearMilestoneIds: ["M002"],
    createdAt: "2026-07-12T00:00:00.000Z",
  });

  assert.deepEqual(hierarchyIdentitySnapshot(), adoptedBefore, "scoped import must not touch adopted milestone M001");
  assert.equal(getAllMilestones().find((milestone) => milestone.id === "M002")?.title, "Imported milestone");
  assert.equal(getMilestoneSlices("M002")[0]?.title, "Imported slice");
  assert.equal(getSliceTasks("M002", "S02")[0]?.title, "Imported task");
});

test("legacy-only restore, recover clear, and bulk import retain their existing behavior", (t) => {
  openFixture(t);
  const manifest = legacyManifest();
  db().prepare("UPDATE milestones SET title = 'Changed' WHERE id = 'M001'").run();

  restoreManifest(manifest);
  assert.equal(getAllMilestones()[0]?.title, "Original milestone");

  clearEngineHierarchy();
  assert.equal(getAllMilestones().length, 0);

  bulkInsertLegacyHierarchy({
    milestones: [{ id: "M002", title: "Legacy import", status: "active" }],
    slices: [{ id: "S02", milestoneId: "M002", title: "Legacy slice", status: "pending", risk: "medium", sequence: 2 }],
    tasks: [{ id: "T02", sliceId: "S02", milestoneId: "M002", title: "Legacy task", status: "pending", sequence: 3 }],
    clearMilestoneIds: ["M002"],
    createdAt: "2026-07-12T00:00:00.000Z",
  });
  assert.equal(getAllMilestones()[0]?.title, "Legacy import");
  assert.equal(getMilestoneSlices("M002")[0]?.title, "Legacy slice");
  assert.equal(getSliceTasks("M002", "S02")[0]?.title, "Legacy task");
});

test("legacy projection renderers exclude cancelled slices and tasks", (t) => {
  const database = openFixture(t);
  const base = tempDir("gsd-active-projection-filter-");
  mkdirSync(join(base, ".gsd"), { recursive: true });
  closeDatabase();
  assert.equal(openDatabase(database), true);

  insertSlice({ milestoneId: "M001", id: "S02", title: "Cancelled slice", status: "pending" });
  insertTask({ milestoneId: "M001", sliceId: "S02", id: "T02", title: "Cancelled slice task", status: "pending" });
  updateSliceStatus("M001", "S02", "skipped");
  updateTaskStatus("M001", "S01", "T01", "skipped");

  renderRoadmapProjection(base, "M001");
  const roadmap = readFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "utf8");
  assert.doesNotMatch(roadmap, /S02|Cancelled slice/);

  const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  const planContent = "# stale cancelled task projection\n";
  writeFileSync(planPath, planContent, "utf8");
  const marker = readCompatMarker(base);
  marker.projections["milestones/M001/slices/S01/S01-PLAN.md"] = {
    sha: computeProjectionSha(planContent),
    entities: ["M001/S01"],
  };
  writeCompatMarker(base, marker);
  renderPlanProjection(base, "M001", "S01");
  assert.equal(existsSync(planPath), false);
});

test("discard milestone fails before deleting projections when canonical lifecycle history exists", () => {
  const base = tempDir("gsd-discard-adopted-");
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), "# Durable roadmap\n", "utf8");
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  seedLegacyHierarchy();
  adoptHierarchy();

  assert.throws(
    () => discardMilestone(base, "M001"),
    /adopted canonical lifecycle|canonical lifecycle history/i,
  );
  assert.equal(existsSync(milestoneDir), true);
  assert.equal(getAllMilestones().some((milestone) => milestone.id === "M001"), true);
});
