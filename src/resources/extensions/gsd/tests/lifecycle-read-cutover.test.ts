// Project/App: gsd-pi
// File Purpose: Behavior tests for the read cutover. On a Project whose
// Authority Epoch has advanced, status, phase, dispatch eligibility and
// dependencies follow the canonical lifecycle rows when legacy rows disagree.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { resolveDispatch } from "../auto-dispatch.ts";
import {
  _executeAuthorityCutoverDomainOperation,
  executeDomainOperation,
  type DomainOperationContext,
  type DomainOperationMutation,
} from "../db/domain-operation.ts";
import {
  readMilestoneSlices,
  readMilestones,
  readProgressCounts,
  readSliceTasks,
} from "../db/lifecycle-read.ts";
import { insertAuthorityCutoverReceipt } from "../db/writers/authority-recovery.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import { getPriorSliceCompletionBlocker } from "../dispatch-guard.ts";
import { closeDatabase, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.ts";
import { analyzeParallelEligibility } from "../parallel-eligibility.ts";
import { cancelSlice } from "../slice-lifecycle-domain-operation.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import { readProgressFromDb } from "../state/progress-from-db.ts";
import { readProjectSnapshotFromDb } from "../state/project-snapshot.ts";
import { executeMilestoneStatus } from "../tools/workflow-tool-executors.ts";

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

test("after the Cutover parallel eligibility follows the lifecycle status of the dependency", async () => {
  const base = makeProject();
  for (const id of ["M001", "M002", "M003", "M004"]) {
    const directory = join(base, ".gsd", "milestones", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "CONTEXT.md"), `# ${id}\n`);
  }
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
