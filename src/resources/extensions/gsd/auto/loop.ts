// Project/App: gsd-pi
// File Purpose: Main auto-mode execution loop.
/**
 * auto/loop.ts — Main auto-mode execution loop.
 *
 * Iterates: orchestration.advance → guards → runUnit → finalize → repeat.
 * Exits when s.active becomes false or a terminal condition is reached.
 *
 * Imports from: auto/types, auto/resolve, auto/phases
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutoSession } from "./session.js";
import type { AutoTerminalOutcome } from "./contracts.js";
import { isUnitAlreadyActiveSkip } from "./contracts.js";
import { settleIterationRun, type IterationRunOutcome } from "./iteration-run.js";
import type { LoopDeps, StopAutoOptions } from "./loop-deps.js";
import type { GSDState } from "../types.js";
import {
  MAX_LOOP_ITERATIONS,
  type LoopState,
  type IterationContext,
  type IterationData,
} from "./types.js";
import { _clearCurrentResolve } from "./resolve.js";
import { runGuards } from "./phases.js";
import { runFinalize } from "./finalize.js";
import { handlePendingHookOutcome } from "../auto-post-unit.js";
import {
  resetSessionTimeoutState,
  restoreTaskHostVerificationContext,
} from "./unit-phase.js";
import { debugLog } from "../debug-logger.js";
import { markBlockedStopReason } from "../stop-notice.js";
import { isTransientProjectionLockError } from "../projection-root-errors.js";
import {
  formatWedgeTripNotice,
  recordNonAdvancingOutcome,
} from "../auto-liveness-backstop.js";
import { isInfrastructureError, isTransientCooldownError, getCooldownRetryAfterMs, COOLDOWN_FALLBACK_WAIT_MS, MAX_COOLDOWN_RETRIES } from "./infra-errors.js";
import { ModelPolicyDispatchBlockedError } from "../auto-model-selection.js";
import { resolveEngine } from "../engine-resolver.js";
import { logWarning } from "../workflow-logger.js";
import {
  recordDispatchClaim,
  markRunning as markDispatchRunning,
  markCompleted as markDispatchCompleted,
  markFailed as markDispatchFailed,
  getRecentForUnit as getRecentDispatchesForUnit,
} from "../db/unit-dispatches.js";
import {
  claimMilestoneLease,
  refreshMilestoneLease,
  milestoneLeaseTtlSeconds,
} from "../db/milestone-leases.js";
import { heartbeatAutoWorker, isDeadLocalAutoWorker } from "../db/auto-workers.js";
import { resolveUokFlags } from "../uok/flags.js";
import { scheduleSidecarQueue } from "../uok/execution-graph.js";
import { normalizeRealPath } from "../paths.js";
import {
  decideCooldownRecovery,
  decideDispatchClaim,
  decideEngineDispatch,
  decideFinalizeResult,
  decideInfrastructureError,
  decideIterationErrorRecovery,
  decideMemoryPressure,
  decideModelPolicyBlocked,
  decideMinRequestInterval,
  decideWorkflowLoop,
  formatDispatchExceptionSummary,
  resolveUnitRequestTimestamp,
  shouldUseCustomEnginePath,
} from "./workflow-kernel.js";
import {
  hydrateCustomVerifyRetryCounts,
  saveCustomVerifyRetryCounts,
} from "./custom-verify-retry-store.js";
import {
  settleDispatchFailed,
  settleDispatchIfNeeded,
} from "./workflow-dispatch-ledger.js";
import { abortActiveUnitTurn } from "./unit-turn-abort.js";
import { emitOpenUnitEndForUnit } from "../crash-recovery.js";
import { writeUnitRuntimeRecord } from "../unit-runtime.js";
import { ensureDispatchLease, openDispatchClaim } from "./workflow-dispatch-claim.js";
import { completeWorkflowIteration } from "./workflow-iteration-completion.js";
import { createWorkflowJournalReporter } from "./workflow-journal-reporter.js";
import { createWorkflowPhaseReporter } from "./workflow-phase-reporter.js";
import { createWorkflowTurnReporter } from "./workflow-turn-reporter.js";
import { validateWorkflowSessionLock } from "./workflow-session-lock.js";
import { dequeueSidecarItem } from "./workflow-sidecar-queue.js";
import { maintainWorkerHeartbeat, runWithWorkerHeartbeat } from "./workflow-worker-heartbeat.js";
import { gsdRoot } from "../paths.js";
import {
  measureMemoryPressure,
  shouldCheckMemoryPressure,
} from "./workflow-memory-pressure.js";
import { buildSidecarIterationData } from "./workflow-sidecar-iteration.js";
import {
  createExecutionGraphUnitDispatchDeps,
  runUnitPhaseViaContract,
  type DispatchContract,
} from "./workflow-unit-dispatch.js";
import { handleCustomEngineDispatchOutcome } from "./workflow-custom-engine-dispatch-outcome.js";
import { buildCustomEngineIterationData } from "./workflow-custom-engine-iteration.js";
import { handleCustomEngineVerifyRetry } from "./workflow-custom-engine-retry.js";
import {
  composeVerificationInputPayload,
  handleCustomEngineTaskVerifyOutcome,
  handleCustomEngineVerifyPause,
  handleCustomEngineVerifyRetryOutcome,
  type VerificationRead,
} from "./workflow-custom-engine-verify-outcome.js";
import { handleCustomEngineReconcile } from "./workflow-custom-engine-reconcile.js";
import { handleCustomEngineReconcileOutcome } from "./workflow-custom-engine-reconcile-outcome.js";
import { formatLeaseConflictNotice } from "./lease-conflict-notice.js";
import { resolveLoopSanctionedExit } from "./loop-sanctioned-exits.js";
import { setAutoOutcomeWidget, unitVerb } from "../auto-dashboard.js";
import {
  isTaskExecutionReadyForHostVerification,
  publishVerifiedTaskExecution,
  runWithTaskExecutionAttempt,
} from "./task-execution-cutover.js";
import {
  requestCustomTaskHumanReviewFromUi,
  resolvePendingCustomTaskHumanReview,
  runCustomEngineHostVerification,
  type HostVerificationEvidence,
} from "./custom-task-host-verification.js";
import {
  claimTaskAttempt,
  interruptOrphanedTaskAttempts,
  readLatestTaskAttempt,
  readTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.js";
import { publishVerifiedTaskCompletion } from "../task-completion-compatibility-adapter.js";
import { readTaskTechnicalVerdict } from "../task-verification-domain-operation.js";
import {
  readTaskRecoveryRoute,
  recordFailureAndSelectRecovery,
} from "../task-recovery-domain-operation.js";
import {
  readTerminalTaskRecoveryAbort,
  verifyExpectedArtifact,
} from "../artifact-verification.js";
import { IS_DISPATCH_OWNER_DEAD, RECLAIM_DEAD_DISPATCH_OWNER } from "./unit-run.js";

function resolveCompletionStopFromState(
  stateSnapshot: GSDState | undefined,
): { reason: string; options: StopAutoOptions } | null {
  if (stateSnapshot?.phase !== "complete") return null;
  const completedMilestone = stateSnapshot.lastCompletedMilestone ?? stateSnapshot.activeMilestone;
  return {
    reason: "All milestones complete",
    options: {
      completionWidget: {
        milestoneId: completedMilestone?.id ?? null,
        milestoneTitle: completedMilestone?.title ?? null,
        allMilestonesComplete: true,
      },
    },
  };
}

function resolveCompletionStopFromOutcome(
  outcome: AutoTerminalOutcome | undefined,
  stateSnapshot: GSDState | undefined,
): { reason: string; options: StopAutoOptions } | null {
  if (outcome?.code !== "all-complete") return null;
  const completedMilestone = stateSnapshot?.lastCompletedMilestone ?? stateSnapshot?.activeMilestone;
  return {
    reason: outcome.displayReason,
    options: {
      completionWidget: {
        milestoneId: completedMilestone?.id ?? null,
        milestoneTitle: completedMilestone?.title ?? null,
        allMilestonesComplete: true,
      },
      terminalOutcome: outcome,
    },
  };
}

const WORKER_HEARTBEAT_INTERVAL_MS = milestoneLeaseTtlSeconds() * 500;
const ORCHESTRATION_MISSING_REASON =
  "Auto Orchestration Module is not wired; cannot dispatch built-in GSD Unit.";
const TASK_EXECUTION_CUTOVER_DEPS = {
  claimTaskAttempt,
  readLatestTaskAttempt,
  readTerminalTaskRecoveryAbort: (task: {
    milestoneId: string;
    sliceId: string;
    taskId: string;
  }) => readTerminalTaskRecoveryAbort(task.milestoneId, task.sliceId, task.taskId),
  readTaskAttempt,
  readTaskRecoveryRoute,
  readTaskTechnicalVerdict,
  routeTaskFailure: recordFailureAndSelectRecovery,
  settleTaskAttempt,
};
const VERIFIED_TASK_PUBLICATION_DEPS = {
  publishVerifiedTaskCompletion,
  readLatestTaskAttempt,
};

function recordLoopNonAdvancingOutcome(
  s: AutoSession,
  input: {
    guardId: string;
    unitType: string;
    unitId: string;
    inputPayload: string;
    sanctionedExit?: string;
  },
): string | null {
  const scopeId = normalizeRealPath(
    s.scope?.workspace.projectRoot ?? (s.originalBasePath || s.basePath),
  ) || s.basePath;
  const result = recordNonAdvancingOutcome({
    scopeId,
    guardId: input.guardId,
    unitType: input.unitType,
    unitId: input.unitId,
    inputPayload: input.inputPayload,
  }, input.sanctionedExit ? { sanctionedExit: input.sanctionedExit } : undefined);
  if ('error' in result) {
    return `liveness backstop unavailable: ${result.error}. Repair the workflow database with \`/gsd doctor --fix\` before resuming auto-mode.`;
  }
  return result.tripped ? formatWedgeTripNotice(result.wedge) : null;
}

function logDispatchLedgerWriteFailure(err: unknown): void {
  debugLog("autoLoop", {
    phase: "dispatch-ledger-write-failed",
    error: err instanceof Error ? err.message : String(err),
  });
}

function logDispatchClaimRejected(details: {
  unitId: string;
  reason: string;
  existingId?: number;
  existingWorker?: string;
}): void {
  debugLog("autoLoop", {
    phase: "dispatch-claim-rejected",
    ...details,
  });
}

function logDispatchClaimFailed(err: unknown): void {
  debugLog("autoLoop", {
    phase: "dispatch-claim-failed",
    error: err instanceof Error ? err.message : String(err),
  });
}

function logDispatchLeaseRecovered(details: {
  milestoneId: string;
  workerId: string;
  token: number;
  recovered: boolean;
}): void {
  debugLog("autoLoop", {
    phase: details.recovered ? "dispatch-lease-recovered" : "dispatch-lease-acquired",
    ...details,
  });
}

function logDispatchLeaseRecoveryFailed(details: {
  milestoneId?: string;
  workerId?: string;
  reason: string;
}): void {
  debugLog("autoLoop", {
    phase: "dispatch-lease-recovery-failed",
    ...details,
  });
}

function logCustomVerifyRetryLoadFailure(err: unknown): void {
  debugLog("autoLoop", {
    phase: "load-custom-verify-retries-failed",
    error: err instanceof Error ? err.message : String(err),
  });
}

function leaseConflictNotice(
  iterData: IterationData,
  reason: string,
): string {
  return formatLeaseConflictNotice({
    milestoneId: iterData.mid,
    unitType: iterData.unitType,
    unitId: iterData.unitId,
    reason,
  });
}

function logCustomVerifyRetrySaveFailure(err: unknown): void {
  debugLog("autoLoop", {
    phase: "save-custom-verify-retries-failed",
    error: err instanceof Error ? err.message : String(err),
  });
}

// ── Memory pressure monitoring (#3331) ──────────────────────────────────
// Check heap usage on session startup, then every N iterations, and trigger
// graceful shutdown before the OS OOM killer sends SIGKILL. The threshold is
// 90% of the V8 heap limit (--max-old-space-size or default ~1.5-4GB depending on platform).
const MEMORY_CHECK_INTERVAL = 5; // check every 5 iterations
const MAX_CUSTOM_ENGINE_VERIFY_RETRIES = 3;

interface AutoLoopOptions {
  dispatchContract?: DispatchContract;
}

type CrashErrorType = "infrastructure" | "cooldown-exhausted" | "iteration-exhausted";

function persistCrashNote(
  s: AutoSession,
  errorType: CrashErrorType,
  errorMessage: string,
  observedUnitType?: string,
  observedUnitId?: string,
): string | null {
  try {
    const activityDir = join(gsdRoot(s.basePath), "activity");
    mkdirSync(activityDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${timestamp}-auto-crash-note.json`;
    const notePath = join(activityDir, filename);
    const payload = {
      kind: "auto_crash_note",
      createdAt: new Date().toISOString(),
      errorType,
      errorMessage,
      workerId: s.workerId ?? null,
      milestoneId: s.currentMilestoneId ?? null,
      unitType: observedUnitType ?? s.currentUnit?.type ?? null,
      unitId: observedUnitId ?? s.currentUnit?.id ?? null,
      sessionFile: s.pausedSessionFile ?? null,
    };
    writeFileSync(notePath, JSON.stringify(payload, null, 2), "utf-8");
    return notePath;
  } catch {
    return null;
  }
}

async function enforceMinRequestInterval(s: AutoSession, prefs: IterationContext["prefs"]): Promise<void> {
  const minInterval = prefs?.min_request_interval_ms ?? 0;
  const decision = decideMinRequestInterval({
    minIntervalMs: minInterval,
    lastRequestTimestamp: s.lastRequestTimestamp,
    nowMs: Date.now(),
  });
  if (decision.action === "wait") {
    debugLog("autoLoop", { phase: "rate-limit-wait", waitMs: decision.waitMs });
    await new Promise<void>(r => setTimeout(r, decision.waitMs));
  }
}

async function snapshotCrashedUnitWork(
  ctx: ExtensionContext,
  s: AutoSession,
  deps: LoopDeps,
  iterData: IterationData,
): Promise<void> {
  try {
    const commitMsg = await deps.autoCommitUnit?.(
      s.basePath,
      iterData.unitType,
      iterData.unitId,
      ctx,
    );
    if (commitMsg) {
      debugLog("autoLoop", {
        phase: "crash-snapshot-commit",
        unitType: iterData.unitType,
        unitId: iterData.unitId,
      });
    }
  } catch (snapshotErr) {
    logWarning(
      "dispatch",
      `unit crash snapshot failed: ${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}`,
    );
  }
}

async function closeOutCrashedUnit(
  ctx: ExtensionContext,
  s: AutoSession,
  deps: LoopDeps,
  iterData: IterationData,
  err: unknown,
): Promise<void> {
  const summary = formatDispatchExceptionSummary({ error: err });
  try {
    abortActiveUnitTurn(ctx);
    try {
      emitOpenUnitEndForUnit(
        s.basePath,
        iterData.unitType,
        iterData.unitId,
        "cancelled",
        {
          message: summary,
          category: "unit-exception",
          isTransient: false,
        },
      );
      writeUnitRuntimeRecord(
        s.basePath,
        iterData.unitType,
        iterData.unitId,
        s.currentUnit?.startedAt ?? Date.now(),
        {
          phase: "crashed",
          lastProgressAt: Date.now(),
          lastProgressKind: "unit-exception",
        },
      );
    } catch (closeoutErr) {
      logWarning("dispatch", `unit crash closeout failed: ${closeoutErr instanceof Error ? closeoutErr.message : String(closeoutErr)}`);
    }
    await snapshotCrashedUnitWork(ctx, s, deps, iterData);
  } finally {
    s.clearCurrentUnit();
  }
}

/**
 * Main auto-mode execution loop. Iterates: orchestration.advance → guards →
 * runUnit → finalize → repeat. Exits when s.active becomes false or a terminal
 * condition is reached.
 *
 * This is the linear replacement for the recursive
 * dispatchNextUnit → resolveAgentEnd → dispatchNextUnit chain.
 */
export async function autoLoop(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  deps: LoopDeps,
  options?: AutoLoopOptions,
): Promise<void> {
  debugLog("autoLoop", { phase: "enter" });
  resetSessionTimeoutState();
  if (s.workerId && s.currentMilestoneId) {
    const repaired = interruptOrphanedTaskAttempts({
      workerId: s.workerId,
      milestoneId: s.currentMilestoneId,
    });
    if (repaired.milestoneLeaseToken !== null) {
      s.milestoneLeaseToken = repaired.milestoneLeaseToken;
    }
    if (repaired.attemptIds.length > 0) {
      debugLog("autoLoop", {
        phase: "orphaned-task-attempts-interrupted",
        attemptIds: repaired.attemptIds,
      });
    }
  }
  let iteration = 0;
  const dispatchContract = options?.dispatchContract ?? "legacy-direct";
  const unitDispatchDeps = createExecutionGraphUnitDispatchDeps();
  // Load persisted verification retry state so the exhausted-unit guard fires on restart (#651)
  hydrateCustomVerifyRetryCounts(s, { logFailure: logCustomVerifyRetryLoadFailure });
  const loopState: LoopState = {
    consecutiveFinalizeTimeouts: 0,
    consecutiveDispatchCount: new Map<string, number>(),
    lastDispatchedKey: null,
    lastDispatchPhase: null,
  };
  let consecutiveErrors = 0;
  let consecutiveProjectionLockPauses = 0;
  let consecutiveCooldowns = 0;
  const recentErrorMessages: string[] = [];
  const workerHeartbeatDeps = {
    heartbeatAutoWorker,
    refreshMilestoneLease,
    logHeartbeatFailure: (err: unknown) => debugLog("autoLoop", {
      phase: "heartbeat-failed",
      error: err instanceof Error ? err.message : String(err),
    }),
    logLeaseRefreshMiss: (details: {
      workerId: string;
      milestoneId: string;
      fencingToken: number;
    }) => debugLog("autoLoop", {
      phase: "lease-refresh-missed",
      ...details,
    }),
  };
  const pauseForTaskRecoveryAbort = async (reason: string): Promise<void> => {
    if (!reason.startsWith("task-recovery-abort")) return;
    ctx.ui.notify(
      `Task recovery requires a verified repair before auto-mode can continue. ${reason}`,
      "warning",
    );
    await deps.pauseAuto(ctx, pi, {
      message: reason,
      category: "unknown",
    });
  };

  while (s.active) {
    iteration++;
    debugLog("autoLoop", { phase: "loop-top", iteration });

    maintainWorkerHeartbeat(s, workerHeartbeatDeps);

    // ── Journal: per-iteration flow grouping ──
    const flowId = randomUUID();
    let seqCounter = 0;
    const nextSeq = () => ++seqCounter;
    const journalReporter = createWorkflowJournalReporter({
      emitJournalEvent: deps.emitJournalEvent,
      flowId,
      nextSeq,
    });
    const turnId = randomUUID();
    s.currentTraceId = flowId;
    s.currentTurnId = turnId;
    const turnStartedAt = new Date().toISOString();
    let observedUnitType: string | undefined;
    let observedUnitId: string | undefined;
    const phaseReporter = createWorkflowPhaseReporter({
      observer: deps.uokObserver,
    });
    const turnReporter = createWorkflowTurnReporter({
      observer: deps.uokObserver,
      traceId: flowId,
      turnId,
      iteration,
      basePath: s.basePath,
      startedAt: turnStartedAt,
      clearCurrentTurn: () => {
        s.currentTraceId = null;
        s.currentTurnId = null;
      },
    });
    let pendingLoopLiveness: {
      guardId: string;
      inputPayload: string;
      unitType: string;
      unitId: string;
    } | null = null;
    let pendingStopAuto: {
      reason?: string;
      options?: StopAutoOptions;
    } | null = null;
    let ownsUnitExecution = false;
    let runClosed = false;
    let abnormalUnitExitReason = "unit exited without clean closeout";
    const deferStopAuto: LoopDeps["stopAuto"] = async (_ctx, _pi, reason, options) => {
      pendingStopAuto ??= { reason, options };
    };
    const iterationDeps = new Proxy(deps, {
      get(target, property, receiver) {
        return property === "stopAuto"
          ? deferStopAuto
          : Reflect.get(target, property, receiver);
      },
    });
    const finishTurn = (
      status: "completed" | "failed" | "paused" | "stopped" | "skipped" | "retry",
      failureClass: "none" | "unknown" | "manual-attention" | "timeout" | "execution" | "verification" | "closeout" | "git" = "none",
      error: string | undefined,
      guardId: string | null,
      inputPayload?: string,
    ): void => {
      if (!runClosed) {
        abnormalUnitExitReason = error ?? guardId ?? status;
      }
      turnReporter.finish({
        unitType: observedUnitType,
        unitId: observedUnitId,
        status,
        failureClass,
        error,
      });
      if (guardId) {
        pendingLoopLiveness = {
          guardId,
          inputPayload: inputPayload ?? error ?? guardId,
          unitType: observedUnitType ?? "orchestration",
          unitId: observedUnitId ?? s.currentMilestoneId ?? "workflow",
        };
      }
    };
    turnReporter.start();

    let dispatchId: number | null = null;
    let dispatchSettled = false;
    let iterData: IterationData | undefined;
    // #2218 — unit-phase break reasons that represent a mid-unit timeout kill
    // record a structured exit_reason on the dispatch row, so a timeout is
    // queryable without parsing error_summary prose.
    const exitReasonForBreak = (breakReason: string): string | undefined =>
      breakReason === "unit-hard-timeout" ? "timeout" : undefined;
    const closeRun = async (
      outcome: IterationRunOutcome,
      reason: string,
      exitReason?: string,
    ): Promise<string | null> => {
      if (runClosed) return null;
      const unit = (observedUnitType && observedUnitId
        ? { unitType: observedUnitType, unitId: observedUnitId }
        : null)
        ?? (iterData
          ? { unitType: iterData.unitType, unitId: iterData.unitId }
          : null);
      if (!unit && dispatchId === null) return null;
      runClosed = true;
      dispatchSettled = await settleIterationRun(
        {
          dispatchId,
          unitType: unit?.unitType ?? "orchestration",
          unitId: unit?.unitId ?? s.currentMilestoneId ?? "workflow",
        },
        outcome,
        reason,
        dispatchSettled,
        {
          markFailed: markDispatchFailed,
          markCompleted: markDispatchCompleted,
          logWriteFailure: logDispatchLedgerWriteFailure,
          completeActiveUnit: s.orchestration?.completeActiveUnit?.bind(s.orchestration),
          retryActiveUnit: s.orchestration?.retryActiveUnit?.bind(s.orchestration),
          abandonActiveUnit: s.orchestration?.abandonActiveUnit?.bind(s.orchestration),
        },
        { ...(exitReason ? { exitReason } : {}) },
      );
      if (outcome === "retry" && s.orchestration?.getStatus().phase === "stopped") {
        // #2198: the finalize-retry guard tripped — the retry recurred with
        // unchanged inputs, so a further redispatch cannot succeed. The
        // orchestrator surfaced the concrete finalize-failure cause; pause with
        // it (plain /gsd auto resumes after the fix) instead of the generic
        // wedge stop.
        await deps.pauseAuto(ctx, pi, { message: reason, category: "unknown" });
        return reason;
      }
      return null;
    };
    const finishRetryCloseoutPause = (reason: string): void => {
      finishIncompleteIteration({
        status: "paused",
        reason,
        unitType: iterData?.unitType,
        unitId: iterData?.unitId,
        failureClass: "closeout",
      });
      finishTurn("paused", "closeout", reason, null);
    };
    let iterationEndEmitted = false;
    const emitIterationEnd = (details: Record<string, unknown> = {}): void => {
      if (iterationEndEmitted) return;
      iterationEndEmitted = true;
      journalReporter.emit("iteration-end", { iteration, ...details });
    };
    const completeIteration = (): void => {
      completeWorkflowIteration({
        get consecutiveErrors() { return consecutiveErrors; },
        set consecutiveErrors(value) { consecutiveErrors = value; },
        get consecutiveCooldowns() { return consecutiveCooldowns; },
        set consecutiveCooldowns(value) { consecutiveCooldowns = value; },
        recentErrorMessages,
      }, {
        emitIterationEnd: () => emitIterationEnd(),
        logIterationComplete: () => debugLog("autoLoop", { phase: "iteration-complete", iteration }),
      });
      consecutiveProjectionLockPauses = 0;
    };
    const finishIncompleteIteration = (details: Record<string, unknown>): void => {
      emitIterationEnd(details);
    };
    const waitForCredentialCooldown = async (
      retryAfterMs: number | undefined,
      errorMessage = "credential-cooldown",
    ): Promise<"retry" | "stop"> => {
      await closeRun("canceled", "credential-cooldown");
      consecutiveCooldowns++;
      const cooldownDecision = decideCooldownRecovery({
        consecutiveCooldowns,
        maxCooldownRetries: MAX_COOLDOWN_RETRIES,
        retryAfterMs,
        fallbackWaitMs: COOLDOWN_FALLBACK_WAIT_MS,
      });
      debugLog("autoLoop", {
        phase: "cooldown-wait",
        iteration,
        consecutiveCooldowns,
        retryAfterMs,
      });
      if (cooldownDecision.action === "stop") {
        const crashNotePath = persistCrashNote(s, "cooldown-exhausted", errorMessage, observedUnitType, observedUnitId);
        ctx.ui.notify(
          `${cooldownDecision.notifyMessage}${crashNotePath ? ` Crash note: ${crashNotePath}` : ""} Run /gsd auto to resume from the last checkpoint.`,
          "error",
        );
        finishIncompleteIteration({ status: "stopped", reason: "credential-cooldown-exhausted" });
        finishTurn("stopped", "timeout", errorMessage, "credential-cooldown-exhausted");
        await deferStopAuto(ctx, pi, cooldownDecision.stopMessage);
        return "stop";
      }
      ctx.ui.notify(cooldownDecision.notifyMessage, "warning");
      await new Promise(resolve => setTimeout(resolve, cooldownDecision.waitMs));
      finishIncompleteIteration({ status: "retry", reason: "cooldown-retry" });
      finishTurn("retry", "timeout", errorMessage, "credential-cooldown");
      return "retry";
    };

    // ── Shared adjudication boundary (ADR-047) ──────────────────────────────
    // The try opens BEFORE the preflight exits (max-iteration, memory pressure,
    // missing command context) so their pending block signatures reach the
    // finally that adjudicates them. Breaking out of the loop from inside a try
    // still runs its finally, so a preflight exit persists a wedge instead of
    // silently recurring after every restart (#1672).
    try {
      const iterationDecision = decideWorkflowLoop({
        active: s.active,
        iteration,
        maxIterations: MAX_LOOP_ITERATIONS,
        hasCommandContext: true,
        sessionLockValid: true,
      });
      if (iterationDecision.action === "stop" && iterationDecision.reason === "max-iterations") {
        debugLog("autoLoop", {
          phase: "exit",
          reason: iterationDecision.reason,
          iteration,
        });
        await deferStopAuto(
          ctx,
          pi,
          `Safety: loop exceeded ${MAX_LOOP_ITERATIONS} iterations — possible runaway`,
        );
        finishTurn("stopped", "manual-attention", "max-iterations", "max-iterations");
        break;
      }

      // ── Memory pressure check (#3331) ──
      // Graceful shutdown before OOM killer sends SIGKILL.
      if (shouldCheckMemoryPressure(iteration, MEMORY_CHECK_INTERVAL)) {
        const mem = (deps.measureMemoryPressure ?? measureMemoryPressure)();
        debugLog("autoLoop", { phase: "memory-check", ...mem });
        const memoryDecision = decideMemoryPressure({ ...mem, iteration });
        if (memoryDecision.action === "stop") {
          logWarning("dispatch", memoryDecision.warningMessage);
          await deferStopAuto(ctx, pi, memoryDecision.stopMessage);
          finishTurn("stopped", "timeout", memoryDecision.turnError, "memory-pressure");
          break;
        }
      }

      const commandContextDecision = decideWorkflowLoop({
        active: s.active,
        iteration,
        maxIterations: MAX_LOOP_ITERATIONS,
        hasCommandContext: typeof s.cmdCtx?.newSession === "function",
        sessionLockValid: true,
      });
      if (commandContextDecision.action === "stop" && commandContextDecision.reason === "missing-command-context") {
        debugLog("autoLoop", { phase: "exit", reason: "no-cmdCtx" });
        if (s.currentUnit) {
          await deps.autoCommitUnit?.(
            s.basePath,
            s.currentUnit.type,
            s.currentUnit.id,
            ctx,
          );
        }
        await deferStopAuto(ctx, pi, commandContextDecision.message, { preserveWorktree: true });
        finishTurn("stopped", "manual-attention", commandContextDecision.reason, "missing-command-context");
        break;
      }

      // ── Blanket try/catch: one bad iteration must not kill the session
      const prefs = deps.loadEffectiveGSDPreferences()?.preferences;
      const uokFlags = resolveUokFlags(prefs);

      if (await handlePendingHookOutcome({ s, ctx, pi, pauseAuto: deps.pauseAuto })) {
        finishTurn("stopped", "manual-attention", "gate-blocked", "gate-blocked");
        break;
      }

      // ── Check sidecar queue before deriveState ──
      // NOTE: Sidecar dequeue MUST run before validateWorkflowSessionLock so a
      // queued item is popped (and the `sidecar-dequeue` journal event emitted)
      // even when the session lock invalidates this iteration. Inverting this
      // order silently drops queued items on lock-loss. Refs #5308.
      const sidecarItem = await dequeueSidecarItem({
        queue: s.sidecarQueue,
        executionGraphEnabled: uokFlags.executionGraph,
        scheduleQueue: scheduleSidecarQueue,
        warnSchedulingFailure: message => logWarning("dispatch", `sidecar queue scheduling failed: ${message}`),
        logDequeue: payload => debugLog("autoLoop", { phase: "sidecar-dequeue", ...payload }),
        emitDequeue: payload => journalReporter.emit("sidecar-dequeue", payload),
      });

      const sessionLockOutcome = validateWorkflowSessionLock({
        active: s.active,
        iteration,
        maxIterations: MAX_LOOP_ITERATIONS,
        deps: {
          lockBase: deps.lockBase,
          validateSessionLock: deps.validateSessionLock,
          handleLostSessionLock: lockStatus => deps.handleLostSessionLock(ctx, lockStatus),
          logInvalidSessionLock: details => debugLog("autoLoop", {
            phase: "session-lock-invalid",
            ...details,
          }),
          logSessionLockExit: details => debugLog("autoLoop", {
            phase: "exit",
            ...details,
          }),
        },
      });
      if (sessionLockOutcome.action === "stop" && sessionLockOutcome.reason === "session-lock-lost") {
        finishTurn("stopped", "manual-attention", sessionLockOutcome.reason, "session-lock-lost");
        break;
      }

      const ic: IterationContext = {
        ctx,
        pi,
        s,
        deps: iterationDeps,
        prefs,
        iteration,
        flowId,
        nextSeq,
      };
      journalReporter.emit("iteration-start", { iteration });

      // ── Custom engine path ──────────────────────────────────────────────
      // When activeEngineId is a non-dev value, the custom engine drives its own
      // state via GRAPH.yaml. It shares guards and Unit execution with the dev
      // path, then verifies and reconciles via the engine layer.
      //
      // GSD_ENGINE_BYPASS=1 skips the engine layer entirely — falls through
      // to the dev path below.
      if (shouldUseCustomEnginePath({
        activeEngineId: s.activeEngineId,
        hasSidecarItem: Boolean(sidecarItem),
        engineBypass: process.env.GSD_ENGINE_BYPASS === "1",
      })) {
        debugLog("autoLoop", { phase: "custom-engine-derive", iteration, engineId: s.activeEngineId });

        const { engine, policy } = resolveEngine({
          activeEngineId: s.activeEngineId,
          activeRunDir: s.activeRunDir,
        });

        const engineState = await engine.deriveState(s.canonicalProjectRoot);
        debugLog("autoLoop", {
          phase: "post-derive",
          site: "custom-engine-derive",
          basePath: s.basePath,
          originalBasePath: s.originalBasePath,
          scopeProjectRoot: s.scope?.workspace.projectRoot,
          canonicalProjectRoot: s.canonicalProjectRoot,
          derivedPhase: (engineState as { phase?: string }).phase,
          isComplete: engineState.isComplete,
        });
        if (engineState.isComplete) {
          finishTurn("completed", "none", undefined, null);
          emitIterationEnd({ status: "completed", reason: "custom-engine-complete" });
          await deferStopAuto(ctx, pi, "Workflow complete");
          break;
        }

        debugLog("autoLoop", { phase: "custom-engine-dispatch", iteration });
        const dispatch = await engine.resolveDispatch(engineState, { basePath: s.basePath });
        const engineDispatchDecision = decideEngineDispatch(dispatch.action === "stop"
          ? { action: "stop", reason: dispatch.reason }
          : { action: dispatch.action });
        const dispatchFlow = await handleCustomEngineDispatchOutcome({
          decision: engineDispatchDecision,
          deps: {
            stopAuto: reason => deferStopAuto(ctx, pi, reason),
          },
        });
        if (dispatchFlow.action === "break") {
          finishTurn(
            "stopped",
            "manual-attention",
            dispatchFlow.inputPayload,
            "custom-engine-dispatch-stop",
            dispatchFlow.inputPayload,
          );
          finishIncompleteIteration({
            status: "stopped",
            reason: "custom-engine-dispatch-stop",
            failureClass: "manual-attention",
          });
          break;
        }
        if (dispatchFlow.action === "continue") {
          finishTurn("skipped", "none", "custom-engine-dispatch-skip", "custom-engine-dispatch-skip");
          emitIterationEnd({ status: "skipped", reason: "custom-engine-dispatch-skip" });
          continue;
        }

        // dispatch.action === "dispatch"
        if (dispatch.action !== "dispatch") {
          finishTurn("skipped", "none", "custom-engine-dispatch-mismatch", "custom-engine-dispatch-mismatch");
          emitIterationEnd({ status: "skipped", reason: "custom-engine-dispatch-mismatch" });
          continue;
        }
        const step = dispatch.step;
        iterData = await buildCustomEngineIterationData({
          step,
          basePath: s.basePath,
          canonicalProjectRoot: s.canonicalProjectRoot,
          currentMilestoneId: s.currentMilestoneId,
          deriveState: deps.deriveState,
          logPostDerive: details => debugLog("autoLoop", {
            phase: "post-derive",
            ...details,
          }),
        });
        const customIterData = iterData;
        observedUnitType = customIterData.unitType;
        observedUnitId = customIterData.unitId;

        let customDispatchId: number | null = null;
        let customDispatchSettled = false;

        // ── Progress widget (mirrors the dev path) ──
        deps.updateProgressWidget(ctx, iterData.unitType, iterData.unitId, iterData.state);

        // ── Guards (shared with dev path) ──
        const guardsResult = await runGuards(ic, s.currentMilestoneId ?? "workflow");
        phaseReporter.report("guard", guardsResult.action, {
          unitType: iterData.unitType,
          unitId: iterData.unitId,
        });
        if (guardsResult.action === "break") {
          finishTurn(
            "stopped",
            "manual-attention",
            guardsResult.reason,
            guardsResult.reason,
            guardsResult.inputPayload,
          );
          finishIncompleteIteration({
            status: "stopped",
            reason: guardsResult.reason,
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            failureClass: "manual-attention",
          });
          break;
        }

        // ── Unit execution (shared with dev path) ──
        await enforceMinRequestInterval(s, prefs);
        if (iterData.unitType === "execute-task") {
          const lease = ensureDispatchLease(s, iterData.mid, {
            claimMilestoneLease,
            logLeaseRecovered: logDispatchLeaseRecovered,
            logLeaseRecoveryFailed: logDispatchLeaseRecoveryFailed,
          });
          if (lease.kind !== "ready") {
            throw new Error(`Custom engine execute-task requires a canonical milestone lease: ${lease.reason}`);
          }
          const claim = openDispatchClaim(s, flowId, turnId, iterData, {
            getRecentDispatchesForUnit,
            recordDispatchClaim,
            markDispatchRunning,
            logClaimRejected: logDispatchClaimRejected,
            logClaimFailed: logDispatchClaimFailed,
            isDispatchOwnerDead: IS_DISPATCH_OWNER_DEAD,
            reclaimDeadDispatchOwner: RECLAIM_DEAD_DISPATCH_OWNER,
          });
          if (claim.kind !== "opened") {
            const reason = claim.kind === "skip" || claim.kind === "degraded"
              ? claim.reason
              : "dispatch claim degraded";
            throw new Error(`Custom engine execute-task requires a canonical coordination dispatch: ${reason}`);
          }
          customDispatchId = claim.dispatchId;
          dispatchId = customDispatchId;
        }
        let unitPhaseResult: Awaited<ReturnType<typeof runUnitPhaseViaContract>>;
        try {
          s.unitExecutionInFlight = true;
          ownsUnitExecution = true;
          unitPhaseResult = await runWithWorkerHeartbeat(
            s,
            workerHeartbeatDeps,
            WORKER_HEARTBEAT_INTERVAL_MS,
            () => (deps.taskExecutionBoundary ?? runWithTaskExecutionAttempt)(
              {
                unitType: customIterData.unitType,
                unitId: customIterData.unitId,
                dispatchId: customDispatchId,
                workerId: s.workerId,
                milestoneLeaseToken: s.milestoneLeaseToken,
                traceId: flowId,
                turnId,
                markCanonicalDispatchSettled() {
                  customDispatchSettled = true;
                },
              },
              () => runUnitPhaseViaContract(
                dispatchContract,
                ic,
                customIterData,
                loopState,
                undefined,
                unitDispatchDeps,
              ),
              TASK_EXECUTION_CUTOVER_DEPS,
            ),
          );
        } catch (err) {
          if (err instanceof ModelPolicyDispatchBlockedError) {
            throw err;
          }
          await closeOutCrashedUnit(ctx, s, deps, iterData, err);
          customDispatchSettled = settleDispatchIfNeeded(customDispatchSettled, () =>
            settleDispatchFailed(customDispatchId, formatDispatchExceptionSummary({ error: err }), {
              markFailed: markDispatchFailed,
              logWriteFailure: logDispatchLedgerWriteFailure,
            }));
          dispatchSettled = customDispatchSettled;
          throw err;
        }
        if (unitPhaseResult.action === "next") {
          const requestTimestamp = resolveUnitRequestTimestamp(unitPhaseResult.data);
          if (requestTimestamp !== undefined) s.lastRequestTimestamp = requestTimestamp;
        }
        phaseReporter.report("unit", unitPhaseResult.action, {
          unitType: iterData.unitType,
          unitId: iterData.unitId,
        });
        if (unitPhaseResult.action === "break") {
          const breakReason = unitPhaseResult.reason ?? "unit-break";
          customDispatchSettled = settleDispatchIfNeeded(customDispatchSettled, () =>
            settleDispatchFailed(customDispatchId, breakReason, {
              markFailed: markDispatchFailed,
              logWriteFailure: logDispatchLedgerWriteFailure,
            }, exitReasonForBreak(breakReason)));
          if (customDispatchId !== null && !customDispatchSettled) {
            throw new Error(`Could not terminalize custom-engine dispatch ${customDispatchId} after unit break`);
          }
          dispatchSettled = customDispatchSettled;
          await closeRun("failed", breakReason, exitReasonForBreak(breakReason));
          await pauseForTaskRecoveryAbort(breakReason);
          finishIncompleteIteration({
            status: "stopped",
            reason: breakReason,
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            failureClass: "execution",
          });
          finishTurn("stopped", "execution", breakReason, "unit-break");
          break;
        }
        if (unitPhaseResult.action === "retry") {
          if (unitPhaseResult.reason === "credential-cooldown") {
            const cooldown = await waitForCredentialCooldown(unitPhaseResult.data?.retryAfterMs);
            if (cooldown === "stop") break;
            continue;
          }
          customDispatchSettled = settleDispatchIfNeeded(customDispatchSettled, () =>
            settleDispatchFailed(customDispatchId, unitPhaseResult.reason, {
              markFailed: markDispatchFailed,
              logWriteFailure: logDispatchLedgerWriteFailure,
            }));
          if (customDispatchId !== null && !customDispatchSettled) {
            throw new Error(`Could not terminalize custom-engine dispatch ${customDispatchId} before unit retry`);
          }
          dispatchSettled = customDispatchSettled;
          const retryStopReason = await closeRun("retry", unitPhaseResult.reason);
          if (retryStopReason) {
            finishRetryCloseoutPause(retryStopReason);
            break;
          }
          finishIncompleteIteration({
            status: "retry",
            reason: unitPhaseResult.reason,
            retry: true,
            unitType: iterData.unitType,
            unitId: iterData.unitId,
          });
          finishTurn("retry", "execution", unitPhaseResult.reason, "unit-retry");
          continue;
        }

        if (iterData.customEnginePreparation === "task-replan") {
          const prepared = verifyExpectedArtifact(iterData.unitType, iterData.unitId, s.basePath);
          phaseReporter.report("custom-engine", prepared ? "complete" : "retry", {
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            preparation: iterData.customEnginePreparation,
          });
          if (!prepared) {
            finishIncompleteIteration({
              status: "retry",
              reason: "custom-engine-task-replan-not-durable",
              retry: true,
              unitType: iterData.unitType,
              unitId: iterData.unitId,
            });
            finishTurn("retry", "verification", "custom-engine-task-replan-not-durable", "custom-engine-task-replan");
            continue;
          }
          deps.clearUnitTimeout();
          completeIteration();
          finishTurn("completed", "none", undefined, null);
          continue;
        }

        // ── Verify first, then reconcile (only mark complete on pass) ──
        debugLog("autoLoop", { phase: "custom-engine-verify", iteration, unitId: iterData.unitId });
        let humanReviewPolicy = false;
        try {
          humanReviewPolicy = policy.requiresHumanVerification?.(iterData.unitType, iterData.unitId) === true;
        } catch (error) {
          debugLog("autoLoop", {
            phase: "custom-engine-human-verification-policy-error",
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        const hostVerification = deps.customEngineHostVerificationBoundary ?? runCustomEngineHostVerification;
        // ADR-047 §3: the signature must hash every input this turn read, in read
        // order. Host verification can decide without ever reaching the policy
        // (stored verdict, recovery route, missing repository, source drift),
        // after catching a policy error, or a second time once interactive human
        // review resolved the blocker. Each read appends here and
        // composeVerificationInputPayload orders them, so a later decisive read
        // can never be shadowed by an earlier one (#1674).
        const verificationReads: VerificationRead[] = [];
        const verificationInput = {
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          basePath: s.basePath,
          preferences: prefs,
          humanReviewPolicy,
          recordHostEvidence: (evidence: HostVerificationEvidence) => {
            verificationReads.push({ source: "host", evidence });
          },
          verifyPolicy: async () => {
            if (policy.verifyWithEvidence) {
              const result = await policy.verifyWithEvidence(
                customIterData.unitType,
                customIterData.unitId,
                { basePath: s.basePath },
              );
              verificationReads.push({ source: "policy", evidence: result.inputPayload });
              return result.outcome;
            }
            const outcome = await policy.verify(customIterData.unitType, customIterData.unitId, { basePath: s.basePath });
            verificationReads.push({ source: "policy", evidence: JSON.stringify({ outcome }) });
            return outcome;
          },
        };
        let verifyResult = await hostVerification(verificationInput);
        if (verifyResult === "pause" &&
            iterData.unitType === "execute-task" &&
            ctx.hasUI) {
          try {
            if (!s.workerId) {
              throw new Error("Human-review response requires the active worker identity");
            }
            const actorId = s.cmdCtx?.sessionManager?.getSessionId?.() ?? s.workerId;
            const resolution = await resolvePendingCustomTaskHumanReview({
              unitId: iterData.unitId,
              responseIdentity: {
                actorId,
                workerId: s.workerId,
                traceId: flowId,
                turnId,
              },
              requestReview: input => requestCustomTaskHumanReviewFromUi(ctx.ui, input),
            });
            if (resolution === "resolved" || resolution === "dismissed") {
              verifyResult = await hostVerification(verificationInput);
            }
          } catch (error) {
            debugLog("autoLoop", {
              phase: "custom-engine-human-review-response-error",
              unitType: iterData.unitType,
              unitId: iterData.unitId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const verificationInputPayload = composeVerificationInputPayload({
          outcome: verifyResult,
          reads: verificationReads,
        });
        if (iterData.unitType === "execute-task" && (verifyResult === "retry" || verifyResult === "abort")) {
          const verifyFlow = handleCustomEngineTaskVerifyOutcome({
            outcome: verifyResult,
            inputPayload: verificationInputPayload,
            finishTurn,
          });
          const reason = verifyResult === "abort"
            ? "custom-engine-task-verify-abort"
            : "custom-engine-task-verify-retry";
          finishIncompleteIteration({
            status: verifyResult === "abort" ? "stopped" : "retry",
            reason,
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            failureClass: "verification",
          });
          if (verifyFlow.action === "break") break;
          continue;
        }
        if (verifyResult === "pause") {
          const verifyFlow = await handleCustomEngineVerifyPause({
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            inputPayload: verificationInputPayload,
            deps: {
              pauseAuto: () => deps.pauseAuto(ctx, pi),
              stopAuto: reason => deferStopAuto(ctx, pi, reason),
              reportPause: details => phaseReporter.report("custom-engine", "pause", details),
              finishTurn,
            },
          });
          if (verifyFlow.action === "break") {
            finishIncompleteIteration({
              status: "paused",
              reason: "custom-engine-verify-pause",
              unitType: iterData.unitType,
              unitId: iterData.unitId,
              failureClass: "manual-attention",
            });
            break;
          }
        }
        if (verifyResult === "retry") {
          const retryOutcome = await handleCustomEngineVerifyRetry({
            session: s,
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            basePath: s.basePath,
            iteration,
            maxRetries: MAX_CUSTOM_ENGINE_VERIFY_RETRIES,
            deps: {
              hydrateRetryCounts: () => hydrateCustomVerifyRetryCounts(s, {
                logFailure: logCustomVerifyRetryLoadFailure,
              }),
              saveRetryCounts: () => saveCustomVerifyRetryCounts(s, {
                logFailure: logCustomVerifyRetrySaveFailure,
              }),
              recover: (unitType, unitId, options) => policy.recover(unitType, unitId, options),
              logRetry: details => debugLog("autoLoop", {
                phase: "custom-engine-verify-retry",
                ...details,
              }),
              reportRetry: details => phaseReporter.report("custom-engine", "retry", details),
            },
          });
          const retryFlow = await handleCustomEngineVerifyRetryOutcome({
            outcome: retryOutcome,
            inputPayload: verificationInputPayload,
            deps: {
              pauseAuto: () => deps.pauseAuto(ctx, pi),
              stopAuto: reason => deferStopAuto(ctx, pi, reason),
              reportPause: details => phaseReporter.report("custom-engine", "pause", details),
              finishTurn,
            },
          });
          if (retryFlow.action === "break") {
            finishIncompleteIteration({
              status: retryOutcome.action === "stop" ? "stopped" : "paused",
              reason: retryOutcome.action === "retry" ? "custom-engine-verify-retry" : retryOutcome.turnError,
              unitType: iterData.unitType,
              unitId: iterData.unitId,
              failureClass: "manual-attention",
            });
            break;
          }
          finishIncompleteIteration({
            status: "retry",
            reason: "custom-engine-verify-retry",
            unitType: iterData.unitType,
            unitId: iterData.unitId,
          });
          continue;
        }

        if (iterData.unitType === "execute-task") {
          try {
            await (deps.taskPublicationBoundary ?? publishVerifiedTaskExecution)({
              unitType: iterData.unitType,
              unitId: iterData.unitId,
              workerId: s.workerId,
              traceId: flowId,
              turnId,
              basePath: s.basePath,
            }, VERIFIED_TASK_PUBLICATION_DEPS);
          } catch (publishErr) {
            const publishReason = publishErr instanceof Error ? publishErr.message : String(publishErr);
            await closeRun("failed", publishReason);
            ctx.ui.notify(publishReason, "error");
            finishIncompleteIteration({
              status: "stopped",
              reason: publishReason,
              unitType: iterData.unitType,
              unitId: iterData.unitId,
              failureClass: "closeout",
            });
            finishTurn("stopped", "closeout", publishReason, "task-publication-failed");
            await deferStopAuto(ctx, pi, publishReason);
            break;
          }
        }

        await closeRun("completed", "custom-engine-iteration-complete");

        // Verification passed — mark step complete
        const reconcileOutcome = await handleCustomEngineReconcile({
          session: s,
          engineState,
          iterData,
          iteration,
          deps: {
            saveRetryCounts: () => saveCustomVerifyRetryCounts(s, {
              logFailure: logCustomVerifyRetrySaveFailure,
            }),
            logReconcile: details => debugLog("autoLoop", {
              phase: "custom-engine-reconcile",
              ...details,
            }),
            reconcile: (state, completedStep) => engine.reconcile(state, completedStep),
            now: () => Date.now(),
            clearUnitTimeout: deps.clearUnitTimeout,
            completeIteration,
          },
        });
        const reconcileFlow = await handleCustomEngineReconcileOutcome({
          outcome: reconcileOutcome,
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          deps: {
            stopAuto: reason => deferStopAuto(ctx, pi, reason),
            pauseAuto: () => deps.pauseAuto(ctx, pi),
            report: (action, details) => phaseReporter.report("custom-engine", action, details),
            finishTurn,
          },
        });
        if (reconcileFlow.action === "break") break;
        if (s.stepMode) {
          if (ctx.hasUI) {
            ctx.ui.setWidget?.("gsd-progress", undefined);
            setAutoOutcomeWidget(ctx, {
              status: "step",
              title: "Step complete",
              detail: `Completed ${unitVerb(iterData.unitType)} ${iterData.unitId}.`,
              unitLabel: `${unitVerb(iterData.unitType)} ${iterData.unitId}`,
              nextAction: "Advance one step, or resume automatic mode.",
              commands: ["/gsd next", "/gsd auto", "/gsd status for overview"],
              startedAt: s.autoStartTime,
            });
          }
          ctx.ui.setStatus("gsd-auto", "next");
          ctx.ui.notify(
            `Step complete: ${unitVerb(iterData.unitType)} ${iterData.unitId}. Run /gsd next for the next step, or /gsd auto to continue automatically.`,
            "info",
          );
          s.preserveStepSurfaceAfterLoopExit = true;
          break;
        }
        continue;
      }

      if (!sidecarItem) {
        const orchestration = s.orchestration;
        if (orchestration) {
          const existingPendingDispatch = s.pendingOrchestrationDispatch;
          let orchestrationResult = existingPendingDispatch
            ? {
                kind: "advanced" as const,
                unit: {
                  unitType: existingPendingDispatch.unitType,
                  unitId: existingPendingDispatch.unitId,
                },
                stateSnapshot: existingPendingDispatch.state,
                dispatchId: existingPendingDispatch.dispatchId ?? 0,
              }
            : await orchestration.advance();

          if (
            orchestrationResult.kind === "skipped" &&
            isUnitAlreadyActiveSkip(orchestrationResult) &&
            !s.unitExecutionInFlight
          ) {
            s.pendingOrchestrationDispatch = null;
            await deferStopAuto(ctx, pi, markBlockedStopReason(orchestrationResult.reason));
            finishTurn(
              "stopped",
              "none",
              orchestrationResult.reason,
              "orchestration-stale-active-unit",
            );
            finishIncompleteIteration({
              status: "stopped",
              reason: orchestrationResult.reason,
              failureClass: "manual-attention",
            });
            break;
          }

          if (orchestrationResult.kind === "blocked") {
            s.pendingOrchestrationDispatch = null;
            const blockMessage = orchestrationResult.terminalOutcome?.code === "settlement-blocked"
              ? [
                  orchestrationResult.terminalOutcome.displayReason,
                  `Next: ${orchestrationResult.terminalOutcome.nextAction}`,
                ].join("\n")
              : orchestrationResult.reason;
            if (orchestrationResult.action === "pause") {
              await deps.pauseAuto(ctx, pi, {
                message: blockMessage,
                category: "unknown",
              }, {
                expectedCurrentUnit: null,
              });
              finishTurn("paused", "manual-attention", "orchestration-blocked", null);
            } else {
              // Carry the blocked marker: the headless host picks its exit code
              // from the reason string, so an unmarked blocked stop exits 0 and
              // reports success over a milestone that never closed.
              await deferStopAuto(ctx, pi, markBlockedStopReason(blockMessage));
              finishTurn("stopped", "manual-attention", "orchestration-blocked", null);
            }
            finishIncompleteIteration({
              status: orchestrationResult.action === "pause" ? "paused" : "stopped",
              reason: orchestrationResult.reason,
              failureClass: "manual-attention",
            });
            break;
          }

          if (orchestrationResult.kind === "skipped") {
            s.pendingOrchestrationDispatch = null;
            if (isUnitAlreadyActiveSkip(orchestrationResult)) {
              emitIterationEnd({ skipped: true });
              completeIteration();
              if (s.unitExecutionInFlight) {
                finishTurn("skipped", "none", undefined, null);
                continue;
              }
              const staleState = orchestrationResult.stateSnapshot;
              finishTurn(
                "skipped",
                "none",
                [
                  orchestrationResult.reason,
                  staleState?.phase,
                  staleState?.activeMilestone?.id,
                  staleState?.activeSlice?.id,
                  staleState?.activeTask?.id,
                ].join("|"),
                "orchestration-stale-active-unit",
              );
              continue;
            }
            const skipState = orchestrationResult.stateSnapshot;
            const skipKey = [
              orchestrationResult.reason,
              skipState?.phase,
              skipState?.activeMilestone?.id,
              skipState?.activeSlice?.id,
              skipState?.activeTask?.id,
            ].join("|");
            emitIterationEnd({ skipped: true });
            completeIteration();
            finishTurn("skipped", "none", skipKey, "orchestration-skip");
            continue;
          }

          if (orchestrationResult.kind === "paused") {
            s.pendingOrchestrationDispatch = null;
            const pausedMsg = orchestrationResult.reason ?? "orchestration transient pause";
            const backoffMs = orchestrationResult.backoffMs;
            const projectionLockTransient = (
              orchestrationResult.failureKind === "projection-lock-transient" ||
              isTransientProjectionLockError(pausedMsg)
            ) && Array.isArray(backoffMs) && backoffMs.length > 0;
            const projectionLockBackoffMs = projectionLockTransient ? backoffMs ?? [] : [];
            let pauseAttempt: number;
            if (projectionLockTransient) {
              // Projection-root contention owns a longer class-specific schedule.
              // It must not consume the generic three-error budget: doing so made
              // every entry after 2s unreachable. Stop only after every scheduled
              // wait has run, and keep the exhaustion out of ADR-047 because an
              // unchanged lock error is not evidence of a deterministic wedge.
              consecutiveProjectionLockPauses++;
              pauseAttempt = consecutiveProjectionLockPauses;
              if (pauseAttempt > projectionLockBackoffMs.length) {
                const stopMessage =
                  `projection root remained busy after ${projectionLockBackoffMs.length} transient retries`;
                ctx.ui.notify(`Auto-mode stopped: ${stopMessage}.`, "error");
                await deferStopAuto(ctx, pi, markBlockedStopReason(stopMessage));
                finishTurn("stopped", "execution", pausedMsg, null);
                finishIncompleteIteration({
                  status: "stopped",
                  reason: pausedMsg,
                  failureClass: "execution",
                });
                break;
              }
            } else {
              consecutiveProjectionLockPauses = 0;
              // ADR-047: other transient-retry pauses still consume the generic
              // consecutive-error budget and feed the liveness ledger.
              consecutiveErrors++;
              pauseAttempt = consecutiveErrors;
              recentErrorMessages.push(pausedMsg.length > 120 ? pausedMsg.slice(0, 120) + "..." : pausedMsg);
              const pausedDecision = decideIterationErrorRecovery({
                consecutiveErrors,
                recentErrorMessages,
                currentErrorMessage: pausedMsg,
              });
              if (pausedDecision.action === "stop") {
                ctx.ui.notify(pausedDecision.notifyMessage, "error");
                await deferStopAuto(ctx, pi, markBlockedStopReason(pausedDecision.stopMessage));
                finishTurn("stopped", "execution", pausedMsg, "transient-retry-exhausted");
                finishIncompleteIteration({
                  status: "stopped",
                  reason: pausedMsg,
                  failureClass: "execution",
                });
                break;
              }
              if (pausedDecision.action === "invalidate-and-retry") {
                deps.invalidateAllCaches();
              }
            }
            // #1690 defect A: a transient pause carries the policy's bounded
            // backoff schedule — wait it out before re-entry instead of
            // immediately retrying a lock that needs time to clear.
            if (backoffMs && backoffMs.length > 0) {
              const waitMs = backoffMs[Math.min(Math.max(pauseAttempt, 1), backoffMs.length) - 1]!;
              ctx.ui.notify(
                `Transient pause (${pausedMsg}) — waiting ${Math.round(waitMs / 1000)}s before retrying.`,
                "warning",
              );
              await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
            }
            finishIncompleteIteration({
              status: "paused",
              reason: orchestrationResult.reason,
            });
            // #1690 defect B: a projection-lock transient pause must not feed
            // the deterministic strike counter — N identical os-error-32
            // strings would false-trip the liveness wedge. Other pause classes
            // keep the ADR-047 ledger behavior; projection locks stop through
            // their class-specific budget above.
            finishTurn(
              "skipped",
              "execution",
              pausedMsg,
              projectionLockTransient ? null : "orchestration-transient-pause",
            );
            continue;
          }

          if (orchestrationResult.kind === "error") {
            s.pendingOrchestrationDispatch = null;
            await deps.pauseAuto(ctx, pi, {
              message: orchestrationResult.reason,
              category: "unknown",
            });
            finishTurn("paused", "manual-attention", `orchestration-${orchestrationResult.kind}`, null);
            finishIncompleteIteration({
              status: "paused",
              reason: orchestrationResult.reason,
              failureClass: "manual-attention",
            });
            break;
          }

          if (orchestrationResult.kind === "stopped") {
            s.pendingOrchestrationDispatch = null;
            let completionStop = resolveCompletionStopFromOutcome(
              orchestrationResult.terminalOutcome,
              orchestrationResult.stateSnapshot,
            );
            completionStop ??= resolveCompletionStopFromState(orchestrationResult.stateSnapshot);
            if (completionStop) {
              await deferStopAuto(ctx, pi, completionStop.reason, completionStop.options);
            } else {
              await deferStopAuto(
                ctx,
                pi,
                orchestrationResult.reason,
              );
            }
            finishTurn(
              "stopped",
              "manual-attention",
              orchestrationResult.reason,
              completionStop || orchestrationResult.terminalOutcome ? null : "orchestration-stop",
            );
            break;
          }

          if (orchestrationResult.kind !== "advanced") {
            s.pendingOrchestrationDispatch = null;
            // ADR-047 §3: the decisive input here is the unexpected outcome
            // kind, so hash it rather than the constant label (#1674).
            finishTurn(
              "skipped",
              "none",
              "unknown orchestration outcome",
              "orchestration-unknown-outcome",
              JSON.stringify({ kind: orchestrationResult.kind }),
            );
            continue;
          }
          const pendingDispatch = s.pendingOrchestrationDispatch;
          iterData = {
            unitType: pendingDispatch?.unitType ?? orchestrationResult.unit.unitType,
            unitId: pendingDispatch?.unitId ?? orchestrationResult.unit.unitId,
            prompt: pendingDispatch?.prompt ?? "",
            finalPrompt: pendingDispatch?.prompt ?? "",
            pauseAfterUatDispatch: pendingDispatch?.pauseAfterUatDispatch ?? false,
            state: pendingDispatch?.state ?? orchestrationResult.stateSnapshot,
            mid: pendingDispatch?.mid ?? s.currentMilestoneId ?? "workflow",
            midTitle: pendingDispatch?.midTitle ?? orchestrationResult.stateSnapshot.activeMilestone?.title ?? "Workflow",
            isRetry: false,
            previousTier: undefined,
          };
          if (orchestrationResult.dispatchId > 0) {
            dispatchId = orchestrationResult.dispatchId;
          }
          const preDispatchResult = deps.runPreDispatchHooks(
            iterData.unitType,
            iterData.unitId,
            iterData.prompt,
            s.basePath,
          );
          if (preDispatchResult.firedHooks.length > 0) {
            ctx.ui.notify(
              `Pre-dispatch hook${preDispatchResult.firedHooks.length > 1 ? "s" : ""}: ${preDispatchResult.firedHooks.join(", ")}`,
              "info",
            );
            deps.emitJournalEvent({
              ts: new Date().toISOString(),
              flowId: ic.flowId,
              seq: ic.nextSeq(),
              eventType: "pre-dispatch-hook",
              data: {
                firedHooks: preDispatchResult.firedHooks,
                action: preDispatchResult.action,
              },
            });
          }
          if (preDispatchResult.action === "skip") {
            ctx.ui.notify(
              `Skipping ${iterData.unitType} ${iterData.unitId} (pre-dispatch hook).`,
              "info",
            );
            s.pendingOrchestrationDispatch = null;
            observedUnitType = iterData.unitType;
            observedUnitId = iterData.unitId;
            emitIterationEnd({ skipped: true });
            completeIteration();
            finishTurn(
              "skipped",
              "none",
              JSON.stringify({
                firedHooks: preDispatchResult.firedHooks,
                unitType: iterData.unitType,
                unitId: iterData.unitId,
              }),
              "pre-dispatch-hook-skip",
            );
            continue;
          }
          if (preDispatchResult.action === "replace") {
            iterData.prompt = preDispatchResult.prompt ?? iterData.prompt;
            iterData.finalPrompt = iterData.prompt;
            if (preDispatchResult.unitType) {
              iterData.unitType = preDispatchResult.unitType;
            }
          } else if (preDispatchResult.prompt) {
            iterData.prompt = preDispatchResult.prompt;
            iterData.finalPrompt = preDispatchResult.prompt;
          }
          if (preDispatchResult.model) {
            iterData.hookModelOverride = preDispatchResult.model;
          }
          s.pendingOrchestrationDispatch = null;
          phaseReporter.report("dispatch", "next", {
            unitType: iterData.unitType,
            unitId: iterData.unitId,
          });
          observedUnitType = iterData.unitType;
          observedUnitId = iterData.unitId;

          const guardMilestoneId = iterData.mid ?? s.currentMilestoneId ?? "workflow";
          const guardsResult = await runGuards(ic, guardMilestoneId);
          phaseReporter.report("guard", guardsResult.action, {
            unitType: iterData.unitType,
            unitId: iterData.unitId,
          });
          if (guardsResult.action === "break") {
            finishTurn(
              "stopped",
              "manual-attention",
              guardsResult.reason,
              guardsResult.reason,
              guardsResult.inputPayload,
            );
            finishIncompleteIteration({
              status: "stopped",
              reason: guardsResult.reason,
              unitType: iterData.unitType,
              unitId: iterData.unitId,
              failureClass: "manual-attention",
            });
            break;
          }
        } else {
          s.pendingOrchestrationDispatch = null;
          await deps.pauseAuto(ctx, pi, {
            message: ORCHESTRATION_MISSING_REASON,
            category: "unknown",
          });
          finishTurn("paused", "manual-attention", ORCHESTRATION_MISSING_REASON, "orchestration-missing");
          finishIncompleteIteration({
            status: "paused",
            reason: ORCHESTRATION_MISSING_REASON,
            failureClass: "manual-attention",
          });
          break;
        }
      } else {
        iterData = await buildSidecarIterationData({
          sidecarItem,
          basePath: s.basePath,
          canonicalProjectRoot: s.canonicalProjectRoot,
          deriveState: deps.deriveState,
          logPostDerive: details => debugLog("autoLoop", {
            phase: "post-derive",
            ...details,
          }),
        });
        observedUnitType = iterData.unitType;
        observedUnitId = iterData.unitId;
        phaseReporter.report("dispatch", "sidecar", {
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          sidecarKind: sidecarItem.kind,
        });
      }

      await enforceMinRequestInterval(s, prefs);

      if (!iterData) {
        throw new Error("iteration data missing after dispatch");
      }
      const unitIterData = iterData;

      if (dispatchId === null) {
      // Sidecar (and pending-dispatch tests without a UnitRun id) still claim
      // here. Canonical advance() already opened the unit_dispatches row.
      let leaseBeforeClaim = ensureDispatchLease(s, iterData.mid, {
        claimMilestoneLease,
        logLeaseRecovered: logDispatchLeaseRecovered,
        logLeaseRecoveryFailed: logDispatchLeaseRecoveryFailed,
      });
      if (leaseBeforeClaim.kind === "blocked" && leaseBeforeClaim.holderWorkerId) {
        const holderWorkerId = leaseBeforeClaim.holderWorkerId;
        if (isDeadLocalAutoWorker(holderWorkerId, s.canonicalProjectRoot)) {
          RECLAIM_DEAD_DISPATCH_OWNER(holderWorkerId);
          const retryLease = ensureDispatchLease(s, iterData.mid, {
            claimMilestoneLease,
            logLeaseRecovered: logDispatchLeaseRecovered,
            logLeaseRecoveryFailed: logDispatchLeaseRecoveryFailed,
          }, { forceReclaim: true });
          if (retryLease.kind === "ready") {
            leaseBeforeClaim = retryLease;
          } else {
            const msg = leaseConflictNotice(iterData, retryLease.reason);
            ctx.ui.notify(msg, "error");
            finishTurn("stopped", "execution", msg, "milestone-lease-conflict");
            await deferStopAuto(ctx, pi, msg);
            break;
          }
        }
      }
      if (leaseBeforeClaim.kind === "blocked" || leaseBeforeClaim.kind === "failed") {
        const msg = leaseConflictNotice(iterData, leaseBeforeClaim.reason);
        ctx.ui.notify(msg, "error");
        finishTurn("stopped", "execution", msg, "milestone-lease-conflict");
        await deferStopAuto(ctx, pi, msg);
        break;
      }

      const openClaim = deps.openDispatchClaim ?? openDispatchClaim;
      let dispatchClaim = openClaim(s, flowId, turnId, iterData, {
        getRecentDispatchesForUnit,
        recordDispatchClaim,
        markDispatchRunning,
        logClaimRejected: logDispatchClaimRejected,
        logClaimFailed: logDispatchClaimFailed,
        isDispatchOwnerDead: IS_DISPATCH_OWNER_DEAD,
        reclaimDeadDispatchOwner: RECLAIM_DEAD_DISPATCH_OWNER,
      });
      let dispatchDecision = decideDispatchClaim(
        dispatchClaim.kind === "opened"
          ? { kind: "opened", dispatchId: dispatchClaim.dispatchId }
          : dispatchClaim.kind === "skip"
            ? { kind: "skip", reason: dispatchClaim.reason }
            : { kind: "degraded", reason: dispatchClaim.reason },
      );
      if (dispatchDecision.action === "skip" && dispatchDecision.reason === "stale-lease") {
        const leaseRecovery = ensureDispatchLease(s, iterData.mid, {
          claimMilestoneLease,
          logLeaseRecovered: logDispatchLeaseRecovered,
          logLeaseRecoveryFailed: logDispatchLeaseRecoveryFailed,
        }, { forceReclaim: true });
        if (leaseRecovery.kind === "ready") {
          dispatchClaim = openClaim(s, flowId, turnId, iterData, {
            getRecentDispatchesForUnit,
            recordDispatchClaim,
            markDispatchRunning,
            logClaimRejected: logDispatchClaimRejected,
            logClaimFailed: logDispatchClaimFailed,
            isDispatchOwnerDead: IS_DISPATCH_OWNER_DEAD,
            reclaimDeadDispatchOwner: RECLAIM_DEAD_DISPATCH_OWNER,
          });
          dispatchDecision = decideDispatchClaim(
            dispatchClaim.kind === "opened"
              ? { kind: "opened", dispatchId: dispatchClaim.dispatchId }
              : dispatchClaim.kind === "skip"
                ? { kind: "skip", reason: dispatchClaim.reason }
                : { kind: "degraded", reason: dispatchClaim.reason },
          );
        } else {
          const msg = leaseConflictNotice(iterData, leaseRecovery.reason);
          ctx.ui.notify(msg, "error");
          finishTurn("stopped", "execution", msg, "milestone-lease-conflict");
          await deferStopAuto(ctx, pi, msg);
          break;
        }
      }
      if (dispatchDecision.action === "skip") {
        if (dispatchDecision.reason === "stale-lease") {
          const msg = leaseConflictNotice(iterData, "dispatch claim still failed after stale-lease recovery");
          ctx.ui.notify(msg, "error");
          finishTurn("stopped", "execution", msg, "dispatch-claim-stale-lease");
          await deferStopAuto(ctx, pi, msg);
          break;
        }
        finishTurn("skipped", "execution", dispatchDecision.reason, "dispatch-claim-skip");
        finishIncompleteIteration({
          status: "skipped",
          reason: dispatchDecision.reason,
          unitType: iterData.unitType,
          unitId: iterData.unitId,
        });
        continue;
      }
      if (dispatchDecision.action === "stop") {
        const msg = dispatchDecision.message;
        ctx.ui.notify(msg, "error");
        finishTurn("stopped", "execution", msg, "dispatch-claim-degraded");
        finishIncompleteIteration({
          status: "stopped",
          reason: msg,
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          failureClass: "execution",
        });
        await deferStopAuto(ctx, pi, msg);
        break;
      }
      dispatchId = dispatchDecision.dispatchId;
      }

      let unitPhaseResult: Awaited<ReturnType<typeof runUnitPhaseViaContract>>;
      try {
        s.unitExecutionInFlight = true;
        ownsUnitExecution = true;
        unitPhaseResult = await runWithWorkerHeartbeat(
          s,
          workerHeartbeatDeps,
          WORKER_HEARTBEAT_INTERVAL_MS,
          () => (deps.taskExecutionBoundary ?? runWithTaskExecutionAttempt)(
            {
              unitType: unitIterData.unitType,
              unitId: unitIterData.unitId,
              dispatchId,
              workerId: s.workerId,
              milestoneLeaseToken: s.milestoneLeaseToken,
              traceId: flowId,
              turnId,
              markCanonicalDispatchSettled() {
                dispatchSettled = true;
              },
            },
            () => runUnitPhaseViaContract(
              dispatchContract,
              ic,
              unitIterData,
              loopState,
              sidecarItem,
              unitDispatchDeps,
            ),
            TASK_EXECUTION_CUTOVER_DEPS,
          ),
        );
      } catch (err) {
        if (err instanceof ModelPolicyDispatchBlockedError) {
          throw err;
        }
        await closeOutCrashedUnit(ctx, s, deps, iterData, err);
        dispatchSettled = settleDispatchIfNeeded(dispatchSettled, () =>
          settleDispatchFailed(
            dispatchId,
            formatDispatchExceptionSummary({ error: err }),
            {
              markFailed: markDispatchFailed,
              logWriteFailure: logDispatchLedgerWriteFailure,
            },
          ));
        // #2127: the dispatch selector returns pendingVerificationRetry's unit
        // unconditionally, and a pre-claim failure (e.g. "Task Attempt claim
        // must activate exactly one matching coordination dispatch") escapes
        // the cutover boundary without consuming the marker. Leaving it armed
        // makes every iteration reselect the same unit. Discard the retry and
        // pause loudly instead.
        if (s.pendingVerificationRetry?.unitId === iterData.unitId) {
          s.pendingVerificationRetry = null;
          const retryFailure = formatDispatchExceptionSummary({ error: err });
          const retryPauseMessage =
            `Verification retry for ${iterData.unitType} ${iterData.unitId} failed before the unit started: ${retryFailure} ` +
            "The pending retry was discarded so the unit is not reselected. Resolve the failure, then run /gsd auto to resume.";
          ctx.ui.notify(retryPauseMessage, "error");
          finishIncompleteIteration({
            status: "stopped",
            reason: retryPauseMessage,
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            failureClass: "execution",
          });
          await deps.pauseAuto(ctx, pi, {
            message: retryPauseMessage,
            category: "unknown",
          });
          finishTurn("stopped", "execution", retryPauseMessage, null);
          break;
        }
        throw err;
      }
      if (unitPhaseResult.action === "next") {
        const requestTimestamp = resolveUnitRequestTimestamp(unitPhaseResult.data);
        if (requestTimestamp !== undefined) s.lastRequestTimestamp = requestTimestamp;
      }
      phaseReporter.report("unit", unitPhaseResult.action, {
        unitType: iterData.unitType,
        unitId: iterData.unitId,
      });
      if (
        unitPhaseResult.action === "next" &&
        iterData.unitType === "execute-task" &&
        !s.currentUnit &&
        isTaskExecutionReadyForHostVerification(iterData.unitType, iterData.unitId)
      ) {
        restoreTaskHostVerificationContext(ic, iterData.unitType, iterData.unitId);
      }
      if (unitPhaseResult.action === "break") {
        const breakReason = unitPhaseResult.reason ?? "unit-break";
        await closeRun("failed", breakReason, exitReasonForBreak(breakReason));
        await pauseForTaskRecoveryAbort(breakReason);
        finishIncompleteIteration({
          status: "stopped",
          reason: breakReason,
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          failureClass: "execution",
        });
        finishTurn("stopped", "execution", breakReason, "unit-break");
        break;
      }
      if (unitPhaseResult.action === "retry") {
        if (unitPhaseResult.reason === "credential-cooldown") {
          const cooldown = await waitForCredentialCooldown(unitPhaseResult.data?.retryAfterMs);
          if (cooldown === "stop") break;
          continue;
        }
        const retryStopReason = await closeRun("retry", unitPhaseResult.reason);
        if (retryStopReason) {
          finishRetryCloseoutPause(retryStopReason);
          break;
        }
        finishIncompleteIteration({
          status: "retry",
          reason: unitPhaseResult.reason,
          retry: true,
          unitType: iterData.unitType,
          unitId: iterData.unitId,
        });
        finishTurn("retry", "execution", unitPhaseResult.reason, "unit-retry");
        continue;
      }

      // ── Phase 5: Finalize ───────────────────────────────────────────────

      let finalizeResult: Awaited<ReturnType<typeof runFinalize>>;
      journalReporter.emit("post-unit-finalize-start", {
        iteration,
        unitType: iterData.unitType,
        unitId: iterData.unitId,
      });
      try {
        finalizeResult = await runFinalize(ic, iterData, loopState, sidecarItem, async () => {
          await (deps.taskPublicationBoundary ?? publishVerifiedTaskExecution)({
            unitType: unitIterData.unitType,
            unitId: unitIterData.unitId,
            workerId: s.workerId,
            traceId: flowId,
            turnId,
            basePath: s.basePath,
          }, VERIFIED_TASK_PUBLICATION_DEPS);
        });
      } catch (err) {
        const error = formatDispatchExceptionSummary({ error: err });
        journalReporter.emit("post-unit-finalize-end", {
          iteration,
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          status: "failed",
          error,
        });
        dispatchSettled = settleDispatchIfNeeded(dispatchSettled, () =>
          settleDispatchFailed(
            dispatchId,
            error,
            {
              markFailed: markDispatchFailed,
              logWriteFailure: logDispatchLedgerWriteFailure,
            },
          ));
        throw err;
      }
      phaseReporter.report("finalize", finalizeResult.action, {
        unitType: iterData.unitType,
        unitId: iterData.unitId,
      });
      const finalizeReason = finalizeResult.action === "break" ? finalizeResult.reason : undefined;
      const finalizeStatus = (finalizeReason === "step-wizard" || finalizeReason === "milestone-complete")
        ? "completed"
        : finalizeResult.action === "next"
          ? "completed"
          : finalizeResult.action === "continue"
            ? "retry"
            : "stopped";
      journalReporter.emit("post-unit-finalize-end", {
        iteration,
        unitType: iterData.unitType,
        unitId: iterData.unitId,
        status: finalizeStatus,
        action: finalizeResult.action,
        ...(finalizeReason ? { reason: finalizeReason } : {}),
      });
      const finalizeDecision = decideFinalizeResult(
        finalizeResult.action === "break"
          ? { action: "break", reason: finalizeResult.reason }
          : finalizeResult.action === "continue"
            ? {
                action: "continue",
                // Surface the specific verification failure (e.g. "roadmap has
                // zero slices") in the ledger/stuck-loop reason instead of the
                // opaque bare "finalize-retry" token. The retry paths in
                // runFinalize set s.pendingVerificationRetry.failureContext
                // from describeArtifactVerificationFailure before returning
                // continue; it is cleared on the next dispatch, so reading it
                // here captures the reason for THIS finalize (#852 follow-up).
                failureDetail: s.pendingVerificationRetry?.failureContext,
              }
            : { action: "next" },
      );
      if (finalizeDecision.action === "stop") {
        await closeRun("failed", finalizeDecision.ledgerErrorSummary);
        finishIncompleteIteration({
          status: "stopped",
          reason: finalizeReason ?? "finalize-break",
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          failureClass: finalizeDecision.failureClass,
        });
        finishTurn("stopped", finalizeDecision.failureClass, finalizeDecision.turnError, "finalize-break");
        break;
      }
      if (finalizeDecision.action === "retry") {
        abortActiveUnitTurn(ctx);
        const retryStopReason = await closeRun("retry", finalizeDecision.ledgerErrorSummary);
        if (retryStopReason) {
          finishRetryCloseoutPause(retryStopReason);
          break;
        }
        finishIncompleteIteration({
          status: "retry",
          reason: "finalize-retry",
          retry: true,
          unitType: iterData.unitType,
          unitId: iterData.unitId,
        });
        finishTurn(
          "retry",
          "closeout",
          finalizeDecision.ledgerErrorSummary,
          s.orchestration?.retryActiveUnit ? null : "finalize-retry",
        );
        continue;
      }

      await closeRun("completed", "iteration-complete");
      completeIteration();
      finishTurn("completed", "none", undefined, null);
      if (finalizeDecision.action === "complete-and-break") {
        if (!s.completionStopInProgress) {
          s.preserveStepSurfaceAfterLoopExit = true;
        }
        break;
      }
    } catch (loopErr) {
      // ── Blanket catch: absorb unexpected exceptions, apply graduated recovery ──
      const msg = loopErr instanceof Error ? loopErr.message : String(loopErr);
      if (!runClosed) {
        abnormalUnitExitReason = msg;
      }

      // ── Pre-send model-policy block: not a retryable error (#4959 / #4850) ──
      // The model-policy gate runs before the prompt is sent.  When every
      // candidate model is denied (cross-provider disabled + flat-rate
      // baseline + tool-policy denial), retrying the same unit produces the
      // same denial — burning the consecutive-error budget toward a 3-strike
      // hard stop and corrupting auto-mode state.  Pause for user attention
      // instead, with the per-model deny reasons surfaced from the typed
      // error.
      if (loopErr instanceof ModelPolicyDispatchBlockedError) {
        const policyDecision = decideModelPolicyBlocked({
          unitType: loopErr.unitType,
          unitId: loopErr.unitId,
          errorMessage: msg,
          reasons: loopErr.reasons,
        });
        debugLog("autoLoop", {
          phase: "model-policy-blocked",
          iteration,
          unitType: loopErr.unitType,
          unitId: loopErr.unitId,
          reasons: loopErr.reasons,
        });
        ctx.ui.notify(policyDecision.notifyMessage, "error");
        journalReporter.emit("unit-end", policyDecision.journalData);
        finishIncompleteIteration({
          status: "blocked",
          reason: "model-policy-dispatch-blocked",
          unitType: loopErr.unitType,
          unitId: loopErr.unitId,
        });
        // Carry the blocked unit identity into the turn-result observer:
        // the throw originated inside dispatch, so observedUnitType/Id were
        // not assigned by the success path at lines 453/631/647 — but the
        // typed error already names the unit (#4959).
        observedUnitType = loopErr.unitType;
        observedUnitId = loopErr.unitId;
        await deps.pauseAuto(ctx, pi);
        finishTurn(policyDecision.turnStatus, policyDecision.failureClass, msg, "model-policy-dispatch");
        // Do NOT increment consecutiveErrors — the failure is configuration,
        // not a transient runtime fault.
        break;
      }

      // Always emit iteration-end on error so the journal records iteration
      // completion even on failure (#2344). Without this, errors in
      // runFinalize leave the journal incomplete, making diagnosis harder.
      finishIncompleteIteration({ status: "failed", error: msg });

      // ── Infrastructure errors: immediate stop, no retry ──
      // These are unrecoverable (disk full, OOM, etc.). Retrying just burns
      // LLM budget on guaranteed failures.
      const infraCode = isInfrastructureError(loopErr);
      if (infraCode) {
        const infraDecision = decideInfrastructureError({
          code: infraCode,
          errorMessage: msg,
        });
        const crashNotePath = persistCrashNote(s, "infrastructure", msg, observedUnitType, observedUnitId);
        debugLog("autoLoop", {
          phase: "infrastructure-error",
          iteration,
          code: infraCode,
          error: msg,
        });
        ctx.ui.notify(
          `${infraDecision.notifyMessage}${crashNotePath ? ` Crash note: ${crashNotePath}` : ""} Run /gsd auto to resume from the last checkpoint.`,
          "error",
        );
        await deferStopAuto(ctx, pi, infraDecision.stopMessage);
        finishTurn(infraDecision.turnStatus, infraDecision.failureClass, msg, "infrastructure-error");
        break;
      }

      // ── Credential cooldown: wait and retry with bounded budget ──
      // A 429 triggers a 30s credential backoff in AuthStorage. If the SDK's
      // getApiKey() retries couldn't outlast the window, the error surfaces
      // here. Wait for the cooldown to clear rather than counting it as a
      // consecutive failure — but cap retries so we don't spin for hours
      // on persistent quota exhaustion.
      if (isTransientCooldownError(loopErr)) {
        const retryAfterMs = getCooldownRetryAfterMs(loopErr);
        const cooldown = await waitForCredentialCooldown(retryAfterMs, msg);
        if (cooldown === "stop") break;
        continue; // Retry iteration without incrementing consecutiveErrors
      }

      consecutiveErrors++;
      recentErrorMessages.push(msg.length > 120 ? msg.slice(0, 120) + "..." : msg);
      debugLog("autoLoop", {
        phase: "iteration-error",
        iteration,
        consecutiveErrors,
        error: msg,
      });

      const errorDecision = decideIterationErrorRecovery({
        consecutiveErrors,
        recentErrorMessages,
        currentErrorMessage: msg,
      });
      if (errorDecision.action === "stop") {
        const crashNotePath = persistCrashNote(s, "iteration-exhausted", msg, observedUnitType, observedUnitId);
        ctx.ui.notify(
          `${errorDecision.notifyMessage}${crashNotePath ? ` Crash note: ${crashNotePath}` : ""} Run /gsd auto to resume from the last checkpoint.`,
          "error",
        );
        await deferStopAuto(ctx, pi, errorDecision.stopMessage);
        finishTurn(errorDecision.turnStatus, "execution", msg, "iteration-error-exhausted");
        break;
      }
      if (errorDecision.action === "invalidate-and-retry") {
        ctx.ui.notify(errorDecision.notifyMessage, "warning");
        deps.invalidateAllCaches();
      } else {
        ctx.ui.notify(errorDecision.notifyMessage, "warning");
      }
      finishTurn(errorDecision.turnStatus, "execution", msg, "iteration-error");
    } finally {
      if (!runClosed && (dispatchId !== null || (observedUnitType && observedUnitId))) {
        await closeRun("failed", abnormalUnitExitReason);
      }
      if (ownsUnitExecution) {
        s.unitExecutionInFlight = false;
      }
      let backstopReason: string | null = null;
      if (pendingLoopLiveness) {
        const liveness = pendingLoopLiveness as {
          guardId: string;
          inputPayload: string;
          unitType: string;
          unitId: string;
        };
        const adjudicateNonAdvancingOutcome =
          deps.adjudicateNonAdvancingOutcome ?? recordLoopNonAdvancingOutcome;
        backstopReason = adjudicateNonAdvancingOutcome(s, {
          ...liveness,
          // ADR-047 §5: the wedge must name the owning guard's real,
          // state-mutating exit — not a generic "resolve the condition" —
          // because the refusal notice after a restart can only reprint what
          // was persisted here (#1672).
          sanctionedExit: resolveLoopSanctionedExit({
            guardId: liveness.guardId,
            unitType: liveness.unitType,
            unitId: liveness.unitId,
            failurePayload: liveness.inputPayload,
          }),
        });
        if (backstopReason) {
          ctx.ui.notify(backstopReason, "error");
          const queuedStop = pendingStopAuto as {
            reason?: string;
            options?: StopAutoOptions;
          } | null;
          pendingStopAuto = {
            reason: markBlockedStopReason(
              [queuedStop?.reason, backstopReason].filter((reason): reason is string => Boolean(reason)).join("\n"),
            ),
            options: queuedStop?.options,
          };
        }
      }
      if (pendingStopAuto) {
        const stop = pendingStopAuto as {
          reason?: string;
          options?: StopAutoOptions;
        };
        await deps.stopAuto(ctx, pi, stop.reason, stop.options);
      }
      if (backstopReason) {
        s.active = false;
      }
    }
  }

  _clearCurrentResolve();
  debugLog("autoLoop", { phase: "exit", totalIterations: iteration });
}

export async function runUokKernelLoop(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  deps: LoopDeps,
): Promise<void> {
  return autoLoop(ctx, pi, s, deps, { dispatchContract: "uok-scheduler" });
}

export async function runLegacyAutoLoop(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  deps: LoopDeps,
): Promise<void> {
  return autoLoop(ctx, pi, s, deps, { dispatchContract: "legacy-direct" });
}
