// Project/App: gsd-pi
// File Purpose: Auto-loop execution, dispatch, recovery, and cancellation regression tests.

import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveAgentEnd,
  resolveAgentEndCancelled,
  _resetPendingResolve,
  _hasPendingResolveForTest,
  _setActiveSession,
  _setSessionSwitchInFlight,
  _markSessionSwitchAbortGraceWindow,
  _clearSessionSwitchAbortGraceWindow,
  _consumePendingSwitchCancellation,
  isSessionSwitchInFlight,
  isSessionSwitchAbortGraceActive,
} from "../auto/resolve.js";
import { runUnit, shouldDeferUnitFailsafeTimeout } from "../auto/run-unit.js";
import { consumeAutoWakeup, scheduleAutoWakeup, _resetAutoWakeupsForTest } from "../auto/schedule-wakeup.js";
import { writeUnitRuntimeRecord, readUnitRuntimeRecord } from "../unit-runtime.js";
import { autoLoop as rawAutoLoop } from "../auto/loop.js";
import { runPreDispatch } from "../auto/pre-dispatch.js";
import { runDispatch } from "../auto/dispatch.js";
import { runUnitPhase, resetSessionTimeoutState } from "../auto/unit-phase.js";
import { runPostUnitVerification } from "../auto-verification.js";
import type { UnitResult, AgentEndEvent, LoopState } from "../auto/types.js";
import type { LoopDeps } from "../auto/loop-deps.js";
import type { AutoAdvanceResult, AutoOrchestrationModule, AutoStatus, UnitRef } from "../auto/contracts.js";
import { WorktreeStateProjection } from "../worktree-state-projection.js";
import { ModelPolicyDispatchBlockedError } from "../auto-model-selection.js";
import type { SessionLockStatus } from "../session-lock.js";
import { _getAdapter, openDatabase, closeDatabase, getTask, insertMilestone, insertSlice, insertTask } from "../gsd-db.js";
import { getOpenWedge } from "../auto-liveness-backstop.js";
import { isBlockedStopReason, stopNoticeKind } from "../stop-notice.js";
import { mapStatusToExitCode } from "../../../../headless-events.ts";
import { getAutoWorker, registerAutoWorker } from "../db/auto-workers.js";
import { claimMilestoneLease, getMilestoneLease, milestoneLeaseTtlSeconds } from "../db/milestone-leases.js";
import { getLatestForUnit, recordDispatchClaim, markCanceled } from "../db/unit-dispatches.js";
import { setRuntimeKv, getRuntimeKv } from "../db/runtime-kv.js";
import { SourceObservationStore } from "../source-observations.js";
import { autoCommitCurrentBranch } from "../worktree.js";
import {
  claimTaskAttempt,
  readLatestTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.js";
import { stageTaskCompletion } from "../task-completion-compatibility-adapter.js";
import {
  publishVerifiedTaskExecution,
  runWithTaskExecutionAttempt,
} from "../auto/task-execution-cutover.js";
import { CustomWorkflowEngine } from "../custom-workflow-engine.js";
import { CustomExecutionPolicy } from "../custom-execution-policy.js";
import { executeDomainOperation } from "../db/domain-operation.js";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.js";
import { recordFailureAndSelectRecovery } from "../task-recovery-domain-operation.js";
import { handleReplanTask } from "../tools/replan-task.js";
import { appendCapture, markCaptureResolved } from "../captures.js";
import { autoSession } from "../auto-runtime-state.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ORCHESTRATION_MISSING_REASON =
  "Auto Orchestration Module is not wired; cannot dispatch built-in GSD Unit.";

type CapturedAutoSideEffects<T> = {
  result: T;
  stopped: boolean;
  stoppedReason?: string;
  paused: boolean;
  pausedReason?: string;
};

function makeEvent(
  messages: unknown[] = [{ role: "assistant" }],
): AgentEndEvent {
  return { messages };
}

async function drainMicrotasks(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

function guardedExitMilestoneForTest(
  merge: (milestoneId: string, opts: { merge: boolean }) => {
    ok: boolean;
    merged?: boolean;
    codeFilesChanged?: boolean;
    reason?: string;
    cause?: unknown;
  },
) {
  return (
    milestoneId: string,
    opts: {
      merge: boolean;
      guardedMerge?: {
        projectRoot: string;
        preflightCleanRoot: (
          basePath: string,
          milestoneId: string,
          notify: (message: string, level: "info" | "warning" | "error") => void,
        ) => { blocked?: boolean; blockedReason?: string; stashPushed: boolean; stashMarker?: string };
        postflightPopStash: (
          basePath: string,
          milestoneId: string,
          stashMarker: string | undefined,
          notify: (message: string, level: "info" | "warning" | "error") => void,
        ) => { needsManualRecovery?: boolean };
      };
    },
    ctx?: { notify: (message: string, level: "info" | "warning" | "error") => void },
  ) => {
    const notify = ctx?.notify ?? (() => {});
    const guard = opts.guardedMerge;
    if (opts.merge && guard) {
      const preflight = guard.preflightCleanRoot(guard.projectRoot, milestoneId, notify);
      if (preflight.blocked) {
        return {
          ok: false,
          reason: preflight.blockedReason?.startsWith("unmerged-conflicts")
            ? "preflight-unmerged-conflicts"
            : "preflight-dirty-overlap",
        };
      }

      const mergeResult = merge(milestoneId, { merge: true });
      const postflight = preflight.stashPushed
        ? guard.postflightPopStash(
            guard.projectRoot,
            milestoneId,
            preflight.stashMarker,
            notify,
          )
        : undefined;

      if (!mergeResult.ok) {
        return {
          ok: false,
          reason: mergeResult.reason === "merge-conflict" ? "merge-conflict" : "merge-failed",
          cause: mergeResult.cause,
          postflight,
        };
      }
      if (postflight?.needsManualRecovery) {
        return { ok: false, reason: "postflight-stash-restore-failed", postflight };
      }
      return mergeResult;
    }
    return merge(milestoneId, opts);
  };
}

async function waitForMicrotasks(
  condition: () => boolean,
  label: string,
  turns = 5000,
): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (condition()) return;
    await Promise.resolve();
    if (i % 25 === 24) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function makeLoopState(): LoopState {
  return {
    consecutiveFinalizeTimeouts: 0,
    consecutiveDispatchCount: new Map<string, number>(),
    lastDispatchedKey: null,
    lastDispatchPhase: null,
  };
}

function createLoopTestOrchestration(
  ctx: any,
  pi: any,
  s: any,
  deps: LoopDeps,
): AutoOrchestrationModule {
  // Production auto.ts wires the real Auto Orchestration Module before entering
  // autoLoop. These loop-mechanics tests keep their LoopDeps fixtures by
  // adapting the old phase helpers to the public orchestration Interface.
  const loopState = makeLoopState();
  const status: AutoStatus = { phase: "running", transitionCount: 0 };
  let iteration = 0;
  let seq = 0;

  function nextSeq(): number {
    return ++seq;
  }

  function clearActiveUnit(): void {
    status.activeUnit = undefined;
  }

  async function captureAutoSideEffects<T>(
    run: () => Promise<T>,
  ): Promise<CapturedAutoSideEffects<T>> {
    const originalStopAuto = deps.stopAuto;
    const originalPauseAuto = deps.pauseAuto;
    let stoppedReason: string | undefined;
    let pausedReason: string | undefined;
    let stopped = false;
    let paused = false;

    (deps as any).stopAuto = async (...args: Parameters<LoopDeps["stopAuto"]>) => {
      stopped = true;
      stoppedReason = args[2];
      return originalStopAuto(...args);
    };
    (deps as any).pauseAuto = async (...args: Parameters<LoopDeps["pauseAuto"]>) => {
      paused = true;
      const context = args[2] as { message?: string } | undefined;
      pausedReason = context?.message;
      return originalPauseAuto(...args);
    };

    try {
      const result = await run();
      return { result, stopped, stoppedReason, paused, pausedReason };
    } finally {
      (deps as any).stopAuto = originalStopAuto;
      (deps as any).pauseAuto = originalPauseAuto;
    }
  }

  function resultForBreak(
    reason: string,
    sideEffects: CapturedAutoSideEffects<unknown>,
  ): AutoAdvanceResult {
    clearActiveUnit();
    status.phase = sideEffects.paused && !sideEffects.stopped ? "paused" : "stopped";
    status.transitionCount += 1;
    if (sideEffects.paused && !sideEffects.stopped) {
      return {
        kind: "blocked",
        reason: sideEffects.pausedReason ?? reason,
        action: "pause",
      };
    }
    return {
      kind: "stopped",
      reason: sideEffects.stoppedReason ?? reason,
    };
  }

  return {
    async start() {
      status.phase = "running";
      status.transitionCount += 1;
      return { kind: "started" };
    },
    async advance() {
      iteration += 1;
      seq = 0;
      const prefs = deps.loadEffectiveGSDPreferences()?.preferences;
      const ic = {
        ctx,
        pi,
        s,
        deps,
        prefs,
        iteration,
        flowId: `loop-test-orchestration-${iteration}`,
        nextSeq,
      };

      const preDispatch = await captureAutoSideEffects(() => runPreDispatch(ic, loopState));
      const preDispatchResult = preDispatch.result;
      if (preDispatchResult.action === "break") {
        return resultForBreak(preDispatchResult.reason, preDispatch);
      }
      if (preDispatchResult.action === "continue") {
        return { kind: "skipped", code: "no-dispatch" as const, reason: "pre-dispatch-skip" };
      }
      if (preDispatchResult.action === "retry") {
        return { kind: "paused", reason: preDispatchResult.reason, failureKind: "runtime-unknown" as const };
      }

      const dispatch = await captureAutoSideEffects(() =>
        runDispatch(ic, preDispatchResult.data, loopState),
      );
      if (dispatch.result.action === "break") {
        return resultForBreak(dispatch.result.reason, dispatch);
      }
      if (dispatch.result.action === "continue") {
        return {
          kind: "skipped",
          code: "no-dispatch" as const,
          reason: "dispatch-skip",
          stateSnapshot: preDispatchResult.data.state,
        };
      }
      if (dispatch.result.action === "retry") {
        return { kind: "paused", reason: dispatch.result.reason, failureKind: "runtime-unknown" as const };
      }

      const data = dispatch.result.data;
      const unit: UnitRef = { unitType: data.unitType, unitId: data.unitId };
      s.pendingOrchestrationDispatch = {
        unitType: data.unitType,
        unitId: data.unitId,
        prompt: data.prompt,
        pauseAfterUatDispatch: data.pauseAfterUatDispatch,
        state: data.state,
        mid: data.mid,
        midTitle: data.midTitle,
      };
      status.phase = "running";
      status.activeUnit = unit;
      status.transitionCount += 1;
      // Real workers still claim in the loop. Fixture-only runs pass a
      // positive id so the loop does not open a second database claim.
      const dispatchId = s.workerId ? 0 : 1;
      s.pendingOrchestrationDispatch.dispatchId = dispatchId;
      return { kind: "advanced", unit, stateSnapshot: data.state, dispatchId };
    },
    async settle() {
      clearActiveUnit();
    },
    async completeActiveUnit() {
      clearActiveUnit();
    },
    async retryActiveUnit() {
      clearActiveUnit();
    },
    async abandonActiveUnit() {
      clearActiveUnit();
    },
    async resume() {
      status.phase = "running";
      status.transitionCount += 1;
      return { kind: "resumed" };
    },
    async stop(reason: string) {
      status.phase = "stopped";
      clearActiveUnit();
      status.transitionCount += 1;
      return { kind: "stopped", reason };
    },
    getStatus() {
      return {
        ...status,
        activeUnit: status.activeUnit ? { ...status.activeUnit } : undefined,
      };
    },
  };
}

async function autoLoop(
  ctx: any,
  pi: any,
  s: any,
  deps: LoopDeps,
  options?: Parameters<typeof rawAutoLoop>[4],
): Promise<void> {
  // Loop-mechanics fixtures intentionally do not open the workflow database or
  // register a worker. Bypass only that unrelated coordination boundary; tests
  // that provide a real worker continue through the canonical claim adapter.
  if (!s.workerId && !deps.openDispatchClaim) {
    deps.openDispatchClaim = () => ({ kind: "opened", dispatchId: 1 });
  }
  if (!s.orchestration) {
    s.orchestration = createLoopTestOrchestration(ctx, pi, s, deps);
  }
  await rawAutoLoop(ctx, pi, s, deps, options);
}

/**
 * Build a minimal mock AutoSession with controllable newSession behavior.
 */
function makeMockSession(opts?: {
  newSessionResult?: { cancelled: boolean };
  newSessionThrows?: string;
  /** Reject newSession() with a specific Error instance (e.g. TypeError). */
  newSessionThrowsError?: Error;
  newSessionDelayMs?: number;
  onNewSessionStart?: (session: any) => void;
  onNewSessionSettle?: (session: any) => void;
  /** Called after the delay with the aborted state of any passed abortSignal.
   *  Used to verify that runUnit passes an aborted signal on late resolution (#3731). */
  onSignalCheck?: (aborted: boolean) => void;
}) {
  const session = {
    active: true,
    verbose: false,
    basePath: process.cwd(),
    cmdCtx: {
      newSession: (options?: { abortSignal?: AbortSignal; workspaceRoot?: string }) => {
        opts?.onNewSessionStart?.(session);
        if (opts?.newSessionThrowsError) {
          return Promise.reject(opts.newSessionThrowsError);
        }
        if (opts?.newSessionThrows) {
          return Promise.reject(new Error(opts.newSessionThrows));
        }
        const result = opts?.newSessionResult ?? { cancelled: false };
        const delay = opts?.newSessionDelayMs ?? 0;
        if (delay > 0) {
          return new Promise<{ cancelled: boolean }>((res) =>
            setTimeout(() => {
              // Simulate AgentSession.newSession() checking abortSignal after
              // its internal async work (abort()) completes — this is where the
              // real code selects a workspace root and rebuilds the tool runtime.
              // If the signal is aborted, the real code discards the session.
              opts?.onSignalCheck?.(options?.abortSignal?.aborted ?? false);
              opts?.onNewSessionSettle?.(session);
              res(result);
            }, delay),
          );
        }
        opts?.onSignalCheck?.(options?.abortSignal?.aborted ?? false);
        opts?.onNewSessionSettle?.(session);
        return Promise.resolve(result);
      },
    },
    clearTimers: () => {},
  } as any;
  return session;
}

/**
 * Build a minimal mock ExtensionContext.
 */
function makeMockCtx() {
  return {
    ui: { notify: () => {} },
    model: { id: "test-model" },
  } as any;
}

/**
 * Build a minimal mock ExtensionAPI that records sendMessage calls.
 */
function makeMockPi() {
  const calls: unknown[] = [];
  const setModelCalls: unknown[] = [];
  return {
    sendMessage: (...args: unknown[]) => {
      calls.push(args);
    },
    setModel: async (...args: unknown[]) => {
      setModelCalls.push(args);
      return true;
    },
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
    calls,
    setModelCalls,
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("resolveAgentEnd resolves a pending runUnit promise", async () => {
  _resetPendingResolve();

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = makeMockPi();
  const s = makeMockSession();
  const event = makeEvent();

  // Start runUnit — it will create the promise and send a message,
  // then block awaiting agent_end
  const resultPromise = runUnit(
    ctx,
    pi,
    s,
    "task",
    "T01",
    "do stuff",
  );

  // Give the microtask queue a tick so runUnit reaches the await
  await new Promise((r) => setTimeout(r, 10));

  // Now resolve the agent_end
  resolveAgentEnd(event);

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.event, event);
});

test("runUnit clears scoped skill visibility after a manifest-scoped unit completes", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const skillVisibilityCalls: Array<string[] | undefined> = [];
  let visibleSkills: string[] | undefined;
  pi.setVisibleSkills = (names: string[] | undefined) => {
    visibleSkills = names;
    skillVisibilityCalls.push(names);
  };
  const s = makeMockSession();

  const resultPromise = runUnit(ctx, pi, s, "plan-slice", "M001/S01", "prompt");

  await new Promise((r) => setTimeout(r, 10));
  assert.ok(Array.isArray(visibleSkills), "unit dispatch should scope skills before the turn starts");

  resolveAgentEnd(makeEvent());

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.equal(visibleSkills, undefined);
  assert.equal(skillVisibilityCalls.at(-1), undefined);
});

test("runUnit honors ScheduleWakeup by continuing the same unit session", async () => {
  _resetPendingResolve();
  _resetAutoWakeupsForTest();

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = makeMockPi();
  const s = makeMockSession();
  const firstEvent = makeEvent([{ role: "assistant", content: "submitted job" }]);
  const secondEvent = makeEvent([{ role: "assistant", content: "job finished" }]);

  const resultPromise = runUnit(
    ctx,
    pi,
    s,
    "execute-task",
    "M001/S01/T01",
    "submit external job",
  );

  await waitForMicrotasks(() => pi.calls.length === 1, "initial unit dispatch");
  scheduleAutoWakeup({
    basePath: s.basePath,
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    delayMs: 0,
    prompt: "check external job and write the task summary if complete",
    reason: "poll external job",
    createdAt: Date.now(),
  });
  resolveAgentEnd(firstEvent);

  await waitForMicrotasks(() => pi.calls.length === 2, "scheduled wakeup dispatch");
  assert.equal((pi.calls[1] as any[])[0].content, "check external job and write the task summary if complete");
  resolveAgentEnd(secondEvent);

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.event, secondEvent);
  assert.equal(pi.calls.length, 2);
});

test("runUnit clears scheduled wakeups when the unit is cancelled", async () => {
  _resetPendingResolve();
  _resetAutoWakeupsForTest();

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = makeMockPi();
  const s = makeMockSession();

  const resultPromise = runUnit(
    ctx,
    pi,
    s,
    "execute-task",
    "M001/S01/T02",
    "submit external job",
  );

  await waitForMicrotasks(() => pi.calls.length === 1, "initial unit dispatch");
  scheduleAutoWakeup({
    basePath: s.basePath,
    unitType: "execute-task",
    unitId: "M001/S01/T02",
    delayMs: 0,
    prompt: "stale prompt from cancelled unit",
    reason: "poll external job",
    createdAt: Date.now(),
  });
  resolveAgentEndCancelled({
    message: "Auto-mode paused",
    category: "aborted",
    isTransient: true,
  });

  const result = await resultPromise;
  assert.equal(result.status, "cancelled");
  assert.equal(
    consumeAutoWakeup(s.basePath, "execute-task", "M001/S01/T02"),
    null,
    "cancelled units must not leave stale ScheduleWakeup prompts for later retries",
  );
});

test("runUnit suppresses the global working-message loader for auto dashboard runs", async () => {
  _resetPendingResolve();
  const workingMessages: unknown[] = [];

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: (message?: string | null) => {
        workingMessages.push(message);
      },
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = makeMockPi();
  const s = makeMockSession();
  const event = makeEvent();

  const resultPromise = runUnit(
    ctx,
    pi,
    s,
    "complete-slice",
    "M003/S01",
    "complete slice",
  );

  await waitForMicrotasks(() => pi.calls.length === 1, "unit dispatch");
  resolveAgentEnd(event);
  const result = await resultPromise;

  assert.equal(result.status, "completed");
  assert.deepEqual(workingMessages, [null, undefined]);
});

test("runUnit failsafe defers cancellation while timeout recovery is making fresh progress", async () => {
  _resetPendingResolve();
  mock.timers.enable();
  const originalCwd = process.cwd();

  try {
    mock.timers.setTime(10_000);
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeMockSession();
    s.basePath = makeLoopTestBase("gsd-rununit-recovery-");
    s.currentUnit = { type: "task", id: "T01", startedAt: 1234 };

    const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");
    await waitForMicrotasks(() => pi.calls.length === 1, "unit dispatch");

    writeUnitRuntimeRecord(s.basePath, "task", "T01", 1234, {
      phase: "recovered",
      recoveryAttempts: 1,
      lastProgressKind: "hard-recovery-retry",
      lastProgressAt: Date.now(),
    });
    assert.equal(
      shouldDeferUnitFailsafeTimeout(readUnitRuntimeRecord(s.basePath, "task", "T01"), {
        nowMs: Date.now(),
        currentUnitStartedAt: s.currentUnit.startedAt,
        freshProgressMs: 30_000,
      }),
      true,
      "fresh recovery runtime should defer the failsafe",
    );

    setTimeout(() => {
      writeUnitRuntimeRecord(s.basePath, "task", "T01", 1234, {
        phase: "recovered",
        recoveryAttempts: 1,
        lastProgressKind: "hard-recovery-retry",
        lastProgressAt: Date.now(),
      });
    }, (30 * 60 * 1000) + 29_000);

    mock.timers.tick((30 * 60 * 1000) + 31_000);
    await Promise.resolve();

    resolveAgentEnd(makeEvent());
    const result = await resultPromise;
    assert.equal(result.status, "completed");
  } finally {
    mock.timers.reset();
    process.chdir(originalCwd);
  }
});

test("shouldDeferUnitFailsafeTimeout rejects stale runtime progress", () => {
  assert.equal(
    shouldDeferUnitFailsafeTimeout({
      version: 1,
      unitType: "task",
      unitId: "T01",
      startedAt: 1234,
      updatedAt: 1,
      phase: "recovered",
      wrapupWarningSent: false,
      continueHereFired: false,
      timeoutAt: 1,
      lastProgressAt: 1,
      progressCount: 1,
      lastProgressKind: "hard-recovery-retry",
      recoveryAttempts: 1,
    }, {
      nowMs: 120_000,
      currentUnitStartedAt: 1234,
      freshProgressMs: 30_000,
    }),
    false,
  );
});

test("shouldDeferUnitFailsafeTimeout rejects future runtime progress", () => {
  assert.equal(
    shouldDeferUnitFailsafeTimeout({
      version: 1,
      unitType: "task",
      unitId: "T01",
      startedAt: 1234,
      updatedAt: 1,
      phase: "recovered",
      wrapupWarningSent: false,
      continueHereFired: false,
      timeoutAt: 1,
      lastProgressAt: 150_000,
      progressCount: 1,
      lastProgressKind: "hard-recovery-retry",
      recoveryAttempts: 1,
    }, {
      nowMs: 120_000,
      currentUnitStartedAt: 1234,
      freshProgressMs: 30_000,
    }),
    false,
  );
});

test("resolveAgentEnd drops event when no promise is pending", () => {
  _resetPendingResolve();

  // Should not throw — event is dropped (logged as warning)
  assert.doesNotThrow(() => {
    resolveAgentEnd(makeEvent());
  });
});

test("double resolveAgentEnd only resolves once (second is dropped)", async () => {
  _resetPendingResolve();

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = makeMockPi();
  const s = makeMockSession();
  const event1 = makeEvent([{ id: 1 }]);
  const event2 = makeEvent([{ id: 2 }]);

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");

  await new Promise((r) => setTimeout(r, 10));

  // First resolve — should work
  resolveAgentEnd(event1);

  // Second resolve — should be dropped (no pending resolver)
  assert.doesNotThrow(() => {
    resolveAgentEnd(event2);
  });

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  // Should have the first event, not the second
  assert.deepEqual(result.event, event1);
});

test("runUnit returns cancelled when session creation fails", async () => {
  _resetPendingResolve();

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = makeMockPi();
  const s = makeMockSession({ newSessionThrows: "connection refused" });

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(result.event, undefined);
  // sendMessage should NOT have been called
  assert.equal(pi.calls.length, 0);
});

test("runUnit returns cancelled when command context lacks newSession", async () => {
  _resetPendingResolve();

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = makeMockPi();
  const s = makeMockSession();
  s.cmdCtx = {} as any;

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "session-failed");
  assert.equal(result.errorContext?.isTransient, false);
  assert.match(result.errorContext?.message ?? "", /missing newSession/);
  assert.equal(pi.calls.length, 0);
});

test("runUnit: TypeError from newSession is classified as structural (isTransient: false)", async () => {
  // Regression for #572: a TypeError thrown from newSession (e.g. "something is
  // not a function") indicates a programming error, not a transient provider
  // blip. Before the fix it was always classified isTransient: true, causing
  // auto-mode to retry indefinitely instead of surfacing the real problem.
  _resetPendingResolve();

  const baseCtx = {
    ...makeMockCtx(),
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
    sessionManager: { getEntries: () => [] },
    modelRegistry: { getProviderAuthMode: () => undefined, isProviderRequestReady: () => true },
  } as any;
  const pi = makeMockPi();
  const s = makeMockSession({
    newSessionThrowsError: new TypeError("pi.sendMessage is not a function"),
  });

  const result = await runUnit(baseCtx, pi, s, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "session-failed");
  assert.equal(result.errorContext?.isTransient, false, "TypeError must be non-transient");
});

test("runUnit: 'is not a function' message from newSession is classified as structural", async () => {
  // Regression for #572: the pattern also catches errors where the thrown
  // object is not a TypeError instance but the message contains "is not a function".
  _resetPendingResolve();

  const baseCtx = {
    ...makeMockCtx(),
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
    sessionManager: { getEntries: () => [] },
    modelRegistry: { getProviderAuthMode: () => undefined, isProviderRequestReady: () => true },
  } as any;
  const pi = makeMockPi();
  const s = makeMockSession({ newSessionThrows: "pi.sendMessage is not a function" });

  const result = await runUnit(baseCtx, pi, s, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "session-failed");
  assert.equal(result.errorContext?.isTransient, false, "'is not a function' errors must be non-transient");
});

test("runUnit: generic network error from newSession remains transient", async () => {
  // Confirm that non-structural session errors (e.g. 429, ECONNREFUSED) are
  // still classified as transient so auto-mode can retry them.
  _resetPendingResolve();

  const baseCtx = {
    ...makeMockCtx(),
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
    sessionManager: { getEntries: () => [] },
    modelRegistry: { getProviderAuthMode: () => undefined, isProviderRequestReady: () => true },
  } as any;
  const pi = makeMockPi();
  const s = makeMockSession({ newSessionThrows: "connection refused" });

  const result = await runUnit(baseCtx, pi, s, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "session-failed");
  assert.equal(result.errorContext?.isTransient, true, "network errors must remain transient");
});

test("runUnit clears queued switch cancellation when session creation fails", async () => {
  _resetPendingResolve();

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = makeMockPi();
  const s = makeMockSession({
    newSessionThrows: "connection refused",
    onNewSessionStart: () => {
      resolveAgentEndCancelled({
        message: "Claude Code process aborted by user",
        category: "aborted",
        isTransient: false,
      });
    },
  });

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(_consumePendingSwitchCancellation(), null);
});

test("runUnit returns cancelled when session creation times out", async () => {
  _resetPendingResolve();

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = makeMockPi();
  // Session returns cancelled: true (simulates the timeout race outcome)
  const s = makeMockSession({ newSessionResult: { cancelled: true } });

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(result.event, undefined);
  assert.equal(pi.calls.length, 0);
});

test("runUnit consumes a cancellation queued during session switch before dispatch", async () => {
  _resetPendingResolve();

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = makeMockPi();
  let cancellationQueued = false;
  const s = makeMockSession({
    newSessionDelayMs: 10,
    onNewSessionStart: () => {
      setTimeout(() => {
        cancellationQueued = !resolveAgentEndCancelled({
          message: "Claude Code process aborted by user",
          category: "aborted",
          isTransient: false,
        });
      }, 0);
    },
  });

  const result = await runUnit(ctx, pi, s, "plan-slice", "M009/S01", "prompt");

  assert.equal(cancellationQueued, true);
  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "aborted");
  assert.equal(result.errorContext?.message, "Claude Code process aborted by user");
  assert.equal(pi.calls.length, 0, "queued switch cancellation must prevent prompt dispatch");
});

test("runUnit keeps the session-switch guard across a late newSession settlement", async () => {
  _resetPendingResolve();
  mock.timers.enable();

  try {
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    // Use delays longer than NEW_SESSION_TIMEOUT_MS (120s) so the timeout fires
    const firstSession = makeMockSession({ newSessionDelayMs: 200_000 });
    const secondSession = makeMockSession({ newSessionDelayMs: 200_000 });

    const firstRun = runUnit(ctx, pi, firstSession, "task", "T01", "prompt");

    // Tick past the 120s session timeout
    mock.timers.tick(121_000);
    await Promise.resolve();

    const firstResult = await firstRun;
    assert.equal(firstResult.status, "cancelled");
    assert.equal(isSessionSwitchInFlight(), true, "guard should remain set after the timed-out session");

    mock.timers.tick(1);
    const secondRun = runUnit(ctx, pi, secondSession, "task", "T02", "prompt");

    mock.timers.tick(100_000);
    await Promise.resolve();
    assert.equal(
      isSessionSwitchInFlight(),
      true,
      "late settlement from the first session must not clear the newer session guard",
    );

    // Tick past the second session's timeout (121s total > 120s NEW_SESSION_TIMEOUT_MS)
    mock.timers.tick(21_001);
    await Promise.resolve();

    const secondResult = await secondRun;
    assert.equal(secondResult.status, "cancelled");

    // Tick past the second session's delayed promise (200s) so .finally() fires
    mock.timers.tick(80_000);
    await Promise.resolve();
    assert.equal(isSessionSwitchInFlight(), false, "guard should clear after the newer session settles");
  } finally {
    mock.timers.reset();
  }
});

test("runUnit returns cancelled when s.active is false before sendMessage", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();
  s.active = false;

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(pi.calls.length, 0);
});

test("runUnit only arms resolve after newSession completes", async () => {
  _resetPendingResolve();

  let sawSwitchFlag = false;

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession({
    newSessionDelayMs: 20,
    onNewSessionStart: () => {
      sawSwitchFlag = isSessionSwitchInFlight();
    },
  });

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");

  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sawSwitchFlag, true, "session switch guard should be active during newSession");
  assert.equal(isSessionSwitchInFlight(), false, "session switch guard should clear after newSession settles");

  resolveAgentEnd(makeEvent());

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.equal(pi.calls.length, 1);
});

test("runUnit re-applies the selected unit model after newSession before dispatch", async () => {
  _resetPendingResolve();

  const callOrder: string[] = [];
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  pi.setModel = async (...args: unknown[]) => {
    callOrder.push("setModel");
    pi.setModelCalls.push(args);
    return true;
  };
  pi.sendMessage = (...args: unknown[]) => {
    callOrder.push("sendMessage");
    pi.calls.push(args);
  };

  const s = makeMockSession();
  s.currentUnitModel = { provider: "anthropic", id: "claude-opus-4-6" };

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");

  await new Promise((r) => setTimeout(r, 10));
  resolveAgentEnd(makeEvent());

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.deepEqual(callOrder, ["setModel", "sendMessage"]);
  assert.equal(pi.setModelCalls.length, 1);
  assert.deepEqual(pi.setModelCalls[0][0], s.currentUnitModel);
  assert.equal(pi.calls.length, 1);
});

test("runUnit cancels before dispatch when model restore fails after newSession", async () => {
  _resetPendingResolve();

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = makeMockCtx();
  ctx.ui.notify = (message: string, level: string) => {
    notifications.push({ message, level });
  };

  const pi = makeMockPi();
  pi.setModel = async (...args: unknown[]) => {
    pi.setModelCalls.push(args);
    return false;
  };

  const s = makeMockSession();
  s.currentUnitModel = { provider: "openai-codex", id: "gpt-5.4" };

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "session-failed");
  assert.match(
    result.errorContext?.message ?? "",
    /Failed to restore configured model openai-codex\/gpt-5\.4 after session creation/,
  );
  assert.equal(pi.setModelCalls.length, 1);
  assert.equal(pi.calls.length, 0, "unit must not dispatch on the session default model");
  assert.deepEqual(notifications, [
    {
      message: "Failed to restore configured model openai-codex/gpt-5.4 after session creation. Cancelling unit before dispatch.",
      level: "warning",
    },
  ]);
});

test("runUnit cancels before dispatch when provider is not request-ready (#4555)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.model = { provider: "anthropic", id: "claude-opus-4-6" };
  ctx.modelRegistry = {
    isProviderRequestReady: (_provider: string) => false,
  };

  const pi = makeMockPi();
  const s = makeMockSession();

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "provider");
  assert.match(
    result.errorContext?.message ?? "",
    /Provider anthropic is not request-ready/,
  );
  assert.equal(pi.calls.length, 0, "sendMessage must not be called when provider is not ready");
  assert.equal(_hasPendingResolveForTest(), false, "provider cancellation must clear the pending resolver");
});

test("runUnit cancels before dispatch using currentUnitModel provider when set (#4555)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  // ctx.model uses "openai" which IS ready — if the code ignores currentUnitModel
  // and falls back to ctx.model.provider, the unit would NOT be cancelled. The
  // test therefore differentiates: only a bug (wrong provider lookup) would pass.
  ctx.model = { provider: "openai", id: "gpt-4o" };
  // modelRegistry says anthropic is not ready but openai is
  ctx.modelRegistry = {
    isProviderRequestReady: (provider: string) => provider === "openai",
  };

  const pi = makeMockPi();
  const s = makeMockSession();
  // currentUnitModel overrides the provider used in the readiness check
  s.currentUnitModel = { provider: "anthropic", id: "claude-opus-4-6" };

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");

  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "provider");
  assert.match(
    result.errorContext?.message ?? "",
    /Provider anthropic is not request-ready/,
  );
  assert.equal(pi.calls.length, 0, "sendMessage must not be called — anthropic (currentUnitModel) is not ready");
});

test("runUnit does not cancel before dispatch when provider is request-ready (#4555)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.model = { provider: "anthropic", id: "claude-opus-4-6" };
  ctx.modelRegistry = {
    isProviderRequestReady: (_provider: string) => true,
  };

  const pi = makeMockPi();
  const s = makeMockSession();

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");

  await new Promise((r) => setTimeout(r, 10));
  resolveAgentEnd(makeEvent());

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.equal(pi.calls.length, 1, "sendMessage must be called when provider is ready");
});

test("runUnit proceeds when modelRegistry is absent (no readiness check available) (#4555)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.model = { provider: "anthropic", id: "claude-opus-4-6" };
  // No modelRegistry on ctx — pre-check should be skipped

  const pi = makeMockPi();
  const s = makeMockSession();

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");

  await new Promise((r) => setTimeout(r, 10));
  resolveAgentEnd(makeEvent());

  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.equal(pi.calls.length, 1);
});

test("runUnit proceeds when isProviderRequestReady throws (defensive) (#4555)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.model = { provider: "anthropic", id: "claude-opus-4-6" };
  ctx.modelRegistry = {
    isProviderRequestReady: (_provider: string) => {
      throw new Error("registry error");
    },
  };

  const pi = makeMockPi();
  const s = makeMockSession();

  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");

  // When the readyCheck throws, ready=false → unit cancelled
  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "provider");
  assert.equal(pi.calls.length, 0);
});

test("late-resolving newSession() after timeout receives aborted signal so tool runtime is not configured with stale workspace root (#3731)", async () => {
  // When newSession() times out in runUnit(), a late resolution must not
  // configure the tool runtime against a stale workspace root.
  //
  // The fix: runUnit creates an AbortController, aborts it on timeout, and passes
  // the signal to newSession(). AgentSession.newSession() checks the signal after
  // its internal await this.abort() completes and returns early (discards) if aborted.
  //
  // This test uses mock.timers to control timing precisely.
  _resetPendingResolve();
  mock.timers.enable();

  try {
    let abortedWhenLateSessionSettled: boolean | null = null;

    // newSession mock simulates AgentSession.newSession() behavior:
    // after an internal delay (representing await this.abort()), it checks the
    // abortSignal before selecting the workspace root and calling _buildRuntime.
    // If aborted, the real code must discard the session.
    const s = makeMockSession({
      newSessionDelayMs: 200_000, // longer than NEW_SESSION_TIMEOUT_MS (120s)
      onSignalCheck: (aborted) => {
        abortedWhenLateSessionSettled = aborted;
      },
    });

    const ctx = makeMockCtx();
    const pi = makeMockPi();

    const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");

    // Tick past the 120s NEW_SESSION_TIMEOUT_MS — runUnit returns cancelled
    mock.timers.tick(121_000);
    await Promise.resolve();

    const result = await resultPromise;
    assert.equal(result.status, "cancelled", "runUnit must return cancelled on session timeout");

    // Tick past the delayed newSession (200s total) — the late newSession resolves
    mock.timers.tick(80_000);
    // Drain microtask queue so the .finally() and setTimeout callbacks run
    await Promise.resolve();
    await Promise.resolve();

    // The key assertion: when the late newSession() resolves, runUnit must have
    // passed an aborted AbortSignal. Without the fix, no signal is passed and
    // abortedWhenLateSessionSettled would be false (or null, if signal not passed at all).
    assert.equal(
      abortedWhenLateSessionSettled,
      true,
      "runUnit must pass an aborted AbortSignal to newSession() when it resolves after the session-creation timeout (#3731). " +
      "Without this, AgentSession.newSession() can rebuild the tool runtime with a stale workspace root.",
    );
  } finally {
    mock.timers.reset();
  }
});

// NOTE: the "while keyword", "one-shot null-before-resolve", and
// "selectAndApplyModel before updateProgressWidget" source-grep tests
// previously here were deleted as tautological (readFileSync + substring
// match). The one-shot pattern is already covered behaviourally by the
// "double resolveAgentEnd only resolves once" test above, which drives the
// real resolveAgentEnd/runUnit flow and asserts on the observable promise
// outcome. The phases.ts ordering contract is tracked via a follow-up
// issue proposing extraction of a pure `dispatchOrder` helper (per the
// #4832/PR #4859 precedent) so it can be tested behaviourally.

// ─── autoLoop tests (T02) ─────────────────────────────────────────────────

/**
 * Build a mock LoopDeps that tracks call order and allows controlling
 * behavior via overrides.
 */
function makeMockDeps(
  overrides?: Partial<LoopDeps>,
): LoopDeps & { callLog: string[] } {
  const callLog: string[] = [];

  const baseDeps: LoopDeps = {
    adjudicateNonAdvancingOutcome: () => null,
    taskExecutionBoundary: async (_input, run) => run(),
    taskPublicationBoundary: async () => {},
    lockBase: () => "/tmp/test-lock",
    buildSnapshotOpts: () => ({}),
    stopAuto: async () => {
      callLog.push("stopAuto");
    },
    pauseAuto: async () => {
      callLog.push("pauseAuto");
    },
    clearUnitTimeout: () => {},
    updateProgressWidget: () => {},
    syncCmuxSidebar: () => {},
    logCmuxEvent: () => {},
    invalidateAllCaches: () => {
      callLog.push("invalidateAllCaches");
    },
    deriveState: async () => {
      callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: {
          id: "M001",
          title: "Test Milestone",
          status: "active",
        },
        activeSlice: { id: "S01", title: "Test Slice" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any;
    },
    loadEffectiveGSDPreferences: () => ({
      // These loop-mechanics tests mock executing state without plan-v2 artifacts.
      // Plan-v2 default-on coverage lives in uok-plan-v2-wiring.test.ts.
      preferences: { uok: { plan_v2: { enabled: false } } },
    }),
    preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
    checkResourcesStale: () => null,
    validateSessionLock: () => ({ valid: true } as SessionLockStatus),
    updateSessionLock: () => {
      callLog.push("updateSessionLock");
    },
    handleLostSessionLock: () => {
      callLog.push("handleLostSessionLock");
    },
    sendDesktopNotification: () => {},
    setActiveMilestoneId: () => {},
    pruneQueueOrder: () => {},
    isInAutoWorktree: () => false,
    shouldUseWorktreeIsolation: () => false,
    teardownAutoWorktree: () => {},
    createAutoWorktree: () => "/tmp/wt",
    captureIntegrationBranch: () => {},
    getIsolationMode: () => "none",
    getCurrentBranch: () => "main",
    autoWorktreeBranch: () => "auto/M001",
    resolveMilestoneFile: () => null,
    reconcileMergeState: () => "clean",
    preflightCleanRoot: () => ({ stashPushed: false, summary: "" }),
    postflightPopStash: () => ({
      restored: true,
      needsManualRecovery: false,
      message: "restored",
    }),
    getLedger: () => null,
    getProjectTotals: () => ({ cost: 0 }),
    formatCost: (c: number) => `$${c.toFixed(2)}`,
    getBudgetAlertLevel: () => 0,
    getNewBudgetAlertLevel: () => 0,
    getBudgetEnforcementAction: () => "none",
    getManifestStatus: async () => null,
    collectSecretsFromManifest: async () => null,
    resolveDispatch: async () => {
      callLog.push("resolveDispatch");
      return {
        action: "dispatch" as const,
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "do the thing",
      };
    },
    runPreDispatchHooks: () => ({ firedHooks: [], action: "proceed" }),
    getPriorSliceCompletionBlocker: () => null,
    getMainBranch: () => "main",
    closeoutUnit: async () => {},
    recordOutcome: () => {},
    writeLock: () => {},
    captureAvailableSkills: () => {},
    ensurePreconditions: () => {},
    updateSliceProgressCache: () => {},
    selectAndApplyModel: async () => ({ routing: null, appliedModel: null }),
    startUnitSupervision: () => {},
    getDeepDiagnostic: () => null,
    isDbAvailable: () => false,
    reorderForCaching: (p: string) => p,
    existsSync: (p: string) => p.endsWith(".git") || p.endsWith("package.json"),
    readFileSync: () => "",
    atomicWriteSync: () => {},
    GitServiceImpl: class {} as any,
    lifecycle: {
      enterMilestone: () => ({ ok: true, mode: "worktree", path: "/tmp/project" }),
      exitMilestone: guardedExitMilestoneForTest((_mid, opts) => ({
        ok: true,
        merged: opts.merge,
        codeFilesChanged: false,
      })),
    } as any,
    worktreeProjection: new WorktreeStateProjection(),
    postUnitPreVerification: async () => {
      callLog.push("postUnitPreVerification");
      return "continue" as const;
    },
    runPostUnitVerification: async () => {
      callLog.push("runPostUnitVerification");
      return "continue" as const;
    },
    postUnitPostVerification: async () => {
      callLog.push("postUnitPostVerification");
      return "continue" as const;
    },
    getSessionFile: () => "/tmp/session.json",
    rebuildState: async () => {},
    resolveModelId: (id: string, models: any[]) => models.find((m: any) => m.id === id),
    emitJournalEvent: () => {},
  };

  const merged = { ...baseDeps, ...overrides, callLog };
  return merged;
}

/**
 * Build a mock session for autoLoop testing — needs more fields than the
 * runUnit mock (dispatch counters, milestone state, etc.).
 */
function makeLoopSession(overrides?: Partial<Record<string, unknown>>) {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-auto-loop-"));
  // Plan 001 enforces worktree safety for all isolation modes. Loop-mechanics
  // tests run with getIsolationMode: () => "none", so the project root itself
  // must be a valid git working tree for source-writing Units to dispatch.
  execSync("git init --initial-branch=main", { cwd: basePath, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: basePath, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: basePath, stdio: "ignore" });
  execSync("git commit --allow-empty -m initial", { cwd: basePath, stdio: "ignore" });
  return {
    active: true,
    verbose: false,
    stepMode: false,
    paused: false,
    basePath,
    originalBasePath: "",
    currentMilestoneId: "M001",
    currentUnit: null,
    unitExecutionInFlight: false,
    currentUnitRouting: null,
    sourceObservations: new SourceObservationStore(),
    completedUnits: [],
    resourceVersionOnStart: null,
    lastPromptCharCount: undefined,
    lastBaselineCharCount: undefined,
    lastBudgetAlertLevel: 0,
    pendingVerificationRetry: null,
    pendingVerificationRetryDispatch: null,
    pendingCrashRecovery: null,
    verificationRetryFailureHashes: new Map<string, string>(),
    pendingQuickTasks: [],
    sidecarQueue: [],
    autoModeStartModel: null,
    unitDispatchCount: new Map<string, number>(),
    unitLifetimeDispatches: new Map<string, number>(),
    unitRecoveryCount: new Map<string, number>(),
    verificationRetryCount: new Map<string, number>(),
    zeroToolRetryCount: new Map<string, number>(),
    gitService: null,
    lastRequestTimestamp: 0,
    autoStartTime: Date.now(),
    cmdCtx: {
      newSession: () => Promise.resolve({ cancelled: false }),
      getContextUsage: () => ({ percent: 10, tokens: 1000, limit: 10000 }),
    },
    setCurrentUnit(this: any, unit: any) {
      this.currentUnit = unit;
      this.sourceObservations.beginUnit({
        unitType: unit.type,
        unitId: unit.id,
        startedAt: unit.startedAt,
        basePath: unit.workspaceRoot ?? this.basePath,
      });
    },
    clearCurrentUnit(this: any) {
      this.currentUnit = null;
      this.sourceObservations.clear();
    },
    clearTimers: () => {},
    ...overrides,
  } as any;
}

function openLoopDatabase(t: TestContext, s: ReturnType<typeof makeLoopSession>): void {
  mkdirSync(join(s.basePath, ".gsd"), { recursive: true });
  openDatabase(join(s.basePath, ".gsd", "gsd.db"));
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(s.basePath, { recursive: true, force: true });
  });
}

/** Create a temp project root suitable for loop-mechanics tests. */
function makeLoopTestBase(prefix: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  execSync("git init --initial-branch=main", { cwd: base, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: base, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: base, stdio: "ignore" });
  return base;
}

test("autoLoop exits when s.active is set to false", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession({ active: false });

  const deps = makeMockDeps();
  await autoLoop(ctx, pi, s, deps);

  // Loop body should not have executed (deriveState never called)
  assert.ok(
    !deps.callLog.includes("deriveState"),
    "loop should not have iterated",
  );
});

test("stop-guard-error is adjudicated by the shared loop liveness boundary", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();
  openLoopDatabase(t, s);
  mkdirSync(join(s.basePath, ".gsd", "CAPTURES.md"));
  const deps = makeMockDeps({ adjudicateNonAdvancingOutcome: undefined });

  await autoLoop(ctx, pi, s, deps);
  const first = getOpenWedge(realpathSync(s.basePath));
  assert.equal(first.ok, true);
  assert.equal(first.ok ? first.wedge : null, null, "first guard failure must not trip");

  await autoLoop(ctx, pi, s, deps);
  const second = getOpenWedge(realpathSync(s.basePath));
  assert.equal(second.ok, true);
  assert.equal(second.ok ? second.wedge?.guardId : null, "stop-guard-error");
  assert.equal(second.ok ? second.wedge?.occurrenceCount : null, 2);
  assert.ok(deps.callLog.includes("stopAuto"));
});

test("autoLoop aborts the active unit turn when dispatch crashes", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  let abortCalls = 0;
  ctx.abort = () => {
    abortCalls += 1;
  };
  const pi = makeMockPi();
  const s = makeLoopSession();

  const deps = makeMockDeps({
    taskExecutionBoundary: async () => {
      throw new Error("dispatch crashed");
    },
    stopAuto: async () => {
      s.active = false;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(abortCalls > 0, "crashed unit closeout must abort the active SDK turn");
});

test("a verification retry whose dispatch fails pre-claim is cleared and auto-mode pauses (#2127)", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const notifications: Array<{ message: string; level: string }> = [];
  ctx.ui.notify = (message: string, level: any) => {
    notifications.push({ message, level });
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  t.after(() => rmSync(s.basePath, { recursive: true, force: true }));
  s.pendingVerificationRetry = {
    unitId: "M001/S01/T01",
    failureContext: "git commit hook rejected the staged task changes",
    signature: "git-commit:1:hook rejected",
    attempt: 1,
  };

  const pauseContexts: Array<{ message?: string } | undefined> = [];
  const deps = makeMockDeps({
    // Simulate the task-attempt claim throwing before the unit starts: the
    // cutover boundary rethrows pre-claim failures untouched because there is
    // no Attempt to settle.
    taskExecutionBoundary: async () => {
      throw new Error(
        "Task Attempt claim must activate exactly one matching coordination dispatch",
      );
    },
    pauseAuto: async (_ctx, _pi, errorContext) => {
      pauseContexts.push(errorContext as { message?: string } | undefined);
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(
    s.pendingVerificationRetry,
    null,
    "the retry marker must be cleared when the retried dispatch fails",
  );
  assert.equal(
    deps.callLog.filter((call) => call === "resolveDispatch").length,
    1,
    "the failed retry-bound unit must not be reselected by the next iteration",
  );
  assert.equal(pauseContexts.length, 1, "auto-mode must pause on the failed retry dispatch");
  assert.match(
    pauseContexts[0]?.message ?? "",
    /M001\/S01\/T01/,
    "the pause diagnostic must name the retried unit",
  );
  assert.match(
    pauseContexts[0]?.message ?? "",
    /must activate exactly one matching coordination dispatch/,
    "the pause diagnostic must include the underlying failure",
  );
  assert.ok(
    notifications.some((n) => n.level === "error" && n.message.includes("M001/S01/T01")),
    "the failure must be surfaced as an error notification naming the unit",
  );
});

test("autoLoop stops before dispatch when command context lacks newSession", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession({
    cmdCtx: {
      getContextUsage: () => ({ percent: 10, tokens: 1000, limit: 10000 }),
    },
  });
  let stopReason: string | undefined;
  let preserveWorktree: boolean | undefined;
  let deriveCalled = false;

  try {
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason, options) => {
        stopReason = reason;
        preserveWorktree = options?.preserveWorktree;
        s.active = false;
      },
      deriveState: async () => {
        deriveCalled = true;
        throw new Error("deriveState should not run without command session support");
      },
    });

    await autoLoop(ctx, pi, s, deps);

    assert.equal(stopReason, "Auto-mode has no command context for dispatch.");
    assert.equal(preserveWorktree, true);
    assert.equal(deriveCalled, false);
    assert.equal(pi.calls.length, 0);
  } finally {
    rmSync(s.basePath, { recursive: true, force: true });
  }
});

test("autoLoop commits open unit work when command context lacks newSession", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession({
    cmdCtx: {
      getContextUsage: () => ({ percent: 10, tokens: 1000, limit: 10000 }),
    },
    currentUnit: { type: "execute-task", id: "T01", startedAt: Date.now() },
  });
  const outputPath = join(s.basePath, "executor-output.txt");
  let autoCommitArgs: { unitType: string; unitId: string } | undefined;
  let preserveWorktree: boolean | undefined;

  try {
    const deps = makeMockDeps({
      autoCommitUnit: async (basePath, unitType, unitId) => {
        autoCommitArgs = { unitType, unitId };
        return autoCommitCurrentBranch(basePath, unitType, unitId);
      },
      stopAuto: async (_ctx, _pi, _reason, options) => {
        preserveWorktree = options?.preserveWorktree;
        s.active = false;
      },
      deriveState: async () => {
        throw new Error("deriveState should not run without command session support");
      },
    });

    writeFileSync(outputPath, "open unit work before stop\n", "utf-8");

    await autoLoop(ctx, pi, s, deps);

    assert.deepEqual(autoCommitArgs, { unitType: "execute-task", unitId: "T01" });
    assert.equal(preserveWorktree, true);
    const committed = execSync("git show HEAD:executor-output.txt", {
      cwd: s.basePath,
      encoding: "utf-8",
    });
    assert.equal(committed, "open unit work before stop\n");
    assert.equal(pi.calls.length, 0);
  } finally {
    rmSync(s.basePath, { recursive: true, force: true });
  }
});

test("autoLoop snapshots dirty work when unit dispatch crashes", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();
  const outputPath = join(s.basePath, "executor-output.txt");
  let autoCommitCalls = 0;

  try {
    const deps = makeMockDeps({
      ensurePreconditions: () => {
        writeFileSync(outputPath, "saved before crash\n", "utf-8");
        throw new Error("dispatch crash after file write");
      },
      autoCommitUnit: async (basePath, unitType, unitId) => {
        autoCommitCalls++;
        const commitMsg = autoCommitCurrentBranch(basePath, unitType, unitId);
        s.active = false;
        return commitMsg;
      },
    });

    await autoLoop(ctx, pi, s, deps);

    assert.equal(autoCommitCalls, 1);
    const committed = execSync("git show HEAD:executor-output.txt", {
      cwd: s.basePath,
      encoding: "utf-8",
    });
    assert.equal(committed, "saved before crash\n");
  } finally {
    rmSync(s.basePath, { recursive: true, force: true });
  }
});

test("autoLoop pauses visibly when Auto Orchestration Module is not wired", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();
  let pauseContext: unknown;

  const deps = makeMockDeps({
    pauseAuto: async (_ctx, _pi, errorContext) => {
      pauseContext = errorContext;
      deps.callLog.push("pauseAuto");
    },
  });

  await rawAutoLoop(ctx, pi, s, deps);

  assert.ok(deps.callLog.includes("pauseAuto"), "missing orchestration should pause auto-mode");
  assert.equal(
    (pauseContext as { message?: string } | undefined)?.message,
    ORCHESTRATION_MISSING_REASON,
  );
  assert.equal(deps.callLog.includes("deriveState"), false);
  assert.equal(deps.callLog.includes("resolveDispatch"), false);
  assert.equal(s.pendingOrchestrationDispatch, null);
});

test("autoLoop exits on terminal complete state", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "complete",
        activeMilestone: { id: "M001", title: "Test", status: "complete" },
        activeSlice: null,
        activeTask: null,
        registry: [{ id: "M001", status: "complete" }],
        blockers: [],
      } as any;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(deps.callLog.includes("deriveState"), "should have derived state");
  assert.ok(
    deps.callLog.includes("stopAuto"),
    "should have called stopAuto for complete state",
  );
  // Should NOT have dispatched a unit
  assert.ok(
    !deps.callLog.includes("resolveDispatch"),
    "should not dispatch when complete",
  );
});

test("autoLoop skips provider dispatch when execute-task is already complete in DB", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.setWidget = () => {};
  const pi = makeMockPi();
  const basePath = realpathSync(makeLoopTestBase("gsd-already-complete-dispatch-"));
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  try {
    openDatabase(join(basePath, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "pending" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task One", status: "complete" });

    const s = makeLoopSession({
      basePath,
      originalBasePath: basePath,
      canonicalProjectRoot: basePath,
    });
    let deriveCount = 0;
    const notifications: string[] = [];
    ctx.ui.notify = (msg: string) => notifications.push(msg);

    const deps = makeMockDeps({
      isDbAvailable: () => true,
      deriveState: async () => {
        deriveCount++;
        if (deriveCount > 1) s.active = false;
        return {
          phase: "executing",
          activeMilestone: { id: "M001", title: "Test", status: "active" },
          activeSlice: { id: "S01", title: "Slice 1" },
          activeTask: { id: "T01" },
          registry: [{ id: "M001", status: "active" }],
          blockers: [],
        } as any;
      },
      resolveDispatch: async () => {
        deps.callLog.push("resolveDispatch");
        return {
          action: "dispatch" as const,
          unitType: "execute-task",
          unitId: "M001/S01/T01",
          prompt: "do the already-complete task",
        };
      },
    });

    await autoLoop(ctx, pi, s, deps);

    assert.equal(pi.calls.length, 0, "completed task must not be sent to provider again");
    assert.ok(!deps.callLog.includes("postUnitPreVerification"));
    assert.ok(notifications.some((m) => m.includes("already complete")));
  } finally {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("custom-engine replan recovery completes preparation without verifying or reconciling the workflow step", async (t) => {
  _resetPendingResolve();
  let reconcileCalls = 0;
  t.mock.method(CustomWorkflowEngine.prototype, "deriveState", async () => ({
    phase: "executing",
    isComplete: false,
    readySteps: [],
    blockedSteps: [],
    completedSteps: [],
  }) as any);
  t.mock.method(CustomWorkflowEngine.prototype, "resolveDispatch", async () => ({
    action: "dispatch",
    step: {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "execute the invalid custom-engine Task plan",
    },
  }) as any);
  t.mock.method(CustomWorkflowEngine.prototype, "reconcile", async () => {
    reconcileCalls += 1;
    return { outcome: "continue" } as any;
  });

  const basePath = realpathSync(makeLoopTestBase("gsd-custom-task-replan-"));
  const taskDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "T01-PLAN.md"), "# Invalid Task plan\n");

  try {
    openDatabase(join(basePath, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "active" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task One", status: "pending" });
    const workerId = registerAutoWorker({ projectRootRealpath: basePath });
    const lease = claimMilestoneLease(workerId, "M001");
    assert.equal(lease.ok, true);
    if (!lease.ok) return;

    const lifecycleFence = readDomainOperationFence();
    executeDomainOperation({
      operationType: "test.task.ready",
      idempotencyKey: "test/custom-replan/task-ready",
      expectedRevision: lifecycleFence.revision,
      expectedAuthorityEpoch: lifecycleFence.authorityEpoch,
      actorType: "test",
      sourceTransport: "test",
      payload: { taskId: "T01" },
    }, (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
        lifecycleStatus: "ready",
      });
      return {
        events: [{
          eventType: "test.task.ready",
          entityType: "task",
          entityId: "M001/S01/T01",
          payload: { taskId: "T01" },
          destinations: ["test"],
        }],
        projections: [{
          projectionKey: "test/m001/s01/t01",
          projectionKind: "test",
          rendererVersion: "1",
        }],
      };
    });
    const dispatch = recordDispatchClaim({
      traceId: "seed-custom-replan",
      workerId,
      milestoneLeaseToken: lease.token,
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
    });
    assert.equal(dispatch.ok, true);
    if (!dispatch.ok) return;
    const attempt = claimTaskAttempt({
      invocation: {
        idempotencyKey: "test/custom-replan/claim",
        sourceTransport: "internal",
        actorType: "test",
      },
      task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
      workerId,
      milestoneLeaseToken: lease.token,
      coordinationDispatchId: dispatch.dispatchId,
    });
    const settled = settleTaskAttempt({
      invocation: {
        idempotencyKey: "test/custom-replan/settle",
        sourceTransport: "internal",
        actorType: "test",
      },
      attemptId: attempt.attemptId,
      outcome: "failed",
      failureClass: "plan-invalid",
      summary: "The custom Task plan is invalid",
      output: { failedCheck: "planning-boundary" },
    });
    recordFailureAndSelectRecovery({
      invocation: {
        idempotencyKey: "test/custom-replan/route",
        sourceTransport: "internal",
        actorType: "test",
      },
      attemptId: attempt.attemptId,
      resultId: settled.resultId,
      owner: "agent",
      classification: { failureKind: "plan-invalid" },
      summary: "The custom Task plan is invalid",
      evidence: { failedCheck: "planning-boundary" },
      rationale: "Replace the invalid plan before implementation.",
    });
    markCanceled(dispatch.dispatchId, "seeded routed recovery");

    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {};
    ctx.ui.setWidget = () => {};
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: basePath,
      basePath,
      originalBasePath: basePath,
      canonicalProjectRoot: basePath,
      workerId,
      milestoneLeaseToken: lease.token,
    });
    let hostVerificationCalls = 0;
    let observedUnitType: string | undefined;
    const deps = makeMockDeps({
      isDbAvailable: () => true,
      taskExecutionBoundary: async (input) => {
        observedUnitType = input.unitType;
        const replanned = await handleReplanTask({
          milestoneId: "M001",
          sliceId: "S01",
          taskId: "T01",
          title: "Task One",
          description: "Use the replacement custom-engine plan.",
          estimate: "1h",
          files: ["src/task.ts"],
          verify: "pnpm test",
          inputs: ["planning-boundary"],
          expectedOutput: ["durable replacement"],
          triggerReason: "custom-engine durable recovery",
        }, basePath, {
          idempotencyKey: "test/custom-replan/replace",
          sourceTransport: "internal",
          actorType: "test",
        });
        assert.ok(!("error" in replanned));
        s.active = false;
        return { action: "next", data: {} };
      },
      customEngineHostVerificationBoundary: async () => {
        hostVerificationCalls += 1;
        return "continue";
      },
    });

    await rawAutoLoop(ctx, pi, s, deps);

    assert.equal(observedUnitType, "replan-task");
    assert.equal(hostVerificationCalls, 0, "planning preparation must not run the custom step verifier");
    assert.equal(reconcileCalls, 0, "planning preparation must not complete the custom workflow step");
    assert.equal(readLatestTaskAttempt({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
    })?.attemptNumber, 1, "planning preparation must not claim a replacement Attempt");
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("custom-engine Task verification bypasses legacy retry counters and aborts without pausing", async (t) => {
  _resetPendingResolve();
  let humanPolicyReadThrows = false;
  t.mock.method(CustomWorkflowEngine.prototype, "deriveState", async () => ({
    phase: "executing",
    isComplete: false,
    readySteps: [],
    blockedSteps: [],
    completedSteps: [],
  }) as any);
  t.mock.method(CustomWorkflowEngine.prototype, "resolveDispatch", async () => ({
    action: "dispatch",
    step: {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "execute the Task",
    },
  }) as any);
  t.mock.method(CustomExecutionPolicy.prototype, "requiresHumanVerification", () => {
    if (humanPolicyReadThrows) throw new Error("frozen definition unavailable");
    return true;
  });

  for (const outcome of ["retry", "abort"] as const) {
    humanPolicyReadThrows = outcome === "abort";
    const basePath = realpathSync(makeLoopTestBase(`gsd-custom-task-verify-${outcome}-`));
    mkdirSync(join(basePath, ".gsd"), { recursive: true });
    try {
      openDatabase(join(basePath, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "active" });
      insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task One", status: "pending" });
      const workerId = registerAutoWorker({ projectRootRealpath: basePath });
      const lease = claimMilestoneLease(workerId, "M001");
      assert.equal(lease.ok, true);
      if (!lease.ok) return;

      const ctx = makeMockCtx();
      ctx.ui.setStatus = () => {};
      ctx.ui.setWidget = () => {};
      const pi = makeMockPi();
      const s = makeLoopSession({
        activeEngineId: "custom",
        activeRunDir: basePath,
        basePath,
        originalBasePath: basePath,
        canonicalProjectRoot: basePath,
        workerId,
        milestoneLeaseToken: lease.token,
      });
      let pauseCalls = 0;
      let publicationCalls = 0;
      let observedHumanReviewPolicy: boolean | undefined;
      const deps = makeMockDeps({
        isDbAvailable: () => true,
        taskExecutionBoundary: async (input) => {
          input.markCanonicalDispatchSettled();
          return { action: "next", data: {} };
        },
        customEngineHostVerificationBoundary: async (input) => {
          observedHumanReviewPolicy = input.humanReviewPolicy;
          if (outcome === "retry") s.active = false;
          return outcome;
        },
        taskPublicationBoundary: async () => { publicationCalls++; },
        pauseAuto: async () => { pauseCalls++; },
      });

      await rawAutoLoop(ctx, pi, s, deps);

      assert.equal(observedHumanReviewPolicy, outcome === "retry", "human ownership read failures must enter Task verification as agent-owned");
      assert.equal(s.verificationRetryCount.size, 0, `${outcome} must not consume the legacy retry budget`);
      assert.equal(pauseCalls, 0, `${outcome} must not invent a human pause`);
      assert.equal(publicationCalls, 0, `${outcome} must not publish an unverified Task`);
    } finally {
      closeDatabase();
      rmSync(basePath, { recursive: true, force: true });
    }
  }
});

test("custom-engine recovery break and retry terminalize their dispatch", async (t) => {
  t.mock.method(CustomWorkflowEngine.prototype, "deriveState", async () => ({
    phase: "executing",
    isComplete: false,
    readySteps: [],
    blockedSteps: [],
    completedSteps: [],
  }) as any);
  t.mock.method(CustomWorkflowEngine.prototype, "resolveDispatch", async () => ({
    action: "dispatch",
    step: {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "execute the Task",
    },
  }) as any);

  for (const { action, reason } of [
    { action: "break", reason: "task-recovery-abort" },
    { action: "retry", reason: "task-recovery-abort" },
    { action: "break", reason: "unit-hard-timeout" },
  ] as const) {
    _resetPendingResolve();
    const basePath = realpathSync(makeLoopTestBase(`gsd-custom-task-recovery-${action}-`));
    mkdirSync(join(basePath, ".gsd"), { recursive: true });
    try {
      openDatabase(join(basePath, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "active" });
      insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task One", status: "pending" });
      const workerId = registerAutoWorker({ projectRootRealpath: basePath });
      const lease = claimMilestoneLease(workerId, "M001");
      assert.equal(lease.ok, true);
      if (!lease.ok) return;

      const ctx = makeMockCtx();
      ctx.ui.setStatus = () => {};
      ctx.ui.setWidget = () => {};
      const pi = makeMockPi();
      const s = makeLoopSession({
        activeEngineId: "custom",
        activeRunDir: basePath,
        basePath,
        originalBasePath: basePath,
        canonicalProjectRoot: basePath,
        workerId,
        milestoneLeaseToken: lease.token,
      });
      let releaseCalls = 0;
      s.orchestration = {
        settle: async () => { releaseCalls++; },
        retryActiveUnit: async () => { releaseCalls++; },
        abandonActiveUnit: async () => { releaseCalls++; },
      };
      let dispatchStatusAtPause: string | undefined;
      let releaseCallsAtPause: number | undefined;
      const deps = makeMockDeps({
        isDbAvailable: () => true,
        taskExecutionBoundary: async () => {
          if (action === "retry") s.active = false;
          return { action, reason };
        },
        pauseAuto: async () => {
          dispatchStatusAtPause = getLatestForUnit("M001/S01/T01")?.status;
          releaseCallsAtPause = releaseCalls;
        },
      });

      await rawAutoLoop(ctx, pi, s, deps);

      assert.equal(
        getLatestForUnit("M001/S01/T01")?.status,
        "failed",
        `${action} must not leave an active dispatch that blocks a later resume`,
      );
      if (reason === "unit-hard-timeout") {
        assert.equal(getLatestForUnit("M001/S01/T01")?.exit_reason, "timeout");
      }
      assert.equal(
        dispatchStatusAtPause,
        action === "break" ? "failed" : undefined,
        "a terminal recovery abort must settle its dispatch before pausing",
      );
      assert.equal(
        releaseCallsAtPause,
        action === "break" ? 1 : undefined,
        "a terminal recovery abort must release its active unit before pausing",
      );
      assert.equal(releaseCalls, 1);
      assert.equal(pi.calls.length, 0, `${action} must exit before invoking the agent`);
    } finally {
      closeDatabase();
      rmSync(basePath, { recursive: true, force: true });
    }
  }
});

test("#1769: unit recovery retry releases the active orchestration marker", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  const pi = makeMockPi();
  let advanceCalls = 0;
  let activeMarker = false;
  const retried: UnitRef[] = [];
  const unit = { unitType: "execute-task", unitId: "M001/S01/T01" };
  const s = makeLoopSession({
    currentMilestoneId: "M001",
    orchestration: {
      start: async () => ({ kind: "stopped" as const, reason: "unused" }),
      advance: async () => {
        advanceCalls++;
        if (advanceCalls === 1) {
          activeMarker = true;
          return {
            kind: "advanced" as const,
            unit,
            stateSnapshot: await makeMockDeps().deriveState(s.basePath),
            dispatchId: 1,
          };
        }
        if (activeMarker) {
          return {
            kind: "skipped" as const,
            code: "unit-already-active" as const,
            reason: "idempotent advance: unit already active",
          };
        }
        return { kind: "stopped" as const, reason: "retry marker released" };
      },
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit: async (retriedUnit) => {
        activeMarker = false;
        retried.push(retriedUnit);
      },
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
      stop: async (reason: string) => ({ kind: "stopped" as const, reason }),
      getStatus: () => ({
        phase: "running" as const,
        transitionCount: advanceCalls,
        ...(activeMarker ? { activeUnit: unit } : {}),
      }),
    } satisfies AutoOrchestrationModule,
  });
  openLoopDatabase(t, s);
  const deps = makeMockDeps({
    adjudicateNonAdvancingOutcome: undefined,
    taskExecutionBoundary: async () => ({
      action: "retry" as const,
      reason: "task-recovery-repair",
    }),
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(advanceCalls, 2, "the next advance must run after recovery retry closeout");
  assert.deepEqual(retried, [unit]);
  const wedgeResult = getOpenWedge(realpathSync(s.basePath));
  assert.equal(wedgeResult.ok, true);
  assert.equal(wedgeResult.ok ? wedgeResult.wedge : null, null);
});

// #2198: a finalize-retry recurrence with unchanged inputs cannot succeed, so
// the retry-closeout liveness trip must pause with the concrete finalize
// failure cause instead of emitting the generic wedge stop.
test("autoLoop pauses with the finalize cause at the retry closeout when orchestration trips", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  const pi = makeMockPi();
  const unit = { unitType: "plan-slice", unitId: "M001/S01" };
  let advanceCalls = 0;
  let orchestrationPhase: AutoStatus["phase"] = "running";
  const stopReasons: Array<string | undefined> = [];
  const pauseReasons: Array<string | undefined> = [];
  const journalEvents: Array<{ eventType: string; data?: any }> = [];
  const s = makeLoopSession({ currentMilestoneId: "M001" });
  s.orchestration = {
    start: async () => ({ kind: "stopped" as const, reason: "unused" }),
    advance: async () => {
      advanceCalls++;
      if (advanceCalls > 1) {
        s.active = false;
        return { kind: "stopped" as const, reason: "unexpected redispatch after retry trip" };
      }
      return {
        kind: "advanced" as const,
        unit,
        stateSnapshot: await makeMockDeps().deriveState(s.basePath),
        dispatchId: 1,
      };
    },
    settle: async () => {},
    completeActiveUnit: async () => {},
    retryActiveUnit: async () => {
      orchestrationPhase = "stopped";
    },
    abandonActiveUnit: async () => {},
    resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
    stop: async (reason: string) => ({ kind: "stopped" as const, reason }),
    getStatus: () => ({ phase: orchestrationPhase, transitionCount: advanceCalls }),
  } satisfies AutoOrchestrationModule;
  openLoopDatabase(t, s);
  const deps = makeMockDeps({
    emitJournalEvent: (entry: any) => { journalEvents.push(entry); },
    adjudicateNonAdvancingOutcome: undefined,
    taskExecutionBoundary: async () => ({
      action: "retry" as const,
      reason: "finalize-retry: source-integrity inconclusive: host snapshot no longer matches closeout evidence",
    }),
    stopAuto: async (_ctx, _pi, reason) => {
      stopReasons.push(reason);
      s.active = false;
    },
    pauseAuto: async (_ctx, _pi, errorContext) => {
      pauseReasons.push(errorContext?.message);
      s.active = false;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(advanceCalls, 1, "the loop must not redispatch after the retry trip");
  assert.equal(stopReasons.length, 0, "the generic wedge stop must not be emitted");
  assert.equal(pauseReasons.length, 1, "auto-mode must pause with the concrete finalize cause");
  assert.match(pauseReasons[0] ?? "", /source-integrity inconclusive/);
  const iterationEnd = journalEvents.find((entry) => entry.eventType === "iteration-end");
  assert.equal(iterationEnd?.data?.status, "paused");
  assert.equal(iterationEnd?.data?.reason, pauseReasons[0]);
  assert.equal(mapStatusToExitCode(iterationEnd?.data?.status), 10);
  t.diagnostic(JSON.stringify({ scenario: "loop retry closeout", pauseReasons, iterationEnd, headlessExitCode: mapStatusToExitCode(iterationEnd?.data?.status) }));
});

test("custom-engine recovery fails loudly when dispatch terminalization cannot be confirmed", async (t) => {
  t.mock.method(CustomWorkflowEngine.prototype, "deriveState", async () => ({
    phase: "executing",
    isComplete: false,
    readySteps: [],
    blockedSteps: [],
    completedSteps: [],
  }) as any);
  t.mock.method(CustomWorkflowEngine.prototype, "resolveDispatch", async () => ({
    action: "dispatch",
    step: {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "execute the Task",
    },
  }) as any);

  _resetPendingResolve();
  const basePath = realpathSync(makeLoopTestBase("gsd-custom-task-terminalization-failure-"));
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  try {
    openDatabase(join(basePath, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "active" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task One", status: "pending" });
    const workerId = registerAutoWorker({ projectRootRealpath: basePath });
    const lease = claimMilestoneLease(workerId, "M001");
    assert.equal(lease.ok, true);
    if (!lease.ok) return;

    const notifications: string[] = [];
    const ctx = makeMockCtx();
    ctx.ui.notify = (message: string) => notifications.push(message);
    ctx.ui.setStatus = () => {};
    ctx.ui.setWidget = () => {};
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: basePath,
      basePath,
      originalBasePath: basePath,
      canonicalProjectRoot: basePath,
      workerId,
      milestoneLeaseToken: lease.token,
    });
    const deps = makeMockDeps({
      isDbAvailable: () => true,
      taskExecutionBoundary: async () => {
        s.active = false;
        closeDatabase();
        return { action: "break", reason: "task-recovery-abort" };
      },
    });

    await rawAutoLoop(ctx, makeMockPi(), s, deps);

    assert.match(
      notifications.join("\n"),
      /could not terminalize custom-engine dispatch/i,
    );
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("autoLoop resumes canonical closeout when a transient provider error follows durable Task completion (#1907)", async () => {
  _resetPendingResolve();

  const originalCwd = process.cwd();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.setWidget = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const basePath = realpathSync(makeLoopTestBase("gsd-canonical-task-publish-"));
  execSync("git commit --allow-empty -m initial", { cwd: basePath, stdio: "ignore" });
  const slicePath = join(basePath, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(slicePath, "tasks"), { recursive: true });
  writeFileSync(join(slicePath, "S01-PLAN.md"), "# Slice Plan\n\n- [ ] **T01:** task one\n");
  writeFileSync(join(slicePath, "tasks", "T01-PLAN.md"), "# Task Plan\n");

  try {
    openDatabase(join(basePath, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "active" });
    insertTask({
      id: "T01",
      milestoneId: "M001",
      sliceId: "S01",
      title: "Task One",
      status: "pending",
      planning: { verify: 'node -e "process.exit(0)"' },
    });
    const workerId = registerAutoWorker({ projectRootRealpath: basePath });
    const lease = claimMilestoneLease(workerId, "M001");
    assert.equal(lease.ok, true);
    if (!lease.ok) return;

    const s = makeLoopSession({
      basePath,
      originalBasePath: basePath,
      canonicalProjectRoot: basePath,
      workerId,
      milestoneLeaseToken: lease.token,
    });
    const deps = makeMockDeps({
      isDbAvailable: () => true,
      taskExecutionBoundary: runWithTaskExecutionAttempt,
      taskPublicationBoundary: publishVerifiedTaskExecution,
      runPostUnitVerification,
      postUnitPostVerification: async () => {
        deps.callLog.push("postUnitPostVerification");
        s.active = false;
        return "continue" as const;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);
    await waitForMicrotasks(
      () => readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" })?.state === "running",
      "canonical Task Attempt claim",
    );
    await stageTaskCompletion({
      invocation: {
        idempotencyKey: "test:auto-loop:stage:T01",
        sourceTransport: "internal",
        actorType: "agent",
        actorId: workerId,
      },
      basePath,
      task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
      completion: {
        oneLiner: "Executor candidate completed",
        narrative: "Candidate result awaiting host verification.",
        verification: "Executor reported success.",
        deviations: "None.",
        knownIssues: "None.",
        keyFiles: ["src/task.ts"],
        keyDecisions: ["Publish only after host verification."],
        blockerDiscovered: false,
        verificationEvidence: [],
      },
    });
    assert.equal(getTask("M001", "S01", "T01")?.status, "in_progress");

    autoSession.reset();
    autoSession.active = true;
    autoSession.basePath = basePath;
    autoSession.originalBasePath = basePath;
    autoSession.currentUnit = {
      type: "execute-task",
      id: "M001/S01/T01",
      startedAt: Date.now(),
    };
    const { handleAgentEnd } = await import("../bootstrap/agent-end-recovery.js");
    process.chdir(basePath);
    try {
      await handleAgentEnd(pi, {
        messages: [{
          role: "assistant",
          stopReason: "error",
          errorMessage: "Provider error: Codex usage_limit_reached: The usage limit has been reached",
        }],
      } as AgentEndEvent, ctx);
    } finally {
      process.chdir(originalCwd);
    }
    await loopPromise;

    const attempt = readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" });
    assert.equal(
      getTask("M001", "S01", "T01")?.status,
      "complete",
      `canonical Attempt after host verification: ${JSON.stringify(attempt)}`,
    );
    assert.ok(attempt);
    assert.equal(attempt.attemptNumber, 1);
    assert.equal(attempt.state, "settled");
    assert.equal(attempt.outcome, "succeeded");
    assert.equal(attempt.nextStage, "settled");
    assert.equal(pi.calls.length, 1, "the completed executor is not re-dispatched");
    assert.equal(deps.callLog.includes("pauseAuto"), false, "durable closeout bypasses provider pause");
    assert.equal(autoSession.active, true, "provider handling does not pause the active auto session");
    assert.equal(autoSession.paused, false, "provider handling leaves no stale paused state");
    assert.equal(getLatestForUnit("M001/S01/T01")?.status, "completed");
  } finally {
    process.chdir(originalCwd);
    autoSession.reset();
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("autoLoop resumes host verification for a settled succeeded Attempt without rerunning the executor", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.setWidget = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const basePath = realpathSync(makeLoopTestBase("gsd-canonical-task-resume-verify-"));
  execSync("git commit --allow-empty -m initial", { cwd: basePath, stdio: "ignore" });
  const originalBasePath = realpathSync(makeLoopTestBase("gsd-canonical-task-resume-root-"));
  execSync("git commit --allow-empty -m initial", { cwd: originalBasePath, stdio: "ignore" });
  writeFileSync(join(originalBasePath, "preexisting-root-note.txt"), "must not become a restart leak\n");
  const slicePath = join(basePath, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(slicePath, "tasks"), { recursive: true });
  writeFileSync(join(slicePath, "S01-PLAN.md"), "# Slice Plan\n\n- [ ] **T01:** task one\n");
  writeFileSync(join(slicePath, "tasks", "T01-PLAN.md"), "# Task Plan\n");

  try {
    openDatabase(join(basePath, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "active" });
    insertTask({
      id: "T01",
      milestoneId: "M001",
      sliceId: "S01",
      title: "Task One",
      status: "pending",
      planning: { verify: 'node -e "process.exit(0)"' },
    });
    const workerId = registerAutoWorker({ projectRootRealpath: basePath });
    const lease = claimMilestoneLease(workerId, "M001");
    assert.equal(lease.ok, true);
    if (!lease.ok) return;

    const seedDispatch = recordDispatchClaim({
      traceId: "seed-resume-verification",
      workerId,
      milestoneLeaseToken: lease.token,
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
    });
    assert.equal(seedDispatch.ok, true);
    if (!seedDispatch.ok) return;
    const claimed = claimTaskAttempt({
      invocation: {
        idempotencyKey: "test:auto-loop:resume-verify:claim",
        sourceTransport: "internal",
        actorType: "test",
      },
      task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
      workerId,
      milestoneLeaseToken: lease.token,
      coordinationDispatchId: seedDispatch.dispatchId,
    });
    await stageTaskCompletion({
      invocation: {
        idempotencyKey: "test:auto-loop:resume-verify:stage",
        sourceTransport: "internal",
        actorType: "agent",
        actorId: workerId,
      },
      basePath,
      task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
      completion: {
        oneLiner: "Executor candidate completed before restart",
        narrative: "Candidate Result awaits restarted host verification.",
        verification: "Host verification has not run yet.",
        deviations: "None.",
        knownIssues: "None.",
        keyFiles: ["src/task.ts"],
        keyDecisions: ["Resume at verification without rerunning execution."],
        blockerDiscovered: false,
        verificationEvidence: [],
      },
    });
    markCanceled(seedDispatch.dispatchId, "simulated process exit after Attempt settlement");
    assert.equal(readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" })?.nextStage, "verify");

    const s = makeLoopSession({
      basePath,
      originalBasePath,
      canonicalProjectRoot: basePath,
      workerId,
      milestoneLeaseToken: lease.token,
    });
    let verificationCalls = 0;
    let stopReason: string | undefined;
    const deps = makeMockDeps({
      isDbAvailable: () => true,
      taskExecutionBoundary: runWithTaskExecutionAttempt,
      taskPublicationBoundary: publishVerifiedTaskExecution,
      runPostUnitVerification: async (vctx, pauseAuto) => {
        verificationCalls += 1;
        return runPostUnitVerification(vctx, pauseAuto);
      },
      postUnitPostVerification: async () => {
        s.active = false;
        return "continue" as const;
      },
      stopAuto: async (_ctx, _pi, reason) => {
        stopReason = reason;
        s.active = false;
      },
    });

    await autoLoop(ctx, pi, s, deps);

    const attempt = readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" });
    assert.equal(attempt?.attemptId, claimed.attemptId, "restart must not claim a successor Attempt");
    assert.equal(pi.calls.length, 0, "restart must not dispatch the executor again");
    assert.equal(verificationCalls, 1);
    assert.equal(attempt?.nextStage, "settled");
    assert.equal(getTask("M001", "S01", "T01")?.status, "complete");
    assert.equal(stopReason, undefined, "pre-existing root dirt must not be reported as a resumed-unit leak");
    assert.equal(getLatestForUnit("M001/S01/T01")?.status, "completed");
  } finally {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(basePath, { recursive: true, force: true });
    rmSync(originalBasePath, { recursive: true, force: true });
  }
});

test("autoLoop refreshes its milestone lease while an execute-task call is pending and clears the heartbeat on exit", async () => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["setInterval"] });

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.setWidget = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const basePath = realpathSync(makeLoopTestBase("gsd-task-lease-heartbeat-"));
  execSync("git commit --allow-empty -m initial", { cwd: basePath, stdio: "ignore" });
  const slicePath = join(basePath, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(slicePath, "tasks"), { recursive: true });
  writeFileSync(join(slicePath, "S01-PLAN.md"), "# Slice Plan\n\n- [ ] **T01:** task one\n");
  writeFileSync(join(slicePath, "tasks", "T01-PLAN.md"), "# Task Plan\n");

  try {
    openDatabase(join(basePath, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "active" });
    insertTask({
      id: "T01",
      milestoneId: "M001",
      sliceId: "S01",
      title: "Task One",
      status: "pending",
      planning: { verify: 'node -e "process.exit(0)"' },
    });
    const workerId = registerAutoWorker({ projectRootRealpath: basePath });
    const lease = claimMilestoneLease(workerId, "M001");
    assert.equal(lease.ok, true);
    if (!lease.ok) return;

    const s = makeLoopSession({
      basePath,
      originalBasePath: basePath,
      canonicalProjectRoot: basePath,
      workerId,
      milestoneLeaseToken: lease.token,
    });
    const deps = makeMockDeps({
      isDbAvailable: () => true,
      taskExecutionBoundary: runWithTaskExecutionAttempt,
      taskPublicationBoundary: publishVerifiedTaskExecution,
      runPostUnitVerification,
      postUnitPostVerification: async () => {
        s.active = false;
        return "continue" as const;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);
    await waitForMicrotasks(
      () => readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" })?.state === "running",
      "canonical Task Attempt claim",
    );

    const expiredAt = "1970-01-01T00:00:00.000Z";
    _getAdapter()!.prepare(
      "UPDATE milestone_leases SET expires_at = :expires_at WHERE milestone_id = :milestone_id",
    ).run({ ":expires_at": expiredAt, ":milestone_id": "M001" });
    mock.timers.tick(milestoneLeaseTtlSeconds() * 500);

    const refreshedLease = getMilestoneLease("M001");
    assert.equal(refreshedLease?.worker_id, workerId);
    assert.equal(refreshedLease?.fencing_token, lease.token);
    assert.equal(refreshedLease?.status, "held");
    const leaseWasRefreshed = Date.parse(refreshedLease?.expires_at ?? "") > Date.now();
    if (!leaseWasRefreshed) {
      _getAdapter()!.prepare(
        "UPDATE milestone_leases SET expires_at = :expires_at WHERE milestone_id = :milestone_id",
      ).run({
        ":expires_at": new Date(Date.now() + milestoneLeaseTtlSeconds() * 1000).toISOString(),
        ":milestone_id": "M001",
      });
    }

    await stageTaskCompletion({
      invocation: {
        idempotencyKey: "test:auto-loop:heartbeat-stage:T01",
        sourceTransport: "internal",
        actorType: "agent",
        actorId: workerId,
      },
      basePath,
      task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
      completion: {
        oneLiner: "Executor candidate completed",
        narrative: "Candidate result awaiting host verification.",
        verification: "Executor reported success.",
        deviations: "None.",
        knownIssues: "None.",
        keyFiles: ["src/task.ts"],
        keyDecisions: ["Keep the lease alive while execution is pending."],
        blockerDiscovered: false,
        verificationEvidence: [],
      },
    });

    resolveAgentEnd(makeEvent());
    await loopPromise;

    const attempt = readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" });
    assert.equal(attempt?.state, "settled");
    assert.equal(attempt?.outcome, "succeeded");
    assert.equal(getLatestForUnit("M001/S01/T01")?.status, "completed");
    assert.equal(leaseWasRefreshed, true, "the in-flight heartbeat must renew the original lease");

    _getAdapter()!.prepare(
      "UPDATE milestone_leases SET expires_at = :expires_at WHERE milestone_id = :milestone_id",
    ).run({ ":expires_at": expiredAt, ":milestone_id": "M001" });
    mock.timers.tick(milestoneLeaseTtlSeconds() * 500);
    assert.equal(getMilestoneLease("M001")?.expires_at, expiredAt);
  } finally {
    mock.timers.reset();
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("autoLoop stops before success notification when postflight stash restore needs recovery", async (t) => {
  _resetPendingResolve();

  const notifications: Array<{ msg: string; level: string }> = [];
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = (msg: string, level: string) => {
    notifications.push({ msg, level });
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  openLoopDatabase(t, s);
  let stopReason = "";

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "complete",
        activeMilestone: { id: "M001", title: "Test", status: "complete" },
        activeSlice: null,
        activeTask: null,
        registry: [{ id: "M001", status: "complete" }],
        blockers: [],
      } as any;
    },
    preflightCleanRoot: () => ({
      stashPushed: true,
      stashMarker: "gsd-preflight-stash:M001:test",
      summary: "stashed",
    }),
    postflightPopStash: () => ({
      restored: false,
      needsManualRecovery: true,
      message: "git stash pop stash@{0} failed after merge of milestone M001",
      stashRef: "stash@{0}",
    }),
    sendDesktopNotification: () => {
      deps.callLog.push("sendDesktopNotification");
    },
    logCmuxEvent: () => {
      deps.callLog.push("logCmuxEvent");
    },
    stopAuto: async (_ctx, _pi, reason) => {
      deps.callLog.push("stopAuto");
      stopReason = reason ?? "";
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(stopReason, "Post-merge stash restore failed for milestone M001");
  assert.ok(
    notifications.some(
      (n) => n.level === "error" && n.msg.includes("Post-merge stash restore failed for milestone M001"),
    ),
    "failed postflight restore must be surfaced as an error",
  );
  assert.ok(
    !deps.callLog.includes("sendDesktopNotification"),
    "must not emit milestone success desktop notification after stash restore failure",
  );
  assert.ok(
    !deps.callLog.includes("logCmuxEvent"),
    "must not emit milestone success cmux event after stash restore failure",
  );
});

test("autoLoop marks transition merge complete before postflight recovery stop", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();
  openLoopDatabase(t, s);
  let mergeCalls = 0;
  let stopReason = "";

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M002", title: "Next", status: "active" },
        activeSlice: null,
        activeTask: null,
        registry: [
          { id: "M001", title: "Done", status: "complete" },
          { id: "M002", title: "Next", status: "active" },
        ],
        blockers: [],
      } as any;
    },
    preflightCleanRoot: () => ({
      stashPushed: true,
      stashMarker: "gsd-preflight-stash:M001:test",
      summary: "stashed",
    }),
    postflightPopStash: () => ({
      restored: false,
      needsManualRecovery: true,
      message: "git stash pop stash@{0} failed after merge of milestone M001",
      stashRef: "stash@{0}",
    }),
    lifecycle: {
      enterMilestone: () => {
        assert.fail("must not enter the next milestone after postflight recovery fails");
      },
      exitMilestone: guardedExitMilestoneForTest((_mid, opts) => {
        if (opts.merge) mergeCalls += 1;
        return { ok: true, merged: opts.merge, codeFilesChanged: false };
      }),
    } as any,
    stopAuto: async (_ctx, _pi, reason) => {
      deps.callLog.push("stopAuto");
      stopReason = reason ?? "";
      if (!s.milestoneMergedInPhases) {
        deps.lifecycle.exitMilestone(
          "M001",
          { merge: true },
          { notify: ctx.ui.notify.bind(ctx.ui) },
        );
      }
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(stopReason, "Post-merge stash restore failed for milestone M001");
  assert.equal(s.milestoneMergedInPhases, true);
  assert.equal(mergeCalls, 1, "postflight recovery stop must not re-run an already completed transition merge");
});

test("autoLoop pauses when provider readiness cancels before dispatch", async (t) => {
  _resetPendingResolve();

  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = (message: string, level?: string) => {
    notifications.push({ message, level });
  };
  ctx.model = { provider: "anthropic", id: "claude-opus-4-6" };
  ctx.modelRegistry = {
    getProviderAuthMode: () => "api-key",
    isProviderRequestReady: () => false,
  };

  const pi = makeMockPi();
  const s = makeLoopSession();
  openLoopDatabase(t, s);
  const deps = makeMockDeps({
    selectAndApplyModel: async () => ({
      routing: null,
      appliedModel: { provider: "anthropic", id: "claude-opus-4-6" },
    }),
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(pi.calls.length, 0, "provider readiness cancellation must not dispatch a message");
  assert.ok(deps.callLog.includes("pauseAuto"), "provider readiness cancellation should pause auto-mode");
  assert.ok(!deps.callLog.includes("stopAuto"), "provider readiness cancellation should not hard-stop auto-mode");
  assert.ok(
    !deps.callLog.includes("postUnitPreVerification"),
    "post-unit verification must not run after pre-dispatch provider cancellation",
  );
  assert.ok(
    notifications.some(n => /Provider anthropic is not request-ready/.test(n.message)),
    "provider pause should notify with the readiness failure",
  );
});

test("autoLoop passes structured session-lock failure details to the handler", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();
  let observedLockStatus: SessionLockStatus | undefined;

  const deps = makeMockDeps({
    validateSessionLock: () =>
      ({
        valid: false,
        failureReason: "compromised",
        expectedPid: process.pid,
      }) as SessionLockStatus,
    handleLostSessionLock: (_ctx, lockStatus) => {
      observedLockStatus = lockStatus;
      deps.callLog.push("handleLostSessionLock");
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.deepEqual(observedLockStatus, {
    valid: false,
    failureReason: "compromised",
    expectedPid: process.pid,
  });
  assert.ok(
    !deps.callLog.includes("resolveDispatch"),
    "should stop before dispatch after lock validation fails",
  );
});

// Regression for #5308: the iteration prelude must dequeue sidecar items
// (popping the queue and emitting the `sidecar-dequeue` journal event) BEFORE
// validateSessionLock + break-on-invalid. Inverting that order silently drops
// queued sidecar work on lock-loss. Covers first-iteration and mid-session.
test("autoLoop dequeues sidecar item before session-lock break (first iteration, #5308)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();
  s.sidecarQueue.push({
    kind: "hook" as const,
    unitType: "hook/review",
    unitId: "M001/S01/T01/review",
    prompt: "review the code",
  });

  const journalEvents: string[] = [];
  const deps = makeMockDeps({
    validateSessionLock: () =>
      ({
        valid: false,
        failureReason: "compromised",
        expectedPid: process.pid,
      }) as SessionLockStatus,
    handleLostSessionLock: () => {
      deps.callLog.push("handleLostSessionLock");
    },
    emitJournalEvent: (entry) => {
      journalEvents.push(entry.eventType);
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(
    s.sidecarQueue.length,
    0,
    "sidecar item must be popped on lock-loss iteration (pre-#5308 ordering)",
  );
  assert.ok(
    journalEvents.includes("sidecar-dequeue"),
    "sidecar-dequeue journal event must be emitted before session-lock break",
  );
  assert.ok(
    deps.callLog.includes("handleLostSessionLock"),
    "session lock handler must still fire after sidecar dequeue",
  );
  assert.ok(!deps.callLog.includes("deriveState"), "lock loss should stop before deriving state");
});

test("autoLoop dequeues sidecar item before session-lock break (mid-session, #5308)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  const journalEvents: string[] = [];
  let lockCheckCount = 0;
  const deps = makeMockDeps({
    // First iteration: lock valid; second iteration: lock invalidates.
    validateSessionLock: () => {
      lockCheckCount += 1;
      if (lockCheckCount === 1) {
        return { valid: true } as SessionLockStatus;
      }
      return {
        valid: false,
        failureReason: "compromised",
        expectedPid: process.pid,
      } as SessionLockStatus;
    },
    handleLostSessionLock: () => {
      deps.callLog.push("handleLostSessionLock");
    },
    emitJournalEvent: (entry) => {
      journalEvents.push(entry.eventType);
    },
    // Enqueue a sidecar item at the end of iteration 1, so iteration 2 begins
    // with a non-empty queue and an invalid lock.
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      s.sidecarQueue.push({
        kind: "hook" as const,
        unitType: "run-uat",
        unitId: "M001/S01/T01/review",
        prompt: "review the code",
      });
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);
  // Allow the loop to reach runUnit's await on iteration 1.
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());
  await loopPromise;

  assert.ok(lockCheckCount >= 2, "lock validator must run on iteration 2");
  assert.equal(
    s.sidecarQueue.length,
    0,
    "queued sidecar item must be popped on the lock-loss iteration",
  );
  assert.ok(
    journalEvents.includes("sidecar-dequeue"),
    "sidecar-dequeue journal event must be emitted before session-lock break",
  );
  assert.ok(
    deps.callLog.includes("handleLostSessionLock"),
    "lock-loss handler must still fire on iteration 2",
  );
});

test("autoLoop exits on terminal blocked state", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "blocked",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: null,
        activeTask: null,
        registry: [{ id: "M001", status: "active" }],
        blockers: ["Missing API key"],
      } as any;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(deps.callLog.includes("deriveState"), "should have derived state");
  assert.ok(
    deps.callLog.includes("pauseAuto"),
    "should have called pauseAuto for blocked state",
  );
  assert.ok(
    !deps.callLog.includes("resolveDispatch"),
    "should not dispatch when blocked",
  );
});

test("autoLoop calls deriveState → resolveDispatch → runUnit in sequence", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();

  const s = makeLoopSession();

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any;
    },
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch" as const,
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "do the thing",
      };
    },
    taskPublicationBoundary: async () => {
      deps.callLog.push("publishVerifiedTaskExecution");
    },
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      // Deactivate after first iteration to exit the loop
      s.active = false;
      return "continue" as const;
    },
  });

  // Run autoLoop — it will call runUnit internally which creates a promise.
  // We need to resolve the promise from outside via resolveAgentEnd.
  const loopPromise = autoLoop(ctx, pi, s, deps);

  // Give the loop time to reach runUnit's await
  await new Promise((r) => setTimeout(r, 50));

  // Resolve the first unit's agent_end
  resolveAgentEnd(makeEvent());

  await loopPromise;

  // Verify the sequence: deriveState → resolveDispatch → then finalize callbacks
  const deriveIdx = deps.callLog.indexOf("deriveState");
  const dispatchIdx = deps.callLog.indexOf("resolveDispatch");
  const preVerIdx = deps.callLog.indexOf("postUnitPreVerification");
  const verIdx = deps.callLog.indexOf("runPostUnitVerification");
  const publishIdx = deps.callLog.indexOf("publishVerifiedTaskExecution");
  const postVerIdx = deps.callLog.indexOf("postUnitPostVerification");

  assert.ok(deriveIdx >= 0, "deriveState should have been called");
  assert.ok(
    dispatchIdx > deriveIdx,
    "resolveDispatch should come after deriveState",
  );
  assert.ok(
    preVerIdx > dispatchIdx,
    "postUnitPreVerification should come after resolveDispatch",
  );
  assert.ok(
    verIdx > preVerIdx,
    "runPostUnitVerification should come after pre-verification",
  );
  assert.ok(
    publishIdx > verIdx,
    "verified Task publication should come after verification",
  );
  assert.ok(
    postVerIdx > publishIdx,
    "postUnitPostVerification should observe the published Task",
  );
});

test("autoLoop keeps current unit available through post-unit closeout", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const s = makeLoopSession();
  const observedUnits: Array<string | null> = [];

  const deps = makeMockDeps({
    postUnitPreVerification: async (postUnitCtx) => {
      deps.callLog.push("postUnitPreVerification");
      const unit = postUnitCtx.s.currentUnit;
      observedUnits.push(unit ? `${unit.type}:${unit.id}` : null);
      return "continue" as const;
    },
    postUnitPostVerification: async (postUnitCtx) => {
      deps.callLog.push("postUnitPostVerification");
      const unit = postUnitCtx.s.currentUnit;
      observedUnits.push(unit ? `${unit.type}:${unit.id}` : null);
      s.active = false;
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());
  await loopPromise;

  assert.deepEqual(
    observedUnits,
    ["execute-task:M001/S01/T01", "execute-task:M001/S01/T01"],
    "pre/post closeout hooks need currentUnit so they can commit and sync the unit that just finished",
  );
  assert.equal(s.currentUnit, null, "currentUnit should clear after closeout finishes");
});

test("autoLoop dev path dispatches orchestration.advance results without legacy resolveDispatch", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  ctx.modelRegistry = {
    getAvailable: () => [{ provider: "test", id: "hook-model" }],
    getProviderAuthMode: () => undefined,
    isProviderRequestReady: () => true,
  };
  const pi = makeMockPi();
  const stateSnapshot = {
    phase: "executing",
    activeMilestone: { id: "M002", title: "Advance Milestone", status: "active" },
    activeSlice: { id: "S03", title: "Slice 3" },
    activeTask: { id: "T05" },
    registry: [{ id: "M002", status: "active" }],
    blockers: [],
  } as any;
  let advanceCalls = 0;
  const finalizedUnits: string[] = [];
  const journalEvents: any[] = [];
  let s: any;
  s = makeLoopSession({
    currentMilestoneId: "M002",
    orchestration: {
      start: async () => ({ kind: "stopped" as const, reason: "unused" }),
      advance: async () => {
        advanceCalls++;
        s.pendingOrchestrationDispatch = {
          unitType: "execute-task",
          unitId: "M002/S03/T05",
          prompt: "advance prompt",
          pauseAfterUatDispatch: false,
          state: stateSnapshot,
          mid: "M002",
          midTitle: "Advance Milestone",
        };
        return {
          kind: "advanced" as const,
          unit: { unitType: "execute-task", unitId: "M002/S03/T05" },
          stateSnapshot,
          dispatchId: 1,
        };
      },
      settle: async () => {},
      completeActiveUnit: async (unit: { unitType: string; unitId: string }) => {
        finalizedUnits.push(`${unit.unitType}:${unit.unitId}`);
      },
      retryActiveUnit: async () => {},
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
      stop: async () => ({ kind: "stopped" as const, reason: "unused" }),
      getStatus: () => ({ phase: "running" as const, transitionCount: 1 }),
    },
  });

  const deps = makeMockDeps({
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      throw new Error("legacy resolveDispatch must not run when orchestration is wired");
    },
    runPreDispatchHooks: () => ({
      firedHooks: ["complete-slice-policies"],
      action: "proceed",
      prompt: "hooked prompt",
      model: "hook-model",
    }),
    emitJournalEvent: (entry: any) => {
      journalEvents.push(entry);
    },
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      s.active = false;
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);
  await waitForMicrotasks(() => pi.calls.length === 1, "orchestration advance dispatch");
  resolveAgentEnd(makeEvent());
  await loopPromise;

  assert.equal(advanceCalls, 1);
  assert.equal(
    deps.callLog.includes("resolveDispatch"),
    false,
    "orchestration.advance owns dev-path dispatch",
  );
  assert.equal(
    (pi.calls[0] as any[])[0].content,
    "hooked prompt",
    "runUnit should receive the dispatch prompt after pre-dispatch hooks",
  );
  assert.deepEqual(
    pi.setModelCalls.map((call: any[]) => call[0]),
    [
      { provider: "test", id: "hook-model" },
      { provider: "test", id: "hook-model" },
    ],
    "proceed hooks should apply model overrides before dispatch",
  );
  assert.deepEqual(finalizedUnits, ["execute-task:M002/S03/T05"]);
  assert.equal(s.pendingOrchestrationDispatch, null, "pending dispatch should be one-shot");
  assert.equal(
    journalEvents.filter((entry) => entry.eventType === "pre-dispatch-hook").length,
    1,
    "hook dispatch should emit one pre-dispatch-hook journal event",
  );
});

test("autoLoop pauses once when orchestration reports reconciliation drift error", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  let advanceCalls = 0;
  const s = makeLoopSession({
    currentMilestoneId: "M002",
    orchestration: {
      start: async () => ({ kind: "stopped" as const, reason: "unused" }),
      advance: async () => {
        advanceCalls++;
        return {
          kind: "error" as const,
          reason: "Reconciliation drift: Reconciliation repair failed in pass 0",
        };
      },
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit: async () => {},
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
      stop: async () => ({ kind: "stopped" as const, reason: "unused" }),
      getStatus: () => ({ phase: "error" as const, transitionCount: 1 }),
    },
  });

  const deps = makeMockDeps({
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      throw new Error("legacy resolveDispatch must not run after orchestration error");
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(advanceCalls, 1, "orchestration error must not be retried in the same loop");
  assert.ok(deps.callLog.includes("pauseAuto"), "orchestration error should pause auto-mode");
  assert.equal(
    deps.callLog.includes("resolveDispatch"),
    false,
    "orchestration error must not fall back to legacy dispatch",
  );
  assert.equal(s.pendingOrchestrationDispatch, null, "no orchestration dispatch should remain pending");
});

test("autoLoop retries next iteration when orchestration reports paused", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  let advanceCalls = 0;
  const s = makeLoopSession({
    currentMilestoneId: "M002",
    orchestration: {
      start: async () => ({ kind: "stopped" as const, reason: "unused" }),
      advance: async () => {
        advanceCalls++;
        return advanceCalls === 1
          ? { kind: "paused" as const, reason: "provider transient; retry", failureKind: "provider" as const }
          : { kind: "stopped" as const, reason: "done retrying" };
      },
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit: async () => {},
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
      stop: async () => ({ kind: "stopped" as const, reason: "unused" }),
      getStatus: () => ({ phase: "running" as const, transitionCount: advanceCalls }),
    },
  });
  openLoopDatabase(t, s);

  const journalEvents: Array<{ eventType: string; data?: any }> = [];
  const deps = makeMockDeps({
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      throw new Error("legacy resolveDispatch must not run after orchestration paused");
    },
    emitJournalEvent: (entry: any) => {
      journalEvents.push(entry);
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(advanceCalls, 2, "orchestration paused should retry on the next loop iteration");
  assert.equal(deps.callLog.includes("pauseAuto"), false, "orchestration paused should not pause auto-mode");
  assert.equal(
    deps.callLog.includes("resolveDispatch"),
    false,
    "orchestration paused must not fall back to legacy dispatch",
  );
  assert.equal(s.pendingOrchestrationDispatch, null, "no orchestration dispatch should remain pending");

  const pausedIterationEnd = journalEvents.find(
    (e) => e.eventType === "iteration-end" && e.data?.status === "paused",
  );
  assert.ok(pausedIterationEnd, "orchestration paused must emit iteration-end to close the iteration journal");
});

test("#1674: unknown orchestration outcomes hash the kind the loop read", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const unexpectedKinds = ["future-a", "future-b"];
  const payloads: string[] = [];
  let advanceCalls = 0;
  const s = makeLoopSession({
    currentMilestoneId: "M002",
    orchestration: {
      start: async () => ({ kind: "stopped" as const, reason: "unused" }),
      advance: async () => {
        const kind = unexpectedKinds[advanceCalls++];
        if (kind) return { kind } as any;
        return { kind: "stopped" as const, reason: "done" };
      },
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit: async () => {},
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
      stop: async () => ({ kind: "stopped" as const, reason: "unused" }),
      getStatus: () => ({ phase: "running" as const, transitionCount: advanceCalls }),
    },
  });
  t.after(() => rmSync(s.basePath, { recursive: true, force: true }));

  const deps = makeMockDeps({
    adjudicateNonAdvancingOutcome: (_session, outcome) => {
      if (outcome.guardId === "orchestration-unknown-outcome") {
        payloads.push(outcome.inputPayload);
      }
      return null;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.deepEqual(payloads.map((payload) => JSON.parse(payload)), [
    { kind: "future-a" },
    { kind: "future-b" },
  ]);
  assert.notEqual(payloads[0], payloads[1]);
});

test("autoLoop consumes pending orchestration dispatch without advancing twice", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const stateSnapshot = {
    phase: "executing",
    activeMilestone: { id: "M004", title: "Milestone 4", status: "active" },
    activeSlice: { id: "S03", title: "Slice 3" },
    activeTask: { id: "T02" },
    registry: [{ id: "M004", status: "active" }],
    blockers: [],
  } as any;
  const s = makeLoopSession({
    currentMilestoneId: "M004",
    pendingOrchestrationDispatch: {
      unitType: "execute-task",
      unitId: "M004/S03/T02",
      prompt: "pending prompt",
      pauseAfterUatDispatch: false,
      state: stateSnapshot,
      mid: "M004",
      midTitle: "Milestone 4",
    },
    orchestration: {
      start: async () => ({ kind: "stopped" as const, reason: "unused" }),
      advance: async () => {
        throw new Error("advance must not run when a pending dispatch already exists");
      },
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit: async () => {},
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
      stop: async () => ({ kind: "stopped" as const, reason: "unused" }),
      getStatus: () => ({ phase: "running" as const, transitionCount: 1 }),
    },
  });

  const deps = makeMockDeps({
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      throw new Error("legacy resolveDispatch must not run when orchestration is wired");
    },
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      s.active = false;
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);
  await waitForMicrotasks(() => pi.calls.length === 1, "pending orchestration dispatch");
  resolveAgentEnd(makeEvent());
  await loopPromise;

  assert.equal((pi.calls[0] as any[])[0].content, "pending prompt");
  assert.equal(s.pendingOrchestrationDispatch, null, "pending dispatch should be consumed");
});

test("autoLoop stops orchestrator complete state through completion surface", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const stateSnapshot = {
    phase: "complete",
    activeMilestone: null,
    lastCompletedMilestone: { id: "M005", title: "Priority Levels" },
    activeSlice: null,
    activeTask: null,
    registry: [{ id: "M005", title: "Priority Levels", status: "complete" }],
    blockers: [],
    recentDecisions: [],
    nextAction: "All milestones complete.",
  } as any;
  const stopCalls: Array<{ reason?: string; options?: unknown }> = [];
  const s = makeLoopSession({
    currentMilestoneId: "M005",
    orchestration: {
      start: async () => ({ kind: "stopped" as const, reason: "unused" }),
      advance: async () => ({
        kind: "stopped" as const,
        reason: "legacy text not used",
        stateSnapshot,
        terminalOutcome: {
          code: "all-complete" as const,
          displayReason: "All milestones complete",
          allMilestonesComplete: true as const,
        },
      }),
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit: async () => {},
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
      stop: async () => ({ kind: "stopped" as const, reason: "unused" }),
      getStatus: () => ({ phase: "running" as const, transitionCount: 1 }),
    },
  });

  const deps = makeMockDeps({
    stopAuto: async (_ctx, _pi, reason, options) => {
      stopCalls.push({ reason, options });
      s.active = false;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0]?.reason, "All milestones complete");
  assert.deepEqual((stopCalls[0]?.options as any)?.completionWidget, {
    milestoneId: "M005",
    milestoneTitle: "Priority Levels",
    allMilestonesComplete: true,
  });
  assert.equal((stopCalls[0]?.options as any)?.terminalOutcome?.code, "all-complete");
  assert.equal(
    deps.callLog.includes("resolveDispatch"),
    false,
    "orchestrator completion must not fall back to legacy dispatch or a generic stop",
  );
});

test("autoLoop replays artifact retry dispatch before deriving the next unit", async () => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 50_000 });

  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {};
    ctx.ui.notify = () => {};
    ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
    const pi = makeMockPi();
    const stateSnapshot = {
      phase: "summarizing",
      activeMilestone: { id: "M004", title: "Milestone 4", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      activeTask: null,
      registry: [{ id: "M004", status: "active" }],
      blockers: [],
    } as any;
    const s = makeLoopSession({
      currentMilestoneId: "M004",
    });

    let resolveDispatchCalls = 0;
    let preVerificationCalls = 0;
    const deps = makeMockDeps({
      deriveState: async () => stateSnapshot,
      resolveDispatch: async () => {
        resolveDispatchCalls++;
        return resolveDispatchCalls === 1
          ? {
              action: "dispatch" as const,
              unitType: "complete-slice",
              unitId: "M004/S01",
              prompt: "complete slice prompt",
            }
          : {
              action: "dispatch" as const,
              unitType: "complete-milestone",
              unitId: "M004",
              prompt: "complete milestone prompt",
            };
      },
      postUnitPreVerification: async () => {
        preVerificationCalls++;
        if (preVerificationCalls === 1) {
          s.pendingVerificationRetry = {
            unitId: "M004/S01",
            failureContext: "slice summary exists but did not satisfy the completion contract",
            attempt: 1,
          };
          return "retry" as const;
        }
        return "continue" as const;
      },
      postUnitPostVerification: async () => {
        deps.callLog.push("postUnitPostVerification");
        if (preVerificationCalls >= 2) s.active = false;
        return "continue" as const;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);

    await waitForMicrotasks(() => pi.calls.length === 1, "initial complete-slice dispatch");
    resolveAgentEnd(makeEvent());
    await drainMicrotasks(100);
    mock.timers.tick(30_000);
    await waitForMicrotasks(() => pi.calls.length === 2, "same-unit retry dispatch");
    resolveAgentEnd(makeEvent());
    await loopPromise;

    const secondPrompt = (pi.calls[1] as any[])[0].content;
    assert.match(secondPrompt, /VERIFICATION FAILED/);
    assert.match(secondPrompt, /complete slice prompt/);
    assert.doesNotMatch(secondPrompt, /complete milestone prompt/);
    assert.equal(s.pendingVerificationRetryDispatch, null);
  } finally {
    mock.timers.reset();
  }
});

test("autoLoop replays pre-execution retry dispatch before deriving the next unit", async () => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 60_000 });

  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {};
    ctx.ui.notify = () => {};
    ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
    const pi = makeMockPi();
    const stateSnapshot = {
      phase: "planning",
      activeMilestone: { id: "M006", title: "Milestone 6", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      activeTask: null,
      registry: [{ id: "M006", status: "active" }],
      blockers: [],
    } as any;
    const s = makeLoopSession({
      currentMilestoneId: "M006",
    });

    let resolveDispatchCalls = 0;
    let postVerificationCalls = 0;
    const deps = makeMockDeps({
      deriveState: async () => stateSnapshot,
      resolveDispatch: async () => {
        resolveDispatchCalls++;
        return resolveDispatchCalls === 1
          ? {
              action: "dispatch" as const,
              unitType: "plan-slice",
              unitId: "M006/S01",
              prompt: "plan slice prompt",
            }
          : {
              action: "dispatch" as const,
              unitType: "execute-task",
              unitId: "M006/S01/T01",
              prompt: "execute task prompt",
            };
      },
      postUnitPostVerification: async () => {
        postVerificationCalls++;
        if (postVerificationCalls === 1) {
          s.pendingVerificationRetry = {
            unitId: "M006/S01",
            failureContext: "Unsafe Verify command: grep alternation with |",
            attempt: 1,
          };
          return "retry" as const;
        }
        s.active = false;
        return "continue" as const;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);

    await waitForMicrotasks(() => pi.calls.length === 1, "initial plan-slice dispatch");
    resolveAgentEnd(makeEvent());
    await drainMicrotasks(100);
    mock.timers.tick(30_000);
    await waitForMicrotasks(() => pi.calls.length === 2, "same planning retry dispatch");
    resolveAgentEnd(makeEvent());
    await loopPromise;

    const secondPrompt = (pi.calls[1] as any[])[0].content;
    assert.match(secondPrompt, /VERIFICATION FAILED/);
    assert.match(secondPrompt, /Unsafe Verify command/);
    assert.match(secondPrompt, /plan slice prompt/);
    assert.doesNotMatch(secondPrompt, /execute task prompt/);
    assert.equal(s.pendingVerificationRetryDispatch, null);
  } finally {
    mock.timers.reset();
  }
});

test("autoLoop releases orchestration active unit before artifact retry", async () => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 80_000 });

  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {};
    ctx.ui.notify = () => {};
    ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
    const pi = makeMockPi();
    const stateSnapshot = {
      phase: "summarizing",
      activeMilestone: { id: "M005", title: "Milestone 5", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      activeTask: null,
      registry: [{ id: "M005", status: "active" }],
      blockers: [],
    } as any;
    const retryUnits: string[] = [];
    let preVerificationCalls = 0;
    let s: any;
    s = makeLoopSession({
      currentMilestoneId: "M005",
      orchestration: {
        start: async () => ({ kind: "stopped" as const, reason: "unused" }),
        advance: async () => {
          s.pendingOrchestrationDispatch = {
            unitType: "complete-slice",
            unitId: "M005/S01",
            prompt: "complete slice prompt",
            pauseAfterUatDispatch: false,
            state: stateSnapshot,
            mid: "M005",
            midTitle: "Milestone 5",
          };
          return {
            kind: "advanced" as const,
            unit: { unitType: "complete-slice", unitId: "M005/S01" },
            stateSnapshot,
            dispatchId: 1,
          };
        },
        settle: async () => {},
        completeActiveUnit: async () => {},
        retryActiveUnit: async (unit: { unitType: string; unitId: string }) => {
          retryUnits.push(`${unit.unitType}:${unit.unitId}`);
        },
        abandonActiveUnit: async () => {},
        resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
        stop: async () => ({ kind: "stopped" as const, reason: "unused" }),
        getStatus: () => ({ phase: "running" as const, transitionCount: 1 }),
      },
    });

    const deps = makeMockDeps({
      postUnitPreVerification: async () => {
        preVerificationCalls++;
        if (preVerificationCalls === 1) {
          s.pendingVerificationRetry = {
            unitId: "M005/S01",
            failureContext: "slice summary exists but did not satisfy the completion contract",
            attempt: 1,
          };
          return "retry" as const;
        }
        return "continue" as const;
      },
      postUnitPostVerification: async () => {
        if (preVerificationCalls >= 2) s.active = false;
        return "continue" as const;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);
    await waitForMicrotasks(() => pi.calls.length === 1, "initial orchestration complete-slice dispatch");
    resolveAgentEnd(makeEvent());
    await drainMicrotasks(100);
    mock.timers.tick(30_000);
    await waitForMicrotasks(() => pi.calls.length === 2, "orchestration retry dispatch");
    resolveAgentEnd(makeEvent());
    await loopPromise;

    assert.deepEqual(retryUnits, ["complete-slice:M005/S01"]);
    const retryPrompt = (pi.calls[1] as any[])[0].content;
    assert.match(retryPrompt, /VERIFICATION FAILED/);
    assert.match(retryPrompt, /complete slice prompt/);
  } finally {
    mock.timers.reset();
  }
});

test("autoLoop journals post-unit finalize stop after completed unit", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const s = makeLoopSession();
  const journalEvents: Array<{ eventType: string; data?: any }> = [];

  const deps = makeMockDeps({
    postUnitPreVerification: async () => {
      deps.callLog.push("postUnitPreVerification");
      s.lastGitActionFailure = "commit failed";
      return "dispatched" as const;
    },
    emitJournalEvent: (entry: any) => {
      journalEvents.push(entry);
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());
  await loopPromise;

  assert.ok(
    deps.callLog.includes("postUnitPreVerification"),
    "completed units must enter post-unit pre-verification before stopping",
  );
  assert.ok(
    !deps.callLog.includes("runPostUnitVerification"),
    "git-closeout stop should not run later verification phases",
  );

  const unitEndIndex = journalEvents.findIndex((e) => e.eventType === "unit-end");
  const finalizeStartIndex = journalEvents.findIndex((e) => e.eventType === "post-unit-finalize-start");
  const finalizeEndIndex = journalEvents.findIndex((e) => e.eventType === "post-unit-finalize-end");
  const iterationEndIndex = journalEvents.findIndex((e) => e.eventType === "iteration-end");

  assert.ok(unitEndIndex >= 0, "unit-end should be journaled after agent completion");
  assert.ok(finalizeStartIndex > unitEndIndex, "post-unit finalize must start after unit-end");
  assert.ok(finalizeEndIndex > finalizeStartIndex, "post-unit finalize must journal its stop result");
  assert.ok(iterationEndIndex > finalizeEndIndex, "iteration-end must be emitted even when finalize stops");

  assert.deepEqual(journalEvents[finalizeEndIndex]!.data, {
    iteration: 1,
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    status: "stopped",
    action: "break",
    reason: "git-closeout-failure",
  });
  assert.deepEqual(journalEvents[iterationEndIndex]!.data, {
    iteration: 1,
    status: "stopped",
    reason: "git-closeout-failure",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    failureClass: "git",
  });
});

test("autoLoop journals iteration-end when unit phase breaks after cancelled unit", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const s = makeLoopSession();
  const journalEvents: Array<{ eventType: string; data?: any }> = [];

  const deps = makeMockDeps({
    emitJournalEvent: (entry: any) => {
      journalEvents.push(entry);
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEndCancelled();
  await loopPromise;

  const unitEndIndex = journalEvents.findIndex(
    (e) => e.eventType === "unit-end" && e.data?.status === "cancelled",
  );
  const iterationEndIndex = journalEvents.findIndex((e) => e.eventType === "iteration-end");

  assert.ok(unitEndIndex >= 0, "cancelled unit should still emit unit-end");
  assert.ok(iterationEndIndex > unitEndIndex, "unit-phase break must close the iteration after unit-end");
  assert.deepEqual(journalEvents[iterationEndIndex]!.data, {
    iteration: 1,
    status: "stopped",
    reason: "unit-aborted",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    failureClass: "execution",
  });
});

test("autoLoop journals iteration-end when dispatch skips the current unit", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();
  openLoopDatabase(t, s);
  const journalEvents: Array<{ eventType: string; data?: any }> = [];

  const deps = makeMockDeps({
    resolveDispatch: async () => {
      s.active = false;
      return { action: "skip" } as any;
    },
    emitJournalEvent: (entry: any) => {
      journalEvents.push(entry);
    },
  });

  await autoLoop(ctx, pi, s, deps);

  const iterationStartIndex = journalEvents.findIndex((e) => e.eventType === "iteration-start");
  const iterationEndIndex = journalEvents.findIndex((e) => e.eventType === "iteration-end");

  assert.ok(iterationStartIndex >= 0, "skipped dispatch should still open an iteration");
  assert.ok(iterationEndIndex > iterationStartIndex, "skipped dispatch must close the active iteration");
  assert.deepEqual(journalEvents[iterationEndIndex]!.data, {
    iteration: 1,
    skipped: true,
  });
  assert.equal(pi.calls.length, 0, "dispatch skip must not send a unit prompt");
});

test("crash lock records session file from AFTER newSession, not before (#1710)", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};

  // Simulate newSession changing the session file path.
  // newSession() in runUnit changes the underlying session, so getSessionFile
  // returns a different path after newSession completes.
  let currentSessionFile = "/tmp/old-session.json";
  ctx.sessionManager = {
    getSessionFile: () => currentSessionFile,
  };
  const pi = makeMockPi();

  const s = makeLoopSession({
    cmdCtx: {
      newSession: () => {
        // When newSession completes, the session file changes
        currentSessionFile = "/tmp/new-session-after-newSession.json";
        return Promise.resolve({ cancelled: false });
      },
      getContextUsage: () => ({ percent: 10, tokens: 1000, limit: 10000 }),
    },
  });

  // Track all writeLock calls with their sessionFile argument
  const writeLockCalls: { sessionFile: string | undefined }[] = [];
  const updateSessionLockCalls: { sessionFile: string | undefined }[] = [];

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any;
    },
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch" as const,
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "do the thing",
      };
    },
    writeLock: (_base: string, _ut: string, _uid: string, sessionFile?: string) => {
      writeLockCalls.push({ sessionFile });
    },
    updateSessionLock: (_base: string, _ut: string, _uid: string, sessionFile?: string) => {
      updateSessionLockCalls.push({ sessionFile });
    },
    getSessionFile: (ctxArg: any) => {
      return ctxArg.sessionManager?.getSessionFile() ?? "";
    },
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      // Deactivate after first iteration to exit the loop
      s.active = false;
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // Give the loop time to reach runUnit's await
  await new Promise((r) => setTimeout(r, 50));

  // Resolve the unit's agent_end
  resolveAgentEnd(makeEvent());

  await loopPromise;

  // The preliminary lock (before runUnit) should have NO session file
  assert.ok(
    writeLockCalls.length >= 2,
    `expected at least 2 writeLock calls, got ${writeLockCalls.length}`,
  );
  assert.strictEqual(
    writeLockCalls[0].sessionFile,
    undefined,
    "preliminary lock before runUnit should have no session file",
  );

  // The post-runUnit lock should have the NEW session file path
  assert.strictEqual(
    writeLockCalls[1].sessionFile,
    "/tmp/new-session-after-newSession.json",
    "post-runUnit lock should record the session file created by newSession",
  );

  // updateSessionLock should also have the new session file
  assert.ok(
    updateSessionLockCalls.length >= 1,
    "updateSessionLock should have been called at least once",
  );
  assert.strictEqual(
    updateSessionLockCalls[0].sessionFile,
    "/tmp/new-session-after-newSession.json",
    "updateSessionLock should record the session file created by newSession",
  );
});

test("autoLoop handles verification retry by continuing loop", async (t) => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });

  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {};
    ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
    const pi = makeMockPi();

    let verifyCallCount = 0;
    let deriveCallCount = 0;
    const s = makeLoopSession();

    // Pre-queued verification actions: each entry provides a side-effect + return value
    type VerifyAction = { sideEffect?: () => void; response: "retry" | "continue" };
    const verificationActions: VerifyAction[] = [
      {
        sideEffect: () => {
          // Simulate retry — set pendingVerificationRetry on session
          s.pendingVerificationRetry = {
            unitId: "M001/S01/T01",
            failureContext: "test failed: expected X got Y",
            attempt: 1,
          };
        },
        response: "retry",
      },
      { response: "continue" },
    ];

    const deps = makeMockDeps({
      deriveState: async () => {
        deriveCallCount++;
        deps.callLog.push("deriveState");
        return {
          phase: "executing",
          activeMilestone: { id: "M001", title: "Test", status: "active" },
          activeSlice: { id: "S01", title: "Slice 1" },
          activeTask: { id: "T01" },
          registry: [{ id: "M001", status: "active" }],
          blockers: [],
        } as any;
      },
      runPostUnitVerification: async () => {
        const action = verificationActions[verifyCallCount] ?? { response: "continue" as const };
        verifyCallCount++;
        deps.callLog.push("runPostUnitVerification");
        action.sideEffect?.();
        return action.response;
      },
      postUnitPostVerification: async () => {
        deps.callLog.push("postUnitPostVerification");
        // After the retry cycle completes, deactivate.
        if (verifyCallCount >= 2) s.active = false;
        return "continue" as const;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);

    // First iteration: runUnit → verification returns "retry" → loop continues
    await waitForMicrotasks(() => pi.calls.length === 1, "first dispatch");
    resolveAgentEnd(makeEvent()); // resolve first unit

    await drainMicrotasks(100);
    mock.timers.tick(30_000);
    await waitForMicrotasks(() => pi.calls.length === 2, "retry dispatch");
    resolveAgentEnd(makeEvent()); // resolve retry unit

    await loopPromise;

    // The retry cycle still completes and may re-derive after the pinned retry
    // finishes, but it must not skip the failed unit's verification pass.
    const deriveCount = deps.callLog.filter((c) => c === "deriveState").length;
    assert.ok(deriveCount >= 1, `deriveState should be called at least once (got ${deriveCount})`);

    // Verify verification was called twice
    assert.equal(
      verifyCallCount,
      2,
      "verification should have been called twice (once retry, once pass)",
    );
  } finally {
    mock.timers.reset();
  }
});

test("autoLoop leaves finalize-retry liveness to orchestration closeout", async (t) => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  t.after(() => mock.timers.reset());

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const unit = { unitType: "execute-task", unitId: "M001/S01/T01" };
  const loopLivenessGuards: string[] = [];
  let advanceCalls = 0;
  let retryCloseouts = 0;
  const s = makeLoopSession({ currentMilestoneId: "M001" });
  s.orchestration = {
    start: async () => ({ kind: "stopped" as const, reason: "unused" }),
    advance: async () => {
      advanceCalls++;
      if (advanceCalls === 1) {
        return {
          kind: "advanced" as const,
          unit,
          stateSnapshot: await makeMockDeps().deriveState(s.basePath),
          dispatchId: 1,
        };
      }
      s.active = false;
      return { kind: "stopped" as const, reason: "retry observed" };
    },
    settle: async () => {},
    completeActiveUnit: async () => {},
    retryActiveUnit: async () => { retryCloseouts++; },
    abandonActiveUnit: async () => {},
    resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
    stop: async (reason: string) => ({ kind: "stopped" as const, reason }),
    getStatus: () => ({ phase: "running" as const, transitionCount: advanceCalls }),
  } satisfies AutoOrchestrationModule;
  openLoopDatabase(t, s);

  const deps = makeMockDeps({
    runPostUnitVerification: async () => {
      s.pendingVerificationRetry = {
        unitId: unit.unitId,
        failureContext: "canonical validation needs fresh objective evidence",
        attempt: 1,
      };
      return "retry" as const;
    },
    adjudicateNonAdvancingOutcome: (_session, input) => {
      loopLivenessGuards.push(input.guardId);
      return null;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);
  await waitForMicrotasks(() => pi.calls.length === 1, "finalize retry dispatch");
  resolveAgentEnd(makeEvent());
  await drainMicrotasks(100);
  mock.timers.tick(30_000);
  await loopPromise;

  assert.equal(retryCloseouts, 1, "the retry must close through orchestration once");
  assert.deepEqual(
    loopLivenessGuards.filter((guardId) => guardId === "finalize-retry"),
    [],
    "orchestration owns finalize-retry liveness and the loop must not record it again",
  );
});

test("autoLoop pauses a machine-terminal verification abort with a terminal notification (#1971)", async () => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {};
    ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
    const pi = makeMockPi();
    const s = makeLoopSession();
    const pauseMessages: string[] = [];
    let postVerificationCalls = 0;
    let publicationCalls = 0;

    const deps = makeMockDeps({
      runPostUnitVerification: async () => {
        s.lastTaskRecoveryAbortId = "recovery-action-1";
        return "abort" as const;
      },
      pauseAuto: async (
        _ctx?: unknown,
        _pi?: unknown,
        errorContext?: { message?: string },
      ) => {
        // Production pauseAuto notifies the errorContext message itself.
        pauseMessages.push(errorContext?.message ?? "");
      },
      postUnitPostVerification: async () => {
        postVerificationCalls++;
        s.active = false;
        return "continue" as const;
      },
      taskPublicationBoundary: async () => { publicationCalls++; },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);
    await waitForMicrotasks(() => pi.calls.length === 1, "verification-abort dispatch");
    resolveAgentEnd(makeEvent());
    await drainMicrotasks(100);
    mock.timers.tick(30_000);
    await loopPromise;

    // The loop must never silent-idle after a terminal abort (#1971): auto-mode
    // pauses with a message carrying the recoveryActionId so the operator sees
    // the /gsd recover instruction and /gsd auto can resume afterwards.
    assert.equal(pauseMessages.length, 1, "verification abort must pause auto-mode");
    assert.ok(
      pauseMessages[0]?.includes("/gsd recover recovery-action-1"),
      `expected the pause message to name the recovery action, got: ${JSON.stringify(pauseMessages)}`,
    );
    assert.equal(postVerificationCalls, 0);
    assert.equal(publicationCalls, 0);
  } finally {
    mock.timers.reset();
  }
});

test("autoLoop stops an evidence-xref block before host verification or publication", async (t) => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  t.after(() => mock.timers.reset());
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const s = makeLoopSession();
  let verificationCalls = 0;
  let publicationCalls = 0;

  const deps = makeMockDeps({
    postUnitPreVerification: async () => "evidence-xref-blocked" as const,
    runPostUnitVerification: async () => {
      verificationCalls++;
      return "continue" as const;
    },
    taskPublicationBoundary: async () => { publicationCalls++; },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);
  await waitForMicrotasks(() => pi.calls.length === 1, "evidence-xref dispatch");
  resolveAgentEnd(makeEvent());
  await drainMicrotasks(100);
  mock.timers.tick(30_000);
  await loopPromise;

  assert.equal(verificationCalls, 0);
  assert.equal(publicationCalls, 0);
});

test("autoLoop pauses a predecessor task-recovery abort before any agent turn", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const notifications: string[] = [];
  ctx.ui.notify = (message: string) => notifications.push(message);
  const pi = makeMockPi();
  const s = makeLoopSession();
  let pauseReason: string | undefined;
  let terminalAbortReads = 0;
  const abortReason =
    "task-recovery-abort (recoveryActionId: recovery-action-1; resume with /gsd recover recovery-action-1 or gsd_task_recovery_resume)";

  const deps = makeMockDeps({
    taskExecutionBoundary: async (input, run, cutoverDeps) =>
      runWithTaskExecutionAttempt({
        ...input,
        dispatchId: 41,
        workerId: "worker-1",
        milestoneLeaseToken: 7,
      }, run, {
        ...cutoverDeps,
        readLatestTaskAttempt() {
          return {
            attemptId: "attempt-1",
            resultId: "result-1",
            attemptNumber: 1,
            state: "settled",
            outcome: "succeeded",
            nextStage: "route",
            coordinationDispatchId: 40,
            workerId: "worker-1",
            milestoneLeaseToken: 7,
          };
        },
        readTerminalTaskRecoveryAbort() {
          terminalAbortReads += 1;
          return { recoveryActionId: "recovery-action-1" };
        },
        readTaskRecoveryRoute() {
          throw new Error("all-attempt terminal abort guard must run before the latest-route fallback");
        },
      }),
    pauseAuto: async (_ctx, _pi, errorContext) => {
      pauseReason = errorContext?.message;
      s.active = false;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(pi.calls.length, 0, "the predecessor abort must stop before an agent turn");
  assert.equal(terminalAbortReads, 1, "the durable predecessor abort must be read exactly once");
  assert.equal(pauseReason, abortReason);
  assert.match(notifications.join("\n"), /recoveryActionId: recovery-action-1/);
  assert.match(notifications.join("\n"), /gsd_task_recovery_resume/);
});

test("autoLoop handles dispatch stop action", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  const deps = makeMockDeps({
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "stop" as const,
        reason: "test-stop-reason",
        level: "info" as const,
      };
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(
    deps.callLog.includes("resolveDispatch"),
    "should have called resolveDispatch",
  );
  assert.ok(
    deps.callLog.includes("stopAuto"),
    "should have stopped on dispatch stop action",
  );
});

// #2474: warning-level dispatch stop should pause (resumable), not hard-stop
test("autoLoop pauses instead of stopping for warning-level dispatch stop", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();
  let pauseContext: unknown;

  const deps = makeMockDeps({
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "stop" as const,
        reason: 'UAT verdict for S01 is "partial" — blocking progression.',
        level: "warning" as const,
      };
    },
    pauseAuto: async (_ctx, _pi, errorContext) => {
      pauseContext = errorContext;
      deps.callLog.push("pauseAuto");
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(
    deps.callLog.includes("resolveDispatch"),
    "should have called resolveDispatch",
  );
  assert.ok(
    deps.callLog.includes("pauseAuto"),
    "warning-level stop should call pauseAuto (resumable)",
  );
  assert.ok(
    !deps.callLog.includes("stopAuto"),
    "warning-level stop should NOT call stopAuto (hard stop)",
  );
  assert.equal(
    (pauseContext as { message?: string } | undefined)?.message,
    'UAT verdict for S01 is "partial" — blocking progression.',
    "warning-level stop should pass pause reason into pauseAuto for persisted paused metadata",
  );
});

test("autoLoop retries warning-level unhandled phase with fresh state before pausing", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();
  const states = [
    {
      phase: "planning",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: null,
      activeTask: null,
      registry: [{ id: "M001", status: "active" }],
      blockers: [],
    },
    {
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      activeTask: { id: "T01" },
      registry: [{ id: "M001", status: "active" }],
      blockers: [],
    },
  ];
  const seenPhases: string[] = [];
  let deriveCalls = 0;

  const deps = makeMockDeps({
    deriveState: async () => states[Math.min(deriveCalls++, states.length - 1)] as any,
    resolveDispatch: async (dctx) => {
      seenPhases.push(dctx.state.phase);
      if (dctx.state.phase === "planning") {
        return {
          action: "stop" as const,
          reason: 'Unhandled phase "planning" — run /gsd doctor to diagnose.',
          level: "warning" as const,
          matchedRule: "<no-match>",
        };
      }
      return {
        action: "stop" as const,
        reason: "fresh state reached terminal stop",
        level: "info" as const,
      };
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.deepEqual(seenPhases, ["planning", "executing"]);
  assert.equal(deriveCalls, 2, "unhandled warning should re-derive state once");
  assert.equal(deps.callLog.includes("pauseAuto"), false);
  assert.equal(deps.callLog.includes("stopAuto"), true);
});

// #2474: error-level dispatch stop should still hard-stop
test("autoLoop hard-stops for error-level dispatch stop", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();

  const deps = makeMockDeps({
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "stop" as const,
        reason: "Cannot complete milestone: missing SUMMARY files.",
        level: "error" as const,
      };
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(
    deps.callLog.includes("stopAuto"),
    "error-level stop should call stopAuto (hard stop)",
  );
  assert.ok(
    !deps.callLog.includes("pauseAuto"),
    "error-level stop should NOT call pauseAuto",
  );
});

test("autoLoop closes journal iteration on pre-dispatch health-gate break", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();
  const journalEvents: Array<{ eventType: string; data?: any }> = [];
  let pauseOptions: unknown;

  const deps = makeMockDeps({
    preDispatchHealthGate: async () => ({
      proceed: false,
      reason: "health gate failed",
      fixesApplied: [],
    }),
    pauseAuto: async (_ctx, _pi, _errorContext, options) => {
      pauseOptions = options;
      deps.callLog.push("pauseAuto");
    },
    emitJournalEvent: (event: any) => {
      journalEvents.push(event);
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(deps.callLog.includes("pauseAuto"), true);
  assert.deepEqual(pauseOptions, { expectedCurrentUnit: null });
  assert.ok(
    journalEvents.some((event) => event.eventType === "iteration-end" && event.data?.reason === "health-gate-failed"),
    "pre-dispatch break must close the started iteration",
  );
});

test("autoLoop handles dispatch skip action by continuing", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();
  openLoopDatabase(t, s);
  const journalEvents: Array<{ eventType: string; data?: any }> = [];

  let dispatchCallCount = 0;
  // Pre-queued dispatch responses: first call returns "skip", second returns "stop"
  const dispatchResponses = [
    { action: "skip" as const, reason: "already-active" as const },
    { action: "stop" as const, reason: "done", level: "info" as const },
  ];
  const deps = makeMockDeps({
    resolveDispatch: async () => {
      const response = dispatchResponses[dispatchCallCount] ?? dispatchResponses[dispatchResponses.length - 1];
      dispatchCallCount++;
      deps.callLog.push("resolveDispatch");
      return response;
    },
    emitJournalEvent: (entry: any) => {
      journalEvents.push(entry);
      deps.callLog.push(`journal:${entry.eventType}`);
    },
  });

  await autoLoop(ctx, pi, s, deps);

  // Should have called resolveDispatch twice (skip → re-derive → stop)
  const dispatchCalls = deps.callLog.filter((c) => c === "resolveDispatch");
  assert.equal(
    dispatchCalls.length,
    2,
    "resolveDispatch should be called twice (skip then stop)",
  );
  const deriveCalls = deps.callLog.filter((c) => c === "deriveState");
  assert.ok(
    deriveCalls.length >= 2,
    "deriveState should be called at least twice (one per iteration)",
  );
  assert.ok(
    !deps.callLog.includes("pauseAuto"),
    "single already-active skip should not pause auto-mode",
  );
  const skippedIterationEnd = journalEvents.find((e) => e.eventType === "iteration-end");
  assert.deepEqual(
    skippedIterationEnd?.data,
    { iteration: 1, skipped: true },
    "dispatch skip must close the skipped iteration before re-deriving state",
  );
  assert.ok(
    deps.callLog.indexOf("journal:iteration-end") < deps.callLog.lastIndexOf("deriveState"),
    "dispatch skip must journal iteration-end before the next deriveState",
  );
});

test("ADR-047: repeated orchestration skips trip the persisted backstop at the loop boundary", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();
  mkdirSync(join(s.basePath, ".gsd"), { recursive: true });
  openDatabase(join(s.basePath, ".gsd", "gsd.db"));
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(s.basePath, { recursive: true, force: true });
  });

  const deps = makeMockDeps({
    adjudicateNonAdvancingOutcome: undefined,
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return { action: "skip" as const, reason: "gate-marker-drift" as const };
    },
  });

  await autoLoop(ctx, pi, s, deps);

  const dispatchCalls = deps.callLog.filter((c) => c === "resolveDispatch");
  assert.equal(dispatchCalls.length, 2, "the second identical skip must trip the backstop");
  assert.equal(deps.callLog.includes("pauseAuto"), false);
  assert.equal(deps.callLog.includes("stopAuto"), true, "a tripped skip must stop through the blocked path");
  const wedgeResult = getOpenWedge(realpathSync(s.basePath));
  assert.equal(wedgeResult.ok, true);
  assert.ok(wedgeResult.ok && wedgeResult.wedge, "the skip wedge must be persisted");
});

test("#1672: dev runGuards preserves semantic ids and capture inputs through adjudication", async (t) => {
  const adjudicated: Array<{ guardId: string; inputPayload: string }> = [];

  for (const text of ["stop after first failure", "stop after second failure"]) {
    _resetPendingResolve();
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {};
    const pi = makeMockPi();
    const s = makeLoopSession();
    openLoopDatabase(t, s);
    const captureId = appendCapture(s.basePath, text);
    markCaptureResolved(s.basePath, captureId, "stop", "halt", text, "M001");
    const deps = makeMockDeps({
      adjudicateNonAdvancingOutcome: (_session, input) => {
        adjudicated.push({ guardId: input.guardId, inputPayload: input.inputPayload });
        return null;
      },
    });

    await autoLoop(ctx, pi, s, deps);
    closeDatabase();
  }

  assert.deepEqual(adjudicated.map((entry) => entry.guardId), ["user-stop", "user-stop"]);
  assert.notEqual(
    adjudicated[0]!.inputPayload,
    adjudicated[1]!.inputPayload,
    "distinct stop captures must hash distinct guard inputs",
  );
  assert.equal(JSON.parse(adjudicated[0]!.inputPayload)[0].text, "stop after first failure");
  assert.equal(JSON.parse(adjudicated[1]!.inputPayload)[0].text, "stop after second failure");
});

test("ADR-047: pre-dispatch hook skips feed the loop-boundary ledger", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession();
  const stateSnapshot = await makeMockDeps().deriveState(s.basePath);
  s.orchestration = {
    start: async () => ({ kind: "started" as const }),
    advance: async () => ({
      kind: "advanced" as const,
      unit: { unitType: "execute-task", unitId: "M001/S01/T01" },
      stateSnapshot,
      dispatchId: 1,
    }),
    settle: async () => {},
    completeActiveUnit: async () => {},
    retryActiveUnit: async () => {},
    abandonActiveUnit: async () => {},
    resume: async () => ({ kind: "resumed" as const }),
    stop: async (reason: string) => ({ kind: "stopped" as const, reason }),
    getStatus: () => ({ phase: "running" as const, transitionCount: 1 }),
  } satisfies AutoOrchestrationModule;
  mkdirSync(join(s.basePath, ".gsd"), { recursive: true });
  openDatabase(join(s.basePath, ".gsd", "gsd.db"));
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(s.basePath, { recursive: true, force: true });
  });
  const deps = makeMockDeps({
    adjudicateNonAdvancingOutcome: undefined,
    runPreDispatchHooks: () => ({ firedHooks: ["skip-execute"], action: "skip" }),
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(deps.callLog.includes("stopAuto"), true);
  const wedgeResult = getOpenWedge(realpathSync(s.basePath));
  assert.equal(wedgeResult.ok, true);
  assert.ok(wedgeResult.ok && wedgeResult.wedge, "the pre-dispatch hook skip wedge must be persisted");
  if (wedgeResult.ok && wedgeResult.wedge) assert.equal(wedgeResult.wedge.guardId, "pre-dispatch-hook-skip");
});

test("#1672: preflight exits persist a block signature that survives a restart", async (t) => {
  // Gap 2 (#1672): the max-iteration, memory-pressure and missing-command-context
  // exits used to run BEFORE the try whose finally adjudicates, so their pending
  // signatures were discarded and the same preflight failure recurred after every
  // restart with no persisted wedge. Each exit now trips on its second identical
  // occurrence, and the ledger is DB-persisted so a restart does not reset it.
  const preflights: Array<{
    name: string;
    guardId: string;
    exitPattern: RegExp;
    session: () => ReturnType<typeof makeLoopSession>;
    deps?: Partial<LoopDeps>;
  }> = [
    {
      name: "memory-pressure",
      guardId: "memory-pressure",
      exitPattern: /`\/gsd auto`/,
      session: () => makeLoopSession(),
      deps: {
        measureMemoryPressure: () => ({ pressured: true, heapMB: 4000, limitMB: 4096, pct: 0.976 }),
      },
    },
    {
      name: "missing-command-context",
      guardId: "missing-command-context",
      exitPattern: /gsd headless auto/,
      // No newSession() on cmdCtx — the loop has nothing to dispatch into.
      session: () => makeLoopSession({
        cmdCtx: { getContextUsage: () => ({ percent: 10, tokens: 1000, limit: 10000 }) },
      }),
    },
  ];

  for (const preflight of preflights) {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {};
    ctx.ui.notify = () => {};
    const pi = makeMockPi();
    const s = preflight.session();
    openLoopDatabase(t, s);
    const dbPath = join(s.basePath, ".gsd", "gsd.db");
    const stopCalls: Array<{
      active: boolean;
      reason: string | undefined;
      options: Parameters<LoopDeps["stopAuto"]>[3];
    }> = [];
    const deps = makeMockDeps({
      adjudicateNonAdvancingOutcome: undefined,
      ...preflight.deps,
      stopAuto: async (_ctx, _pi, reason, options) => {
        deps.callLog.push(`stopAuto:${reason ?? ""}`);
        stopCalls.push({ active: s.active, reason, options });
        s.active = false;
        closeDatabase();
      },
    });

    await autoLoop(ctx, pi, s, deps);
    openDatabase(dbPath);
    const first = getOpenWedge(realpathSync(s.basePath));
    assert.equal(first.ok, true);
    assert.equal(
      first.ok ? first.wedge : null,
      null,
      `${preflight.name}: the first preflight exit must not trip`,
    );

    s.active = true;

    await autoLoop(ctx, pi, s, deps);
    openDatabase(dbPath);
    const second = getOpenWedge(realpathSync(s.basePath));
    assert.equal(second.ok, true);
    const wedge = second.ok ? second.wedge : null;
    assert.ok(wedge, `${preflight.name}: the repeated preflight exit must persist a wedge`);
    assert.equal(wedge!.guardId, preflight.guardId);
    assert.equal(wedge!.occurrenceCount, 2);
    assert.match(
      wedge!.sanctionedExit,
      preflight.exitPattern,
      `${preflight.name}: the wedge must name its owning guard's real recovery command`,
    );
    assert.doesNotMatch(wedge!.sanctionedExit, /Resolve the reported condition/);
    if (preflight.name === "missing-command-context") {
      const stop = stopCalls.at(-1);
      assert.equal(stop?.active, true);
      assert.deepEqual(stop?.options, { preserveWorktree: true });
      assert.equal(isBlockedStopReason(stop?.reason), true);
      assert.equal(stopNoticeKind(stop?.reason), "blocked");
      assert.equal(mapStatusToExitCode(stopNoticeKind(stop?.reason)), 10);
      assert.match(stop?.reason ?? "", /Auto-mode has no command context for dispatch\./);
    }
    closeDatabase();
  }
});

test("#1672: the max-iteration preflight exit persists a block signature across a restart", async (t) => {
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  const pi = makeMockPi();

  // Every iteration skips with a run-unique payload so only the terminal
  // max-iteration exit repeats identically across the two runs.
  let runTag = "run-1";
  let skipCounter = 0;
  const s = makeLoopSession({
    currentMilestoneId: "M001",
    orchestration: {
      start: async () => ({ kind: "stopped" as const, reason: "unused" }),
      advance: async () => ({
        kind: "skipped" as const,
        code: "no-dispatch" as const,
        reason: `no-op ${runTag}-${++skipCounter}`,
      }),
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit: async () => {},
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
      stop: async (reason: string) => ({ kind: "stopped" as const, reason }),
      getStatus: () => ({ phase: "running" as const, transitionCount: 1 }),
    } satisfies AutoOrchestrationModule,
  });
  openLoopDatabase(t, s);
  const dbPath = join(s.basePath, ".gsd", "gsd.db");
  const deps = makeMockDeps({ adjudicateNonAdvancingOutcome: undefined });

  await autoLoop(ctx, pi, s, deps);
  const first = getOpenWedge(realpathSync(s.basePath));
  assert.equal(first.ok && first.wedge, null, "the first iteration-ceiling exit must not trip");

  closeDatabase();
  openDatabase(dbPath);
  runTag = "run-2";
  skipCounter = 0;
  s.active = true;

  await autoLoop(ctx, pi, s, deps);
  const second = getOpenWedge(realpathSync(s.basePath));
  assert.equal(second.ok, true);
  const wedge = second.ok ? second.wedge : null;
  assert.ok(wedge, "the repeated iteration-ceiling exit must persist a wedge");
  assert.equal(wedge!.guardId, "max-iterations");
  assert.match(wedge!.sanctionedExit, /`\/gsd status`/);
  assert.match(wedge!.sanctionedExit, /`\/gsd auto`/);
  assert.doesNotMatch(wedge!.sanctionedExit, /Resolve the reported condition/);
});

test("abnormal unit exit abandons the active orchestration marker before the next advance", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  const pi = makeMockPi();
  let advanceCalls = 0;
  let executionStarted = false;
  let activeMarker = false;
  const abandoned: Array<{ unitType: string; unitId: string; reason: string }> = [];
  const currentUnitsAtAdvance: Array<string | null> = [];
  const s = makeLoopSession({
    currentMilestoneId: "M001",
    orchestration: {
      start: async () => ({ kind: "stopped" as const, reason: "unused" }),
      advance: async () => {
        advanceCalls++;
        currentUnitsAtAdvance.push(s.currentUnit?.id ?? null);
        if (advanceCalls === 1) {
          activeMarker = true;
          return {
            kind: "advanced" as const,
            unit: { unitType: "plan-slice", unitId: "M001/S01" },
            stateSnapshot: await makeMockDeps().deriveState(s.basePath),
            dispatchId: 1,
          };
        }
        if (activeMarker) {
          return { kind: "skipped" as const, code: "unit-already-active" as const, reason: "idempotent advance: unit already active" };
        }
        return { kind: "stopped" as const, reason: "no active unit" };
      },
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit: async () => {},
      abandonActiveUnit: async (unit, reason) => {
        activeMarker = false;
        abandoned.push({ ...unit, reason });
      },
      resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
      stop: async (reason: string) => ({ kind: "stopped" as const, reason }),
      getStatus: () => ({ phase: "running" as const, transitionCount: 1 }),
    } satisfies AutoOrchestrationModule,
  });
  openLoopDatabase(t, s);
  const deps = makeMockDeps({
    adjudicateNonAdvancingOutcome: undefined,
    taskExecutionBoundary: async () => {
      executionStarted = true;
      s.setCurrentUnit({ type: "plan-slice", id: "M001/S01", startedAt: Date.now() });
      throw new Error("unit execution crashed");
    },
    stopAuto: async (_ctx, _pi, reason) => {
      deps.callLog.push(`stopAuto:${reason ?? ""}`);
      s.active = false;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(executionStarted, true);
  assert.deepEqual(
    currentUnitsAtAdvance,
    [null, null],
    "crash closeout and orchestration abandonment must both finish before the next advance",
  );
  assert.equal(advanceCalls, 2);
  assert.deepEqual(abandoned.map(({ unitType, unitId }) => ({ unitType, unitId })), [
    { unitType: "plan-slice", unitId: "M001/S01" },
  ]);
  assert.match(abandoned[0]?.reason ?? "", /unit execution crashed/);
  const wedgeResult = getOpenWedge(realpathSync(s.basePath));
  assert.equal(wedgeResult.ok, true);
  assert.equal(wedgeResult.ok ? wedgeResult.wedge : null, null);
});

test("#1721: idle unit-already-active skip without in-flight stops instead of livelocking", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const unit = { unitType: "execute-task", unitId: "M001/S01/T01" };
  let advanceCalls = 0;
  const s = makeLoopSession({
    currentMilestoneId: "M001",
    orchestration: {
      start: async () => ({ kind: "stopped" as const, reason: "unused" }),
      advance: async () => {
        advanceCalls++;
        return { kind: "skipped" as const, code: "unit-already-active" as const, reason: "idempotent advance: unit already active" };
      },
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit: async () => {},
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
      stop: async (reason: string) => ({ kind: "stopped" as const, reason }),
      getStatus: () => ({
        phase: "running" as const,
        transitionCount: advanceCalls,
        activeUnit: unit,
      }),
    } satisfies AutoOrchestrationModule,
  });
  openLoopDatabase(t, s);
  const deps = makeMockDeps({
    adjudicateNonAdvancingOutcome: () => null,
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(advanceCalls, 1, "a stale skip must stop instead of re-polling");
  assert.ok(
    deps.callLog.includes("stopAuto") || deps.callLog.some(entry => entry.startsWith("stopAuto")),
    "stale skip must stop auto-mode",
  );
});

test("#1672: an unclearable active-unit marker still makes following skips ledger-visible", async (t) => {
  _resetPendingResolve();

  // Abandonment is key-matched inside the orchestrator, so a marker the loop
  // cannot clear (mismatched key, or one planted by another writer) survives
  // the abnormal exit. The stale-skip guard is the defence-in-depth behind the
  // abandon call: it must still terminate the loop through the blocked path
  // instead of re-polling an in-flight unit that is not running (#1672).
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  const pi = makeMockPi();
  let advanceCalls = 0;
  const s = makeLoopSession({
    currentMilestoneId: "M001",
    orchestration: {
      start: async () => ({ kind: "stopped" as const, reason: "unused" }),
      advance: async () => {
        advanceCalls++;
        if (advanceCalls === 1) {
          return {
            kind: "advanced" as const,
            unit: { unitType: "plan-slice", unitId: "M001/S01" },
            stateSnapshot: await makeMockDeps().deriveState(s.basePath),
            dispatchId: 1,
          };
        }
        return { kind: "skipped" as const, code: "unit-already-active" as const, reason: "idempotent advance: unit already active" };
      },
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit: async () => {},
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
      stop: async (reason: string) => ({ kind: "stopped" as const, reason }),
      getStatus: () => ({ phase: "running" as const, transitionCount: 1 }),
    } satisfies AutoOrchestrationModule,
  });
  openLoopDatabase(t, s);
  const deps = makeMockDeps({
    adjudicateNonAdvancingOutcome: undefined,
    taskExecutionBoundary: async () => {
      s.setCurrentUnit({ type: "plan-slice", id: "M001/S01", startedAt: Date.now() });
      throw new Error("unit execution crashed");
    },
    stopAuto: async (_ctx, _pi, reason) => {
      deps.callLog.push(`stopAuto:${reason ?? ""}`);
      s.active = false;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(advanceCalls, 2, "the first stale skip must stop, not spin");
  const stopEntry = deps.callLog.find(entry => entry.startsWith("stopAuto:"));
  assert.match(stopEntry ?? "", /^stopAuto:Blocked: /, "a stale skip stops through the blocked path");
  const wedgeResult = getOpenWedge(realpathSync(s.basePath));
  assert.equal(wedgeResult.ok, true);
  // One stale skip is enough to stop; ADR-047 still trips only at occurrence 2.
});

test("finalize exceptions abandon the active orchestration marker before the next advance", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  const pi = makeMockPi();
  let advanceCalls = 0;
  let activeMarker = false;
  const abandoned: Array<{ unitType: string; unitId: string; reason: string }> = [];
  let inFlightDuringFinalize = false;
  const inFlightAtAdvance: boolean[] = [];
  const s = makeLoopSession({
    currentMilestoneId: "M001",
    orchestration: {
      start: async () => ({ kind: "stopped" as const, reason: "unused" }),
      advance: async () => {
        advanceCalls++;
        inFlightAtAdvance.push(s.unitExecutionInFlight);
        if (advanceCalls === 1) {
          activeMarker = true;
          return {
            kind: "advanced" as const,
            unit: { unitType: "plan-slice", unitId: "M001/S01" },
            stateSnapshot: await makeMockDeps().deriveState(s.basePath),
            dispatchId: 1,
          };
        }
        if (activeMarker) {
          return { kind: "skipped" as const, code: "unit-already-active" as const, reason: "idempotent advance: unit already active" };
        }
        return { kind: "stopped" as const, reason: "no active unit" };
      },
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit: async () => {},
      abandonActiveUnit: async (unit, reason) => {
        activeMarker = false;
        abandoned.push({ ...unit, reason });
      },
      resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
      stop: async (reason: string) => ({ kind: "stopped" as const, reason }),
      getStatus: () => ({ phase: "running" as const, transitionCount: 1 }),
    } satisfies AutoOrchestrationModule,
  });
  openLoopDatabase(t, s);
  const deps = makeMockDeps({
    adjudicateNonAdvancingOutcome: undefined,
    taskExecutionBoundary: async () => {
      s.setCurrentUnit({ type: "plan-slice", id: "M001/S01", startedAt: Date.now() });
      return { action: "next" as const, data: { unitStartedAt: Date.now() } };
    },
    postUnitPreVerification: async () => {
      inFlightDuringFinalize = s.unitExecutionInFlight;
      throw new Error("post-unit verification crashed");
    },
    stopAuto: async (_ctx, _pi, reason) => {
      deps.callLog.push(`stopAuto:${reason ?? ""}`);
      s.active = false;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.equal(inFlightDuringFinalize, true);
  assert.deepEqual(inFlightAtAdvance, [false, false]);
  assert.equal(s.currentUnit?.id, "M001/S01", "the test must retain the stale marker from finalize failure");
  assert.equal(advanceCalls, 2);
  assert.deepEqual(abandoned.map(({ unitType, unitId }) => ({ unitType, unitId })), [
    { unitType: "plan-slice", unitId: "M001/S01" },
  ]);
  assert.match(abandoned[0]?.reason ?? "", /post-unit verification crashed/);
  const wedgeResult = getOpenWedge(realpathSync(s.basePath));
  assert.equal(wedgeResult.ok, true);
  assert.equal(wedgeResult.ok ? wedgeResult.wedge : null, null);
});

test("autoLoop does not pause on repeated idempotent advance skips while a unit is in flight", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  let advanceCalls = 0;
  const adjudicated: string[] = [];
  const s = makeLoopSession({
    currentMilestoneId: "M001",
    // A unit really is executing: re-polling is the designed no-op, so this
    // skip stays exempt from the liveness ledger (#1672).
    currentUnit: { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() },
    unitExecutionInFlight: true,
    orchestration: {
      start: async () => ({ kind: "stopped" as const, reason: "unused" }),
      advance: async () => {
        advanceCalls++;
        if (advanceCalls >= 5) s.active = false;
        return { kind: "skipped" as const, code: "unit-already-active" as const, reason: "idempotent advance: unit already active" };
      },
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit: async () => {},
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
      stop: async (reason: string) => ({ kind: "stopped" as const, reason }),
      getStatus: () => ({ phase: "running" as const, transitionCount: 1 }),
    } satisfies AutoOrchestrationModule,
  });

  const deps = makeMockDeps({
    adjudicateNonAdvancingOutcome: (_session, input) => {
      adjudicated.push(input.guardId);
      return null;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(advanceCalls >= 5, "loop should complete multiple idempotent skips before deactivating");
  assert.equal(deps.callLog.includes("pauseAuto"), false, "idempotent advance skips must not trigger the consecutive-skip pause");
  assert.equal(deps.callLog.includes("stopAuto"), false, "idempotent advance skips must not reach the max-iteration stop");
  assert.deepEqual(adjudicated, [], "re-polling a genuinely in-flight unit is not a non-advancing outcome");
});

test("ADR-047 #1655: identical transient pauses trip at the loop outcome boundary", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  const pi = makeMockPi();

  const makePausedSession = () => {
    const session = makeLoopSession({ currentMilestoneId: "M001" });
    session.orchestration = {
      start: async () => ({ kind: "stopped" as const, reason: "unused" }),
      advance: async () => ({
        kind: "paused" as const,
        reason: "transient: database is locked",
        failureKind: "runtime-unknown" as const,
      }),
      settle: async () => {},
      completeActiveUnit: async () => {},
      retryActiveUnit: async () => {},
      abandonActiveUnit: async () => {},
      resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
      stop: async (reason: string) => ({ kind: "stopped" as const, reason }),
      getStatus: () => ({ phase: "running" as const, transitionCount: 1 }),
    } satisfies AutoOrchestrationModule;
    return session;
  };

  const s1 = makePausedSession();
  mkdirSync(join(s1.basePath, ".gsd"), { recursive: true });
  const dbPath = join(s1.basePath, ".gsd", "gsd.db");
  openDatabase(dbPath);
  let stopReason = "";
  const deps1 = makeMockDeps({
    adjudicateNonAdvancingOutcome: undefined,
    stopAuto: async (_ctx, _pi, reason) => {
      deps1.callLog.push("stopAuto");
      stopReason = reason ?? "";
      s1.active = false;
    },
  });

  try {
    await autoLoop(ctx, pi, s1, deps1);

    assert.equal(deps1.callLog.includes("stopAuto"), true, "the second pause must stop, not loop forever");
    assert.match(stopReason, /^Blocked: /, "the stop must carry the blocked marker (exit 10 in headless)");
    const wedgeResult = getOpenWedge(realpathSync(s1.basePath));
    assert.equal(wedgeResult.ok, true);
    assert.ok(wedgeResult.ok && wedgeResult.wedge, "second identical pause must persist a wedge");
    if (wedgeResult.ok && wedgeResult.wedge) assert.equal(wedgeResult.wedge.guardId, "orchestration-transient-pause");
  } finally {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(s1.basePath, { recursive: true, force: true });
  }
});

test("#1852/#2001: projection-lock transient pauses exhaust their backoff and never wedge", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const notices: string[] = [];
  ctx.ui.notify = (message: string) => { notices.push(message); };

  const s = makeLoopSession({ currentMilestoneId: "M001" });
  let advanceCalls = 0;
  s.orchestration = {
    start: async () => ({ kind: "stopped" as const, reason: "unused" }),
    advance: async () => {
      advanceCalls++;
      const legacyFallback = advanceCalls > 4;
      return {
        kind: "paused" as const,
        reason: legacyFallback
          ? "projection root operation failed: file in use (os error 32)"
          : "Projection root busy: native projection root identity locking failed",
        failureKind: legacyFallback
          ? "runtime-unknown" as const
          : "projection-lock-transient" as const,
        backoffMs: [1, 1, 1],
      };
    },
    settle: async () => {},
    completeActiveUnit: async () => {},
    retryActiveUnit: async () => {},
    abandonActiveUnit: async () => {},
    resume: async () => ({ kind: "stopped" as const, reason: "unused" }),
    stop: async (reason: string) => ({ kind: "stopped" as const, reason }),
    getStatus: () => ({ phase: "running" as const, transitionCount: 1 }),
  } satisfies AutoOrchestrationModule;
  mkdirSync(join(s.basePath, ".gsd"), { recursive: true });
  openDatabase(join(s.basePath, ".gsd", "gsd.db"));

  let stopReason = "";
  const deps = makeMockDeps({
    adjudicateNonAdvancingOutcome: undefined,
    stopAuto: async (_ctx, _pi, reason) => {
      deps.callLog.push("stopAuto");
      stopReason = reason ?? "";
      s.active = false;
    },
  });

  try {
    await autoLoop(ctx, pi, s, deps);

    assert.equal(advanceCalls, 4, "all three waits must run before the next pause exhausts retries");
    assert.equal(
      notices.filter((message) => /waiting \d+s before retrying/.test(message)).length,
      3,
      "every class-specific backoff entry must be reachable",
    );
    assert.equal(deps.callLog.includes("stopAuto"), true, "the class budget still stops a never-healing transient");
    assert.match(stopReason, /^Blocked: /);

    // A later manual restart from a legacy adapter without the typed
    // classification still uses the message fallback without creating a wedge.
    s.active = true;
    stopReason = "";
    await autoLoop(ctx, pi, s, deps);
    assert.equal(advanceCalls, 8);
    assert.match(stopReason, /^Blocked: /);
    const wedgeResult = getOpenWedge(realpathSync(s.basePath));
    assert.equal(wedgeResult.ok, true);
    assert.equal(
      wedgeResult.ok ? wedgeResult.wedge : null,
      null,
      "identical transient strings must not trip the strike counter",
    );
  } finally {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(s.basePath, { recursive: true, force: true });
  }
});

test("autoLoop drains sidecar queue after postUnitPostVerification enqueues items", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const s = makeLoopSession();

  let postVerCallCount = 0;
  const postVerActions: Array<() => void> = [
    () => {
      // First call (main unit): enqueue a sidecar item
      s.sidecarQueue.push({
        kind: "hook" as const,
        unitType: "run-uat",
        unitId: "M001/S01/T01/review",
        prompt: "review the code",
      });
    },
    () => {
      // Second call (sidecar unit completed): deactivate
      s.active = false;
    },
  ];
  const deps = makeMockDeps({
    postUnitPostVerification: async () => {
      postVerActions[postVerCallCount]?.();
      postVerCallCount++;
      deps.callLog.push("postUnitPostVerification");
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // Wait for main unit's runUnit to be awaiting
  for (let i = 0; !_hasPendingResolveForTest() && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(_hasPendingResolveForTest(), true, "main unit should be awaiting agent_end");
  resolveAgentEnd(makeEvent()); // resolve main unit

  // Wait for the sidecar unit's runUnit to be awaiting
  for (let i = 0; !_hasPendingResolveForTest() && postVerCallCount < 2 && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(_hasPendingResolveForTest(), true, "sidecar unit should be awaiting agent_end");
  resolveAgentEnd(makeEvent()); // resolve sidecar unit

  await loopPromise;

  // postUnitPostVerification should have been called twice (main + sidecar)
  assert.equal(
    postVerCallCount,
    2,
    "postUnitPostVerification should be called twice (main + sidecar)",
  );
});

test("autoLoop exits when no active milestone found", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const pi = makeMockPi();
  const s = makeLoopSession({ currentMilestoneId: null });

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: null,
        activeSlice: null,
        activeTask: null,
        registry: [],
        blockers: [],
      } as any;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(
    deps.callLog.includes("stopAuto"),
    "should stop when no milestone and all complete",
  );
});

// NOTE: The T03 "wiring structural assertions" block (barrel re-exports,
// LoopDeps-interface-declared, while-loop keyword, UOK kernel wrapper,
// selfHeal ordering, s.active concurrent guard, agent_end handler call
// shape, runPostUnitVerification signature, auto-timeout-recovery call
// shape) was a pure source-grep chain — readFileSync + includes/indexOf —
// so it asserted on code shape rather than runtime behaviour. The symbols
// named in those assertions are ALREADY imported at the top of this file;
// if the production barrel drops any of them, this file fails to import
// and every test here fails cold. That import-time check is the real
// behavioural contract. The ordering/signature contracts (UOK dispatch,
// concurrent guard, agent_end wiring) are tracked as follow-up issues for
// pure-helper extraction per the #4832/PR #4859 precedent.

// ── Stuck counter tests ──────────────────────────────────────────────────────

test("autoLoop lifecycle: advances through research → plan → execute → verify → complete across iterations", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.ui.notify = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const s = makeLoopSession();

  let deriveCallCount = 0;
  let dispatchCallCount = 0;
  const dispatchedUnitTypes: string[] = [];

  // Phase sequence: each deriveState call returns a different phase.
  // The 6th entry (index 5) is the terminal "complete" phase that stops the loop.
  const phases = [
    // Call 1: researching → dispatches research-slice
    {
      phase: "researching",
      activeSlice: { id: "S01", title: "Research Slice" },
      activeTask: null,
    },
    // Call 2: planning → dispatches plan-slice
    {
      phase: "planning",
      activeSlice: { id: "S01", title: "Plan Slice" },
      activeTask: null,
    },
    // Call 3: executing → dispatches execute-task
    {
      phase: "executing",
      activeSlice: { id: "S01", title: "Execute Slice" },
      activeTask: { id: "T01" },
    },
    // Call 4: verifying → dispatches verify-slice
    {
      phase: "verifying",
      activeSlice: { id: "S01", title: "Verify Slice" },
      activeTask: null,
    },
    // Call 5: completing → dispatches complete-slice
    {
      phase: "completing",
      activeSlice: { id: "S01", title: "Complete Slice" },
      activeTask: null,
    },
    // Call 6: terminal — deactivate to exit the loop
    {
      phase: "complete",
      activeSlice: null,
      activeTask: null,
    },
  ];

  const dispatches = [
    { unitType: "research-slice", unitId: "M001/S01", prompt: "research" },
    { unitType: "plan-slice", unitId: "M001/S01", prompt: "plan" },
    { unitType: "execute-task", unitId: "M001/S01/T01", prompt: "execute" },
    { unitType: "run-uat", unitId: "M001/S01", prompt: "verify" },
    { unitType: "complete-slice", unitId: "M001/S01", prompt: "complete" },
  ];

  const deps = makeMockDeps({
    deriveState: async () => {
      const p = phases[Math.min(deriveCallCount, phases.length - 1)];
      deriveCallCount++;
      deps.callLog.push("deriveState");

      const terminalPhases: Record<string, string> = { complete: "complete" };
      s.active = p.phase !== "complete";
      const milestoneStatus = terminalPhases[p.phase] ?? "active";
      return {
        phase: p.phase,
        activeMilestone: { id: "M001", title: "Test", status: milestoneStatus },
        activeSlice: p.activeSlice ?? null,
        activeTask: p.activeTask ?? null,
        registry: [{ id: "M001", status: milestoneStatus }],
        blockers: [],
      } as any;
    },
    resolveDispatch: async () => {
      const d = dispatches[Math.min(dispatchCallCount, dispatches.length - 1)];
      dispatchCallCount++;
      deps.callLog.push("resolveDispatch");
      dispatchedUnitTypes.push(d.unitType);
      return {
        action: "dispatch" as const,
        unitType: d.unitType,
        unitId: d.unitId,
        prompt: d.prompt,
      };
    },
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      return "continue" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // Resolve each iteration's agent_end — 5 iterations, each dispatches a unit
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 30));
    resolveAgentEnd(makeEvent());
  }

  await loopPromise;

  // Assert deriveState was called at least 5 times (once per iteration)
  assert.ok(
    deriveCallCount >= 5,
    `deriveState should be called at least 5 times (got ${deriveCallCount})`,
  );

  // Assert the dispatched unit types cover the full lifecycle sequence
  assert.ok(
    dispatchedUnitTypes.includes("research-slice"),
    `should have dispatched research-slice, got: ${dispatchedUnitTypes.join(", ")}`,
  );
  assert.ok(
    dispatchedUnitTypes.includes("plan-slice"),
    `should have dispatched plan-slice, got: ${dispatchedUnitTypes.join(", ")}`,
  );
  assert.ok(
    dispatchedUnitTypes.includes("execute-task"),
    `should have dispatched execute-task, got: ${dispatchedUnitTypes.join(", ")}`,
  );
  assert.ok(
    dispatchedUnitTypes.includes("run-uat"),
    `should have dispatched run-uat, got: ${dispatchedUnitTypes.join(", ")}`,
  );
  assert.ok(
    dispatchedUnitTypes.includes("complete-slice"),
    `should have dispatched complete-slice, got: ${dispatchedUnitTypes.join(", ")}`,
  );

  // Assert call sequence: deriveState and resolveDispatch entries are interleaved
  const deriveEntries = deps.callLog.filter((c) => c === "deriveState");
  const dispatchEntries = deps.callLog.filter((c) => c === "resolveDispatch");
  assert.ok(
    deriveEntries.length >= 5,
    `callLog should have at least 5 deriveState entries (got ${deriveEntries.length})`,
  );
  assert.ok(
    dispatchEntries.length >= 5,
    `callLog should have at least 5 resolveDispatch entries (got ${dispatchEntries.length})`,
  );

  // Verify interleaving: a deriveState must follow a resolveDispatch (confirms loop advanced)
  const firstDispatchIdx = deps.callLog.indexOf("resolveDispatch");
  const firstDeriveAfterDispatch = deps.callLog.indexOf("deriveState", firstDispatchIdx + 1);
  assert.ok(firstDispatchIdx >= 0, "resolveDispatch should appear in callLog");
  assert.ok(firstDeriveAfterDispatch > firstDispatchIdx, "deriveState should follow resolveDispatch to confirm loop advanced");

  // Assert the exact sequence of dispatched unit types
  assert.deepEqual(
    dispatchedUnitTypes,
    [
      "research-slice",
      "plan-slice",
      "execute-task",
      "run-uat",
      "complete-slice",
    ],
    "dispatched unit types should follow the full lifecycle sequence",
  );
});

// ─── resolveAgentEndCancelled tests ──────────────────────────────────────────

test("resolveAgentEndCancelled resolves a pending promise with cancelled status", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");

  await new Promise((r) => setTimeout(r, 10));

  resolveAgentEndCancelled();

  const result = await resultPromise;
  assert.equal(result.status, "cancelled");
  assert.equal(result.event, undefined);
});

test("resolveAgentEndCancelled is a no-op when no promise is pending", () => {
  _resetPendingResolve();

  assert.doesNotThrow(() => {
    resolveAgentEndCancelled();
  });
});

test("resolveAgentEndCancelled prevents orphaned promise after abort path", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");

  await new Promise((r) => setTimeout(r, 10));

  s.active = false;
  resolveAgentEndCancelled();

  const result = await resultPromise;
  assert.equal(result.status, "cancelled");
});

test("resolveAgentEndCancelled with errorContext passes it through to resolved promise", async () => {
  _resetPendingResolve();

  const { _setCurrentResolve } = await import("../auto/resolve.js");

  const p = new Promise<UnitResult>((r) => {
    _setCurrentResolve(r);
  });

  resolveAgentEndCancelled({ message: "test timeout", category: "timeout", isTransient: true });

  const resolved = await p;
  assert.equal(resolved.status, "cancelled");
  assert.ok(resolved.errorContext, "errorContext must be present");
  assert.equal(resolved.errorContext!.category, "timeout");
  assert.equal(resolved.errorContext!.message, "test timeout");
  assert.equal(resolved.errorContext!.isTransient, true);
});

test("runUnitPhase pauses transient aborted cancellations instead of hard-stopping", async (t) => {
  _resetPendingResolve();

  const basePath = makeLoopTestBase("gsd-aborted-cancel-");
  t.after(() => {
    rmSync(basePath, { recursive: true, force: true });
  });

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = {
    ...makeMockPi(),
    sendMessage: () => {
      queueMicrotask(() => resolveAgentEndCancelled({
        message: "Claude Code process aborted by user",
        category: "aborted",
        isTransient: true,
      }));
    },
  } as any;
  const s = makeLoopSession({
    basePath,
    canonicalProjectRoot: basePath,
    originalBasePath: basePath,
  });
  const deps = makeMockDeps();
  let seq = 0;

  const result = await runUnitPhase(
    { ctx, pi, s, deps, prefs: undefined, iteration: 1, flowId: "flow-aborted", nextSeq: () => ++seq },
    {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do work",
      finalPrompt: "do work",
      pauseAfterUatDispatch: false,
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Milestone" },
        activeSlice: { id: "S01", title: "Slice" },
        activeTask: { id: "T01", title: "Task" },
        registry: [{ id: "M001", title: "Milestone", status: "active" }],
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        progress: { milestones: { done: 0, total: 1 } },
        requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      } as any,
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: undefined,
    },
    { consecutiveFinalizeTimeouts: 0 },
  );

  assert.equal(result.action, "break");
  assert.equal((result as any).reason, "unit-aborted-pause");
  assert.equal(deps.callLog.includes("pauseAuto"), true);
  assert.equal(deps.callLog.includes("stopAuto"), false);
});

test("resetSessionTimeoutState gives a new auto session a fresh session-creation timeout budget", async (t) => {
  _resetPendingResolve();

  // runUnitPhase schedules an auto-resume setTimeout on transient session
  // timeouts. Capture and clear those timers so the test process can exit
  // promptly while still exercising the real production path.
  const originalSetTimeout = globalThis.setTimeout;
  const timerHandles: ReturnType<typeof originalSetTimeout>[] = [];
  globalThis.setTimeout = ((callback: any, delay?: number, ...args: any[]) => {
    const handle = originalSetTimeout(callback, delay ?? 0, ...args);
    timerHandles.push(handle);
    return handle;
  }) as any;

  const basePath = makeLoopTestBase("gsd-session-timeout-reset-");
  execSync("git init", { cwd: basePath });
  execSync('git -c user.email=test@test.com -c user.name=Test commit --allow-empty -m init', { cwd: basePath });

  t.after(() => {
    for (const handle of timerHandles) clearTimeout(handle);
    globalThis.setTimeout = originalSetTimeout;
    rmSync(basePath, { recursive: true, force: true });
  });

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const notifications: Array<{ message: string; level?: string }> = [];
  ctx.ui.notify = (message: string, level?: string) => {
    notifications.push({ message, level });
  };
  const pi = makeMockPi();
  const s = makeLoopSession({
    basePath,
    canonicalProjectRoot: basePath,
    originalBasePath: basePath,
  });
  const deps = makeMockDeps();

  async function runTimeoutUnit(iteration: number): Promise<string | undefined> {
    notifications.length = 0;
    const callsBefore = pi.calls.length;
    let seq = 0;
    const phasePromise = runUnitPhase(
      { ctx, pi, s, deps, prefs: undefined, iteration, flowId: `flow-${iteration}`, nextSeq: () => ++seq },
      {
        unitType: "plan-slice",
        unitId: "M001/S01",
        prompt: "plan the slice",
        finalPrompt: "plan the slice",
        pauseAfterUatDispatch: false,
        state: {
          phase: "planning",
          activeMilestone: { id: "M001", title: "Milestone" },
          activeSlice: { id: "S01", title: "Slice" },
          activeTask: null,
          registry: [{ id: "M001", title: "Milestone", status: "active" }],
          recentDecisions: [],
          blockers: [],
          nextAction: "",
          progress: { milestones: { done: 0, total: 1 } },
          requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
        } as any,
        mid: "M001",
        midTitle: "Milestone",
        isRetry: false,
        previousTier: undefined,
      },
      makeLoopState(),
    );

    // Wait until runUnit has dispatched the prompt, then resolve the unit
    // as a session-creation timeout. This avoids the 120s real timeout and
    // the mock-timer interaction that runUnitPhase's pre-flight setup makes
    // fragile.
    await new Promise<void>((resolve) => {
      const check = () => {
        if (pi.calls.length > callsBefore) return resolve();
        setTimeout(check, 5);
      };
      check();
    });
    resolveAgentEndCancelled({
      message: "Session creation timed out",
      category: "timeout",
      isTransient: true,
    });

    const result = await phasePromise;
    return (result as any).reason;
  }

  // Start from a known state in case a previous test left the counter raised.
  resetSessionTimeoutState();

  // Exhaust the per-process timeout budget in the first "session".
  for (let i = 1; i <= 4; i++) {
    const reason = await runTimeoutUnit(i);
    assert.equal(reason, "session-timeout");
  }
  const lastBudgetNotification = notifications.find((n) =>
    n.message.includes("Session creation timed out")
  );
  assert.ok(lastBudgetNotification, "expected a session-creation timeout notification");
  assert.match(
    lastBudgetNotification.message,
    /Pausing for manual review/,
    "fourth consecutive timeout should exhaust the auto-resume budget",
  );

  // Simulate a new auto-mode session starting. autoLoop() must reset the
  // module-level counter so the next timeout is treated as the first in the
  // new session rather than inheriting the exhausted budget.
  const freshSession = makeLoopSession({
    basePath,
    canonicalProjectRoot: basePath,
    originalBasePath: basePath,
    active: false,
  });
  freshSession.orchestration = createLoopTestOrchestration(ctx, pi, freshSession, deps);
  await rawAutoLoop(ctx, pi, freshSession, deps);

  const reasonAfterReset = await runTimeoutUnit(5);
  assert.equal(reasonAfterReset, "session-timeout");
  const notificationAfterReset = notifications.find((n) =>
    n.message.includes("Auto-resuming")
  );
  assert.ok(notificationAfterReset, "expected an auto-resume notification after reset");
  assert.match(
    notificationAfterReset.message,
    /Auto-resuming/,
    "after autoLoop entry the timeout budget should be fresh so the first timeout auto-resumes",
  );
});

test("runUnitPhase treats setup-race cancellations as pause-induced when session is already paused", async (t) => {
  _resetPendingResolve();

  const basePath = makeLoopTestBase("gsd-paused-setup-race-");
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  openDatabase(join(basePath, ".gsd", "gsd.db"));
  t.after(() => {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  const workerId = registerAutoWorker({ projectRootRealpath: realpathSync(basePath) });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = makeMockPi();
  const s = makeLoopSession({
    basePath,
    canonicalProjectRoot: basePath,
    originalBasePath: basePath,
    paused: false,
    active: true,
    currentMilestoneId: "M001",
    workerId,
    milestoneLeaseToken: lease.token,
    cmdCtx: {
      newSession: () => {
        s.paused = true;
        s.active = false;
        return Promise.resolve({ cancelled: false });
      },
      getContextUsage: () => ({ percent: 10, tokens: 1000, limit: 10000 }),
    },
  });
  const deps = makeMockDeps();
  let seq = 0;

  const result = await runUnitPhase(
    { ctx, pi, s, deps, prefs: undefined, iteration: 1, flowId: "flow-paused-setup", nextSeq: () => ++seq },
    {
      unitType: "plan-milestone",
      unitId: "M001",
      prompt: "do work",
      finalPrompt: "do work",
      pauseAfterUatDispatch: false,
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Milestone" },
        activeSlice: { id: "S01", title: "Slice" },
        activeTask: { id: "T01", title: "Task" },
        registry: [{ id: "M001", title: "Milestone", status: "active" }],
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        progress: { milestones: { done: 0, total: 1 } },
        requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      } as any,
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: undefined,
    },
    // ADR-047 deleted the Rule 1 stuck window (`recentUnits`/`stuckRecoveryAttempts`).
    { consecutiveFinalizeTimeouts: 0 },
  );

  assert.equal(result.action, "break");
  assert.equal((result as any).reason, "pause-during-setup");
  assert.equal(deps.callLog.includes("stopAuto"), false);
  assert.equal(s.workerId, null, "setup cancellation must detach the abandoned worker from the session");
  assert.equal(s.milestoneLeaseToken, null, "setup cancellation must clear the abandoned lease token");
  assert.equal(getAutoWorker(workerId)?.status, "stopping");
  assert.equal(getMilestoneLease("M001")?.status, "released");
});

test("runUnitPhase remembers aborted milestone closeout for same-unit resume", async (t) => {
  _resetPendingResolve();

  const basePath = makeLoopTestBase("gsd-aborted-closeout-");
  t.after(() => {
    rmSync(basePath, { recursive: true, force: true });
  });

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = {
    ...makeMockPi(),
    sendMessage: () => {
      queueMicrotask(() => resolveAgentEndCancelled({
        message: "Operation aborted",
        category: "aborted",
        isTransient: true,
      }));
    },
  } as any;
  const s = makeLoopSession({
    basePath,
    canonicalProjectRoot: basePath,
    originalBasePath: basePath,
    currentMilestoneId: "M004",
  });
  const deps = makeMockDeps();
  let seq = 0;

  const result = await runUnitPhase(
    { ctx, pi, s, deps, prefs: undefined, iteration: 1, flowId: "flow-aborted-closeout", nextSeq: () => ++seq },
    {
      unitType: "complete-milestone",
      unitId: "M004",
      prompt: "complete milestone prompt",
      finalPrompt: "complete milestone prompt",
      pauseAfterUatDispatch: false,
      state: {
        phase: "completing-milestone",
        activeMilestone: { id: "M004", title: "Milestone 4" },
        activeSlice: null,
        activeTask: null,
        registry: [{ id: "M004", title: "Milestone 4", status: "active" }],
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        progress: { milestones: { done: 0, total: 1 } },
      } as any,
      mid: "M004",
      midTitle: "Milestone 4",
      isRetry: false,
      previousTier: undefined,
    },
    { consecutiveFinalizeTimeouts: 0 },
  );

  const runtime = readUnitRuntimeRecord(basePath, "complete-milestone", "M004");

  assert.equal(result.action, "break");
  assert.equal((result as any).reason, "unit-aborted-pause");
  assert.equal(s.pendingVerificationRetryDispatch?.unitType, "complete-milestone");
  assert.equal(s.pendingVerificationRetryDispatch?.unitId, "M004");
  assert.equal(s.pendingVerificationRetryDispatch?.prompt, "complete milestone prompt");
  assert.equal(runtime?.phase, "paused");
  assert.equal(runtime?.lastProgressKind, "unit-aborted-pause");
});

test("runUnitPhase routes transient usage-limit cancellations through credential cooldown", async (t) => {
  _resetPendingResolve();

  const basePath = makeLoopTestBase("gsd-provider-resume-");
  t.after(() => {
    _resetPendingResolve();
    rmSync(basePath, { recursive: true, force: true });
  });

  const originalSetTimeout = globalThis.setTimeout;
  const timers: Array<{ fn: () => void; delay: number }> = [];
  globalThis.setTimeout = ((fn: () => void, delay?: number) => {
    timers.push({ fn, delay: delay ?? 0 });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    const notifications: Array<{ message: string; level?: string }> = [];
    const ctx = {
      ...makeMockCtx(),
      ui: {
        notify: (message: string, level?: string) => {
          notifications.push({ message, level });
        },
        setStatus: () => {},
        setWorkingMessage: () => {},
      },
      sessionManager: {
        getEntries: () => [],
      },
      modelRegistry: {
        getProviderAuthMode: () => undefined,
        isProviderRequestReady: () => true,
      },
    } as any;
    const pi = {
      ...makeMockPi(),
      sendMessage: () => {
        queueMicrotask(() => resolveAgentEndCancelled({
          message: "Provider error: Codex usage_limit_reached: The usage limit has been reached",
          category: "provider",
          isTransient: true,
          retryAfterMs: 30_000,
        }));
      },
    } as any;
    const s = makeLoopSession({
      basePath,
      canonicalProjectRoot: basePath,
      originalBasePath: basePath,
    });
    const deps = makeMockDeps();
    let seq = 0;

    const result = await runUnitPhase(
      { ctx, pi, s, deps, prefs: undefined, iteration: 1, flowId: "flow-provider-resume", nextSeq: () => ++seq },
      {
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "do work",
        finalPrompt: "do work",
        pauseAfterUatDispatch: false,
        state: {
          phase: "executing",
          activeMilestone: { id: "M001", title: "Milestone" },
          activeSlice: { id: "S01", title: "Slice" },
          activeTask: { id: "T01", title: "Task" },
          registry: [{ id: "M001", title: "Milestone", status: "active" }],
          recentDecisions: [],
          blockers: [],
          nextAction: "",
          progress: { milestones: { done: 0, total: 1 } },
          requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
        } as any,
        mid: "M001",
        midTitle: "Milestone",
        isRetry: false,
        previousTier: undefined,
      },
      { consecutiveFinalizeTimeouts: 0 },
    );

    assert.deepEqual(result, {
      action: "retry",
      reason: "credential-cooldown",
      data: { retryAfterMs: 30_000 },
    });
    assert.equal(deps.callLog.includes("pauseAuto"), false);
    assert.equal(timers.some((timer) => timer.delay === 30_000), false, "the auto loop owns the bounded cooldown wait");
    assert.equal(notifications.some((n) => /pausing|provider error/i.test(n.message)), false, "no provider pause is announced for a bounded cooldown");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("runUnitPhase pauses ghost completions before closeout and finalize side effects", async (t) => {
  _resetPendingResolve();

  const basePath = makeLoopTestBase("gsd-ghost-completion-");
  t.after(() => {
    _resetPendingResolve();
    rmSync(basePath, { recursive: true, force: true });
  });

  let closeoutCalls = 0;
  let preVerificationCalls = 0;
  let postVerificationCalls = 0;
  const journalEvents: any[] = [];
  const deps = makeMockDeps({
    closeoutUnit: async () => {
      closeoutCalls++;
    },
    postUnitPreVerification: async () => {
      preVerificationCalls++;
      return "continue";
    },
    postUnitPostVerification: async () => {
      postVerificationCalls++;
      return "continue";
    },
    emitJournalEvent: (event: any) => {
      journalEvents.push(event);
    },
  });
  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = {
    ...makeMockPi(),
    sendMessage: () => {
      queueMicrotask(() => resolveAgentEnd({ messages: [] }));
    },
  } as any;
  const s = makeLoopSession({
    basePath,
    canonicalProjectRoot: basePath,
    originalBasePath: basePath,
  });
  let seq = 0;

  const result = await runUnitPhase(
    { ctx, pi, s, deps, prefs: undefined, iteration: 1, flowId: "flow-ghost", nextSeq: () => ++seq },
    {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do work",
      finalPrompt: "do work",
      pauseAfterUatDispatch: false,
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Milestone" },
        activeSlice: { id: "S01", title: "Slice" },
        activeTask: { id: "T01", title: "Task" },
        registry: [{ id: "M001", title: "Milestone", status: "active" }],
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        progress: { milestones: { done: 0, total: 1 } },
        requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      } as any,
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: undefined,
    },
    { consecutiveFinalizeTimeouts: 0 },
  );

  assert.equal(result.action, "break");
  assert.equal((result as any).reason, "ghost-completion");
  assert.equal(deps.callLog.includes("pauseAuto"), true);
  assert.equal(closeoutCalls, 0);
  assert.equal(preVerificationCalls, 0);
  assert.equal(postVerificationCalls, 0);
  assert.equal(s.currentUnit, null);
  assert.ok(
    journalEvents.some((event) =>
      event.eventType === "unit-end" &&
      event.data?.status === "cancelled" &&
      event.data?.errorContext?.message.includes("stale ghost completion")
    ),
    "ghost completion should emit a cancelled unit-end",
  );
});

test("runUnitPhase records failed routing outcome when expected artifact is missing", async (t) => {
  _resetPendingResolve();

  const basePath = makeLoopTestBase("gsd-routing-artifact-missing-");
  t.after(() => {
    _resetPendingResolve();
    rmSync(basePath, { recursive: true, force: true });
  });

  const recordedOutcomes: Array<{ unitType: string; tier: string; success: boolean }> = [];
  const deps = makeMockDeps({
    selectAndApplyModel: async () => ({
      routing: { tier: "light" } as any,
      appliedModel: null,
    }),
    recordOutcome: (unitType: string, tier: string, success: boolean) => {
      recordedOutcomes.push({ unitType, tier, success });
    },
  });
  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = {
    ...makeMockPi(),
    sendMessage: () => {
      queueMicrotask(() => resolveAgentEnd({ messages: [{ role: "assistant" }] }));
    },
  } as any;
  const s = makeLoopSession({
    basePath,
    canonicalProjectRoot: basePath,
    originalBasePath: basePath,
  });
  let seq = 0;

  const result = await runUnitPhase(
    { ctx, pi, s, deps, prefs: undefined, iteration: 1, flowId: "flow-routing-outcome", nextSeq: () => ++seq },
    {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do work",
      finalPrompt: "do work",
      pauseAfterUatDispatch: false,
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Milestone" },
        activeSlice: { id: "S01", title: "Slice" },
        activeTask: { id: "T01", title: "Task" },
        registry: [{ id: "M001", title: "Milestone", status: "active" }],
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        progress: { milestones: { done: 0, total: 1 } },
        requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      } as any,
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: undefined,
    },
    { consecutiveFinalizeTimeouts: 0 },
  );

  assert.equal(result.action, "next");
  assert.deepEqual(
    recordedOutcomes,
    [{ unitType: "execute-task", tier: "light", success: false }],
    "routing history must treat missing artifacts as failed outcomes so retries can escalate",
  );
});

test("runUnitPhase execute-task retry prompt instructs gsd_task_complete instead of manual summary writes", async (t) => {
  _resetPendingResolve();

  const basePath = makeLoopTestBase("gsd-execute-task-retry-prompt-");
  t.after(() => {
    _resetPendingResolve();
    rmSync(basePath, { recursive: true, force: true });
  });

  const deps = makeMockDeps({
    getDeepDiagnostic: () => "diagnostic: missing artifact",
    selectAndApplyModel: async () => ({ routing: null, appliedModel: null }),
  });
  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = {
    ...makeMockPi(),
    sendMessage: (...args: unknown[]) => {
      pi.calls.push(args);
      queueMicrotask(() => resolveAgentEnd({ messages: [{ role: "assistant" }] }));
    },
  } as any;
  const s = makeLoopSession({
    basePath,
    canonicalProjectRoot: basePath,
    originalBasePath: basePath,
    unitDispatchCount: new Map([["execute-task/M001/S01/T01", 1]]),
  });
  let seq = 0;

  await runUnitPhase(
    { ctx, pi, s, deps, prefs: undefined, iteration: 1, flowId: "flow-execute-task-retry-prompt", nextSeq: () => ++seq },
    {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do work",
      finalPrompt: "do work",
      pauseAfterUatDispatch: false,
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Milestone" },
        activeSlice: { id: "S01", title: "Slice" },
        activeTask: { id: "T01", title: "Task" },
        registry: [{ id: "M001", title: "Milestone", status: "active" }],
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        progress: { milestones: { done: 0, total: 1 } },
        requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      } as any,
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: undefined,
    },
    { consecutiveFinalizeTimeouts: 0 },
  );

  const dispatchedPrompt = pi.calls[0]?.[0]?.content;
  assert.equal(typeof dispatchedPrompt, "string");
  assert.match(dispatchedPrompt, /Call `gsd_task_complete`/);
  assert.match(dispatchedPrompt, /Do NOT manually write this file/);
  assert.match(dispatchedPrompt, /milestoneId/i);
  assert.match(dispatchedPrompt, /sliceId/i);
  assert.match(dispatchedPrompt, /taskId/i);
  assert.doesNotMatch(dispatchedPrompt, /Fix whatever went wrong and make sure you write the required file this time/);
});

test("runUnitPhase non-execute-task retry prompt keeps generic required-file guidance", async (t) => {
  _resetPendingResolve();

  const basePath = makeLoopTestBase("gsd-non-execute-retry-prompt-");
  t.after(() => {
    _resetPendingResolve();
    rmSync(basePath, { recursive: true, force: true });
  });

  const deps = makeMockDeps({
    getDeepDiagnostic: () => "diagnostic: missing artifact",
    selectAndApplyModel: async () => ({ routing: null, appliedModel: null }),
    resolveDispatch: async () => ({
      action: "dispatch" as const,
      unitType: "plan-slice",
      unitId: "M001/S01",
      prompt: "plan work",
    }),
  });
  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = {
    ...makeMockPi(),
    sendMessage: (...args: unknown[]) => {
      pi.calls.push(args);
      queueMicrotask(() => resolveAgentEnd({ messages: [{ role: "assistant" }] }));
    },
  } as any;
  const s = makeLoopSession({
    basePath,
    canonicalProjectRoot: basePath,
    originalBasePath: basePath,
    unitDispatchCount: new Map([["plan-slice/M001/S01", 1]]),
  });
  let seq = 0;

  await runUnitPhase(
    { ctx, pi, s, deps, prefs: undefined, iteration: 1, flowId: "flow-non-execute-retry-prompt", nextSeq: () => ++seq },
    {
      unitType: "plan-slice",
      unitId: "M001/S01",
      prompt: "plan work",
      finalPrompt: "plan work",
      pauseAfterUatDispatch: false,
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Milestone" },
        activeSlice: { id: "S01", title: "Slice" },
        activeTask: { id: "T01", title: "Task" },
        registry: [{ id: "M001", title: "Milestone", status: "active" }],
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        progress: { milestones: { done: 0, total: 1 } },
        requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      } as any,
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: undefined,
    },
    { consecutiveFinalizeTimeouts: 0 },
  );

  const dispatchedPrompt = pi.calls[0]?.[0]?.content;
  assert.equal(typeof dispatchedPrompt, "string");
  assert.match(dispatchedPrompt, /Fix whatever went wrong and make sure you write the required file this time/);
  assert.doesNotMatch(dispatchedPrompt, /Call `gsd_task_complete`/);
  assert.doesNotMatch(dispatchedPrompt, /Do NOT manually write this file/);
});

test("resolveAgentEndCancelled without args produces no errorContext field", async () => {
  _resetPendingResolve();

  const { _setCurrentResolve } = await import("../auto/resolve.js");

  const p = new Promise<UnitResult>((r) => {
    _setCurrentResolve(r);
  });

  resolveAgentEndCancelled();

  const resolved = await p;
  assert.equal(resolved.status, "cancelled");
  assert.equal(resolved.errorContext, undefined, "errorContext must not be present when no args passed");
});

test("resolveAgentEndCancelled queues cancellation that arrives during session switch", () => {
  _resetPendingResolve();

  _setSessionSwitchInFlight(true);
  const resolved = resolveAgentEndCancelled({
    message: "Claude Code process aborted by user",
    category: "aborted",
    isTransient: false,
  });

  assert.equal(resolved, false);
  const pending = _consumePendingSwitchCancellation();
  assert.ok(pending?.errorContext, "queued cancellation should preserve errorContext");
  assert.equal(pending.errorContext.category, "aborted");
  assert.equal(pending.errorContext.message, "Claude Code process aborted by user");
  assert.equal(_consumePendingSwitchCancellation(), null);
  _resetPendingResolve();
});

test("session-switch abort grace window is short-lived and resettable", () => {
  _resetPendingResolve();

  _markSessionSwitchAbortGraceWindow(1_000);

  assert.equal(isSessionSwitchAbortGraceActive(Date.now()), true);
  assert.equal(isSessionSwitchAbortGraceActive(Date.now() + 10_000), false);

  _clearSessionSwitchAbortGraceWindow();
  assert.equal(isSessionSwitchAbortGraceActive(), false);
});

// ─── #1571: artifact verification retry ──────────────────────────────────────

test("autoLoop re-iterates when postUnitPreVerification returns retry (#1571)", async () => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 30_000 });

  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {};
    const pi = makeMockPi();
    const s = makeLoopSession();

    let preVerifyCallCount = 0;
    const currentUnitSnapshotsAtPreVerify: Array<{ type: string; id: string; startedAt: number } | null> = [];
    // Pre-queued responses: first call returns "retry", second returns "continue"
    const preVerifyResponses = ["retry", "continue"] as const;

    const deps = makeMockDeps({
      deriveState: async () => {
        deps.callLog.push("deriveState");
        return {
          phase: "executing",
          activeMilestone: { id: "M001", title: "Test", status: "active" },
          activeSlice: { id: "S01", title: "Slice 1" },
          activeTask: { id: "T01" },
          registry: [{ id: "M001", status: "active" }],
          blockers: [],
        } as any;
      },
      postUnitPreVerification: async () => {
        deps.callLog.push("postUnitPreVerification");
        currentUnitSnapshotsAtPreVerify.push(s.currentUnit);
        const response = preVerifyResponses[preVerifyCallCount++] ?? "continue";
        if (response === "retry") {
          s.pendingVerificationRetry = {
            unitId: "M001/S01/T01",
            failureContext: "missing artifact",
            attempt: 1,
          };
        }
        return response;
      },
      postUnitPostVerification: async () => {
        deps.callLog.push("postUnitPostVerification");
        s.active = false;
        return "continue" as const;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);

    await waitForMicrotasks(() => pi.calls.length === 1, "first dispatch");
    resolveAgentEnd(makeEvent());

    await drainMicrotasks(100);
    mock.timers.tick(30_000);
    await waitForMicrotasks(() => pi.calls.length === 2, "retry dispatch");
    resolveAgentEnd(makeEvent());

    await loopPromise;

    assert.equal(preVerifyCallCount, 2, "preVerification should be called twice");
    assert.deepEqual(
      currentUnitSnapshotsAtPreVerify.map((unit) => unit ? `${unit.type}:${unit.id}` : null),
      ["execute-task:M001/S01/T01", "execute-task:M001/S01/T01"],
      "preVerification needs currentUnit so closeout can commit and sync the unit that just finished",
    );
    assert.ok(
      (currentUnitSnapshotsAtPreVerify[1]?.startedAt ?? 0) > (currentUnitSnapshotsAtPreVerify[0]?.startedAt ?? 0),
      "retry dispatch should get a fresh currentUnit timestamp, not reuse stale retry scope",
    );

    const postVerifyCalls = deps.callLog.filter(
      (c: string) => c === "runPostUnitVerification",
    );
    const postPostVerifyCalls = deps.callLog.filter(
      (c: string) => c === "postUnitPostVerification",
    );

    assert.equal(postVerifyCalls.length, 1, "runPostUnitVerification should only be called once");
    assert.equal(postPostVerifyCalls.length, 1, "postUnitPostVerification should only be called once");
  } finally {
    mock.timers.reset();
  }
});

// ─── stopAuto unitPromise leak regression (#1799) ────────────────────────────

test("resolveAgentEnd unblocks pending runUnit when called before session reset (#1799)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();

  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "do work");

  await new Promise((r) => setTimeout(r, 10));

  resolveAgentEnd({ messages: [] });
  _resetPendingResolve();
  s.active = false;

  const result = await resultPromise;
  assert.equal(result.status, "completed", "runUnit should resolve, not hang");
});

// ─── Zero tool-call hallucination guard (#1833) ───────────────────────────

test("autoLoop rejects execute-task with 0 tool calls as hallucinated (#1833)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();

  let closeoutCount = 0;
  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  const s = makeLoopSession();

  // Mock ledger: execute-task completed with 0 tool calls
  const mockLedger = {
    version: 1,
    projectStartedAt: Date.now(),
    units: [] as any[],
  };

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any;
    },
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch" as const,
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "implement the feature",
      };
    },
    closeoutUnit: async () => {
      closeoutCount++;
      // Simulate snapshotUnitMetrics adding a 0-toolCalls entry to ledger
      mockLedger.units.push({
        type: "execute-task",
        id: "M001/S01/T01",
        startedAt: s.currentUnit?.startedAt ?? Date.now(),
        toolCalls: 0,
        assistantMessages: 1,
        tokens: { input: 100, output: 200, total: 300, cacheRead: 0, cacheWrite: 0 },
        cost: 0.50,
      });
      if (closeoutCount >= 2) s.active = false;
    },
    getLedger: () => mockLedger,
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // First iteration: execute-task with 0 tool calls → rejected
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());

  // Second iteration: same task re-dispatched, this time with tool calls
  await new Promise((r) => setTimeout(r, 50));
  mockLedger.units.length = 0; // clear previous entry
  (deps as any).closeoutUnit = async () => {
    closeoutCount++;
    mockLedger.units.push({
      type: "execute-task",
      id: "M001/S01/T01",
      startedAt: s.currentUnit?.startedAt ?? Date.now(),
      toolCalls: 5,
      assistantMessages: 3,
      tokens: { input: 500, output: 800, total: 1300, cacheRead: 0, cacheWrite: 0 },
      cost: 1.00,
    });
    if (closeoutCount >= 2) s.active = false;
  };
  resolveAgentEnd(makeEvent());

  await loopPromise;

  // The task should NOT have been added to completedUnits on the first iteration
  // (0 tool calls), but SHOULD be added on the second iteration (5 tool calls)
  const warningNotification = notifications.find(
    (n) => n.includes("0 tool calls") && n.includes("context exhaustion"),
  );
  assert.ok(
    warningNotification,
    "should notify about 0 tool calls context exhaustion",
  );

  // Verify deriveState was called at least twice (two iterations)
  const deriveCount = deps.callLog.filter((c) => c === "deriveState").length;
  assert.ok(
    deriveCount >= 2,
    `deriveState should be called at least 2 times for retry (got ${deriveCount})`,
  );
  assert.equal(
    deps.callLog.filter((c) => c === "postUnitPreVerification").length,
    1,
    "zero-tool retry should bypass finalize on the failed iteration",
  );
});

test("runUnitPhase retries 0-tool units with ordinary network-related assistant text", async (t) => {
  _resetPendingResolve();

  const basePath = makeLoopTestBase("gsd-zero-tool-network-text-");
  t.after(() => {
    rmSync(basePath, { recursive: true, force: true });
  });

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = {
    ...makeMockPi(),
    sendMessage: () => {
      queueMicrotask(() => resolveAgentEnd(makeEvent([
        {
          role: "assistant",
          content: [
            { type: "text", text: "Error: I'll investigate the network error handling next." },
          ],
        },
      ])));
    },
  } as any;
  const s = makeLoopSession({
    basePath,
    canonicalProjectRoot: basePath,
    originalBasePath: basePath,
  });
  const mockLedger = {
    version: 1,
    projectStartedAt: Date.now(),
    units: [] as any[],
  };
  const deps = makeMockDeps({
    closeoutUnit: async () => {
      mockLedger.units.push({
        type: "execute-task",
        id: "M001/S01/T01",
        startedAt: s.currentUnit?.startedAt ?? Date.now(),
        toolCalls: 0,
        assistantMessages: 1,
        tokens: { input: 100, output: 20, total: 120, cacheRead: 0, cacheWrite: 0 },
        cost: 0.01,
      });
    },
    getLedger: () => mockLedger,
  });
  let seq = 0;

  const result = await runUnitPhase(
    { ctx, pi, s, deps, prefs: undefined, iteration: 1, flowId: "flow-zero-tool-network-text", nextSeq: () => ++seq },
    {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do work",
      finalPrompt: "do work",
      pauseAfterUatDispatch: false,
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Milestone" },
        activeSlice: { id: "S01", title: "Slice" },
        activeTask: { id: "T01", title: "Task" },
        registry: [{ id: "M001", title: "Milestone", status: "active" }],
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        progress: { milestones: { done: 0, total: 1 } },
        requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      } as any,
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: undefined,
    },
    { consecutiveFinalizeTimeouts: 0 },
  );

  assert.equal(result.action, "retry");
  assert.equal((result as any).reason, "zero-tool-calls");
  assert.equal(deps.callLog.includes("pauseAuto"), false);
});

test("runUnitPhase pauses 0-tool units with pseudo tool-call text as serialization drift", async (t) => {
  _resetPendingResolve();

  const basePath = makeLoopTestBase("gsd-zero-tool-pseudo-tool-");
  t.after(() => {
    rmSync(basePath, { recursive: true, force: true });
  });

  const notifications: string[] = [];
  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: (msg: string) => { notifications.push(msg); },
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = {
    ...makeMockPi(),
    sendMessage: () => {
      queueMicrotask(() => resolveAgentEnd(makeEvent([
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: 'bash<arg_key>command</arg_key><arg_value>ls -la /tmp && echo "---SRC---"</arg_value></tool_call>',
            },
          ],
        },
      ])));
    },
  } as any;
  const s = makeLoopSession({
    basePath,
    canonicalProjectRoot: basePath,
    originalBasePath: basePath,
  });
  const mockLedger = {
    version: 1,
    projectStartedAt: Date.now(),
    units: [] as any[],
  };
  const deps = makeMockDeps({
    closeoutUnit: async () => {
      mockLedger.units.push({
        type: "execute-task",
        id: "M001/S01/T01",
        startedAt: s.currentUnit?.startedAt ?? Date.now(),
        toolCalls: 0,
        assistantMessages: 1,
        tokens: { input: 100, output: 20, total: 120, cacheRead: 0, cacheWrite: 0 },
        cost: 0.01,
      });
    },
    getLedger: () => mockLedger,
  });
  let seq = 0;

  const result = await runUnitPhase(
    { ctx, pi, s, deps, prefs: undefined, iteration: 1, flowId: "flow-zero-tool-pseudo-tool", nextSeq: () => ++seq },
    {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do work",
      finalPrompt: "do work",
      pauseAfterUatDispatch: false,
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Milestone" },
        activeSlice: { id: "S01", title: "Slice" },
        activeTask: { id: "T01", title: "Task" },
        registry: [{ id: "M001", title: "Milestone", status: "active" }],
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        progress: { milestones: { done: 0, total: 1 } },
        requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      } as any,
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: undefined,
    },
    { consecutiveFinalizeTimeouts: 0 },
  );

  assert.equal(result.action, "break");
  assert.equal((result as any).reason, "zero-tool-serialization-drift");
  assert.equal(deps.callLog.includes("pauseAuto"), true);
  assert.equal(s.zeroToolRetryCount.has("execute-task/M001/S01/T01"), false);
  assert.ok(
    notifications.some((msg) => msg.includes("serialization drift") && msg.includes("bash<arg_key>command")),
    "serialization drift notification should include a snippet of the pseudo tool-call text",
  );
  assert.ok(
    !notifications.some((msg) => msg.includes("context exhaustion")),
    "pseudo tool-call text should not be labeled as context exhaustion",
  );
});

test("runUnitPhase pauses auto-mode when zero-tool-call retry is exhausted", async (t) => {
  _resetPendingResolve();

  const basePath = makeLoopTestBase("gsd-zero-tool-exhausted-");
  t.after(() => {
    rmSync(basePath, { recursive: true, force: true });
  });

  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    },
  } as any;
  const pi = {
    ...makeMockPi(),
    sendMessage: () => {
      queueMicrotask(() => resolveAgentEnd(makeEvent([
        {
          role: "assistant",
          content: [
            { type: "text", text: "Error: I'll investigate the network error handling next." },
          ],
        },
      ])));
    },
  } as any;
  const s = makeLoopSession({
    basePath,
    canonicalProjectRoot: basePath,
    originalBasePath: basePath,
  });
  // Pre-seed counter at MAX_ZERO_TOOL_RETRIES so the next zero-tool turn exhausts the cap
  s.zeroToolRetryCount.set("execute-task/M001/S01/T01", 1);

  const mockLedger = {
    version: 1,
    projectStartedAt: Date.now(),
    units: [] as any[],
  };
  const deps = makeMockDeps({
    closeoutUnit: async () => {
      mockLedger.units.push({
        type: "execute-task",
        id: "M001/S01/T01",
        startedAt: s.currentUnit?.startedAt ?? Date.now(),
        toolCalls: 0,
        assistantMessages: 1,
        tokens: { input: 100, output: 20, total: 120, cacheRead: 0, cacheWrite: 0 },
        cost: 0.01,
      });
    },
    getLedger: () => mockLedger,
  });
  let seq = 0;

  const result = await runUnitPhase(
    { ctx, pi, s, deps, prefs: undefined, iteration: 1, flowId: "flow-zero-tool-exhausted", nextSeq: () => ++seq },
    {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do work",
      finalPrompt: "do work",
      pauseAfterUatDispatch: false,
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Milestone" },
        activeSlice: { id: "S01", title: "Slice" },
        activeTask: { id: "T01", title: "Task" },
        registry: [{ id: "M001", title: "Milestone", status: "active" }],
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        progress: { milestones: { done: 0, total: 1 } },
        requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      } as any,
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: undefined,
    },
    { consecutiveFinalizeTimeouts: 0 },
  );

  assert.equal(result.action, "break");
  assert.equal((result as any).reason, "zero-tool-calls-exhausted");
  assert.equal(deps.callLog.includes("pauseAuto"), true);
});

test("autoLoop pauses user-driven deep question instead of flagging 0 tool calls", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();

  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  const s = makeLoopSession();
  const mockLedger = {
    version: 1,
    projectStartedAt: Date.now(),
    units: [] as any[],
  };

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Bootstrap", status: "active" },
        activeSlice: null,
        activeTask: null,
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any;
    },
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch" as const,
        unitType: "discuss-project",
        unitId: "PROJECT",
        prompt: "ask what to build",
      };
    },
    closeoutUnit: async () => {
      mockLedger.units.push({
        type: "discuss-project",
        id: "PROJECT",
        startedAt: s.currentUnit?.startedAt ?? Date.now(),
        toolCalls: 0,
        assistantMessages: 1,
        tokens: { input: 100, output: 20, total: 120, cacheRead: 0, cacheWrite: 0 },
        cost: 0.01,
      });
    },
    getLedger: () => mockLedger,
    postUnitPreVerification: async () => {
      deps.callLog.push("postUnitPreVerification");
      return "dispatched" as const;
    },
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent([
    {
      role: "assistant",
      content: [
        { type: "text", text: "What do you want to build?" },
      ],
    },
  ]));

  await loopPromise;

  assert.ok(
    deps.callLog.includes("postUnitPreVerification"),
    "questioning units should reach post-unit verification so the pause path can run",
  );
  assert.ok(
    !notifications.some((n) => n.includes("context exhaustion")),
    "questioning units should not show the context-exhaustion warning",
  );
});

test("autoLoop rejects complete-slice with 0 tool calls as context-exhausted (#2653)", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();

  let closeoutCount = 0;
  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  const s = makeLoopSession();

  const mockLedger = {
    version: 1,
    projectStartedAt: Date.now(),
    units: [] as any[],
  };

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any;
    },
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch" as const,
        unitType: "complete-slice",
        unitId: "M001/S01",
        prompt: "complete the slice",
      };
    },
    closeoutUnit: async () => {
      closeoutCount++;
      // complete-slice with 0 tool calls — context exhausted, no progress
      mockLedger.units.push({
        type: "complete-slice",
        id: "M001/S01",
        startedAt: s.currentUnit?.startedAt ?? Date.now(),
        toolCalls: 0,
        assistantMessages: 1,
        tokens: { input: 50, output: 100, total: 150, cacheRead: 0, cacheWrite: 0 },
        cost: 0.10,
      });
      if (closeoutCount >= 2) s.active = false;
    },
    getLedger: () => mockLedger,
  });

  const loopPromise = autoLoop(ctx, pi, s, deps);

  // First iteration: complete-slice with 0 tool calls → rejected
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());

  // Second iteration: re-dispatched, this time with tool calls
  await new Promise((r) => setTimeout(r, 50));
  mockLedger.units.length = 0;
  (deps as any).closeoutUnit = async () => {
    closeoutCount++;
    mockLedger.units.push({
      type: "complete-slice",
      id: "M001/S01",
      startedAt: s.currentUnit?.startedAt ?? Date.now(),
      toolCalls: 3,
      assistantMessages: 2,
      tokens: { input: 200, output: 400, total: 600, cacheRead: 0, cacheWrite: 0 },
      cost: 0.30,
    });
    if (closeoutCount >= 2) s.active = false;
  };
  resolveAgentEnd(makeEvent());

  await loopPromise;

  // Should have a warning about 0 tool calls for complete-slice
  const warningNotification = notifications.find(
    (n) => n.includes("0 tool calls"),
  );
  assert.ok(
    warningNotification,
    "should flag complete-slice with 0 tool calls as failed (#2653)",
  );

  // Verify deriveState was called at least twice (two iterations: rejected + retry)
  const deriveCount = deps.callLog.filter((c) => c === "deriveState").length;
  assert.ok(
    deriveCount >= 2,
    `deriveState should be called at least 2 times for retry (got ${deriveCount})`,
  );
  assert.equal(
    deps.callLog.filter((c) => c === "postUnitPreVerification").length,
    1,
    "zero-tool retry should bypass finalize on the failed iteration",
  );
});

test("autoLoop pauses on zero-tool-call rate-limit assistant messages instead of immediate retry", async (t) => {
  _resetPendingResolve();

  const basePath = makeLoopTestBase("gsd-zero-tool-rate-limit-");
  t.after(() => {
    _resetPendingResolve();
    rmSync(basePath, { recursive: true, force: true });
  });

  const originalSetTimeout = globalThis.setTimeout;
  const timers: Array<{ fn: () => void; delay: number }> = [];
  globalThis.setTimeout = ((fn: () => void, delay?: number) => {
    timers.push({ fn, delay: delay ?? 0 });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {};
    const notifications: string[] = [];
    ctx.ui.notify = (msg: string) => { notifications.push(msg); };
    ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
    ctx.modelRegistry = {
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => true,
    };
    const pi = makeMockPi();
    const s = makeLoopSession({
      basePath,
      canonicalProjectRoot: basePath,
      originalBasePath: basePath,
    });

    const mockLedger = {
      version: 1,
      projectStartedAt: Date.now(),
      units: [] as any[],
    };

    const deps = makeMockDeps({
      closeoutUnit: async () => {
        mockLedger.units.push({
          type: "execute-task",
          id: "M001/S01/T01",
          startedAt: s.currentUnit?.startedAt ?? Date.now(),
          toolCalls: 0,
          assistantMessages: 1,
          tokens: { input: 100, output: 100, total: 200, cacheRead: 0, cacheWrite: 0 },
          cost: 0.05,
        });
      },
      getLedger: () => mockLedger,
    });

    const loopPromise = autoLoop(ctx as any, pi as any, s, deps);

    await new Promise((r) => originalSetTimeout(r, 50));
    resolveAgentEnd(makeEvent([
      {
        role: "assistant",
        content: [{ type: "text", text: "You've hit your limit · resets Jun 1 at 8am" }],
      },
    ]));

    await loopPromise;

    assert.equal(deps.callLog.includes("pauseAuto"), true);
    assert.ok(
      timers.some((timer) => timer.delay === 60_000),
      "rate-limit message should schedule delayed auto-resume instead of immediate retry",
    );
    assert.ok(
      notifications.some((msg) => msg.includes("Auto-resuming in 60s")),
      "rate-limit pause should announce delayed resume",
    );
    assert.ok(
      !notifications.some((msg) => msg.includes("context exhaustion")),
      "rate-limit message should not be classified as context exhaustion",
    );
    const deriveCount = deps.callLog.filter((entry) => entry === "deriveState").length;
    assert.equal(deriveCount, 1, "loop should pause after first iteration instead of redispatching");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

// ─── Worktree health check (#1833) ────────────────────────────────────────

test("autoLoop stops when Worktree Safety finds no .git marker for execute-task (#1833)", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();

  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-safety-loop-"));
  const worktreeRoot = join(projectRoot, ".gsd", "worktrees", "M001");
  mkdirSync(worktreeRoot, { recursive: true });
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const s = makeLoopSession({
    basePath: worktreeRoot,
    originalBasePath: projectRoot,
    canonicalProjectRoot: projectRoot,
  });

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any;
    },
    getIsolationMode: () => "worktree",
  });

  await autoLoop(ctx, pi, s, deps);

  assert.ok(
    deps.callLog.includes("stopAuto"),
    "should stop auto-mode when worktree is invalid",
  );
  const healthNotification = notifications.find(
    (n) => n.includes("Worktree Safety failed") && n.includes("worktree-git-marker-missing"),
  );
  assert.ok(
    healthNotification,
    "should notify about missing worktree .git marker",
  );
});

test("dispatch Worktree Safety wins before stuck detection for execute-task without .git", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-safety-dispatch-"));
  const worktreeRoot = join(projectRoot, ".gsd", "worktrees", "M001");
  mkdirSync(worktreeRoot, { recursive: true });
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const s = makeLoopSession({
    basePath: worktreeRoot,
    originalBasePath: projectRoot,
    canonicalProjectRoot: projectRoot,
  });
  const deps = makeMockDeps({
    getIsolationMode: () => "worktree",
  });
  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: undefined,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1,
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any,
      mid: "M001",
      midTitle: "Test",
    },
    {
      consecutiveFinalizeTimeouts: 0,
    },
  );

  assert.equal(result.action, "break");
  assert.equal(result.reason, "worktree-git-marker-missing");
  assert.ok(deps.callLog.includes("stopAuto"), "should stop through Worktree Safety");
  assert.ok(
    notifications.some((n) => n.includes("Worktree Safety failed") && n.includes("worktree-git-marker-missing")),
    "should notify about missing worktree .git marker",
  );
  assert.ok(
    !notifications.some((n) => n.includes("Stuck on execute-task")),
    "stuck-loop message must not mask the worktree health failure",
  );
});

test("dispatch Worktree Safety honors degraded branch fallback instead of demanding the canonical worktree root", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  // Worktree creation failed and the lifecycle fell back to the milestone
  // branch in the project root. The safety gate must validate against that
  // effective branch mode, not the configured worktree mode.
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-safety-degraded-"));
  execSync("git init --initial-branch=main", { cwd: projectRoot, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: projectRoot, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: projectRoot, stdio: "ignore" });
  // The lifecycle fallback checks out the milestone branch in the project
  // root, so the safety gate's branch verification expects that branch here
  // too. expectedBranch comes from deps.autoWorktreeBranch (mocked to
  // "auto/M001"), so the fixture repo must be on that same branch.
  execSync("git commit --allow-empty -m init", { cwd: projectRoot, stdio: "ignore" });
  execSync("git checkout -b auto/M001", { cwd: projectRoot, stdio: "ignore" });
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const s = makeLoopSession({
    basePath: projectRoot,
    originalBasePath: projectRoot,
    canonicalProjectRoot: projectRoot,
    isolationDegraded: true,
  });
  const deps = makeMockDeps({
    getIsolationMode: () => "worktree",
  });
  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: undefined,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1,
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any,
      mid: "M001",
      midTitle: "Test",
    },
    {
      consecutiveFinalizeTimeouts: 0,
    },
  );

  assert.equal(result.action, "next", "dispatch must proceed under degraded branch isolation");
  assert.ok(
    !notifications.some((n) => n.includes("Worktree Safety failed")),
    "degraded branch fallback must not trip a false invalid-root",
  );
  assert.ok(!deps.callLog.includes("stopAuto"), "auto-mode must not stop on the degraded fallback");
});

test("dispatch Worktree Safety honors stranded branch recovery instead of demanding the canonical worktree root", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  // Bootstrap adopted stranded work by checking out the milestone branch in
  // the project root (strandedRecoveryIsolationMode = "branch"). Isolation is
  // NOT degraded — the adoption is intentional. The safety gate must validate
  // against the effective branch mode, not the configured worktree mode.
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-safety-stranded-"));
  execSync("git init --initial-branch=main", { cwd: projectRoot, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: projectRoot, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: projectRoot, stdio: "ignore" });
  // Stranded recovery adopts the milestone branch in the project root, so the
  // safety gate's branch verification expects that branch here too.
  // expectedBranch comes from deps.autoWorktreeBranch (mocked to "auto/M001"),
  // so the fixture repo must be on that same branch.
  execSync("git commit --allow-empty -m init", { cwd: projectRoot, stdio: "ignore" });
  execSync("git checkout -b auto/M001", { cwd: projectRoot, stdio: "ignore" });
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const s = makeLoopSession({
    basePath: projectRoot,
    originalBasePath: projectRoot,
    canonicalProjectRoot: projectRoot,
    strandedRecoveryIsolationMode: "branch",
  });
  const deps = makeMockDeps({
    getIsolationMode: () => "worktree",
  });
  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: undefined,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1,
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any,
      mid: "M001",
      midTitle: "Test",
    },
    {
      consecutiveFinalizeTimeouts: 0,
    },
  );

  assert.equal(result.action, "next", "dispatch must proceed under stranded branch recovery");
  assert.ok(
    !notifications.some((n) => n.includes("Worktree Safety failed")),
    "stranded branch recovery must not trip a false invalid-root",
  );
  assert.ok(!deps.callLog.includes("stopAuto"), "auto-mode must not stop on stranded branch recovery");
});

test("runDispatch falls back to main when dispatch guard cannot read main branch (#5530)", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const basePath = makeLoopTestBase("gsd-5530-main-branch-fallback-");
  t.after(() => rmSync(basePath, { recursive: true, force: true }));

  let guardBranch: string | null = null;
  const s = makeLoopSession({ basePath });
  const deps = makeMockDeps({
    getMainBranch: () => {
      throw new Error("fatal: detected dubious ownership");
    },
    getPriorSliceCompletionBlocker: (_basePath, mainBranch) => {
      guardBranch = mainBranch;
      return null;
    },
  });

  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: undefined,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1,
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any,
      mid: "M001",
      midTitle: "Test",
    },
    {
      consecutiveFinalizeTimeouts: 0,
    },
  );

  assert.equal(guardBranch, "main");
  assert.equal(result.action, "next");
});

test("dispatch Worktree Safety stops unknown unit types with missing Tool Contract", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-safety-missing-contract-"));
  const worktreeRoot = join(projectRoot, ".gsd", "worktrees", "M001");
  mkdirSync(worktreeRoot, { recursive: true });
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const s = makeLoopSession({
    basePath: worktreeRoot,
    originalBasePath: projectRoot,
    canonicalProjectRoot: projectRoot,
  });
  const deps = makeMockDeps({
    getIsolationMode: () => "worktree",
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch" as const,
        unitType: "new-source-writing-unit-without-manifest",
        unitId: "M001/S01/T01",
        prompt: "do the thing",
      };
    },
  });

  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: undefined,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1,
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any,
      mid: "M001",
      midTitle: "Test",
    },
    {
      consecutiveFinalizeTimeouts: 0,
    },
  );

  assert.equal(result.action, "break");
  assert.equal(result.reason, "missing-tool-contract");
  assert.ok(deps.callLog.includes("stopAuto"), "should stop when the Tool Contract is missing");
  assert.ok(
    notifications.some((n) => n.includes("missing Tool Contract for new-source-writing-unit-without-manifest")),
    "should notify with an actionable missing Tool Contract reason",
  );
});

test("dispatch Worktree Safety allows hook units without Tool Contract lookup", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-safety-hook-contract-"));
  const worktreeRoot = join(projectRoot, ".gsd", "worktrees", "M001");
  mkdirSync(worktreeRoot, { recursive: true });
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const s = makeLoopSession({
    basePath: worktreeRoot,
    originalBasePath: projectRoot,
    canonicalProjectRoot: projectRoot,
  });
  const deps = makeMockDeps({
    getIsolationMode: () => "worktree",
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch" as const,
        unitType: "hook/code-review",
        unitId: "M001/S01/T01/review",
        prompt: "review the unit",
      };
    },
  });

  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: undefined,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1,
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any,
      mid: "M001",
      midTitle: "Test",
    },
    {
      consecutiveFinalizeTimeouts: 0,
    },
  );

  assert.equal(result.action, "next");
  assert.equal(result.data?.unitType, "hook/code-review");
  assert.ok(!deps.callLog.includes("stopAuto"), "hook units should not require a Tool Contract");
  assert.ok(
    !notifications.some((n) => n.includes("missing Tool Contract")),
    "hook units must not fail the source-writing Tool Contract gate",
  );
});

test("dispatch Worktree Safety accepts sidecar-prefixed known unit types", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();

  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-safety-sidecar-prefix-"));
  const worktreeRoot = join(projectRoot, ".gsd", "worktrees", "M001");
  mkdirSync(worktreeRoot, { recursive: true });
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const s = makeLoopSession({
    basePath: worktreeRoot,
    originalBasePath: projectRoot,
    canonicalProjectRoot: projectRoot,
  });
  const deps = makeMockDeps({
    getIsolationMode: () => "worktree",
    resolveDispatch: async () => ({
      action: "dispatch" as const,
      unitType: "sidecar/triage-captures",
      unitId: "M001/S01/triage",
      prompt: "triage",
    }),
  });

  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: undefined,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1,
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any,
      mid: "M001",
      midTitle: "Test",
    },
    {
      consecutiveFinalizeTimeouts: 0,
    },
  );

  assert.equal(result.action, "next");
  assert.ok(!deps.callLog.includes("stopAuto"), "should not stop for sidecar-prefixed known unit types");
});

test("dispatch Worktree Safety allows hook units without Unit Tool Contract manifests", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-safety-hook-contract-"));
  const worktreeRoot = join(projectRoot, ".gsd", "worktrees", "M001");
  mkdirSync(worktreeRoot, { recursive: true });
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const s = makeLoopSession({
    basePath: worktreeRoot,
    originalBasePath: projectRoot,
    canonicalProjectRoot: projectRoot,
  });
  const deps = makeMockDeps({
    getIsolationMode: () => "worktree",
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch" as const,
        unitType: "hook/session-context",
        unitId: "M001/S01/T01",
        prompt: "do the thing",
      };
    },
  });

  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: undefined,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1,
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any,
      mid: "M001",
      midTitle: "Test",
    },
    {
      consecutiveFinalizeTimeouts: 0,
    },
  );

  assert.equal(result.action, "next");
  assert.ok(
    !notifications.some((n) => n.includes("missing Tool Contract for hook/session-context")),
    "hook units should not fail closed with missing-tool-contract",
  );
});

test("pre-dispatch skip resolves before dispatch health and stuck accounting", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  const s = makeLoopSession({ basePath: "/tmp/broken-worktree" });
  const deps = makeMockDeps({
    existsSync: (p: string) => !p.endsWith(".git"),
    runPreDispatchHooks: () => ({ firedHooks: ["skip-execute"], action: "skip" }),
  });
  const loopState = {
    consecutiveFinalizeTimeouts: 0,
  };

  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: undefined,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1,
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any,
      mid: "M001",
      midTitle: "Test",
    },
    loopState,
  );

  assert.equal(result.action, "continue");
  assert.ok(!deps.callLog.includes("stopAuto"), "skip hook should not stop on worktree health");
  assert.ok(
    notifications.some((n) => n.includes("Skipping execute-task M001/S01/T01")),
    "should notify about the skip hook",
  );
  assert.ok(
    !notifications.some((n) => n.includes("Worktree health check failed") || n.includes("Stuck on execute-task")),
    "health and stuck notifications must not run before skip hook resolution",
  );
});

test("pre-dispatch replace resolves final unit before dispatch health and stuck accounting", async () => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };

  const s = makeLoopSession({ basePath: "/tmp/broken-worktree" });
  const deps = makeMockDeps({
    existsSync: (p: string) => !p.endsWith(".git"),
    runPreDispatchHooks: () => ({
      firedHooks: ["review"],
      action: "replace",
      unitType: "run-uat",
      prompt: "review before executing",
      model: "review-model",
    }),
  });
  const loopState = {
    consecutiveFinalizeTimeouts: 0,
  };

  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: undefined,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1,
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any,
      mid: "M001",
      midTitle: "Test",
    },
    loopState,
  );

  assert.equal(result.action, "next");
  assert.equal(result.data?.unitType, "run-uat");
  assert.equal(result.data?.finalPrompt, "review before executing");
  assert.equal(result.data?.hookModelOverride, "review-model");
  assert.ok(!deps.callLog.includes("stopAuto"), "replace hook should not stop on execute-task health");
  assert.ok(
    !notifications.some((n) => n.includes("Worktree health check failed") || n.includes("Stuck on execute-task")),
    "health and stuck notifications must use the final replaced unit",
  );
});

test("autoLoop warns but proceeds for greenfield project (no project files) (#1833)", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();

  const notifications: string[] = [];
  const basePath = makeLoopTestBase("gsd-greenfield-");
  t.after(() => rmSync(basePath, { recursive: true, force: true }));
  const s = makeLoopSession({ basePath });

  ctx.ui.notify = (msg: string) => {
    notifications.push(msg);
    // Terminate the loop after the greenfield warning fires,
    // so we don't hang waiting for dispatch resolution.
    if (msg.includes("greenfield")) {
      s.active = false;
    }
  };

  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
      } as any;
    },
  });

  await autoLoop(ctx, pi, s, deps);

  // Should NOT have stopped auto-mode due to health check — greenfield is allowed
  const stoppedForHealth = notifications.find(
    (n) => n.includes("Worktree health check failed"),
  );
  assert.ok(
    !stoppedForHealth,
    "should not stop with health check failure for greenfield project",
  );
  const greenfieldWarning = notifications.find(
    (n) => n.includes("no project content yet") && n.includes("greenfield"),
  );
  assert.ok(
    greenfieldWarning,
    "should warn about greenfield project (no project files)",
  );
});

// ── Proactive rate limiting (#2996) ──────────────────────────────────────────

test("autoLoop enforces min_request_interval_ms delay between LLM dispatches (#2996)", async () => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });

  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {};
    ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
    const pi = makeMockPi();
    const originalSendMessage = pi.sendMessage;
    const dispatchTimestamps: number[] = [];
    pi.sendMessage = (...args: unknown[]) => {
      dispatchTimestamps.push(Date.now());
      return originalSendMessage(...args);
    };

    let iterCount = 0;

    const s = makeLoopSession();

    const deps = makeMockDeps({
      loadEffectiveGSDPreferences: () => ({
        preferences: {
          min_request_interval_ms: 300,
          uok: { plan_v2: { enabled: false } },
        },
      }),
      deriveState: async () => {
        iterCount++;
        deps.callLog.push("deriveState");
        return {
          phase: "executing",
          activeMilestone: { id: "M001", title: "Test", status: "active" },
          activeSlice: { id: "S01", title: "Slice" },
          activeTask: { id: "T01" },
          registry: [{ id: "M001", status: "active" }],
          blockers: [],
        } as any;
      },
      postUnitPostVerification: async () => {
        deps.callLog.push("postUnitPostVerification");
        if (iterCount >= 2) {
          s.active = false;
        }
        return "continue" as const;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);

    await waitForMicrotasks(() => dispatchTimestamps.length === 1, "first dispatch");
    resolveAgentEnd(makeEvent());
    await waitForMicrotasks(
      () => deps.callLog.filter((entry) => entry === "resolveDispatch").length >= 2,
      "second dispatch planning",
    );

    await drainMicrotasks(100);
    mock.timers.tick(299);
    await drainMicrotasks(100);
    assert.equal(dispatchTimestamps.length, 1, "second dispatch should wait for the configured interval");

    mock.timers.tick(1);
    await waitForMicrotasks(() => dispatchTimestamps.length === 2, "second dispatch");
    resolveAgentEnd(makeEvent());

    await loopPromise;

    assert.ok(iterCount >= 2, `expected at least 2 iterations, got ${iterCount}`);
    assert.ok(dispatchTimestamps.length >= 2, `expected at least 2 dispatches, got ${dispatchTimestamps.length}`);

    assert.equal(
      (s as any).lastRequestTimestamp,
      dispatchTimestamps[1],
      "lastRequestTimestamp should record the actual dispatch time",
    );

    const gap = dispatchTimestamps[1]! - dispatchTimestamps[0]!;
    assert.equal(
      gap,
      300,
      `gap between dispatches should match min_request_interval_ms=300 (got ${gap}ms)`,
    );
  } finally {
    mock.timers.reset();
  }
});

test("autoLoop skips rate-limit delay when min_request_interval_ms is 0 (default)", async () => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 2_000 });

  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {};
    ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
    const pi = makeMockPi();
    const originalSendMessage = pi.sendMessage;
    const dispatchTimestamps: number[] = [];
    pi.sendMessage = (...args: unknown[]) => {
      dispatchTimestamps.push(Date.now());
      return originalSendMessage(...args);
    };

    let iterCount = 0;

    const s = makeLoopSession();

    const deps = makeMockDeps({
      loadEffectiveGSDPreferences: () => ({
        preferences: { uok: { plan_v2: { enabled: false } } },
      }),
      deriveState: async () => {
        iterCount++;
        deps.callLog.push("deriveState");
        return {
          phase: "executing",
          activeMilestone: { id: "M001", title: "Test", status: "active" },
          activeSlice: { id: "S01", title: "Slice" },
          activeTask: { id: "T01" },
          registry: [{ id: "M001", status: "active" }],
          blockers: [],
        } as any;
      },
      postUnitPostVerification: async () => {
        deps.callLog.push("postUnitPostVerification");
        if (iterCount >= 3) {
          s.active = false;
        }
        return "continue" as const;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);

    for (let i = 1; i <= 3; i++) {
      await waitForMicrotasks(() => dispatchTimestamps.length === i, `dispatch ${i}`);
      resolveAgentEnd(makeEvent());
    }

    await loopPromise;

    assert.ok(iterCount >= 3, `expected at least 3 iterations, got ${iterCount}`);
    assert.ok(dispatchTimestamps.length >= 3, `expected at least 3 dispatches, got ${dispatchTimestamps.length}`);

    const gap = dispatchTimestamps[2]! - dispatchTimestamps[1]!;
    assert.equal(
      gap,
      0,
      `gap should be 0ms under mocked time without rate limiting (got ${gap}ms)`,
    );
  } finally {
    mock.timers.reset();
  }
});

// ─── #4850: pre-send model-policy block is non-retryable ────────────────────
test("autoLoop classifies ModelPolicyDispatchBlockedError as blocked, not a retryable error", async (t) => {
  _resetPendingResolve();

  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {};
  const notifications: Array<{ message: string; level?: string }> = [];
  ctx.ui.notify = (m: string, l?: string) => { notifications.push({ message: m, level: l }); };

  const pi = makeMockPi();
  const s = makeLoopSession();
  openLoopDatabase(t, s);

  const journalEvents: Array<{ eventType: string; data?: any }> = [];
  let pauseAutoCalls = 0;
  let stopAutoCalls = 0;
  // Capture onTurnResult to assert blocked-unit identity is propagated to
  // the uokObserver. Without the fix, observedUnitType/Id are unset because
  // the throw happens inside dispatch before the success-path assignments
  // at loop.ts:453/631/647 (#4959).
  const turnResults: Array<{ unitType?: string; unitId?: string; status: string }> = [];

  const deps = makeMockDeps({
    selectAndApplyModel: async () => {
      throw new ModelPolicyDispatchBlockedError(
        "research-slice",
        "M001/S01",
        [{ provider: "openai", modelId: "gpt-4o", reason: "tool policy denied (web_search) for openai-completions" }],
      );
    },
    pauseAuto: async () => { pauseAutoCalls++; },
    stopAuto: async () => { stopAutoCalls++; },
    emitJournalEvent: (entry: any) => { journalEvents.push(entry); },
    uokObserver: {
      onTurnStart: () => {},
      onPhaseResult: () => {},
      onTurnResult: (res: any) => { turnResults.push({ unitType: res.unitType, unitId: res.unitId, status: res.status }); },
    } as any,
  });

  await autoLoop(ctx, pi, s, deps);

  // The unit-end event with status: "blocked" must be emitted.
  const unitEnd = journalEvents.find(
    e => e.eventType === "unit-end" && e.data?.status === "blocked",
  );
  assert.ok(unitEnd, "should emit unit-end with status=blocked");
  assert.equal(unitEnd!.data.reason, "model-policy-dispatch-blocked");
  const unitEndIndex = journalEvents.findIndex(
    e => e.eventType === "unit-end" && e.data?.status === "blocked",
  );
  const iterationEndIndex = journalEvents.findIndex(
    e => e.eventType === "iteration-end" && e.data?.status === "blocked",
  );
  assert.ok(iterationEndIndex > unitEndIndex, "blocked policy iterations must close after unit-end");

  // Loop must pause for manual attention, NOT retry until 3-strike hard stop.
  assert.equal(pauseAutoCalls, 1, "should pause once on policy block");
  assert.equal(stopAutoCalls, 0, "should NOT call stopAuto — pre-send block is not a retryable iteration error");

  // The notification should surface the per-model deny reason from the typed error.
  const blockedNotice = notifications.find(
    n => n.message.includes("model-policy denied dispatch")
      && n.message.includes("tool policy denied (web_search)"),
  );
  assert.ok(blockedNotice, "user-facing notification should name the policy block + deny reason");

  // Blocked-unit identity must reach uokObserver.onTurnResult — the typed
  // error already carries it, the loop must thread it into observedUnitType/Id
  // before finishTurn is called (#4959).
  const pausedTurn = turnResults.find(r => r.status === "paused");
  assert.ok(pausedTurn, "uokObserver should observe a paused turn for the blocked unit");
  assert.equal(pausedTurn!.unitType, "research-slice", "onTurnResult must receive the blocked unitType from the typed error");
  assert.equal(pausedTurn!.unitId, "M001/S01", "onTurnResult must receive the blocked unitId from the typed error");
});
