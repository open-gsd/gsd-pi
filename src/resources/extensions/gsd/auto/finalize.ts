// Project/App: gsd-pi
// File Purpose: Auto-loop finalize phase — post-unit verification and UAT pause.

import type { SidecarItem } from "./session.js";
import {
  type PostUnitContext,
  type PreVerificationOpts,
} from "../auto-post-unit.js";
import { clearCurrentPhase } from "../../shared/gsd-phase-state.js";
import { withTimeout, FINALIZE_PRE_TIMEOUT_MS, FINALIZE_POST_TIMEOUT_MS } from "./finalize-timeout.js";
import { writeUnitRuntimeRecord } from "../unit-runtime.js";
import { buildManualValidationGuidance } from "../worktree-manager.js";
import { relSliceFile } from "../paths.js";
import {
  detectRootWriteLeak,
  formatRootWriteLeakMessage,
} from "../root-write-leak-guard.js";
import {
  logWarning,
  drainLogs,
  drainAndSummarize,
  formatForNotification,
  hasAnyIssues,
} from "../workflow-logger.js";
import { debugLog } from "../debug-logger.js";
import { buildPhaseHandoffOutcome, setAutoOutcomeWidget } from "../auto-dashboard.js";
import {
  applyVerificationRetryPolicy,
  rememberRetryDispatch,
  _resolveCurrentUnitStartedAtForTest,
  isIsolatedWorktreeSession,
} from "./phase-helpers.js";
import { _runMilestoneMergeOnceWithStashRestore } from "./closeout.js";
import type { IterationContext, IterationData, LoopState, PhaseResult } from "./types.js";
import { MAX_FINALIZE_TIMEOUTS } from "./types.js";

export async function failClosedOnFinalizeTimeout(
  ic: IterationContext,
  iterData: IterationData,
  loopState: LoopState,
  stage: "pre" | "post",
  startedAt: number,
): Promise<PhaseResult> {
  const { ctx, pi, s, deps } = ic;
  const now = Date.now();
  const unitType = iterData.unitType;
  const unitId = iterData.unitId;
  const timeoutMs = stage === "pre" ? FINALIZE_PRE_TIMEOUT_MS : FINALIZE_POST_TIMEOUT_MS;
  const progressKind = stage === "pre" ? "finalize-pre-timeout" : "finalize-post-timeout";

  writeUnitRuntimeRecord(s.basePath, unitType, unitId, startedAt, {
    phase: "finalize-timeout",
    timeoutAt: now,
    lastProgressAt: now,
    lastProgressKind: progressKind,
  });

  deps.emitJournalEvent({
    ts: new Date(now).toISOString(),
    flowId: ic.flowId,
    seq: ic.nextSeq(),
    eventType: "unit-end",
    data: {
      unitType,
      unitId,
      status: "timed-out-finalize",
      artifactVerified: false,
      finalizeStage: stage,
    },
  });

  loopState.consecutiveFinalizeTimeouts++;
  debugLog("autoLoop", {
    phase: progressKind,
    iteration: ic.iteration,
    unitType,
    unitId,
    consecutiveTimeouts: loopState.consecutiveFinalizeTimeouts,
  });

  ctx.ui.notify(
    `${stage === "pre" ? "postUnitPreVerification" : "postUnitPostVerification"} timed out after ${timeoutMs / 1000}s for ${unitType} ${unitId} (${loopState.consecutiveFinalizeTimeouts}/${MAX_FINALIZE_TIMEOUTS}) — pausing auto-mode for recovery.`,
    "warning",
  );

  await deps.pauseAuto(ctx, pi);
  s.clearCurrentUnit();
  clearCurrentPhase();
  drainLogs();
  return { action: "break", reason: progressKind };
}

/**
 * Phase 5: Post-unit finalize — pre/post verification, UAT pause, step-wizard.
 * Returns break/continue/next to control the outer loop.
 */
export async function runFinalize(
  ic: IterationContext,
  iterData: IterationData,
  loopState: LoopState,
  sidecarItem?: SidecarItem,
  publishVerifiedTask?: () => Promise<void>,
): Promise<PhaseResult> {
  const { ctx, pi, s, deps } = ic;
  const { pauseAfterUatDispatch } = iterData;

  debugLog("autoLoop", { phase: "finalize", iteration: ic.iteration });

  // Clear unit timeout (unit completed)
  deps.clearUnitTimeout();

  // Post-unit context for pre/post verification
  const postUnitCtx: PostUnitContext = {
    s,
    ctx,
    pi,
    buildSnapshotOpts: deps.buildSnapshotOpts,
    lockBase: deps.lockBase,
    stopAuto: deps.stopAuto,
    pauseAuto: deps.pauseAuto,
    updateProgressWidget: deps.updateProgressWidget,
  };

  // Pre-verification processing (commit, doctor, state rebuild, etc.)
  // Timeout guard: if postUnitPreVerification hangs (e.g., safety harness
  // deadlock, browser teardown hang, worktree sync stall), force-continue
  // after timeout so the auto-loop is not permanently frozen (#3757).
  //
  // On timeout, null out s.currentUnit so the timed-out task's late async
  // mutations are harmless — postUnitPreVerification guards all side effects
  // behind `if (s.currentUnit)`. The next iteration sets a fresh currentUnit.
  // Sidecar items use lightweight pre-verification opts
  const preVerificationOpts: PreVerificationOpts = sidecarItem
    ? sidecarItem.kind === "hook"
      ? { skipSettleDelay: true, skipWorktreeSync: true, agentEndMessages: s.lastUnitAgentEndMessages ?? undefined }
      : { skipSettleDelay: true, agentEndMessages: s.lastUnitAgentEndMessages ?? undefined }
    : { agentEndMessages: s.lastUnitAgentEndMessages ?? undefined };
  const preUnitSnapshot = s.currentUnit
    ? { type: s.currentUnit.type, id: s.currentUnit.id, startedAt: s.currentUnit.startedAt }
    : null;
  const clearFinalizingUnit = () => {
    if (
      preUnitSnapshot &&
      s.currentUnit?.type === preUnitSnapshot.type &&
      s.currentUnit?.id === preUnitSnapshot.id &&
      s.currentUnit?.startedAt === preUnitSnapshot.startedAt
    ) {
      s.clearCurrentUnit();
    }
    s.rootWriteBaseline = null;
  };
  clearCurrentPhase();
  const preResultGuard = await withTimeout(
    deps.postUnitPreVerification(postUnitCtx, preVerificationOpts),
    FINALIZE_PRE_TIMEOUT_MS,
    "postUnitPreVerification",
  );

  if (preResultGuard.timedOut) {
    return failClosedOnFinalizeTimeout(
      ic,
      iterData,
      loopState,
      "pre",
      preUnitSnapshot?.startedAt ?? Date.now(),
    );
  }

  const preResult = preResultGuard.value;
  if (preResult === "dispatched") {
    const dispatchedReason = s.lastGitActionFailure
      ? "git-closeout-failure"
      : "pre-verification-dispatched";
    debugLog("autoLoop", {
      phase: "exit",
      reason: dispatchedReason,
      gitError: s.lastGitActionFailure ?? undefined,
    });
    clearFinalizingUnit();
    return { action: "break", reason: dispatchedReason };
  }
  if (preResult === "evidence-xref-blocked") {
    // A blocking safety evidence mismatch withheld the verdict and routed the
    // Attempt through the canonical recovery seam (#1641 / #1649). The reason
    // is deliberately NOT a complete-and-break reason: decideFinalizeResult
    // must stop the loop here so the verified-task publication boundary — which
    // correctly throws without a passing host Technical Verdict — is never
    // entered. Carry the recoveryActionId so the sanctioned exit reaches the
    // journal, the dispatch ledger, and the operator (mirrors #1593).
    const safetyRecovery = s.lastSafetyBlockRecovery;
    const recoveryId = safetyRecovery?.recoveryActionId
      ? `recoveryActionId: ${safetyRecovery.recoveryActionId}; `
      : "";
    const safetyReason = safetyRecovery
      ? `safety-evidence-block (${recoveryId}${safetyRecovery.resumeInstruction})`
      : "safety-evidence-block";
    debugLog("autoLoop", { phase: "exit", reason: safetyReason });
    clearFinalizingUnit();
    return { action: "break", reason: safetyReason };
  }
  if (preResult === "retry") {
    if (sidecarItem) {
      // Sidecar artifact retries are skipped — just continue
      debugLog("autoLoop", { phase: "sidecar-artifact-retry-skipped", iteration: ic.iteration });
    } else {
      // s.pendingVerificationRetry was set by postUnitPreVerification.
      // Emit a dedicated journal event so forensics can distinguish bounded
      // verification retries from genuine stuck-loop dispatch repetitions (#4540).
      const retryInfo = s.pendingVerificationRetry;
      deps.emitJournalEvent({
        ts: new Date().toISOString(),
        flowId: ic.flowId,
        seq: ic.nextSeq(),
        eventType: "artifact-verification-retry",
        data: {
          unitType: preUnitSnapshot?.type,
          unitId: retryInfo?.unitId,
          attempt: retryInfo?.attempt,
        },
      });
      const retryPolicyResult = await applyVerificationRetryPolicy(
        ic,
        preUnitSnapshot?.type,
        "artifact-verification-retry",
      );
      if (retryPolicyResult) {
        clearFinalizingUnit();
        return retryPolicyResult;
      }
      // Continue the loop — next iteration will inject the retry context into the prompt.
      rememberRetryDispatch(s, preUnitSnapshot, iterData);
      debugLog("autoLoop", { phase: "artifact-verification-retry", iteration: ic.iteration });
      clearFinalizingUnit();
      return { action: "continue" };
    }
  }

  if (pauseAfterUatDispatch) {
    const pauseMid = iterData.mid;
    const pauseSliceId = pauseMid && iterData.unitId.startsWith(`${pauseMid}/`)
      ? iterData.unitId.slice(pauseMid.length + 1)
      : undefined;
    const guidance = pauseMid
      ? buildManualValidationGuidance(s.basePath, pauseMid, {
          uatPath: pauseSliceId
            ? relSliceFile(s.basePath, pauseMid, pauseSliceId, "UAT")
            : undefined,
        })
      : null;
    const pauseMessage = guidance
      ? `UAT requires human execution. Auto-mode will pause after this unit writes the result file.\n\n${guidance}`
      : "UAT requires human execution. Auto-mode will pause after this unit writes the result file.";
    ctx.ui.notify(pauseMessage, "info");
    await deps.pauseAuto(ctx, pi);
    debugLog("autoLoop", { phase: "exit", reason: "uat-pause" });
    clearFinalizingUnit();
    return { action: "break", reason: "uat-pause" };
  }

  // Verification gate
  // Hook sidecar items skip verification entirely.
  // Non-hook sidecar items run verification but skip retries (just continue).
  const skipVerification = sidecarItem?.kind === "hook";
  if (!skipVerification) {
    const verificationResult = await deps.runPostUnitVerification(
      { s, ctx, pi },
      deps.pauseAuto,
    );

    if (verificationResult === "abort") {
      // The abort is terminal but operator-resumable via `/gsd recover`, which
      // needs the exact recoveryActionId. Carry it in the break reason so it
      // reaches the journal, dispatch ledger, and operator (#1593).
      const abortId = s.lastTaskRecoveryAbortId;
      const abortReason = abortId
        ? `verification-abort (recoveryActionId: ${abortId}; resume with /gsd recover ${abortId})`
        : "verification-abort";
      // Never exit silently: breaking without a terminal notification left a
      // headless session idling with nothing scheduled until an external
      // timeout — the loop exits on the first abort, so the ADR-047 trip-at-2
      // backstop can never fire in-session (#1971). Pause with the sanctioned
      // exit so the operator sees the recovery instruction and /gsd auto can
      // resume after `/gsd recover`. pauseAuto notifies the errorContext
      // message itself, so no separate notify here.
      const abortMessage = abortId
        ? `Verification auto-fix retries are exhausted — durable recovery aborted this task. Resume with /gsd recover ${abortId} after fixing the failure.`
        : "Verification was aborted by durable task recovery.";
      await deps.pauseAuto(ctx, pi, { message: abortMessage, category: "unknown" });
      debugLog("autoLoop", { phase: "exit", reason: abortReason });
      clearFinalizingUnit();
      return { action: "break", reason: abortReason };
    }

    if (verificationResult === "pause") {
      debugLog("autoLoop", { phase: "exit", reason: "verification-pause" });
      clearFinalizingUnit();
      return { action: "break", reason: "verification-pause" };
    }

    if (verificationResult === "retry") {
      if (sidecarItem) {
        // Sidecar verification retries are skipped — just continue
        debugLog("autoLoop", { phase: "sidecar-verification-retry-skipped", iteration: ic.iteration });
      } else {
        // s.pendingVerificationRetry was set by runPostUnitVerification.
        const retryPolicyResult = await applyVerificationRetryPolicy(
          ic,
          iterData.unitType,
          "verification-retry",
        );
        if (retryPolicyResult) {
          clearFinalizingUnit();
          return retryPolicyResult;
        }
        // Continue the loop — next iteration will inject the retry context into the prompt.
        rememberRetryDispatch(s, preUnitSnapshot, iterData);
        debugLog("autoLoop", { phase: "verification-retry", iteration: ic.iteration });
        clearFinalizingUnit();
        return { action: "continue" };
      }
    }

    if (
      verificationResult === "continue"
      && iterData.unitType === "execute-task"
      && publishVerifiedTask
    ) {
      try {
        await publishVerifiedTask();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(reason, "error");
        await deps.stopAuto(ctx, pi, reason);
        clearFinalizingUnit();
        return { action: "break", reason };
      }
    }
  }

  // Post-verification processing (DB dual-write, hooks, triage, quick-tasks)
  // Timeout guard: if postUnitPostVerification hangs (e.g., module import
  // deadlock, SQLite transaction hang), force-continue after timeout so the
  // auto-loop is not permanently frozen (#2344).
  const postResultGuard = await withTimeout(
    deps.postUnitPostVerification(postUnitCtx),
    FINALIZE_POST_TIMEOUT_MS,
    "postUnitPostVerification",
  );

  if (postResultGuard.timedOut) {
    return failClosedOnFinalizeTimeout(
      ic,
      iterData,
      loopState,
      "post",
      preUnitSnapshot?.startedAt ?? Date.now(),
    );
  }

  const postResult = postResultGuard.value;

  if (postResult === "retry") {
    if (sidecarItem) {
      debugLog("autoLoop", { phase: "sidecar-pre-execution-retry-skipped", iteration: ic.iteration });
    } else {
      const retryInfo = s.pendingVerificationRetry;
      // #2119: execute-task retries returned after publishVerifiedTask belong
      // to the durable verification-retry phase. Git-commit remediation supplies
      // retry context and its own cap; source recapture without context still
      // fails closed in the policy. Plan/refine retries keep the legacy phase.
      const retryPhase = preUnitSnapshot?.type === "execute-task"
        ? "verification-retry"
        : "pre-execution-retry";
      deps.emitJournalEvent({
        ts: new Date().toISOString(),
        flowId: ic.flowId,
        seq: ic.nextSeq(),
        eventType: retryPhase,
        data: {
          unitType: preUnitSnapshot?.type,
          unitId: retryInfo?.unitId,
          attempt: retryInfo?.attempt,
        },
      });
      const retryPolicyResult = await applyVerificationRetryPolicy(
        ic,
        preUnitSnapshot?.type,
        retryPhase,
      );
      if (retryPolicyResult) {
        clearFinalizingUnit();
        return retryPolicyResult;
      }
      rememberRetryDispatch(s, preUnitSnapshot, iterData);
      debugLog("autoLoop", {
        phase: retryPhase,
        iteration: ic.iteration,
        unitType: preUnitSnapshot?.type,
        unitId: retryInfo?.unitId,
        attempt: retryInfo?.attempt,
      });
      clearFinalizingUnit();
      return { action: "continue" };
    }
  }

  if (postResult === "stopped") {
    debugLog("autoLoop", {
      phase: "exit",
      reason: "post-verification-stopped",
    });
    clearFinalizingUnit();
    return { action: "break", reason: "post-verification-stopped" };
  }

  if (postResult === "step-wizard") {
    // Step mode — exit the loop (caller handles wizard)
    debugLog("autoLoop", { phase: "exit", reason: "step-wizard" });
    clearFinalizingUnit();
    return { action: "break", reason: "step-wizard" };
  }

  if (preUnitSnapshot && isIsolatedWorktreeSession(s)) {
    const leak = detectRootWriteLeak({
      rootPath: s.originalBasePath,
      worktreePath: s.basePath,
      unitType: preUnitSnapshot.type,
      unitId: preUnitSnapshot.id,
      before: s.rootWriteBaseline,
    });
    s.rootWriteBaseline = null;
    if (leak) {
      const message = formatRootWriteLeakMessage(leak);
      debugLog("autoLoop", {
        phase: "root-write-leak",
        unitType: preUnitSnapshot.type,
        unitId: preUnitSnapshot.id,
        rootPath: leak.rootPath,
        worktreePath: leak.worktreePath,
        files: leak.files.map((file) => ({ path: file.path, status: file.status })),
      });
      ctx.ui.notify(message, "error");
      try {
        deps.checkpointWorkflowDatabase?.();
      } catch (err) {
        debugLog("autoLoop", {
          phase: "root-write-leak-checkpoint-failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await deps.stopAuto(ctx, pi, "Root-write leak during isolated auto-mode", {
        preserveCompletedMilestoneBranch: true,
      });
      clearFinalizingUnit();
      return { action: "break", reason: "root-write-leak" };
    }
  } else {
    s.rootWriteBaseline = null;
  }

  if (preUnitSnapshot?.type === "complete-milestone" && s.currentMilestoneId) {
    const stop = await _runMilestoneMergeOnceWithStashRestore(ic, s.currentMilestoneId, {
      preserveCloseoutTranscript: true,
    });
    if (stop) {
      clearFinalizingUnit();
      return stop;
    }
  }

  // Both pre and post verification completed without timeout — reset counter
  loopState.consecutiveFinalizeTimeouts = 0;
  if (preUnitSnapshot) {
    writeUnitRuntimeRecord(s.basePath, preUnitSnapshot.type, preUnitSnapshot.id, preUnitSnapshot.startedAt, {
      phase: "finalized",
      lastProgressAt: Date.now(),
      lastProgressKind: "finalize-success",
    });
    if (
      !preUnitSnapshot.type.startsWith("hook/") &&
      preUnitSnapshot.type !== "custom-step" &&
      preUnitSnapshot.type !== "complete-milestone"
    ) {
      setAutoOutcomeWidget(ctx, {
        ...buildPhaseHandoffOutcome({
          unitType: preUnitSnapshot.type,
          unitId: preUnitSnapshot.id,
          agentEndMessages: s.lastUnitAgentEndMessages,
        }),
        startedAt: s.autoStartTime,
      });
    }
  }
  clearFinalizingUnit();
  // Surface accumulated workflow-logger issues for this unit to the user.
  // Warnings/errors logged during the unit are buffered in the logger and
  // drained here so the user sees a single consolidated post-unit alert.
  if (hasAnyIssues()) {
    const { logs } = drainAndSummarize();
    if (logs.length > 0) {
      const severity = logs.some((e) => e.severity === "error") ? "error" : "warning";
      ctx.ui.notify(formatForNotification(logs), severity);
    }
  }

  if (preUnitSnapshot?.type === "complete-milestone" && s.currentMilestoneId) {
    // cleanupAfterLoopExit skips gsd-progress when preserveCompletionSurface is true, so clear stale controls here.
    ctx.ui.setStatus?.("gsd-step", undefined);
    ctx.ui.setWidget?.("gsd-progress", undefined);
    await deps.stopAuto(ctx, pi, `Milestone ${s.currentMilestoneId} complete`, {
      completionWidget: {
        milestoneId: s.currentMilestoneId,
        milestoneTitle: iterData.midTitle,
      },
    });
    return { action: "break", reason: "milestone-complete" };
  }

  return { action: "next", data: undefined as void };
}
