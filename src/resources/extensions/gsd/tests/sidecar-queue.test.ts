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
import { spawnSync } from "node:child_process";

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
  hasHeldQuickTask,
  listQueuedSidecarItems,
} from "../db/unit-dispatch-sidecars.ts";
import {
  cancelOpenSidecarItems,
  enqueueSidecarItem,
  holdQuickTask,
  promoteHeldQuickTask,
  settleSidecarItem,
} from "../db/writers/unit-dispatch-sidecars.ts";
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
  restoreHookState(base);
  reconcileRestoredHookDispatch(base);
  reconcileRestoredGateBlock(base);

  const queued = listQueuedSidecarItems();
  assert.equal(queued.length, 1, "the restart finds the hook and does not queue it twice");
  assert.equal(queued[0].kind, "hook");
  assert.equal(queued[0].unitType, "hook/slice-plan-review");
  assert.equal(queued[0].unitId, "M001/S01");
  assert.match(queued[0].prompt, /Review the slice plan/);
  assert.ok(getActiveHook(), "the registry still tracks the hook as in flight");
});

test("a queued item stays queued until the iteration that ran it ends", (t) => {
  const base = makeProject(t);
  const id = enqueueSidecarItem({ kind: "triage", unitType: "triage-captures", unitId: "M001/S01/triage", prompt: "Triage", model: "provider/model" },
    null,
  );

  // A kill while the item runs: the row was read but not settled.
  restartProcess(base);
  assert.deepEqual(listQueuedSidecarItems(), [
    { id, kind: "triage", unitType: "triage-captures", unitId: "M001/S01/triage", prompt: "Triage", model: "provider/model" },
  ]);

  settleSidecarItem(id);
  assert.deepEqual(listQueuedSidecarItems(), []);
});

test("items run oldest first", (t) => {
  makeProject(t);
  enqueueSidecarItem({ kind: "hook", unitType: "hook/a", unitId: "M001/S01", prompt: "a" }, null);
  enqueueSidecarItem({ kind: "triage", unitType: "triage-captures", unitId: "M001/S01/triage", prompt: "b" }, null);

  assert.deepEqual(listQueuedSidecarItems().map((item) => item.unitType), ["hook/a", "triage-captures"]);
});

test("a row queued at the end of a milestone runs after a kill, when the restart is on the next milestone", async (t) => {
  const base = makeProject(t);
  process.chdir(base);
  _clearGsdRootCache();
  resetHookState();
  const captureId = appendCapture(base, "Fix the typo in the README.");
  markCaptureResolved(base, captureId, "quick-task", "run as a quick task", "small fix");
  holdQuickTask(quickTask(captureId), null);

  // The last unit of M001 closes out: the quick task is queued. Its capture is not executed yet.
  const pctx = makePostUnitContext(base, "research-slice", "M001/S01");
  assert.equal(await postUnitPostVerification(pctx), "continue");
  enqueueSidecarItem({ kind: "hook", unitType: "hook/a", unitId: "M001/S01", prompt: "a" }, null);
  assert.equal(loadAllCaptures(base).find((capture) => capture.id === captureId)?.executed, undefined);

  // The process dies. The next start is on M002 and its first close-out queues new work.
  restartProcess(base);
  enqueueSidecarItem({ kind: "hook", unitType: "hook/b", unitId: "M002/S01", prompt: "b" }, null);

  assert.deepEqual(
    listQueuedSidecarItems().map((item) => item.unitId),
    [`M001/${captureId}`, "M001/S01", "M002/S01"],
    "the rows of the finished milestone run before the work of the next one",
  );
});

test("a parallel worker does not see the queue of another milestone lock or another slice lock", (t) => {
  makeProject(t);
  const previous = {
    GSD_PARALLEL_WORKER: process.env.GSD_PARALLEL_WORKER,
    GSD_MILESTONE_LOCK: process.env.GSD_MILESTONE_LOCK,
    GSD_SLICE_LOCK: process.env.GSD_SLICE_LOCK,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.GSD_PARALLEL_WORKER = "1";
  process.env.GSD_MILESTONE_LOCK = "M001";
  delete process.env.GSD_SLICE_LOCK;
  enqueueSidecarItem({ kind: "hook", unitType: "hook/a", unitId: "M001/S01", prompt: "a" }, null);

  process.env.GSD_MILESTONE_LOCK = "M002";
  assert.equal(listQueuedSidecarItems().length, 0);

  process.env.GSD_MILESTONE_LOCK = "M001";
  process.env.GSD_SLICE_LOCK = "S02";
  assert.equal(listQueuedSidecarItems().length, 0);
  delete process.env.GSD_SLICE_LOCK;
  assert.equal(listQueuedSidecarItems().length, 1);
});

test("held quick tasks survive a restart and move to the queue one at a time", (t) => {
  const base = makeProject(t);
  holdQuickTask(quickTask("CAP-1"), null);
  holdQuickTask(quickTask("CAP-2"), null);
  // A second triage run reports the same capture again.
  holdQuickTask(quickTask("CAP-1"), null);

  assert.deepEqual(listQueuedSidecarItems(), [], "a held quick task is not ready work");

  restartProcess(base);
  assert.equal(hasHeldQuickTask(), true);

  const first = promoteHeldQuickTask("M001");
  assert.equal(first?.captureId, "CAP-1");
  assert.deepEqual(listQueuedSidecarItems().map((item) => item.captureId), ["CAP-1"]);
  settleSidecarItem(first!.id);

  assert.equal(promoteHeldQuickTask("M001")?.captureId, "CAP-2");
  assert.equal(hasHeldQuickTask(), false, "CAP-1 was held once");
  assert.equal(promoteHeldQuickTask("M001"), null);
});

test("unit close-out moves one held quick task to the queue and does not mark its capture executed", async (t) => {
  const base = makeProject(t);
  process.chdir(base);
  _clearGsdRootCache();
  resetHookState();
  const captureId = appendCapture(base, "Fix the typo in the README.");
  markCaptureResolved(base, captureId, "quick-task", "run as a quick task", "small fix");
  holdQuickTask(quickTask(captureId), null);

  // A new process finishes the next unit: the held task is found in the database.
  restartProcess(base);
  const pctx = makePostUnitContext(base, "research-slice", "M001/S01");
  const messages: string[] = [];
  pctx.ctx.ui.notify = (message: string) => { messages.push(message); };

  assert.equal(await postUnitPostVerification(pctx), "continue");

  assert.ok(
    messages.includes(`Executing quick-task: ${captureId} — "Fix the typo in the README."`),
    `the message shows the capture text: ${JSON.stringify(messages)}`,
  );
  assert.deepEqual(listQueuedSidecarItems().map((item) => item.captureId), [captureId]);
  assert.equal(hasHeldQuickTask(), false);
  assert.equal(
    loadAllCaptures(base).find((capture) => capture.id === captureId)?.executed,
    undefined,
    "only gsd_capture_complete records the outcome",
  );
});

test("a session that moves to the next milestone still runs the quick tasks it holds", async (t) => {
  const base = makeProject(t);
  process.chdir(base);
  _clearGsdRootCache();
  resetHookState();
  const captureIds = ["Fix the typo in the README.", "Rename the helper."].map((text) => {
    const captureId = appendCapture(base, text);
    markCaptureResolved(base, captureId, "quick-task", "run as a quick task", "small fix");
    // Triage held the task while the session ran M001.
    holdQuickTask(quickTask(captureId), null);
    return captureId;
  });

  // The session adopts M002 before a unit close-out takes the held tasks.
  for (const captureId of captureIds) {
    const pctx = makePostUnitContext(base, "research-slice", "M002/S01");
    pctx.s.currentMilestoneId = "M002";

    assert.equal(await postUnitPostVerification(pctx), "continue");

    const queued = listQueuedSidecarItems();
    assert.deepEqual(
      queued.map((item) => item.unitId),
      [`M002/${captureId}`],
      "the task runs as a unit of the milestone the session runs now",
    );
    assert.equal(loadAllCaptures(base).find((capture) => capture.id === captureId)?.executed, undefined);
    settleSidecarItem(queued[0].id);
  }
  assert.equal(hasHeldQuickTask(), false);
});

/** Run `fn` as the parallel worker of M001, then go back to a plain session. */
function asParallelWorkerOfM001<T>(fn: () => T): T {
  const previous = {
    GSD_PARALLEL_WORKER: process.env.GSD_PARALLEL_WORKER,
    GSD_MILESTONE_LOCK: process.env.GSD_MILESTONE_LOCK,
  };
  process.env.GSD_PARALLEL_WORKER = "1";
  process.env.GSD_MILESTONE_LOCK = "M001";
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** The M001 parallel worker queues a hook and holds a quick task. It is the process `pid`. */
function queueWorkAsOtherParallelWorker(base: string, pid: number): void {
  asParallelWorkerOfM001(() => {
    claimDispatch(base, "plan-slice", "M001/S01");
    enqueueSidecarItem(
      { kind: "hook", unitType: "hook/a", unitId: "M001/S01", prompt: "a" },
      { type: "plan-slice", id: "M001/S01" },
    );
    holdQuickTask(quickTask("CAP-1"), null);
  });
  _getAdapter()!.prepare("UPDATE workers SET pid = :pid").run({ ":pid": pid });
}

/** The pid of init: a live process that is not this one. */
const LIVE_PID = 1;

/** The heartbeat and the milestone lease of every worker were not renewed for 10 minutes. */
function letHeartbeatAndLeaseLapse(): void {
  const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  _getAdapter()!.prepare("UPDATE workers SET last_heartbeat_at = :past").run({ ":past": past });
  _getAdapter()!.prepare("UPDATE milestone_leases SET expires_at = :past").run({ ":past": past });
}

function assertPlainStartTakesNothing(): void {
  assert.deepEqual(listQueuedSidecarItems(), []);
  assert.equal(hasHeldQuickTask(), false);
  assert.equal(promoteHeldQuickTask("M002"), null);
  cancelOpenSidecarItems();

  asParallelWorkerOfM001(() => {
    assert.equal(listQueuedSidecarItems().length, 1, "the worker still has its queue");
    assert.equal(hasHeldQuickTask(), true);
  });
}

test("a plain start leaves the rows of a live parallel worker alone", (t) => {
  const base = makeProject(t);
  queueWorkAsOtherParallelWorker(base, LIVE_PID);

  assertPlainStartTakesNothing();
});

test("a plain start leaves the rows of a parallel worker whose process is alive but whose heartbeat and lease lapsed", (t) => {
  const base = makeProject(t);
  queueWorkAsOtherParallelWorker(base, LIVE_PID);
  // A long step of the worker did not renew them.
  letHeartbeatAndLeaseLapse();

  assertPlainStartTakesNothing();
});

test("a plain start leaves the rows of a parallel worker with a dead pid while its heartbeat is fresh", (t) => {
  const base = makeProject(t);
  // The pid is from another host or was not updated: the fresh heartbeat decides.
  queueWorkAsOtherParallelWorker(base, spawnSync(process.execPath, ["-e", ""]).pid);

  assertPlainStartTakesNothing();
});

test("a plain start runs the rows of a parallel worker that was killed", (t) => {
  const base = makeProject(t);
  // The worker is killed: its process is gone, and its heartbeat and its milestone lease are not renewed.
  queueWorkAsOtherParallelWorker(base, spawnSync(process.execPath, ["-e", ""]).pid);
  letHeartbeatAndLeaseLapse();
  restartProcess(base);

  assert.deepEqual(listQueuedSidecarItems().map((item) => item.unitType), ["hook/a"]);
  const quick = promoteHeldQuickTask("M002");
  assert.equal(quick?.captureId, "CAP-1");
  assert.equal(quick?.unitId, "M002/CAP-1");
  assert.deepEqual(listQueuedSidecarItems().map((item) => item.unitType), ["hook/a", "quick-task"]);
});

test("a parallel worker does not take the quick tasks another worker holds", (t) => {
  makeProject(t);
  const previous = {
    GSD_PARALLEL_WORKER: process.env.GSD_PARALLEL_WORKER,
    GSD_MILESTONE_LOCK: process.env.GSD_MILESTONE_LOCK,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.GSD_PARALLEL_WORKER = "1";
  process.env.GSD_MILESTONE_LOCK = "M001";
  holdQuickTask(quickTask("CAP-1"), null);

  process.env.GSD_MILESTONE_LOCK = "M002";
  assert.equal(hasHeldQuickTask(), false);
  assert.equal(promoteHeldQuickTask("M002"), null);
  cancelOpenSidecarItems();

  process.env.GSD_MILESTONE_LOCK = "M001";
  assert.equal(promoteHeldQuickTask("M001")?.captureId, "CAP-1");
});

test("a user stop drops its queued items and its held quick tasks only", (t) => {
  makeProject(t);
  const previous = {
    GSD_PARALLEL_WORKER: process.env.GSD_PARALLEL_WORKER,
    GSD_MILESTONE_LOCK: process.env.GSD_MILESTONE_LOCK,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.GSD_PARALLEL_WORKER = "1";
  process.env.GSD_MILESTONE_LOCK = "M002";
  enqueueSidecarItem({ kind: "hook", unitType: "hook/b", unitId: "M002/S01", prompt: "b" }, null);

  process.env.GSD_MILESTONE_LOCK = "M001";
  // Rows of two milestones: the stop takes every row of this worker.
  enqueueSidecarItem({ kind: "hook", unitType: "hook/a", unitId: "M001/S01", prompt: "a" }, null);
  enqueueSidecarItem({ kind: "hook", unitType: "hook/c", unitId: "M003/S01", prompt: "c" }, null);
  holdQuickTask(quickTask("CAP-1"), null);

  cancelOpenSidecarItems();

  assert.deepEqual(listQueuedSidecarItems(), []);
  assert.equal(hasHeldQuickTask(), false);
  process.env.GSD_MILESTONE_LOCK = "M002";
  assert.equal(listQueuedSidecarItems().length, 1, "the queue of the other worker stays");
});

test("stopAuto drops the queue so the next start does not run old follow-on work", async (t) => {
  const base = makeProject(t);
  holdQuickTask(quickTask("CAP-1"), null);

  // The session moved from M001 to M002 after triage held the quick task.
  enqueueSidecarItem({ kind: "hook", unitType: "hook/a", unitId: "M002/S01", prompt: "a" }, null);

  autoSession.reset();
  t.after(() => autoSession.reset());
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M002";

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
  assert.deepEqual(listQueuedSidecarItems(), []);
  assert.equal(hasHeldQuickTask(), false);
});
