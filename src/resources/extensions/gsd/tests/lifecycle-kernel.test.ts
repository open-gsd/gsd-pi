// Project/App: gsd-pi
// File Purpose: Behavior tests for the persisted Lifecycle Kernel — advance() selects the next unit from database rows.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AutoAdvanceResult, AutoOrchestrationModule } from "../auto/contracts.ts";
import { kernelAdvance, kernelResume, kernelStart, kernelStop } from "../auto/lifecycle-kernel.ts";
import { AutoSession } from "../auto/session.ts";
import { clearStaleWorkerLock } from "../crash-recovery.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { listQueuedSidecarItems } from "../db/unit-dispatch-sidecars.ts";
import {
  getDispatchById,
  markCanceled,
  recordDispatchClaim,
  setDispatchStage,
  type DispatchStage,
} from "../db/unit-dispatches.ts";
import { enqueueSidecarItem } from "../db/writers/unit-dispatch-sidecars.ts";
import type { GSDState } from "../types.ts";

const STATE = {
  phase: "executing",
  activeMilestone: { id: "M001", title: "Milestone" },
  activeSlice: { id: "S01", title: "Slice" },
  activeTask: null,
  registry: [],
  blockers: [],
} as unknown as GSDState;

/** The unit state derivation selects when no row has work for the kernel. */
const DERIVED_UNIT = { unitType: "execute-task", unitId: "M001/S01/T09" };

function makeProject(t: TestContext): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-lifecycle-kernel-")));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  t.after(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

/** A session whose orchestration module counts the selections it is asked for. */
function makeSession(): { s: AutoSession; calls: string[] } {
  const calls: string[] = [];
  const s = new AutoSession();
  s.currentMilestoneId = "M001";
  s.orchestration = {
    start: async () => { calls.push("start"); return { kind: "started" }; },
    advance: async () => {
      calls.push("advance");
      return { kind: "advanced", unit: DERIVED_UNIT, stateSnapshot: STATE, dispatchId: 0 };
    },
    settle: async () => {},
    completeActiveUnit: async () => {},
    retryActiveUnit: async () => {},
    abandonActiveUnit: async () => {},
    resume: async () => { calls.push("resume"); return { kind: "resumed" }; },
    stop: async (reason: string) => { calls.push(`stop:${reason}`); return { kind: "stopped", reason }; },
    getStatus: () => ({ phase: "running", transitionCount: 0 }),
  } satisfies AutoOrchestrationModule;
  return { s, calls };
}

function advance(s: AutoSession, dequeued: string[] = []) {
  return kernelAdvance(s, {
    executionGraphEnabled: false,
    emitSidecarDequeue: payload => dequeued.push(payload.unitId),
  });
}

/** Claim the dispatch row of a unit in a new worker, as a process does before the unit runs. */
function claimUnit(base: string, unitType: string, unitId: string): { workerId: string; dispatchId: number } {
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  if (!lease.ok) throw new Error("expected a milestone lease");
  const [, sliceId = null, taskId = null] = unitId.split("/");
  const claim = recordDispatchClaim({
    traceId: "trace-lifecycle-kernel",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    sliceId,
    taskId,
    unitType,
    unitId,
  });
  if (!claim.ok) throw new Error(`expected a dispatch claim: ${claim.error}`);
  return { workerId, dispatchId: claim.dispatchId };
}

/** Kill the process of the worker, then run the crash sweep of the next start. */
function killAndRestart(base: string, workerId: string): void {
  _getAdapter()!.prepare(
    `UPDATE workers
     SET pid = 99999, last_heartbeat_at = '1970-01-01T00:00:00.000Z'
     WHERE worker_id = :worker_id`,
  ).run({ ":worker_id": workerId });
  clearStaleWorkerLock(base);
}

/** A unit that a process ran to `stage` before it was killed. */
function killUnitInStage(base: string, unitType: string, unitId: string, stage: DispatchStage): number {
  const unit = claimUnit(base, unitType, unitId);
  if (stage !== "execute") setDispatchStage(unit.dispatchId, stage);
  killAndRestart(base, unit.workerId);
  assert.equal(getDispatchById(unit.dispatchId)?.status, "canceled", "the crash sweep cancels the row of the dead worker");
  return unit.dispatchId;
}

const UNITS = [
  { unitType: "execute-task", unitId: "M001/S01/T01" },
  { unitType: "plan-slice", unitId: "M001/S01" },
  { unitType: "research-slice", unitId: "M001/S01" },
  { unitType: "complete-slice", unitId: "M001/S01" },
];
const STAGES: DispatchStage[] = ["execute", "verify", "route", "closeout"];

for (const unit of UNITS) {
  for (const stage of STAGES) {
    // A non-task unit killed in verify continues there. Every other case goes
    // to state derivation: a unit killed in execute runs again, a unit killed
    // in route or closeout finished its work, and the Attempt of a Task holds
    // the stage of the Task.
    const continues = stage === "verify" && unit.unitType !== "execute-task";
    test(`restart after a kill of ${unit.unitType} in the ${stage} stage ${continues ? "continues the unit at verify" : "selects from state"}`, async (t) => {
      const base = makeProject(t);
      const dispatchId = killUnitInStage(base, unit.unitType, unit.unitId, stage);
      const { s, calls } = makeSession();

      const result = await advance(s);

      if (continues) {
        assert.deepEqual(result, { kind: "stage", stage: "verify", unit, interruptedDispatchId: dispatchId });
        assert.deepEqual(calls, [], "the unit is not selected from state and does not run again");
      } else {
        assert.equal(result.kind, "advanced");
        assert.deepEqual(calls, ["advance"]);
      }
    });
  }
}

test("a unit that a pause or a stop left in the verify stage is not continued", async (t) => {
  const base = makeProject(t);
  const unit = claimUnit(base, "plan-slice", "M001/S01");
  setDispatchStage(unit.dispatchId, "verify");
  markCanceled(unit.dispatchId, "pause");
  const { s, calls } = makeSession();

  const result = await advance(s);

  assert.equal(result.kind, "advanced");
  assert.deepEqual(calls, ["advance"]);
});

test("a unit killed in verify is history once another unit of the milestone was dispatched", async (t) => {
  const base = makeProject(t);
  killUnitInStage(base, "plan-slice", "M001/S01", "verify");
  const later = claimUnit(base, "execute-task", "M001/S01/T01");
  markCanceled(later.dispatchId, "stop");
  const { s, calls } = makeSession();

  const result = await advance(s);

  assert.equal(result.kind, "advanced");
  assert.deepEqual(calls, ["advance"]);
});

test("a unit killed in verify in another milestone is not continued", async (t) => {
  const base = makeProject(t);
  killUnitInStage(base, "plan-slice", "M001/S01", "verify");
  const { s, calls } = makeSession();
  s.currentMilestoneId = "M002";

  const result = await advance(s);

  assert.equal(result.kind, "advanced");
  assert.deepEqual(calls, ["advance"]);
});

test("advance selects the oldest queued sidecar row before it selects a unit from state", async (t) => {
  makeProject(t);
  enqueueSidecarItem({ kind: "hook", unitType: "hook/review", unitId: "M001/S01/T01/review", prompt: "review" }, null);
  enqueueSidecarItem({ kind: "triage", unitType: "triage-captures", unitId: "M001/triage", prompt: "triage" }, null);
  const { s, calls } = makeSession();
  const dequeued: string[] = [];

  const result = await advance(s, dequeued);

  assert.equal(result.kind, "sidecar");
  assert.equal(result.kind === "sidecar" && result.item.unitId, "M001/S01/T01/review");
  assert.deepEqual(dequeued, ["M001/S01/T01/review"]);
  assert.deepEqual(calls, [], "state derivation does not run while the queue has work");
  assert.equal(listQueuedSidecarItems().length, 2, "the row stays queued until the iteration that runs it ends");
});

test("a sidecar unit killed in verify runs again from its queue row", async (t) => {
  const base = makeProject(t);
  enqueueSidecarItem({ kind: "hook", unitType: "hook/review", unitId: "M001/S01/T01/review", prompt: "review" }, null);
  killUnitInStage(base, "hook/review", "M001/S01/T01/review", "verify");
  const { s } = makeSession();

  const result = await advance(s);

  assert.equal(result.kind, "sidecar");
});

test("a custom engine selects its own step, after the sidecar queue", async (t) => {
  makeProject(t);
  const { s, calls } = makeSession();
  s.activeEngineId = "custom";

  assert.deepEqual(await advance(s), { kind: "engine" });

  enqueueSidecarItem({ kind: "hook", unitType: "hook/review", unitId: "run/step/review", prompt: "review" }, null);
  assert.equal((await advance(s)).kind, "sidecar");
  assert.deepEqual(calls, [], "the dev orchestration module selects nothing for a custom engine");
});

test("advance returns the unit this process claimed and did not start", async (t) => {
  makeProject(t);
  const { s, calls } = makeSession();
  s.pendingOrchestrationDispatch = {
    unitType: "plan-slice",
    unitId: "M001/S01",
    prompt: "plan",
    pauseAfterUatDispatch: false,
    state: STATE,
    mid: "M001",
    midTitle: "Milestone",
    dispatchId: 7,
  };

  const result = await advance(s);

  assert.deepEqual(result, {
    kind: "advanced",
    unit: { unitType: "plan-slice", unitId: "M001/S01" },
    stateSnapshot: STATE,
    dispatchId: 7,
  } satisfies AutoAdvanceResult);
  assert.deepEqual(calls, []);
});

test("advance reports a session with no orchestration module", async (t) => {
  makeProject(t);
  const s = new AutoSession();
  s.currentMilestoneId = "M001";

  assert.deepEqual(await advance(s), { kind: "unavailable" });
});

test("start, resume and stop reach the orchestration module of the session", async (t) => {
  makeProject(t);
  const { s, calls } = makeSession();

  assert.deepEqual(await kernelStart(s, { basePath: "/project", trigger: "auto-loop" }), { kind: "started" });
  assert.deepEqual(await kernelResume(s), { kind: "resumed" });
  assert.deepEqual(await kernelStop(s, "pause"), { kind: "stopped", reason: "pause" });
  assert.deepEqual(calls, ["start", "resume", "stop:pause"]);
});
