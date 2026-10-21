// GSD Extension — Post-unit hooks under /gsd next step mode (#2194).
//
// `/gsd next` runs the auto workflow with stepMode=true, and the post-unit
// hook path used to be guarded by `!s.stepMode`. A `criticality: blocking`
// hook after plan-slice was therefore bypassed, letting an unreviewed plan
// reach task execution. These tests pin the step-mode contract:
//   - a blocking hook dispatches before any execute-task unit can be selected
//   - a passing hook artifact lets selection proceed (wizard surfaces)
//   - a failed/exhausted blocking hook pauses instead of exposing execution
//   - non-blocking hooks keep their step-mode behavior (skipped)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mock } from "node:test";

import { handlePendingHookOutcome, postUnitPostVerification, type PostUnitContext } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import {
  checkPostUnitHooks,
  consumeGateBlock,
  getActiveHook,
  persistHookState,
  reconcileRestoredGateBlock,
  reconcileRestoredHookDispatch,
  resetHookState,
  resolveHookArtifactPath,
  restoreHookState,
} from "../post-unit-hooks.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  closeDatabase,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  completeLegacyTaskForVerifiedAttempt,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";

function writePreferences(basePath: string, hookYaml: string): void {
  const content = `---
post_unit_hooks:
${hookYaml}
---
`;
  writeFileSync(join(basePath, ".gsd", "PREFERENCES.md"), content, "utf-8");
  invalidateAllCaches();
}

const BLOCKING_PLAN_SLICE_HOOK = `  - name: slice-plan-review
    after:
      - plan-slice
    criticality: blocking
    artifact: SLICE-REVIEW.md
    max_cycles: 2
    enabled: true
    prompt: Review the slice plan and write a frontmatter verdict.
`;

const BLOCKING_PLAN_SLICE_HOOK_ONE_CYCLE = `  - name: slice-plan-review
    after:
      - plan-slice
    criticality: blocking
    artifact: SLICE-REVIEW.md
    max_cycles: 1
    enabled: true
    prompt: Review the slice plan and write a frontmatter verdict.
`;

const ADVISORY_PLAN_SLICE_HOOK = `  - name: slice-plan-review
    after:
      - plan-slice
    artifact: SLICE-REVIEW.md
    enabled: true
    prompt: Review the slice plan and write a frontmatter verdict.
`;

const MIXED_PLAN_SLICE_HOOKS = `  - name: plan-hint
    after:
      - plan-slice
    artifact: PLAN-HINT.md
    enabled: true
    prompt: Leave a documentation hint.
  - name: slice-plan-review
    after:
      - plan-slice
    criticality: blocking
    artifact: SLICE-REVIEW.md
    max_cycles: 2
    enabled: true
    prompt: Review the slice plan and write a frontmatter verdict.
`;

const TWO_BLOCKING_PLAN_SLICE_HOOKS = `  - name: gate-a
    after:
      - plan-slice
    criticality: blocking
    artifact: GATE-A.md
    max_cycles: 1
    enabled: true
    prompt: Gate A.
  - name: gate-b
    after:
      - plan-slice
    criticality: blocking
    artifact: GATE-B.md
    max_cycles: 1
    enabled: true
    prompt: Gate B.
`;

const EXECUTE_TASK_BLOCKING_HOOK = `  - name: review-gate
    after:
      - execute-task
    criticality: blocking
    artifact: REVIEW.md
    max_cycles: 2
    enabled: true
    prompt: Review the task.
`;

interface StepModeHarness {
  base: string;
  session: AutoSession;
  pctx: PostUnitContext;
  pauseAuto: ReturnType<typeof mock.fn>;
}

function createPctx(basePath: string, session: AutoSession): { pctx: PostUnitContext; pauseAuto: ReturnType<typeof mock.fn> } {
  const pauseAuto = mock.fn(async () => {});
  return {
    pauseAuto,
    pctx: {
      s: session,
      ctx: {
        ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, setFooter: () => {} },
        model: { id: "test-model" },
      } as any,
      pi: { sendMessage: async () => {}, setModel: async () => true } as any,
      buildSnapshotOpts: () => ({}),
      lockBase: () => basePath,
      stopAuto: async () => {},
      pauseAuto,
      updateProgressWidget: () => {},
    },
  };
}

function createStepModeHarness(basePath: string, unitType: string, unitId: string): StepModeHarness {
  const session = new AutoSession();
  session.basePath = basePath;
  session.active = true;
  session.stepMode = true;
  session.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
  const { pctx, pauseAuto } = createPctx(basePath, session);
  return { base: basePath, session, pctx, pauseAuto };
}

function setupFixture(prefix: string, hookYaml: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  writePreferences(base, hookYaml);
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  return base;
}

test("step mode dispatches a blocking plan-slice hook before any execute-task unit can be selected", async () => {
  const originalCwd = process.cwd();
  let base = "";
  try {
    base = setupFixture("gsd-step-blocking-hook-", BLOCKING_PLAN_SLICE_HOOK);
    process.chdir(base);
    _clearGsdRootCache();
    resetHookState();

    const { pctx, session } = createStepModeHarness(base, "plan-slice", "M001/S01");

    const result = await postUnitPostVerification(pctx);

    assert.equal(result, "continue", "loop continues to run the dispatched hook unit");
    const queued = session.sidecarQueue;
    assert.equal(queued.length, 1, "exactly the hook sidecar is enqueued");
    assert.equal(queued[0].kind, "hook");
    assert.equal(queued[0].unitType, "hook/slice-plan-review");
    assert.equal(queued[0].unitId, "M001/S01");
    assert.ok(getActiveHook(), "registry tracks the in-flight blocking hook");
    assert.equal(consumeGateBlock(), null, "no gate block while the hook is in flight");
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    if (base) rmSync(base, { recursive: true, force: true });
  }
});

test("after the blocking hook records a passing verdict, step-mode selection proceeds", async () => {
  const originalCwd = process.cwd();
  let base = "";
  try {
    base = setupFixture("gsd-step-blocking-pass-", BLOCKING_PLAN_SLICE_HOOK);
    process.chdir(base);
    _clearGsdRootCache();
    resetHookState();

    const { pctx, session } = createStepModeHarness(base, "plan-slice", "M001/S01");
    assert.equal(await postUnitPostVerification(pctx), "continue");
    session.clearCurrentUnit();
    session.sidecarQueue.length = 0; // the loop drains the enqueued hook dispatch

    // The hook unit completes and writes a passing gate artifact.
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01", "SLICE-REVIEW.md"),
      "---\nverdict: pass\n---\n\nPlan reviewed. No blocking findings.\n",
      "utf-8",
    );
    session.currentUnit = { type: "hook/slice-plan-review", id: "M001/S01", startedAt: Date.now() };

    const result = await postUnitPostVerification(pctx);

    assert.equal(result, "step-wizard", "wizard surfaces so the next unit can be selected");
    assert.equal(session.sidecarQueue.length, 0, "passing gate is not re-dispatched");
    assert.equal(getActiveHook(), null, "gate is cleared after a passing verdict");
    assert.equal(consumeGateBlock(), null, "passing gate does not block");
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    if (base) rmSync(base, { recursive: true, force: true });
  }
});

test("blocking hook failure under step mode pauses instead of exposing task execution", async () => {
  const originalCwd = process.cwd();
  let base = "";
  try {
    base = setupFixture("gsd-step-blocking-fail-", BLOCKING_PLAN_SLICE_HOOK_ONE_CYCLE);
    process.chdir(base);
    _clearGsdRootCache();
    resetHookState();

    const { pctx, session, pauseAuto } = createStepModeHarness(base, "plan-slice", "M001/S01");
    assert.equal(await postUnitPostVerification(pctx), "continue");
    session.clearCurrentUnit();
    session.sidecarQueue.length = 0; // the loop drains the enqueued hook dispatch

    // The hook unit completes but its artifact carries no frontmatter verdict;
    // with max_cycles exhausted the gate must block the advance.
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01", "SLICE-REVIEW.md"),
      "review notes without a verdict",
      "utf-8",
    );
    session.currentUnit = { type: "hook/slice-plan-review", id: "M001/S01", startedAt: Date.now() };

    const result = await postUnitPostVerification(pctx);

    assert.equal(result, "stopped", "gate failure pauses instead of returning a step action");
    assert.equal(pauseAuto.mock.callCount(), 1, "auto-mode is paused for manual recovery");
    assert.equal(session.sidecarQueue.length, 0, "no further unit is dispatched");
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    if (base) rmSync(base, { recursive: true, force: true });
  }
});

test("non-blocking hooks keep their step-mode behavior and stay skipped", async () => {
  const originalCwd = process.cwd();
  let base = "";
  try {
    base = setupFixture("gsd-step-advisory-hook-", ADVISORY_PLAN_SLICE_HOOK);
    process.chdir(base);
    _clearGsdRootCache();
    resetHookState();

    const { pctx, session } = createStepModeHarness(base, "plan-slice", "M001/S01");

    const result = await postUnitPostVerification(pctx);

    assert.equal(result, "step-wizard", "step completes and the wizard surfaces as today");
    assert.equal(session.sidecarQueue.length, 0, "advisory hook is not dispatched in step mode");
    assert.equal(getActiveHook(), null, "no hook state is created");
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    if (base) rmSync(base, { recursive: true, force: true });
  }
});

test("failed gate block persists and resume re-dispatches the blocked hook before selection", async () => {
  const originalCwd = process.cwd();
  let base = "";
  try {
    base = setupFixture("gsd-step-gate-resume-", BLOCKING_PLAN_SLICE_HOOK_ONE_CYCLE);
    process.chdir(base);
    _clearGsdRootCache();
    resetHookState();

    // plan-slice completes; the hook dispatches.
    const first = createStepModeHarness(base, "plan-slice", "M001/S01");
    assert.equal(await postUnitPostVerification(first.pctx), "continue");
    first.session.clearCurrentUnit();
    first.session.sidecarQueue.length = 0; // loop drains and runs the hook

    // The hook completes without a verdict: the gate blocks and pauses.
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01", "SLICE-REVIEW.md"),
      "review notes without a verdict",
      "utf-8",
    );
    first.session.currentUnit = { type: "hook/slice-plan-review", id: "M001/S01", startedAt: Date.now() };
    assert.equal(await postUnitPostVerification(first.pctx), "stopped");

    // Resume (auto.ts order: restore, then reconcile dispatches + gate blocks).
    resetHookState();
    restoreHookState(base);
    const resumed = new AutoSession();
    resumed.basePath = base;
    resumed.active = true;
    resumed.stepMode = true;
    reconcileRestoredHookDispatch(base, resumed.sidecarQueue);
    reconcileRestoredGateBlock(base, resumed.sidecarQueue);

    assert.equal(resumed.sidecarQueue.length, 1, "the blocked hook is re-dispatched on resume");
    assert.equal(resumed.sidecarQueue[0].kind, "hook");
    assert.equal(resumed.sidecarQueue[0].unitType, "hook/slice-plan-review");
    assert.ok(getActiveHook(), "the gate is re-armed in flight so its completion is re-assessed");
    assert.equal(consumeGateBlock(), null, "the block is superseded by the re-dispatch");
    resumed.sidecarQueue.length = 0; // loop drains and runs the re-dispatched hook

    // The re-run records a passing verdict: selection may finally proceed.
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01", "SLICE-REVIEW.md"),
      "---\nverdict: pass\n---\n\nPlan reviewed. No blocking findings.\n",
      "utf-8",
    );
    resumed.currentUnit = { type: "hook/slice-plan-review", id: "M001/S01", startedAt: Date.now() };
    const { pctx } = createPctx(base, resumed);
    assert.equal(await postUnitPostVerification(pctx), "step-wizard");
    assert.equal(resumed.sidecarQueue.length, 0, "passing gate is not re-dispatched");
    assert.equal(getActiveHook(), null, "gate clears after the re-run passes");
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    if (base) rmSync(base, { recursive: true, force: true });
  }
});

test("resume with an already-passing gate artifact holds no dispatch and clears the block", async () => {
  const originalCwd = process.cwd();
  let base = "";
  try {
    base = setupFixture("gsd-step-gate-resolved-", BLOCKING_PLAN_SLICE_HOOK_ONE_CYCLE);
    process.chdir(base);
    _clearGsdRootCache();
    resetHookState();

    const first = createStepModeHarness(base, "plan-slice", "M001/S01");
    assert.equal(await postUnitPostVerification(first.pctx), "continue");
    first.session.clearCurrentUnit();
    first.session.sidecarQueue.length = 0;

    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01", "SLICE-REVIEW.md"),
      "review notes without a verdict",
      "utf-8",
    );
    first.session.currentUnit = { type: "hook/slice-plan-review", id: "M001/S01", startedAt: Date.now() };
    assert.equal(await postUnitPostVerification(first.pctx), "stopped");

    // The review is completed manually while paused; resume must not rerun
    // an already valid hook and must not hold selection.
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01", "SLICE-REVIEW.md"),
      "---\nverdict: pass\n---\n\nPlan reviewed manually during the pause.\n",
      "utf-8",
    );
    resetHookState();
    restoreHookState(base);
    const resumed = new AutoSession();
    resumed.basePath = base;
    resumed.active = true;
    resumed.stepMode = true;
    reconcileRestoredHookDispatch(base, resumed.sidecarQueue);
    reconcileRestoredGateBlock(base, resumed.sidecarQueue);

    assert.equal(resumed.sidecarQueue.length, 0, "passing artifact clears the block without a rerun");
    assert.equal(getActiveHook(), null);
    assert.equal(consumeGateBlock(), null);
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    if (base) rmSync(base, { recursive: true, force: true });
  }
});

test("step mode runs only the blocking hook from a mixed advisory+blocking queue", async () => {
  const originalCwd = process.cwd();
  let base = "";
  try {
    base = setupFixture("gsd-step-mixed-hooks-", MIXED_PLAN_SLICE_HOOKS);
    process.chdir(base);
    _clearGsdRootCache();
    resetHookState();

    const { pctx, session } = createStepModeHarness(base, "plan-slice", "M001/S01");
    const result = await postUnitPostVerification(pctx);

    assert.equal(result, "continue");
    assert.equal(session.sidecarQueue.length, 1, "only the blocking hook dispatches in step mode");
    assert.equal(session.sidecarQueue[0].unitType, "hook/slice-plan-review");
    session.clearCurrentUnit();
    session.sidecarQueue.length = 0;

    // The blocking gate passes; the advisory hook must stay skipped.
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01", "SLICE-REVIEW.md"),
      "---\nverdict: pass\n---\n\nPlan reviewed. No blocking findings.\n",
      "utf-8",
    );
    session.currentUnit = { type: "hook/slice-plan-review", id: "M001/S01", startedAt: Date.now() };
    assert.equal(await postUnitPostVerification(pctx), "step-wizard");
    assert.equal(session.sidecarQueue.length, 0, "advisory hook remains skipped after the gate passes");
    assert.equal(getActiveHook(), null);
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    if (base) rmSync(base, { recursive: true, force: true });
  }
});

function seedCompletedTaskLifecycle(idempotencyKey: string): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: `test.task.completed.${idempotencyKey}`,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "completed",
    });
    completeLegacyTaskForVerifiedAttempt(context, {
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
    });
    return {
      events: [{
        eventType: `test.task.completed.${idempotencyKey}`,
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/task/${idempotencyKey}`,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

test("resume after gate A blocks still runs queued gate B once A passes", async () => {
  const originalCwd = process.cwd();
  let base = "";
  try {
    base = setupFixture("gsd-step-two-gates-", TWO_BLOCKING_PLAN_SLICE_HOOKS);
    process.chdir(base);
    _clearGsdRootCache();
    resetHookState();

    // plan-slice completes; gate-a (first in queue) dispatches.
    const first = createStepModeHarness(base, "plan-slice", "M001/S01");
    assert.equal(await postUnitPostVerification(first.pctx), "continue");
    assert.equal(first.session.sidecarQueue[0].unitType, "hook/gate-a");
    first.session.clearCurrentUnit();
    first.session.sidecarQueue.length = 0;

    // gate-a completes without a verdict; its cycle budget is exhausted, so
    // the gate blocks with gate-b still queued behind it.
    first.session.currentUnit = { type: "hook/gate-a", id: "M001/S01", startedAt: Date.now() };
    assert.equal(await postUnitPostVerification(first.pctx), "stopped");

    // Resume: gate-a is re-armed, and gate-b must be restored with it.
    resetHookState();
    restoreHookState(base);
    const resumed = new AutoSession();
    resumed.basePath = base;
    resumed.active = true;
    resumed.stepMode = true;
    reconcileRestoredHookDispatch(base, resumed.sidecarQueue);
    reconcileRestoredGateBlock(base, resumed.sidecarQueue);
    assert.equal(resumed.sidecarQueue.length, 1);
    assert.equal(resumed.sidecarQueue[0].unitType, "hook/gate-a");
    resumed.sidecarQueue.length = 0;

    // gate-a's re-run passes; gate-b must dispatch next — not be skipped.
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01", "GATE-A.md"),
      "---\nverdict: pass\n---\n\nGate A passed.\n",
      "utf-8",
    );
    resumed.currentUnit = { type: "hook/gate-a", id: "M001/S01", startedAt: Date.now() };
    const { pctx } = createPctx(base, resumed);
    assert.equal(await postUnitPostVerification(pctx), "continue");
    assert.equal(resumed.sidecarQueue.length, 1, "gate-b runs after gate-a passes");
    assert.equal(resumed.sidecarQueue[0].unitType, "hook/gate-b");
    resumed.sidecarQueue.length = 0;

    // gate-b passes; selection may finally proceed.
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01", "GATE-B.md"),
      "---\nverdict: pass\n---\n\nGate B passed.\n",
      "utf-8",
    );
    resumed.currentUnit = { type: "hook/gate-b", id: "M001/S01", startedAt: Date.now() };
    assert.equal(await postUnitPostVerification(pctx), "step-wizard");
    assert.equal(resumed.sidecarQueue.length, 0);
    assert.equal(getActiveHook(), null);
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    if (base) rmSync(base, { recursive: true, force: true });
  }
});

test("resume re-arms an execute-task gate with completion identity and schedules rework", async () => {
  const originalCwd = process.cwd();
  let base = "";
  try {
    base = setupFixture("gsd-step-gate-rework-", EXECUTE_TASK_BLOCKING_HOOK);
    process.chdir(base);
    _clearGsdRootCache();
    resetHookState();
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete" });
    seedCompletedTaskLifecycle("gsd-step-gate-rework-op");

    // execute-task completed: the gate dispatches carrying the canonical
    // completion operation, then pauses the task on needs-attention.
    const dispatch = checkPostUnitHooks("execute-task", "M001/S01/T01", base);
    assert.ok(dispatch, "gate dispatches for the completed task");
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01/T01", "REVIEW.md"),
      "---\nverdict: needs-attention\n---\n\nNeeds human attention.\n",
      "utf-8",
    );
    assert.equal(checkPostUnitHooks("hook/review-gate", "M001/S01/T01", base), null);
    persistHookState(base);

    // Resume: the re-armed gate keeps the completion identity.
    resetHookState();
    restoreHookState(base);
    const resumed = new AutoSession();
    resumed.basePath = base;
    resumed.active = true;
    resumed.stepMode = true;
    reconcileRestoredGateBlock(base, resumed.sidecarQueue);
    assert.equal(resumed.sidecarQueue.length, 1);
    assert.equal(resumed.sidecarQueue[0].unitType, "hook/review-gate");
    const rearmed = getActiveHook();
    assert.ok(rearmed, "gate is re-armed in flight");
    assert.ok(rearmed.completionOperationId, "re-armed hook keeps the completion operation id");
    resumed.sidecarQueue.length = 0;

    // The re-run requests rework: the trigger task is reopened for retry
    // instead of throwing on the missing completion identity.
    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01/T01", "REVIEW.md"),
      "---\nverdict: needs-rework\n---\n\nRework requested.\n",
      "utf-8",
    );
    resumed.currentUnit = { type: "hook/review-gate", id: "M001/S01/T01", startedAt: Date.now() };
    const retryActiveUnit = mock.fn(async (_unit: { unitType: string; unitId: string }) => {});
    resumed.orchestration = {
      start: async () => ({ kind: "started" }),
      advance: async () => ({ kind: "stopped", reason: "unused" }),
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit,
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "resumed" }),
      stop: async (reason: string) => ({ kind: "stopped", reason }),
      getStatus: () => ({ phase: "running", transitionCount: 0 }),
    } as any;
    const { pctx } = createPctx(base, resumed);
    assert.equal(await postUnitPostVerification(pctx), "step-wizard");
    assert.equal(retryActiveUnit.mock.callCount(), 1);
    assert.deepEqual(retryActiveUnit.mock.calls[0]?.arguments[0], {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
    });
    assert.equal(getTask("M001", "S01", "T01")?.status, "pending", "rework reopens the task");
  } finally {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    if (base) rmSync(base, { recursive: true, force: true });
  }
});

test("resume holds selection when a resolved gate has a blocked sibling", async (t) => {
  const originalCwd = process.cwd();
  const base = setupFixture("gsd-step-blocked-sibling-", TWO_BLOCKING_PLAN_SLICE_HOOKS);
  t.after(() => {
    closeDatabase();
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  _clearGsdRootCache();
  resetHookState();
  assert.ok(checkPostUnitHooks("plan-slice", "M001/S01", base));
  for (const artifact of ["GATE-A.md", "GATE-B.md"]) {
    writeFileSync(resolveHookArtifactPath(base, "M001/S01", artifact), "---\nverdict: needs-attention\n---\n");
  }
  assert.equal(checkPostUnitHooks("hook/gate-a", "M001/S01", base), null);
  persistHookState(base);
  writeFileSync(resolveHookArtifactPath(base, "M001/S01", "GATE-A.md"), "---\nverdict: pass\n---\n");
  resetHookState();
  restoreHookState(base);
  const resumed = new AutoSession();
  resumed.basePath = base;
  resumed.active = true;
  resumed.stepMode = true;
  reconcileRestoredGateBlock(base, resumed.sidecarQueue);
  const { pctx, pauseAuto } = createPctx(base, resumed);
  assert.equal(resumed.currentUnit, null);
  assert.equal(await handlePendingHookOutcome(pctx), "stopped");
  assert.equal(pauseAuto.mock.callCount(), 1);
  resetHookState();
  restoreHookState(base);
  reconcileRestoredGateBlock(base, resumed.sidecarQueue);
  assert.equal(resumed.sidecarQueue[0]?.unitType, "hook/gate-b");
});

for (const queuedSibling of [false, true]) {
  test(`resume preserves existing-artifact completion identity (sibling=${queuedSibling})`, async (t) => {
    const originalCwd = process.cwd();
    let base = "";
    t.after(() => {
      closeDatabase();
      process.chdir(originalCwd);
      resetHookState();
      invalidateAllCaches();
      _clearGsdRootCache();
      if (base) rmSync(base, { recursive: true, force: true });
    });
    base = setupFixture("gsd-step-gate-rework-", (queuedSibling
      ? EXECUTE_TASK_BLOCKING_HOOK.replaceAll("review-gate", "first-gate").replaceAll("REVIEW.md", "FIRST.md") + EXECUTE_TASK_BLOCKING_HOOK
      : EXECUTE_TASK_BLOCKING_HOOK));
    process.chdir(base);
    _clearGsdRootCache();
    resetHookState();
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete" });
    seedCompletedTaskLifecycle("gsd-step-gate-rework-op");

    writeFileSync(resolveHookArtifactPath(base, "M001/S01/T01", "REVIEW.md"), "---\nverdict: needs-attention\n---\n");
    if (queuedSibling) {
      assert.ok(checkPostUnitHooks("execute-task", "M001/S01/T01", base));
      writeFileSync(resolveHookArtifactPath(base, "M001/S01/T01", "FIRST.md"), "---\nverdict: needs-attention\n---\n");
      assert.equal(checkPostUnitHooks("hook/first-gate", "M001/S01/T01", base), null);
      persistHookState(base);
      writeFileSync(resolveHookArtifactPath(base, "M001/S01/T01", "FIRST.md"), "---\nverdict: pass\n---\n");
      resetHookState();
      restoreHookState(base);
      reconcileRestoredGateBlock(base, []);
    } else {
      assert.equal(checkPostUnitHooks("execute-task", "M001/S01/T01", base), null);
    }
    persistHookState(base);

    resetHookState();
    restoreHookState(base);
    const resumed = new AutoSession();
    resumed.basePath = base;
    resumed.active = true;
    resumed.stepMode = true;
    reconcileRestoredGateBlock(base, resumed.sidecarQueue);
    assert.equal(resumed.sidecarQueue.length, 1);
    assert.equal(resumed.sidecarQueue[0].unitType, "hook/review-gate");
    const rearmed = getActiveHook();
    assert.ok(rearmed, "gate is re-armed in flight");
    assert.ok(rearmed.completionOperationId, "re-armed hook keeps the completion operation id");
    resumed.sidecarQueue.length = 0;

    writeFileSync(
      resolveHookArtifactPath(base, "M001/S01/T01", "REVIEW.md"),
      "---\nverdict: needs-rework\n---\n\nRework requested.\n",
      "utf-8",
    );
    resumed.currentUnit = { type: "hook/review-gate", id: "M001/S01/T01", startedAt: Date.now() };
    const retryActiveUnit = mock.fn(async (_unit: { unitType: string; unitId: string }) => {});
    resumed.orchestration = {
      start: async () => ({ kind: "started" }),
      advance: async () => ({ kind: "stopped", reason: "unused" }),
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit,
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "resumed" }),
      stop: async (reason: string) => ({ kind: "stopped", reason }),
      getStatus: () => ({ phase: "running", transitionCount: 0 }),
    } as any;
    const { pctx } = createPctx(base, resumed);
    assert.equal(await postUnitPostVerification(pctx), "step-wizard");
    assert.equal(retryActiveUnit.mock.callCount(), 1);
    assert.deepEqual(retryActiveUnit.mock.calls[0]?.arguments[0], {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
    });
    assert.equal(getTask("M001", "S01", "T01")?.status, "pending", "rework reopens the task");
  });
}
