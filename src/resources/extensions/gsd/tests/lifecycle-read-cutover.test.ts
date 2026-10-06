// Project/App: gsd-pi
// File Purpose: Behavior tests for the read cutover. On a Project whose
// Authority Epoch has advanced, status, phase, dispatch eligibility and
// dependencies follow the canonical lifecycle rows when legacy rows disagree.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { verifyExpectedArtifact } from "../artifact-verification.ts";
import { shouldSkipTerminalMilestoneCloseout } from "../auto/closeout.ts";
import { getAlreadyClosedDispatchReason } from "../auto/dispatch.ts";
import { isAutoActive } from "../auto.ts";
import type { AutoSession } from "../auto/session.ts";
import { clearSliceProgressCache, getRoadmapSlicesSync, updateSliceProgressCache } from "../auto-dashboard.ts";
import { findOpenSlices, resolveDispatch } from "../auto-dispatch.ts";
import { _repairCompleteSliceRoadmapProjectionForTest, detectRogueFileWrites } from "../auto-post-unit.ts";
import {
  buildDiscussMilestoneInlinedContext,
  checkNeedsReassessment,
  loadRoadmapCompletedSliceCandidates,
} from "../auto-prompts.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { auditOrphanedMilestoneBranches, findUnmergedCompletedMilestone } from "../auto-start.ts";
import { checkCloseoutConsistencyGate } from "../closeout-consistency-gate.ts";
import { detectIdleMilestoneResidueHint } from "../closeout-wizard.ts";
import { handleAutoCommand } from "../commands/handlers/auto.ts";
import { handleCleanupBranches } from "../commands-maintenance.ts";
import { GSDDashboardOverlay } from "../dashboard-overlay.ts";
import {
  _executeAuthorityCutoverDomainOperation,
  executeDomainOperation,
  type DomainOperationContext,
  type DomainOperationMutation,
} from "../db/domain-operation.ts";
import {
  readClosedSliceIds,
  readListedMilestoneIds,
  readMilestone,
  readMilestoneSlices,
  readMilestones,
  readProgressCounts,
  readSlice,
  readSliceTasks,
  readTask,
} from "../db/lifecycle-read.ts";
import { insertAuthorityCutoverReceipt } from "../db/writers/authority-recovery.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import { getPriorSliceCompletionBlocker } from "../dispatch-guard.ts";
import { selectDoctorScope } from "../doctor.ts";
import { _loadDiscussNormSlicesForTest } from "../guided-flow.ts";
import {
  _getAdapter,
  closeDatabase,
  insertArtifact,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  setSliceUatMd,
} from "../gsd-db.ts";
import { findStaleScopedPauses } from "../interrupted-session.ts";
import { discardMilestone, isParked, parkMilestone, unparkMilestone } from "../milestone-actions.ts";
import { evaluateGuardedCompleteMilestoneDispatch } from "../milestone-closeout.ts";
import { persistMilestonePlan } from "../milestone-planning-persistence.ts";
import { showQueue } from "../guided-flow-queue.ts";
import { analyzeParallelEligibility } from "../parallel-eligibility.ts";
import { internalPlanningInvocation } from "../planning-invocation.ts";
import { checkVerificationCommands } from "../pre-execution-checks.ts";
import { reorderMilestones, setMilestoneDependencies } from "../queue-order.ts";
import { loadSliceTaskIO } from "../reactive-graph.ts";
import { handleRethink } from "../rethink.ts";
import { cancelSlice } from "../slice-lifecycle-domain-operation.ts";
import { getEligibleSlicesFromRows } from "../slice-parallel-eligibility.ts";
import { deriveState, invalidateStateCache, isGhostMilestone } from "../state.ts";
import { readProgressFromDb } from "../state/progress-from-db.ts";
import { readProjectSnapshotFromDb } from "../state/project-snapshot.ts";
import { handleCompleteTask } from "../tools/complete-task.ts";
import { handlePlanSlice } from "../tools/plan-slice.ts";
import { handlePlanTask } from "../tools/plan-task.ts";
import { handleReassessRoadmap } from "../tools/reassess-roadmap.ts";
import { handleReplanSlice } from "../tools/replan-slice.ts";
import { handleReplanTask } from "../tools/replan-task.ts";
import { executeMilestoneStatus, executeTaskComplete } from "../tools/workflow-tool-executors.ts";
import { checkNeedsRunUat, sliceAwaitsUatVerdict } from "../uat-dispatch.ts";
import { undoLastCompletedUnit } from "../undo.ts";
import { inspectExecuteTaskDurability } from "../unit-runtime.ts";
import { findUnmergedCompletedMilestones } from "../unmerged-milestone-guard.ts";
import { _resetLogs, drainLogs } from "../workflow-logger.ts";

const tempDirectories = new Set<string>();

afterEach(() => {
  closeDatabase();
  invalidateStateCache();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

function makeProject(): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-lifecycle-read-cutover-")));
  tempDirectories.add(base);
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  return base;
}

function mutation(key: string): DomainOperationMutation {
  return {
    events: [{
      eventType: "lifecycle-read-cutover.seeded",
      entityType: "project",
      entityId: key,
      payload: { key },
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: `lifecycle-read-cutover/${key}`,
      projectionKind: "markdown",
      rendererVersion: "v1",
    }],
  };
}

type Lifecycle = Parameters<typeof adoptOrTransitionLifecycle>[1];

/** Write canonical lifecycle rows that the legacy rows do not agree with. */
function seedLifecycles(key: string, lifecycles: Lifecycle[]): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "lifecycle-read-cutover.seed",
    idempotencyKey: `lifecycle-read-cutover/${key}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    actorId: "lifecycle-read-cutover",
    sourceTransport: "test",
    payload: { key },
  }, (context: Readonly<DomainOperationContext>) => {
    for (const lifecycle of lifecycles) adoptOrTransitionLifecycle(context, lifecycle);
    return mutation(key);
  });
}

/** Advance the Authority Epoch of the Project from 0 to 1. */
function cutOver(): void {
  const fence = readDomainOperationFence();
  const evidenceHash = `sha256:${"3".repeat(64)}`;
  const consentHash = `sha256:${"4".repeat(64)}`;
  const cutover = _executeAuthorityCutoverDomainOperation({
    operationType: "authority.cutover",
    idempotencyKey: "lifecycle-read-cutover/cutover",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    actorId: "lifecycle-read-cutover",
    sourceTransport: "internal",
    payload: { authorityContractVersion: 1, evidenceHash, consentHash },
  }, (context) => {
    insertAuthorityCutoverReceipt(context, { authorityContractVersion: 1, evidenceHash, consentHash });
    return mutation("cutover");
  });
  assert.equal(cutover.resultingAuthorityEpoch, 1);
  invalidateStateCache();
}

function milestone(milestoneId: string, lifecycleStatus: Lifecycle["lifecycleStatus"]): Lifecycle {
  return { itemKind: "milestone", milestoneId, lifecycleStatus };
}

function slice(milestoneId: string, sliceId: string, lifecycleStatus: Lifecycle["lifecycleStatus"]): Lifecycle {
  return { itemKind: "slice", milestoneId, sliceId, lifecycleStatus };
}

function task(
  milestoneId: string,
  sliceId: string,
  taskId: string,
  lifecycleStatus: Lifecycle["lifecycleStatus"],
): Lifecycle {
  return { itemKind: "task", milestoneId, sliceId, taskId, lifecycleStatus };
}

/**
 * Legacy rows and lifecycle rows that disagree in both directions:
 * M001 is legacy active and canonical completed. M002 is legacy complete and
 * canonical ready, and so are its Slice S01 and Task T01. S02 and T02 are
 * legacy pending and canonical completed. M005 is legacy complete and
 * canonical pending.
 */
function seedDisagreement(): string {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Canonical completed", status: "active" });
  insertMilestone({ id: "M002", title: "Canonical open", status: "complete", depends_on: ["M001"] });
  insertMilestone({ id: "M003", title: "Canonical cancelled", status: "active" });
  insertMilestone({ id: "M004", title: "Canonical paused", status: "active" });
  insertMilestone({ id: "M005", title: "Canonical pending", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Canonical open", status: "complete", depends: ["S02"], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M002", title: "Canonical completed", status: "pending", depends: [], sequence: 2 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M002", title: "Canonical open", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M002", title: "Canonical completed", status: "pending" });
  seedLifecycles("disagreement", [
    milestone("M001", "completed"),
    milestone("M002", "ready"),
    milestone("M003", "cancelled"),
    milestone("M004", "paused"),
    milestone("M005", "pending"),
    slice("M002", "S01", "ready"),
    slice("M002", "S02", "completed"),
    task("M002", "S01", "T01", "ready"),
    task("M002", "S01", "T02", "completed"),
  ]);
  invalidateStateCache();
  return base;
}

test("the Authority Epoch switches the read interface from the legacy rows to the lifecycle rows", () => {
  seedDisagreement();
  const answers = () => ({
    milestones: readMilestones().map((m) => [m.id, m.status, m.done, m.closed, m.parked, m.discarded]),
    slices: readMilestoneSlices("M002").map((s) => [s.id, s.status, s.done, s.satisfiesDependents]),
    tasks: readSliceTasks("M002", "S01").map((t) => [t.id, t.status, t.done]),
  });

  assert.deepEqual(answers(), {
    milestones: [
      ["M001", "active", false, false, false, false],
      ["M002", "complete", true, true, false, false],
      ["M003", "active", false, false, false, false],
      ["M004", "active", false, false, false, false],
      ["M005", "complete", true, true, false, false],
    ],
    slices: [["S01", "complete", true, true], ["S02", "pending", false, false]],
    tasks: [["T01", "complete", true], ["T02", "pending", false]],
  }, "before the Cutover the legacy rows answer");

  cutOver();

  assert.deepEqual(answers(), {
    milestones: [
      ["M001", "complete", true, true, false, false],
      ["M002", "active", false, false, false, false],
      ["M003", "skipped", false, true, false, true],
      ["M004", "parked", false, false, true, false],
      ["M005", "pending", false, false, false, false],
    ],
    slices: [["S01", "pending", false, false], ["S02", "complete", true, true]],
    tasks: [["T01", "pending", false], ["T02", "complete", true]],
  }, "after the Cutover the lifecycle rows answer");
});

test("the canonical lifecycle status of the snapshot comes from the legacy row before the Cutover and from the lifecycle row after it", async () => {
  const base = seedDisagreement();
  const statuses = async () =>
    (await readProjectSnapshotFromDb(base))?.milestones.items.map((m) => [m.id, m.lifecycleStatus]);

  assert.deepEqual(await statuses(), [
    ["M001", "in_progress"],
    ["M002", "completed"],
    ["M003", "in_progress"],
    ["M004", "in_progress"],
    ["M005", "completed"],
  ]);

  cutOver();

  assert.deepEqual(await statuses(), [
    ["M001", "completed"],
    ["M002", "ready"],
    ["M003", "cancelled"],
    ["M004", "paused"],
    // No lifecycle row: no work on it is recorded.
    ["M005", "pending"],
  ]);
});

test("after the Cutover a legacy label that names the same lifecycle status is kept", () => {
  makeProject();
  insertMilestone({ id: "M001", title: "Queued", status: "queued" });
  insertMilestone({ id: "M002", title: "Parked", status: "parked" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Deferred", status: "deferred", depends: [], sequence: 1 });
  seedLifecycles("labels", [milestone("M001", "ready"), milestone("M002", "paused"), slice("M001", "S01", "cancelled")]);
  cutOver();

  assert.deepEqual(readMilestones().map((m) => [m.id, m.status, m.parked]), [
    ["M001", "queued", false],
    ["M002", "parked", true],
  ]);
  assert.deepEqual(readMilestoneSlices("M001").map((s) => [s.id, s.status, s.done]), [["S01", "deferred", true]]);
});

test("after the Cutover the status tool reports the lifecycle status of the milestone, its slices and its tasks", async () => {
  const base = seedDisagreement();
  cutOver();

  const completed = await executeMilestoneStatus({ milestoneId: "M001" }, base);
  assert.equal((completed.details as { status: string }).status, "complete");

  const open = await executeMilestoneStatus({ milestoneId: "M002" }, base);
  const details = open.details as { status: string; slices: unknown };
  assert.equal(details.status, "active");
  assert.deepEqual(details.slices, [
    { id: "S01", status: "pending", taskCounts: { total: 2, done: 1, pending: 1 } },
    { id: "S02", status: "complete", taskCounts: { total: 0, done: 0, pending: 0 } },
  ]);
});

test("after the Cutover deriveState takes the phase and the active unit from the lifecycle rows", async () => {
  const base = seedDisagreement();
  cutOver();

  const state = await deriveState(base);
  assert.deepEqual(
    state.registry.map((entry) => [entry.id, entry.status]),
    [["M001", "complete"], ["M002", "active"], ["M004", "parked"], ["M005", "pending"]],
  );
  assert.deepEqual(
    [state.phase, state.activeMilestone?.id, state.activeSlice?.id, state.activeTask?.id],
    ["executing", "M002", "S01", "T01"],
  );
  assert.deepEqual(state.progress, {
    milestones: { done: 1, total: 4 },
    slices: { done: 1, total: 2 },
    tasks: { done: 1, total: 2 },
  });
});

test("after the Cutover resolveDispatch stops on a canonically completed milestone and dispatches a canonically open one", async () => {
  const base = seedDisagreement();
  cutOver();
  const dispatch = (mid: string) => resolveDispatch({
    basePath: base,
    mid,
    midTitle: mid,
    prefs: undefined,
    state: {
      activeMilestone: { id: mid, title: mid },
      activeSlice: null,
      activeTask: null,
      phase: "needs-discussion",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [{ id: mid, title: mid, status: "active" }],
    },
  });

  const completed = await dispatch("M001");
  assert.equal(completed.action, "stop");
  assert.match(completed.reason, /Milestone M001 is closed \(status: complete\)/);

  const open = await dispatch("M002");
  assert.equal(open.action, "dispatch");
  assert.equal(open.unitType, "discuss-milestone");
});

test("after the Cutover the rule complete → stop dispatches the closeout of a canonically open milestone", async () => {
  const base = seedDisagreement();
  cutOver();

  // M002 is legacy complete and canonical ready: the legacy row says closed.
  const result = await resolveDispatch({
    basePath: base,
    mid: "M002",
    midTitle: "M002",
    prefs: undefined,
    state: {
      activeMilestone: { id: "M002", title: "M002" },
      activeSlice: null,
      activeTask: null,
      phase: "complete",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [{ id: "M002", title: "M002", status: "active" }],
    },
  });

  assert.equal(result.action, "dispatch");
  assert.equal(result.unitType, "complete-milestone");
});

test("after the Cutover parallel eligibility follows the lifecycle status of the dependency", async () => {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Canonical open", status: "complete" });
  insertMilestone({ id: "M002", title: "Blocked dependent", status: "active", depends_on: ["M001"] });
  insertMilestone({ id: "M003", title: "Canonical completed", status: "active" });
  insertMilestone({ id: "M004", title: "Allowed dependent", status: "active", depends_on: ["M003"] });
  seedLifecycles("eligibility", [
    milestone("M001", "ready"),
    milestone("M002", "ready"),
    milestone("M003", "completed"),
    milestone("M004", "ready"),
  ]);
  cutOver();

  const eligibility = await analyzeParallelEligibility(base);
  assert.ok(eligibility.ineligible.some((entry) => entry.milestoneId === "M002"));
  assert.ok(eligibility.eligible.some((entry) => entry.milestoneId === "M004"));
  assert.ok(eligibility.ineligible.some((entry) => entry.milestoneId === "M003"), "a completed milestone is not a candidate");
});

/**
 * S01 is cancelled with no Waiver (the legacy row says skipped). S03 is
 * cancelled by the slice.cancel operation, which grants the Waiver.
 */
function seedCancelledDependencies(): string {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Dependencies", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Cancelled, no Waiver", status: "skipped", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Needs S01", status: "pending", depends: ["S01"], sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M001", title: "Cancelled with Waiver", status: "pending", depends: [], sequence: 3 });
  insertSlice({ id: "S04", milestoneId: "M001", title: "Needs S03", status: "pending", depends: ["S03"], sequence: 4 });
  insertTask({ id: "T01", sliceId: "S04", milestoneId: "M001", title: "Open", status: "pending" });
  seedLifecycles("dependencies", [
    milestone("M001", "ready"),
    slice("M001", "S01", "cancelled"),
    slice("M001", "S02", "ready"),
    slice("M001", "S04", "ready"),
    task("M001", "S04", "T01", "ready"),
  ]);
  cancelSlice({
    invocation: {
      idempotencyKey: "lifecycle-read-cutover/cancel-S03",
      sourceTransport: "pi-tool",
      actorType: "agent",
      actorId: "lifecycle-read-cutover",
    },
    slice: { milestoneId: "M001", sliceId: "S03" },
    reason: "The work of S03 is no longer required.",
  });
  invalidateStateCache();
  return base;
}

test("before the Cutover a legacy skipped dependency still unlocks its dependent", () => {
  const base = seedCancelledDependencies();

  assert.equal(getPriorSliceCompletionBlocker(base, "main", "execute-task", "M001/S02/T01"), null);
});

test("after the Cutover a cancelled dependency unlocks its dependent only with a Waiver", async () => {
  const base = seedCancelledDependencies();
  cutOver();

  assert.deepEqual(
    readMilestoneSlices("M001").map((s) => [s.id, s.done, s.satisfiesDependents]),
    [["S01", true, false], ["S02", false, false], ["S03", true, true], ["S04", false, false]],
  );
  assert.match(
    getPriorSliceCompletionBlocker(base, "main", "execute-task", "M001/S02/T01") ?? "",
    /dependency slice M001\/S01 is not complete/,
  );
  assert.equal(getPriorSliceCompletionBlocker(base, "main", "execute-task", "M001/S04/T01"), null);

  const state = await deriveState(base);
  assert.deepEqual(
    [state.phase, state.activeSlice?.id, state.activeTask?.id],
    ["executing", "S04", "T01"],
    "S02 waits on the cancelled S01; S04 runs because S03 has a Waiver",
  );
});

test("after the Cutover progress and the project snapshot give the same counts from the lifecycle rows", async () => {
  const base = seedDisagreement();
  cutOver();

  const counts = readProgressCounts();
  assert.deepEqual(counts, {
    // M003 is cancelled and is in no count. M001 is done, M004 is parked,
    // M002 is active and M005 is pending.
    milestones: { total: 4, done: 1, active: 1, pending: 1, parked: 1 },
    slices: { total: 2, done: 1, active: 0, pending: 1 },
    tasks: { total: 2, done: 1, pending: 1 },
  });

  const progress = await readProgressFromDb(base);
  assert.ok(progress);
  assert.deepEqual({ milestones: progress.milestones, slices: progress.slices, tasks: progress.tasks }, counts);

  const snapshot = await readProjectSnapshotFromDb(base);
  assert.ok(snapshot);
  assert.equal(snapshot.authority.authorityEpoch, 1);
  assert.deepEqual(snapshot.progress, counts);
  assert.deepEqual(
    snapshot.milestones.items.map((m) => [m.id, m.status]),
    [["M001", "complete"], ["M002", "active"], ["M003", "skipped"], ["M004", "parked"], ["M005", "pending"]],
  );
});

test("after the Cutover the already-closed dispatch check, the open-slice list and the reactive task graph follow the lifecycle rows", async () => {
  seedDisagreement();
  cutOver();

  // T01 and S01 are legacy complete and canonical ready.
  assert.equal(getAlreadyClosedDispatchReason("execute-task", "M002/S01/T01"), null);
  assert.equal(getAlreadyClosedDispatchReason("complete-slice", "M002/S01"), null);
  // T02 and S02 are legacy pending and canonical completed.
  assert.equal(
    getAlreadyClosedDispatchReason("execute-task", "M002/S01/T02"),
    "execute-task M002/S01/T02 is already complete",
  );
  assert.equal(
    getAlreadyClosedDispatchReason("complete-slice", "M002/S02"),
    "complete-slice M002/S02 is already complete",
  );

  assert.deepEqual(findOpenSlices("M002"), ["S01"]);

  assert.deepEqual(
    loadSliceTaskIO("M002", "S01").map((entry) => [entry.id, entry.done]),
    [["T01", false], ["T02", true]],
  );
});

test("slice-parallel eligibility releases a dependent of a cancelled slice only with a Waiver after the Cutover", () => {
  seedCancelledDependencies();
  const eligible = () => getEligibleSlicesFromRows(readMilestoneSlices("M001")).map((entry) => entry.id);

  assert.deepEqual(eligible(), ["S02", "S04"], "before the Cutover the legacy skipped status releases S02");

  cutOver();

  assert.deepEqual(eligible(), ["S04"], "S02 waits on the cancelled S01; S03 has a Waiver");
});

test("after the Cutover the queue commands take closed, parked and discarded from the lifecycle rows", () => {
  const base = seedDisagreement();
  cutOver();

  // M001 is legacy active and canonical completed.
  assert.throws(() => reorderMilestones(base, ["M001"]), /milestone M001 is closed/);
  assert.throws(() => setMilestoneDependencies("M001", []), /milestone M001 is closed \(complete\)/);
  // M003 is legacy active and canonical cancelled.
  assert.throws(
    () => setMilestoneDependencies("M002", ["M003"]),
    /depends_on milestone M003 was discarded/,
  );

  // M002 is legacy complete and canonical ready: it is open and has a place in the queue.
  setMilestoneDependencies("M002", ["M004"]);
  assert.deepEqual(readMilestone("M002")?.depends_on, ["M004"]);
  // M004 is canonical paused: it is outside the queue and M002 does not wait on its position.
  assert.deepEqual(reorderMilestones(base, ["M002"]).order, ["M002", "M005"]);
});

test("after the Cutover a queued row whose lifecycle is completed is not a ghost milestone", () => {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Canonical completed", status: "queued" });
  seedLifecycles("ghost", [milestone("M001", "completed")]);

  assert.equal(isGhostMilestone(base, "M001"), true, "before the Cutover a queued row with no files is a ghost");

  cutOver();

  assert.equal(isGhostMilestone(base, "M001"), false);
});

/**
 * Four canonically ready Milestones: M001 has no planning behind it and its
 * legacy row is pending. M002 has a saved CONTEXT row, M003 has a Slice row,
 * and M004 is a queued shell in both rows.
 */
function seedQueuedShellDisagreement(): string {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Shell, legacy pending", status: "pending" });
  insertMilestone({ id: "M002", title: "Shell with context", status: "queued" });
  insertMilestone({ id: "M003", title: "Shell with slices", status: "queued" });
  insertMilestone({ id: "M004", title: "Shell in both rows", status: "queued" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "Planned", status: "pending", depends: [], sequence: 1 });
  insertArtifact({
    path: "milestones/M002/M002-CONTEXT.md",
    artifact_type: "CONTEXT",
    milestone_id: "M002",
    slice_id: null,
    task_id: null,
    full_content: "# M002\n",
  });
  seedLifecycles("queued-shell", [
    milestone("M001", "ready"),
    milestone("M002", "ready"),
    milestone("M003", "ready"),
    milestone("M004", "ready"),
    slice("M003", "S01", "ready"),
  ]);
  invalidateStateCache();
  return base;
}

test("a queued shell is a lifecycle row in ready with no CONTEXT artifact row and no Slice rows", () => {
  seedQueuedShellDisagreement();
  const shells = () => readMilestones().map((m) => [m.id, m.queuedShell]);

  assert.deepEqual(shells(), [["M001", false], ["M002", false], ["M003", false], ["M004", true]],
    "before the Cutover the legacy queued label answers");

  cutOver();

  assert.deepEqual(shells(), [["M001", true], ["M002", false], ["M003", false], ["M004", true]],
    "after the Cutover the lifecycle row answers: ready with no CONTEXT row and no Slices");
});

test("after the Cutover the readiness class takes the queued shell from the canonical field, not the legacy label", async () => {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Shell, nothing behind it", status: "pending" });
  insertMilestone({ id: "M002", title: "Shell with a draft", status: "pending" });
  insertArtifact({
    path: "milestones/M002/M002-CONTEXT-DRAFT.md",
    artifact_type: "CONTEXT-DRAFT",
    milestone_id: "M002",
    slice_id: null,
    task_id: null,
    full_content: "# M002 draft\n",
  });
  seedLifecycles("readiness", [milestone("M001", "ready"), milestone("M002", "ready")]);
  invalidateStateCache();

  const before = await deriveState(base);
  assert.deepEqual(before.registry.map((e) => [e.id, e.status]), [["M001", "active"], ["M002", "pending"]],
    "before the Cutover the legacy pending row is planning-pending and is the active milestone");

  cutOver();

  // M001 is a queued shell that no sequence names and that has no draft: it
  // is not promoted. M002 has a draft, so its shell resumes the discussion.
  const after = await deriveState(base);
  assert.deepEqual(after.registry.map((e) => [e.id, e.status]), [["M001", "pending"], ["M002", "active"]]);
  assert.equal(after.activeMilestone?.id, "M002");
  assert.equal(after.phase, "needs-discussion");
});

test("after the Cutover the milestone branch audit takes completion from the lifecycle rows", () => {
  const base = seedDisagreement();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: base, stdio: ["ignore", "pipe", "pipe"] });
  git("init");
  git("config", "user.email", "test@test.com");
  git("config", "user.name", "Test");
  writeFileSync(join(base, ".gitignore"), ".gsd/\n");
  git("add", ".gitignore");
  git("commit", "-m", "init");
  git("branch", "-M", "main");
  // M001 (legacy active, canonical completed): a branch that is merged in main.
  git("branch", "milestone/M001");
  // M002 (legacy complete, canonical ready): a branch with work that main does not have.
  git("checkout", "-b", "milestone/M002");
  writeFileSync(join(base, "feature.txt"), "work\n");
  git("add", "feature.txt");
  git("commit", "-m", "work on M002");
  git("checkout", "main");
  cutOver();

  assert.equal(findUnmergedCompletedMilestone(base, "worktree"), null, "M002 is not complete");

  const audit = auditOrphanedMilestoneBranches(base, "branch");
  assert.deepEqual(
    audit.actions.map((action) => [action.kind, action.milestoneId]),
    [["complete-merged-branch", "M001"], ["in-progress-stranded-work", "M002"]],
  );
  assert.equal(git("branch", "--list", "milestone/M001").toString().trim(), "");
});

test("the single-item reads and the closed Slice list follow the Authority Epoch", () => {
  seedDisagreement();
  const answers = () => ({
    slices: ["S01", "S02"].map((id) => [id, readSlice("M002", id)?.closed]),
    tasks: ["T01", "T02"].map((id) => [id, readTask("M002", "S01", id)?.done]),
    closedSliceIds: readClosedSliceIds("M002"),
    missing: [readSlice("M002", "S99"), readTask("M002", "S01", "T99")],
  });

  assert.deepEqual(answers(), {
    slices: [["S01", true], ["S02", false]],
    tasks: [["T01", true], ["T02", false]],
    closedSliceIds: ["S01"],
    missing: [null, null],
  });

  cutOver();

  assert.deepEqual(answers(), {
    slices: [["S01", false], ["S02", true]],
    tasks: [["T01", false], ["T02", true]],
    closedSliceIds: ["S02"],
    missing: [null, null],
  });
});

test("a deferred Slice is done but not closed before the Cutover, and closed after it", () => {
  makeProject();
  insertMilestone({ id: "M001", title: "Deferred slice", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Deferred", status: "deferred", depends: [], sequence: 1 });
  seedLifecycles("deferred", [milestone("M001", "ready"), slice("M001", "S01", "cancelled")]);
  const answer = () => [readSlice("M001", "S01")?.done, readSlice("M001", "S01")?.closed, readClosedSliceIds("M001")];

  assert.deepEqual(answer(), [true, false, []]);

  cutOver();

  assert.deepEqual(answer(), [true, true, ["S01"]]);
});

test("after the Cutover the terminal closeout skip and the complete-milestone guard follow the lifecycle rows", async () => {
  const base = seedDisagreement();
  cutOver();
  const session = { basePath: base, originalBasePath: base, completionStopInProgress: false } as unknown as AutoSession;
  const state = { phase: "complete" as const, activeMilestone: null };

  // M001 is legacy active and canonical completed. M002 is legacy complete and canonical ready.
  assert.deepEqual(
    await shouldSkipTerminalMilestoneCloseout(session, state, "M001"),
    { skip: true, milestoneId: "M001" },
  );
  assert.deepEqual(
    await shouldSkipTerminalMilestoneCloseout(session, state, "M002"),
    { skip: false, milestoneId: "M002" },
  );

  const guard = (mid: string) => evaluateGuardedCompleteMilestoneDispatch({
    basePath: base,
    mid,
    midTitle: mid,
    prefs: { uat_dispatch: true },
    preview: true,
    state: {
      activeMilestone: { id: mid, title: mid },
      activeSlice: null,
      activeTask: null,
      phase: "completing-milestone",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [{ id: mid, title: mid, status: "active" }],
    },
  });

  assert.deepEqual(await guard("M001"), { action: "skip" });
  // The UAT sign-off check runs for the closed Slices. S02 is the canonically
  // closed Slice of M002; the legacy row names S01.
  const open = await guard("M002");
  assert.equal(open.action, "stop");
  assert.match(open.action === "stop" ? open.reason : "", /missing UAT PASS verdict for S02/);
});

/** Make the project a git repository with one commit on main. `.gsd/` is not tracked. */
function initRepository(base: string): (...args: string[]) => Buffer {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: base, stdio: ["ignore", "pipe", "pipe"] });
  git("init");
  git("config", "user.email", "test@test.com");
  git("config", "user.name", "Test");
  writeFileSync(join(base, ".gitignore"), ".gsd/\n");
  git("add", ".gitignore");
  git("commit", "-m", "init");
  git("branch", "-M", "main");
  return git;
}

test("after the Cutover the closeout consistency gate follows the lifecycle rows", () => {
  const base = makeProject();
  // The gate reads the source revision of the repository.
  initRepository(base);
  // M001 is legacy complete and canonical ready. S01 is complete in both rows;
  // its Task T01 is legacy pending and canonical completed. S02 is legacy
  // complete and canonical ready.
  insertMilestone({ id: "M001", title: "Canonical open", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Completed", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Canonical open", status: "complete", depends: [], sequence: 2 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Canonical completed", status: "pending" });
  // M002 is legacy active and canonical cancelled, and has no Slice.
  insertMilestone({ id: "M002", title: "Canonical cancelled", status: "active" });
  seedLifecycles("closeout-gate", [
    milestone("M001", "ready"),
    slice("M001", "S01", "completed"),
    slice("M001", "S02", "ready"),
    task("M001", "S01", "T01", "completed"),
    milestone("M002", "cancelled"),
  ]);
  const gate = (milestoneId: string, allowOpenMilestone: boolean) => {
    const result = checkCloseoutConsistencyGate(milestoneId, {
      allowOpenMilestone,
      assumeValidationWaived: true,
      artifactBasePath: base,
    });
    return result.ok ? "ok" : result.reason;
  };
  const answers = () => [gate("M001", false), gate("M001", true), gate("M002", true)];

  // The lifecycle rows: M001 is closed and its Task T01 is open. M002 is open and has no Slice.
  assert.deepEqual(answers(), ["task-open", "task-open", "slice-missing"]);

  cutOver();

  // The lifecycle rows: M001 is open, T01 is done and S02 is open. M002 is discarded.
  assert.deepEqual(answers(), ["milestone-open", "slice-open", "ok"]);
});

test("after the Cutover rogue file detection, the roadmap repair, task durability and artifact verification follow the lifecycle rows", async () => {
  const base = seedDisagreement();
  const tasksDirectory = join(base, ".gsd", "milestones", "M002", "slices", "S01", "tasks");
  mkdirSync(tasksDirectory, { recursive: true });
  for (const taskId of ["T01", "T02"]) writeFileSync(join(tasksDirectory, `${taskId}-SUMMARY.md`), `# ${taskId}\n`);
  const rogueCount = (taskId: string) => detectRogueFileWrites("execute-task", `M002/S01/${taskId}`, base).length;
  const repairs = (sliceId: string) =>
    _repairCompleteSliceRoadmapProjectionForTest("complete-slice", `M002/${sliceId}`, base);

  // T01 and S01 are legacy complete and canonical ready. T02 and S02 are
  // legacy pending and canonical completed.
  assert.deepEqual([rogueCount("T01"), rogueCount("T02")], [0, 1]);
  assert.equal(await repairs("S02"), false);

  cutOver();

  assert.deepEqual([rogueCount("T01"), rogueCount("T02")], [1, 0]);
  assert.equal(await repairs("S01"), false);
  assert.equal(await repairs("S02"), true);
  assert.deepEqual(inspectExecuteTaskDurability("M002/S01/T01"), { dbComplete: false });
  assert.deepEqual(inspectExecuteTaskDurability("M002/S01/T02"), { dbComplete: true });
  assert.equal(verifyExpectedArtifact("complete-slice", "M002/S01", base, { readOnly: true }), false);
  assert.equal(verifyExpectedArtifact("complete-slice", "M002/S02", base, { readOnly: true }), true);
  assert.equal(verifyExpectedArtifact("reactive-execute", "M002/S01/batch+T01", base, { readOnly: true }), false);
  assert.equal(verifyExpectedArtifact("reactive-execute", "M002/S01/batch+T02", base, { readOnly: true }), true);
  // The pre-execution checks skip a Task that needs no further work.
  assert.deepEqual(
    checkVerificationCommands(
      readSliceTasks("M002", "S01").map((row) => ({ ...row, verify: "gsd_task_complete" })),
    ).map((check) => check.target),
    ["T01 Verify"],
  );
});

test("after the Cutover the unmerged-milestone guard and the stranded-branch hint report the canonically closed milestone", async () => {
  const base = seedDisagreement();
  const git = initRepository(base);
  // M001 (legacy active, canonical completed) and M002 (legacy complete,
  // canonical ready) each have a branch with work that main does not have.
  for (const milestoneId of ["M001", "M002"]) {
    git("checkout", "-b", `milestone/${milestoneId}`);
    writeFileSync(join(base, `${milestoneId}.txt`), "work\n");
    git("add", `${milestoneId}.txt`);
    git("commit", "-m", `work on ${milestoneId}`);
    git("checkout", "main");
  }
  const blocked = async () => (await findUnmergedCompletedMilestones(base)).map((blocker) => blocker.milestoneId);
  const stranded = () => detectIdleMilestoneResidueHint(base)?.milestoneIds;

  assert.deepEqual(await blocked(), ["M002"]);
  assert.deepEqual(stranded(), ["M002"]);

  cutOver();

  assert.deepEqual(await blocked(), ["M001"]);
  assert.deepEqual(stranded(), ["M001"]);
});

test("after the Cutover park, unpark and discard take parked and closed from the lifecycle rows", async () => {
  const base = seedDisagreement();

  assert.equal(isParked("M004"), false, "before the Cutover the legacy row of M004 is active");

  cutOver();

  // M004 is legacy active and canonical paused. M001 is legacy active and canonical completed.
  assert.equal(isParked("M004"), true);
  assert.equal(await parkMilestone(base, "M004", "already parked"), false);
  assert.equal(await parkMilestone(base, "M001", "closed"), false);
  await assert.rejects(discardMilestone(base, "M001"), /M001 is already closed \(complete\)/);
  assert.equal(await unparkMilestone(base, "M004"), true);
  assert.equal(isParked("M004"), false);
});

test("after the Cutover undo and a duplicate task completion take the task state from the lifecycle rows", async () => {
  const base = seedDisagreement();
  const db = _getAdapter();
  assert.ok(db);
  db.prepare(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath
    ) VALUES ('cutover-worker', 'test-host', 1, '2026-10-04T00:00:00.000Z', 'test',
      '2026-10-04T00:00:00.000Z', 'active', :root)
  `).run({ ":root": base });
  db.prepare(`
    INSERT INTO unit_dispatches (
      trace_id, worker_id, milestone_lease_token, milestone_id, slice_id, task_id,
      unit_type, unit_id, status, attempt_n, started_at, ended_at
    ) VALUES (
      'trace-T01', 'cutover-worker', 1, 'M002', 'S01', 'T01',
      'execute-task', 'M002/S01/T01', 'completed', 1, '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z'
    )
  `).run();
  cutOver();

  // T01 is legacy complete and canonical ready: there is no completion to undo.
  const undone = await undoLastCompletedUnit(base);
  assert.equal(undone.success, false);
  assert.match(undone.message, /Nothing to undo — execute-task \(M002\/S01\/T01\) is already open/);

  const complete = (taskId: string) => executeTaskComplete({
    milestoneId: "M002",
    sliceId: "S01",
    taskId,
    oneLiner: "Duplicate completion",
    narrative: "A second completion call with no verification.",
  }, base);
  // T02 is legacy pending and canonical completed: the call is a duplicate.
  assert.equal((await complete("T02")).details["duplicate"], true);
  assert.equal((await complete("T01")).details["error"], "verification_required");
});

test("after the Cutover the run-uat candidates, the UAT hold and the reassessment check follow the lifecycle rows", async () => {
  const base = seedDisagreement();
  const uat = ["# UAT", "", "## UAT Type", "- UAT mode: runtime-executable"].join("\n");
  setSliceUatMd("M002", "S01", uat);
  setSliceUatMd("M002", "S02", uat);
  const state = await deriveState(base);
  const answers = async () => ({
    runUat: (await checkNeedsRunUat(base, "M002", undefined))?.sliceId,
    awaitsUat: ["S01", "S02"].map((sliceId) => sliceAwaitsUatVerdict(base, "M002", sliceId)),
    reassess: (await checkNeedsReassessment(base, "M002", state))?.sliceId,
    completed: (await loadRoadmapCompletedSliceCandidates(base, "M002")).map((candidate) => candidate.sliceId),
  });

  // S01 is legacy complete and canonical ready. S02 is legacy pending and canonical completed.
  assert.deepEqual(await answers(), { runUat: "S01", awaitsUat: [true, false], reassess: "S01", completed: ["S01"] });

  cutOver();

  assert.deepEqual(await answers(), { runUat: "S02", awaitsUat: [false, true], reassess: "S02", completed: ["S02"] });
});

test("after the Cutover a scoped pause is stale when the lifecycle row of its milestone or slice is closed", () => {
  seedDisagreement();
  const db = _getAdapter();
  assert.ok(db);
  for (const scope of ["M001", "M002", "M002/S01", "M002/S02"]) {
    db.prepare(`
      INSERT INTO auto_pauses (scope, blocker_kind, step_mode, paused_at)
      VALUES (:scope, 'user_request', 0, '2026-10-04T00:00:00.000Z')
    `).run({ ":scope": scope });
  }

  // The legacy rows: M002 is complete, so each pause in M002 is stale.
  assert.deepEqual(findStaleScopedPauses(), ["M002", "M002/S01", "M002/S02"]);

  cutOver();

  // The lifecycle rows: M001 is completed. M002 is open and its Slice S02 is completed.
  assert.deepEqual(findStaleScopedPauses(), ["M001", "M002/S02"]);
});

/**
 * Rows for the planning and completion commands. M002 is legacy complete and
 * canonical ready, and so are its Slices S01 and S03 and the Tasks T02 and T03
 * of S01 and T01 of S03. S02 and the Task T01 of S01 are legacy pending and
 * canonical completed. M001 is legacy active and canonical completed. M003 is
 * legacy active and canonical cancelled. M004 is legacy complete and canonical
 * pending.
 */
function seedPlanningDisagreement(): string {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Canonical completed", status: "active" });
  insertMilestone({ id: "M002", title: "Canonical open", status: "complete" });
  insertMilestone({ id: "M003", title: "Canonical cancelled", status: "active" });
  insertMilestone({ id: "M004", title: "Canonical pending", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Canonical open", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M002", title: "Canonical completed", status: "pending", depends: [], sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M002", title: "Canonical open", status: "complete", depends: [], sequence: 3 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M002", title: "Canonical completed", status: "pending" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M002", title: "Canonical open", status: "complete" });
  insertTask({ id: "T03", sliceId: "S01", milestoneId: "M002", title: "Canonical open", status: "complete" });
  insertTask({ id: "T01", sliceId: "S03", milestoneId: "M002", title: "Canonical open", status: "complete" });
  seedLifecycles("planning-disagreement", [
    milestone("M001", "completed"),
    milestone("M002", "ready"),
    milestone("M003", "cancelled"),
    milestone("M004", "pending"),
    slice("M002", "S01", "ready"),
    slice("M002", "S02", "completed"),
    slice("M002", "S03", "ready"),
    task("M002", "S01", "T01", "completed"),
    task("M002", "S01", "T02", "ready"),
    task("M002", "S01", "T03", "ready"),
    task("M002", "S03", "T01", "ready"),
  ]);
  invalidateStateCache();
  return base;
}

/** A command context that records its notifications, and a session that records the prompts it gets. */
function makeCommandSession() {
  const notifications: string[] = [];
  const prompts: string[] = [];
  const ctx = {
    ui: {
      notify: (message: string) => { notifications.push(message); },
      setStatus: () => {},
    },
  } as never;
  const pi = {
    sendMessage: (message: { content: string }) => { prompts.push(message.content); },
  } as never;
  return { ctx, pi, notifications, prompts };
}

/**
 * The seeded disagreement, plus a milestone directory M009 that has no row and
 * a SUMMARY for each Milestone. No Milestone row has a directory.
 */
function seedUniverseDisagreement(t: { after: (fn: () => void) => void }): string {
  const base = seedDisagreement();
  mkdirSync(join(base, ".gsd", "milestones", "M009"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M009", "M009-SUMMARY.md"), "# M009\n\nSUMMARY-OF-M009\n");
  for (const id of ["M001", "M002", "M003"]) {
    insertArtifact({
      path: `milestones/${id}/${id}-SUMMARY.md`,
      artifact_type: "SUMMARY",
      milestone_id: id,
      slice_id: null,
      task_id: null,
      full_content: `# ${id}\n\nSUMMARY-OF-${id}\n`,
    });
  }
  const previousCwd = process.cwd();
  t.after(() => process.chdir(previousCwd));
  process.chdir(base);
  return base;
}

test("the Milestone universe is the listed rows of the read interface, never the milestone directories", (t) => {
  seedUniverseDisagreement(t);

  assert.deepEqual(readListedMilestoneIds(), ["M001", "M002", "M003", "M004", "M005"]);

  cutOver();

  // M003 is legacy active and canonical cancelled: a tombstone is not listed.
  assert.deepEqual(readListedMilestoneIds(), ["M001", "M002", "M004", "M005"]);
});

test("after the Cutover /gsd auto and /gsd next refuse a Milestone that the lifecycle rows do not list", async (t) => {
  seedUniverseDisagreement(t);
  cutOver();

  for (const command of ["auto M003", "next M009"]) {
    const { ctx, pi, notifications } = makeCommandSession();
    assert.equal(await handleAutoCommand(command, ctx, pi), true);
    const target = command.split(" ")[1];
    assert.deepEqual(
      notifications.filter((message) => message.includes("does not exist")),
      [`Milestone ${target} does not exist. Available: M001, M002, M004, M005`],
    );
    assert.equal(isAutoActive(), false);
  }
});

test("after the Cutover the prior Milestone summaries of a discuss prompt follow the lifecycle rows", async (t) => {
  const base = seedUniverseDisagreement(t);

  const before = await buildDiscussMilestoneInlinedContext("M004", base);
  assert.match(before, /SUMMARY-OF-M001/);
  assert.match(before, /SUMMARY-OF-M002/);
  assert.match(before, /SUMMARY-OF-M003/, "before the Cutover M003 is listed (legacy active)");

  cutOver();

  const after = await buildDiscussMilestoneInlinedContext("M004", base);
  assert.match(after, /SUMMARY-OF-M001/);
  assert.match(after, /SUMMARY-OF-M002/);
  assert.doesNotMatch(after, /SUMMARY-OF-M003/, "a cancelled Milestone is not a prior Milestone");
  assert.doesNotMatch(after, /SUMMARY-OF-M009/, "a directory with no row is not a Milestone");
});

test("after the Cutover /gsd rethink lists the Milestones of the lifecycle rows", async (t) => {
  seedUniverseDisagreement(t);
  cutOver();

  const { ctx, pi, prompts } = makeCommandSession();
  await handleRethink("", ctx, pi);

  assert.equal(prompts.length, 1);
  const rows = prompts[0]!.split("\n").filter((line) => /^\| \d+ \| /.test(line)).map((line) => line.split(" | ")[1]);
  assert.deepEqual(rows, ["M001", "M002", "M004", "M005"]);
  assert.match(prompts[0]!, /— 4 total/);
});

test("a milestone directory with no row is no Milestone for /gsd queue and /gsd rethink", async (t) => {
  const base = makeProject();
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");
  const previousCwd = process.cwd();
  t.after(() => process.chdir(previousCwd));
  process.chdir(base);

  const queue = makeCommandSession();
  await showQueue(queue.ctx, queue.pi, base);
  assert.deepEqual(queue.notifications, ["No milestones exist yet. Run /gsd to create the first one."]);

  const rethink = makeCommandSession();
  await handleRethink("", rethink.ctx, rethink.pi);
  assert.equal(rethink.notifications.at(-1), "No milestones exist yet. Nothing to rethink.");
  assert.deepEqual(rethink.prompts, []);
});

/**
 * One active Milestone whose Slices and Tasks disagree: S01, S02, T01 and T02
 * are legacy complete and canonical ready; S03 and T03 are legacy pending and
 * canonical completed.
 */
function seedDashboardDisagreement(): string {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Dashboard", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Open one", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Open two", status: "complete", depends: [], sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M001", title: "Completed", status: "pending", depends: [], sequence: 3 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Open one", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Open two", status: "complete" });
  insertTask({ id: "T03", sliceId: "S01", milestoneId: "M001", title: "Completed", status: "pending" });
  seedLifecycles("dashboard", [
    milestone("M001", "in_progress"),
    slice("M001", "S01", "ready"),
    slice("M001", "S02", "ready"),
    slice("M001", "S03", "completed"),
    task("M001", "S01", "T01", "ready"),
    task("M001", "S01", "T02", "ready"),
    task("M001", "S01", "T03", "completed"),
  ]);
  invalidateStateCache();
  return base;
}

function plannedTask(taskId: string) {
  return {
    taskId,
    title: `Planned ${taskId}`,
    description: "Planned after the Cutover.",
    estimate: "30m",
    files: ["src/planned.ts"],
    verify: "node --test src/planned.test.ts",
    inputs: ["src/planned.ts"],
    expectedOutput: ["src/planned.ts"],
    requiredWorkflowTools: [] as string[],
  };
}

function errorOf(result: object): string | undefined {
  return "error" in result ? String(result.error) : undefined;
}

test("after the Cutover plan-slice takes the closed milestone, slice and tasks from the lifecycle rows", async () => {
  const base = seedPlanningDisagreement();
  const plan = () => handlePlanSlice({
    milestoneId: "M002",
    sliceId: "S03",
    goal: "Plan the slice again.",
    successCriteria: "- The plan is stored",
    proofLevel: "integration",
    integrationClosure: "The handler stores the plan rows.",
    observabilityImpact: "- A refusal returns an error",
    tasks: [plannedTask("T02")],
  }, base, internalPlanningInvocation());

  assert.match(errorOf(await plan()) ?? "", /cannot plan slice in a closed milestone: M002 \(status: complete\)/);

  cutOver();

  // M002, S03 and its Task T01 are legacy complete and canonical ready: the
  // plan is accepted, and it removes T01, which the new plan does not name.
  assert.equal(errorOf(await plan()), undefined);
  assert.deepEqual(
    readSliceTasks("M002", "S03").map((row) => [row.id, row.done]),
    [["T01", true], ["T02", false]],
  );
});

test("after the Cutover plan-task and replan-task take the closed slice and task from the lifecycle rows", async () => {
  const base = seedPlanningDisagreement();
  const { taskId: _taskId, ...taskPlan } = plannedTask("T02");
  const planTask = () => handlePlanTask(
    { milestoneId: "M002", sliceId: "S01", taskId: "T02", ...taskPlan },
    base,
    internalPlanningInvocation(),
  );
  const replanTask = (taskId: string) => handleReplanTask(
    { milestoneId: "M002", sliceId: "S01", taskId, ...taskPlan, reworkBriefRef: "RB-001" },
    base,
    internalPlanningInvocation(),
  );

  assert.match(errorOf(await planTask()) ?? "", /cannot plan task in a closed slice: S01 \(status: complete\)/);
  assert.match(errorOf(await replanTask("T03")) ?? "", /cannot replan a task in a closed slice: S01 \(status: complete\)/);

  cutOver();

  // S01, T02 and T03 are legacy complete and canonical ready. T01 is legacy
  // pending and canonical completed.
  assert.equal(errorOf(await planTask()), undefined);
  assert.equal(errorOf(await replanTask("T03")), undefined);
  assert.match(errorOf(await replanTask("T01")) ?? "", /cannot replan completed task T01/);
});

test("after the Cutover replan-slice takes the closed milestone, the blocker and the completed tasks from the lifecycle rows", async () => {
  const base = seedPlanningDisagreement();
  const replan = () => handleReplanSlice({
    milestoneId: "M002",
    sliceId: "S01",
    blockerTaskId: "T01",
    blockerDescription: "T01 found a blocker.",
    whatChanged: "T02 uses the new interface.",
    updatedTasks: [plannedTask("T02")],
    removedTaskIds: ["T03"],
  }, base, internalPlanningInvocation());

  assert.match(errorOf(await replan()) ?? "", /cannot replan a slice in a closed milestone: M002 \(status: complete\)/);

  cutOver();

  // The blocker T01 is legacy pending and canonical completed. T02 and T03
  // are legacy complete and canonical ready, so the replan can change them.
  assert.equal(errorOf(await replan()), undefined);
  assert.deepEqual(
    readSliceTasks("M002", "S01").map((row) => [row.id, row.status]),
    [["T01", "complete"], ["T02", "pending"], ["T03", "skipped"]],
  );
});

test("after the Cutover reassess-roadmap takes the closed milestone and the completed slices from the lifecycle rows", async () => {
  const base = seedPlanningDisagreement();
  const reassess = (completedSliceId: string, modifiedSliceId: string) => handleReassessRoadmap({
    milestoneId: "M002",
    completedSliceId,
    verdict: "confirmed",
    assessment: "The roadmap is on track.",
    sliceChanges: {
      modified: [{ sliceId: modifiedSliceId, title: "Changed after the Cutover", risk: "high", depends: [], demo: "Changed demo." }],
      added: [],
      removed: [],
    },
  }, base, internalPlanningInvocation());

  assert.match(errorOf(await reassess("S02", "S01")) ?? "", /cannot reassess a closed milestone: M002 \(status: complete\)/);

  cutOver();

  // S01 is legacy complete and canonical ready: it is not a completed slice.
  assert.match(errorOf(await reassess("S01", "S03")) ?? "", /completedSliceId S01 is not complete/);
  // S02 is legacy pending and canonical completed: it cannot be changed.
  assert.match(errorOf(await reassess("S02", "S02")) ?? "", /cannot modify completed slice S02/);
  assert.equal(errorOf(await reassess("S02", "S01")), undefined);
  assert.equal(readSlice("M002", "S01")?.title, "Changed after the Cutover");
});

test("after the Cutover a blocker report takes the closed milestone, slice and task from the lifecycle rows", async () => {
  const base = seedPlanningDisagreement();
  const report = () => handleCompleteTask({
    milestoneId: "M002",
    sliceId: "S01",
    taskId: "T01",
    oneLiner: "Found a blocker",
    narrative: "The task cannot continue.",
    verification: "Not run.",
    blockerDiscovered: true,
  }, base);

  assert.match(errorOf(await report()) ?? "", /cannot complete task in a closed milestone: M002 \(status: complete\)/);

  cutOver();

  // M002 and S01 are canonical ready. T01 is legacy pending and canonical completed.
  assert.match(errorOf(await report()) ?? "", /task T01 is already complete/);
});

test("after the Cutover plan-milestone takes the closed milestone and its dependencies from the lifecycle rows", async () => {
  const base = seedPlanningDisagreement();
  const plan = (milestoneId: string, dependsOn: string[]) => persistMilestonePlan({
    milestoneId,
    title: "Planned after the Cutover",
    vision: "The plan follows the lifecycle rows.",
    dependsOn,
    slices: [{
      sliceId: "S01",
      title: "First slice",
      risk: "low",
      depends: [],
      demo: "The plan is stored.",
      goal: "Store the plan.",
      successCriteria: "The plan rows exist.",
      proofLevel: "integration",
      integrationClosure: "The roadmap renders from the rows.",
      observabilityImpact: "A refusal returns an error.",
    }],
  }, base, internalPlanningInvocation());

  assert.match(errorOf(await plan("M004", [])) ?? "", /cannot re-plan milestone M004: it is already complete/);
  assert.match(errorOf(await plan("M006", ["M001"])) ?? "", /depends_on milestone M001 is not yet complete \(status: active\)/);

  cutOver();

  // M003 is legacy active and canonical cancelled. M002 is legacy complete and canonical ready.
  assert.match(errorOf(await plan("M006", ["M003"])) ?? "", /depends_on milestone M003 was discarded/);
  assert.match(errorOf(await plan("M006", ["M002"])) ?? "", /depends_on milestone M002 is not yet complete/);
  // M004 is legacy complete and canonical pending: the precondition accepts
  // it, and the plan's status projection refuses the rows that disagree.
  assert.match(
    errorOf(await plan("M004", [])) ?? "",
    /Cannot project Milestone M004 legacy status active; canonical lifecycle is pending/,
  );
  // M001 is legacy active and canonical completed.
  assert.equal(errorOf(await plan("M006", ["M001"])), undefined);
  assert.equal(readSlice("M006", "S01")?.title, "First slice");
});

test("after the Cutover the branch cleanup tries to delete the branch of a canonically complete milestone only", async () => {
  const base = seedDisagreement();
  const git = initRepository(base);
  git("branch", "milestone/M001");
  git("branch", "milestone/M002");
  // The cleanup skips a milestone branch that a worktree holds, and a branch
  // with no worktree. It reaches the status check only for the branch that
  // the project root has checked out, and git refuses to delete that branch.
  // The warning of the refused delete shows which branch the cleanup chose.
  const refusedDeletes = async (milestoneId: string) => {
    git("checkout", `milestone/${milestoneId}`);
    _resetLogs();
    await handleCleanupBranches({ ui: { notify() {} } } as never, base);
    return drainLogs().map((entry) => entry.message.replace(/:.*$/s, ""));
  };

  // M001 is legacy active and canonical completed. M002 is legacy complete and canonical ready.
  assert.deepEqual(await refusedDeletes("M001"), []);
  assert.deepEqual(await refusedDeletes("M002"), ["stale milestone branch delete failed for milestone/M002"]);

  cutOver();

  assert.deepEqual(await refusedDeletes("M001"), ["stale milestone branch delete failed for milestone/M001"]);
  assert.deepEqual(await refusedDeletes("M002"), []);
  assert.deepEqual(
    git("branch", "--list", "milestone/*", "--format=%(refname:short)").toString().trim().split("\n"),
    ["milestone/M001", "milestone/M002"],
  );
});

test("after the Cutover the doctor scope is the first milestone with a canonically open slice", async () => {
  const base = makeProject();
  // No Milestone is active: both are parked. The Slice of M001 is legacy
  // complete and canonical ready. The Slice of M002 is legacy pending and
  // canonical completed.
  insertMilestone({ id: "M001", title: "Canonical open slice", status: "parked" });
  insertMilestone({ id: "M002", title: "Canonical completed slice", status: "parked" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Canonical open", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Canonical completed", status: "pending", depends: [], sequence: 1 });
  seedLifecycles("doctor-scope", [
    milestone("M001", "paused"),
    milestone("M002", "paused"),
    slice("M001", "S01", "ready"),
    slice("M002", "S01", "completed"),
  ]);
  invalidateStateCache();

  assert.equal(await selectDoctorScope(base), "M002");

  cutOver();

  assert.equal(await selectDoctorScope(base), "M001");
});

test("after the Cutover the discuss flow takes the complete slices from the lifecycle rows", async () => {
  const base = seedDisagreement();
  const complete = async () =>
    (await _loadDiscussNormSlicesForTest(base, "M002")).filter((entry) => entry.done).map((entry) => entry.id);

  // S01 is legacy complete and canonical ready. S02 is legacy pending and canonical completed.
  assert.deepEqual(await complete(), ["S01"]);

  cutOver();

  assert.deepEqual(await complete(), ["S02"]);
});

test("after the Cutover the progress widget counts done Slices and Tasks from the lifecycle rows", (t) => {
  const base = seedDashboardDisagreement();
  t.after(() => clearSliceProgressCache());

  updateSliceProgressCache(base, "M001", "S01");
  assert.deepEqual(
    [getRoadmapSlicesSync()?.done, getRoadmapSlicesSync()?.activeSliceTasks?.done],
    [2, 2],
    "before the Cutover the legacy rows answer",
  );

  cutOver();
  updateSliceProgressCache(base, "M001", "S01");

  assert.deepEqual(getRoadmapSlicesSync(), {
    done: 1,
    total: 3,
    milestoneId: "M001",
    activeSliceTasks: { done: 1, total: 3 },
    taskDetails: [
      { id: "T01", title: "Open one", done: false },
      { id: "T02", title: "Open two", done: false },
      { id: "T03", title: "Completed", done: true },
    ],
  });
});

test("after the Cutover the dashboard overlay marks done Slices and Tasks from the lifecycle rows", async (t) => {
  const base = seedDashboardDisagreement();
  cutOver();
  autoSession.reset();
  autoSession.basePath = base;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const overlay = new GSDDashboardOverlay({ requestRender() {} }, theme as never, () => {});
  t.after(() => {
    overlay.dispose();
    autoSession.reset();
  });

  await (overlay as unknown as { refreshInFlight: Promise<void> | null }).refreshInFlight;

  const view = (overlay as unknown as {
    milestoneData: { slices: Array<{ id: string; done: boolean; tasks: Array<{ id: string; done: boolean }> }> } | null;
  }).milestoneData;
  assert.deepEqual(view?.slices.map((s) => [s.id, s.done]), [["S01", false], ["S02", false], ["S03", true]]);
  assert.deepEqual(
    view?.slices.find((s) => s.id === "S01")?.tasks.map((task) => [task.id, task.done]),
    [["T01", false], ["T02", false], ["T03", true]],
  );
});
