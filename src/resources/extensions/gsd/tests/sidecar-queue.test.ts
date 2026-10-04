// gsd-pi — Sidecar queue behavior tests (ADR-048: queue rows linked to the dispatch row).
//
// The queue of follow-on work (post-unit hooks, capture triage, quick tasks) is
// the unit_dispatch_sidecars table. These tests kill the "process" by closing
// the database and dropping every in-memory object, then start again.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { stopAuto } from "../auto.ts";
import { postUnitPostVerification, type PostUnitContext } from "../auto-post-unit.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { AutoSession } from "../auto/session.ts";
import { invalidateAllCaches } from "../cache.ts";
import { appendCapture, loadAllCaptures, markCaptureResolved } from "../captures.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { recordDispatchClaim } from "../db/unit-dispatches.ts";
import {
  cancelOpenSidecarItems,
  enqueueSidecarItem,
  hasHeldQuickTask,
  holdQuickTask,
  listQueuedSidecarItems,
  promoteHeldQuickTask,
  settleSidecarItem,
  sidecarQueueScope,
} from "../db/unit-dispatch-sidecars.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { _clearGsdRootCache } from "../paths.ts";
import {
  getActiveHook,
  reconcileRestoredGateBlock,
  reconcileRestoredHookDispatch,
  resetHookState,
  restoreHookState,
} from "../post-unit-hooks.ts";

const BLOCKING_PLAN_SLICE_HOOK = `---
post_unit_hooks:
  - name: slice-plan-review
    after:
      - plan-slice
    criticality: blocking
    artifact: SLICE-REVIEW.md
    max_cycles: 2
    enabled: true
    prompt: Review the slice plan and write a frontmatter verdict.
---
`;

function makeProject(t: TestContext): string {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-sidecar-queue-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  t.after(() => {
    try { closeDatabase(); } catch { /* the test may have closed it already */ }
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

/** Close the database and open it again: nothing in memory survives. */
function restartProcess(base: string): void {
  closeDatabase();
  resetHookState();
  invalidateAllCaches();
  openDatabase(join(base, ".gsd", "gsd.db"));
}

function claimDispatch(base: string, unitType: string, unitId: string): number {
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  if (!lease.ok) throw new Error("expected test lease");
  const claim = recordDispatchClaim({
    traceId: "trace-1",
    turnId: "turn-1",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    sliceId: "S01",
    unitType,
    unitId,
  });
  if (!claim.ok) throw new Error("expected test dispatch claim");
  return claim.dispatchId;
}

function makePostUnitContext(base: string, unitType: string, unitId: string): PostUnitContext {
  const session = new AutoSession();
  session.basePath = base;
  session.active = true;
  session.currentMilestoneId = "M001";
  session.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
  return {
    s: session,
    ctx: {
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, setFooter: () => {} },
      model: { id: "test-model" },
    } as any,
    pi: { sendMessage: async () => {}, setModel: async () => true } as any,
    buildSnapshotOpts: () => ({}),
    lockBase: () => base,
    stopAuto: async () => {},
    pauseAuto: async () => {},
    updateProgressWidget: () => {},
  };
}

function quickTask(captureId: string) {
  return {
    kind: "quick-task" as const,
    unitType: "quick-task",
    unitId: `M001/${captureId}`,
    prompt: `Do ${captureId}`,
    captureId,
  };
}

test("a post-unit hook queued at close-out survives a process kill and is queued once after restart", async (t) => {
  const base = makeProject(t);
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), BLOCKING_PLAN_SLICE_HOOK, "utf-8");
  invalidateAllCaches();
  process.chdir(base);
  _clearGsdRootCache();
  resetHookState();
  const dispatchId = claimDispatch(base, "plan-slice", "M001/S01");

  const pctx = makePostUnitContext(base, "plan-slice", "M001/S01");

  assert.equal(await postUnitPostVerification(pctx), "continue");

  const row = _getAdapter()!.prepare(
    "SELECT trigger_dispatch_id, status FROM unit_dispatch_sidecars",
  ).all();
  assert.deepEqual(
    row.map((r) => ({ ...r })),
    [{ trigger_dispatch_id: dispatchId, status: "queued" }],
    "the hook is one queued row linked to the plan-slice dispatch row",
  );

  // The process dies before the loop runs the hook.
  restartProcess(base);
  const scope = sidecarQueueScope("M001");
  restoreHookState(base);
  reconcileRestoredHookDispatch(base, scope);
  reconcileRestoredGateBlock(base, scope);

  const queued = listQueuedSidecarItems(scope);
  assert.equal(queued.length, 1, "the restart finds the hook and does not queue it twice");
  assert.equal(queued[0].kind, "hook");
  assert.equal(queued[0].unitType, "hook/slice-plan-review");
  assert.equal(queued[0].unitId, "M001/S01");
  assert.match(queued[0].prompt, /Review the slice plan/);
  assert.ok(getActiveHook(), "the registry still tracks the hook as in flight");
});

test("a queued item stays queued until the iteration that ran it ends", (t) => {
  const base = makeProject(t);
  const scope = sidecarQueueScope("M001");
  const id = enqueueSidecarItem(
    scope,
    { kind: "triage", unitType: "triage-captures", unitId: "M001/S01/triage", prompt: "Triage", model: "provider/model" },
    null,
  );

  // A kill while the item runs: the row was read but not settled.
  restartProcess(base);
  assert.deepEqual(listQueuedSidecarItems(scope), [
    { id, kind: "triage", unitType: "triage-captures", unitId: "M001/S01/triage", prompt: "Triage", model: "provider/model" },
  ]);

  settleSidecarItem(id);
  assert.deepEqual(listQueuedSidecarItems(scope), []);
});

test("items run oldest first", (t) => {
  makeProject(t);
  const scope = sidecarQueueScope("M001");
  enqueueSidecarItem(scope, { kind: "hook", unitType: "hook/a", unitId: "M001/S01", prompt: "a" }, null);
  enqueueSidecarItem(scope, { kind: "triage", unitType: "triage-captures", unitId: "M001/S01/triage", prompt: "b" }, null);

  assert.deepEqual(listQueuedSidecarItems(scope).map((item) => item.unitType), ["hook/a", "triage-captures"]);
});

test("a worker does not see the queue of another milestone or another slice lock", (t) => {
  makeProject(t);
  enqueueSidecarItem(sidecarQueueScope("M001"), { kind: "hook", unitType: "hook/a", unitId: "M001/S01", prompt: "a" }, null);

  assert.equal(listQueuedSidecarItems(sidecarQueueScope("M002")).length, 0);

  const previousSliceLock = process.env.GSD_SLICE_LOCK;
  t.after(() => {
    if (previousSliceLock === undefined) delete process.env.GSD_SLICE_LOCK;
    else process.env.GSD_SLICE_LOCK = previousSliceLock;
  });
  process.env.GSD_SLICE_LOCK = "S02";
  assert.equal(listQueuedSidecarItems(sidecarQueueScope("M001")).length, 0);
  delete process.env.GSD_SLICE_LOCK;
  assert.equal(listQueuedSidecarItems(sidecarQueueScope("M001")).length, 1);
});

test("held quick tasks survive a restart and move to the queue one at a time", (t) => {
  const base = makeProject(t);
  const scope = sidecarQueueScope("M001");
  holdQuickTask(scope, quickTask("CAP-1"), null);
  holdQuickTask(scope, quickTask("CAP-2"), null);
  // A second triage run reports the same capture again.
  holdQuickTask(scope, quickTask("CAP-1"), null);

  assert.deepEqual(listQueuedSidecarItems(scope), [], "a held quick task is not ready work");

  restartProcess(base);
  assert.equal(hasHeldQuickTask(scope), true);

  const first = promoteHeldQuickTask(scope);
  assert.equal(first?.captureId, "CAP-1");
  assert.deepEqual(listQueuedSidecarItems(scope).map((item) => item.captureId), ["CAP-1"]);
  settleSidecarItem(first!.id);

  assert.equal(promoteHeldQuickTask(scope)?.captureId, "CAP-2");
  assert.equal(hasHeldQuickTask(scope), false, "CAP-1 was held once");
  assert.equal(promoteHeldQuickTask(scope), null);
});

test("unit close-out moves one held quick task to the queue and marks its capture executed", async (t) => {
  const base = makeProject(t);
  process.chdir(base);
  _clearGsdRootCache();
  resetHookState();
  const captureId = appendCapture(base, "Fix the typo in the README.");
  markCaptureResolved(base, captureId, "quick-task", "run as a quick task", "small fix");
  const scope = sidecarQueueScope("M001");
  holdQuickTask(scope, quickTask(captureId), null);

  // A new process finishes the next unit: the held task is found in the database.
  restartProcess(base);
  const pctx = makePostUnitContext(base, "research-slice", "M001/S01");

  assert.equal(await postUnitPostVerification(pctx), "continue");

  assert.deepEqual(listQueuedSidecarItems(scope).map((item) => item.captureId), [captureId]);
  assert.equal(hasHeldQuickTask(scope), false);
  assert.equal(loadAllCaptures(base).find((capture) => capture.id === captureId)?.executed, true);
});

test("a user stop drops held and queued items of its own scope only", (t) => {
  makeProject(t);
  const scope = sidecarQueueScope("M001");
  const otherScope = sidecarQueueScope("M002");
  enqueueSidecarItem(scope, { kind: "hook", unitType: "hook/a", unitId: "M001/S01", prompt: "a" }, null);
  holdQuickTask(scope, quickTask("CAP-1"), null);
  enqueueSidecarItem(otherScope, { kind: "hook", unitType: "hook/b", unitId: "M002/S01", prompt: "b" }, null);

  cancelOpenSidecarItems(scope);

  assert.deepEqual(listQueuedSidecarItems(scope), []);
  assert.equal(hasHeldQuickTask(scope), false);
  assert.equal(listQueuedSidecarItems(otherScope).length, 1);
});

test("stopAuto drops the queue so the next start does not run old follow-on work", async (t) => {
  const base = makeProject(t);
  const scope = sidecarQueueScope("M001");
  enqueueSidecarItem(scope, { kind: "hook", unitType: "hook/a", unitId: "M001/S01", prompt: "a" }, null);
  holdQuickTask(scope, quickTask("CAP-1"), null);

  autoSession.reset();
  t.after(() => autoSession.reset());
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M001";

  await stopAuto(
    {
      hasUI: true,
      ui: { setStatus: () => {}, setWidget: () => {}, setHeader: () => {}, notify: () => {} },
      modelRegistry: { find: () => null },
    } as any,
    { events: { emit: () => {} } } as any,
    "user stop",
  );

  // stopAuto closes the database; the next start opens it again.
  openDatabase(join(base, ".gsd", "gsd.db"));
  assert.deepEqual(listQueuedSidecarItems(scope), []);
  assert.equal(hasHeldQuickTask(scope), false);
});
