// Project/App: gsd-pi
// File Purpose: Shared helpers used across auto-loop phase modules.

import { debugLog } from "../debug-logger.js";
import { readPreviousUnitRetry, releaseUnitRetry } from "../db/unit-dispatch-retries.js";
import { recordUnitEnd } from "../unit-runtime.js";
import { resolveWorktreeProjectRoot, normalizeWorktreePathForCompare } from "../worktree-root.js";
import { decideVerificationRetry, hashVerificationFailureContext } from "./verification-retry-policy.js";
import type { AutoSession } from "./session.js";
import type { IterationContext, LoopState, PhaseResult } from "./types.js";
import type { Phase } from "../types.js";
import type { EnterResult } from "../worktree-lifecycle.js";

/** Compare two paths for physical identity, tolerating trailing slashes and symlinks. */
export function isSamePathLocal(a: string, b: string): boolean {
  return normalizeWorktreePathForCompare(a) === normalizeWorktreePathForCompare(b);
}

/**
 * Which enterMilestone failures must STOP the auto-mode resume instead of
 * degrading to project root. Resuming after a lease conflict or a stale
 * worktree registration (#2317) would run every subsequent operation against
 * the wrong tree. Returns null when the resume may continue.
 */
export function autoResumeEnterFailureStop(
  enterResult: EnterResult,
  milestoneId: string,
): { notify: string; detail: string } | null {
  if (enterResult.ok) return null;
  if (enterResult.reason === "lease-conflict") {
    return {
      notify: `Cannot resume milestone ${milestoneId}: lease is held by another worker.`,
      detail: "lease-conflict during resume",
    };
  }
  if (enterResult.reason === "stale-worktree-registration") {
    return {
      notify:
        `Cannot resume milestone ${milestoneId}: a stale git worktree registration still claims the milestone branch. ` +
        `Follow the remediation in the worktree warning above (git worktree unlock + git worktree prune), then run /gsd auto to resume.`,
      detail: "stale worktree registration during resume",
    };
  }
  return null;
}

export function isIsolatedWorktreeSession(s: AutoSession): boolean {
  return Boolean(s.originalBasePath)
    && Boolean(s.basePath)
    && !isSamePathLocal(s.originalBasePath, s.basePath);
}

export async function applyVerificationRetryPolicy(
  ic: IterationContext,
  unitType: string | undefined,
  phase: "artifact-verification-retry" | "verification-retry" | "pre-execution-retry",
): Promise<PhaseResult | null> {
  const { ctx, pi, s, deps } = ic;
  const retryInfo = s.pendingVerificationRetry;
  // Task host verification only returns retry after durable recovery authorizes it.
  // Repeated evidence belongs to that policy, not this legacy loop guard.
  const durableTaskRetry = unitType === "execute-task" && phase === "verification-retry";
  // ADR-048: the failure before this one is the retry that an earlier dispatch
  // of the unit stored, so a restart does not lose the comparison.
  const previousRetry = !durableTaskRetry && unitType && retryInfo
    ? readPreviousUnitRetry(unitType, retryInfo.unitId)
    : null;
  const decision = decideVerificationRetry({
    unitType,
    retryInfo,
    previousFailureHash: previousRetry
      ? hashVerificationFailureContext(previousRetry.signature ?? previousRetry.failureContext)
      : undefined,
  });

  if (decision.action === "pause") {
    s.pendingVerificationRetry = null;
    // The pause hands the unit to a person, so its stored retry is released.
    if (unitType && retryInfo) releaseUnitRetry(unitType, retryInfo.unitId);
    debugLog("autoLoop", {
      phase: `${phase}-paused`,
      reason: decision.reason,
      unitType,
      unitId: retryInfo?.unitId,
      failureHash: decision.failureHash,
    });
    ctx.ui.notify(
      decision.reason === "duplicate-failure-context"
        ? `Verification retry for ${unitType ?? "unit"} ${retryInfo?.unitId ?? "unknown"} produced the same failure context. Pausing auto-mode instead of re-dispatching.`
        : "Verification retry requested without retry context. Pausing auto-mode instead of re-dispatching.",
      "warning",
    );
    await deps.pauseAuto(ctx, pi);
    return { action: "break", reason: decision.reason };
  }

  debugLog("autoLoop", {
    phase: `${phase}-backoff`,
    iteration: ic.iteration,
    unitType,
    unitId: retryInfo?.unitId,
    attempt: retryInfo?.attempt,
    delayMs: decision.delayMs,
    baseDelayMs: decision.baseDelayMs,
    failureHash: decision.failureHash,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, decision.delayMs));
  return null;
}

/**
 * Resolve the base path for milestone reports.
 * Prefers originalBasePath (project root) over basePath (which may be a worktree).
 */
export function _resolveReportBasePath(s: Pick<AutoSession, "originalBasePath" | "basePath">): string {
  return resolveWorktreeProjectRoot(s.basePath, s.originalBasePath);
}

/**
 * Resolve the authoritative project base for dispatch guards.
 * Prior-milestone completion lives at the project root, even when the active
 * unit is running inside an auto worktree.
 */
export function _resolveDispatchGuardBasePath(
  s: Pick<AutoSession, "originalBasePath" | "basePath">,
): string {
  return resolveWorktreeProjectRoot(s.basePath, s.originalBasePath);
}

const PLAN_V2_GATE_PHASES: ReadonlySet<Phase> = new Set([
  "executing",
  "summarizing",
  "validating-milestone",
  "completing-milestone",
]);

export function shouldRunPlanV2Gate(phase: Phase): boolean {
  return PLAN_V2_GATE_PHASES.has(phase);
}

export function _resolveCurrentUnitStartedAtForTest(
  currentUnit: { startedAt: number } | null | undefined,
): number | undefined {
  return currentUnit?.startedAt;
}

export async function emitCancelledUnitEnd(
  ic: IterationContext,
  unitType: string,
  unitId: string,
  unitStartSeq: number,
  errorContext?: { message: string; category: string; stopReason?: string; isTransient?: boolean; retryAfterMs?: number },
): Promise<void> {
  recordUnitEnd(ic.s.basePath, unitType, unitId, {
    status: "cancelled",
    artifactVerified: false,
    ...(errorContext ? { error: errorContext.message } : {}),
  });
  ic.deps.emitJournalEvent({
    ts: new Date().toISOString(),
    flowId: ic.flowId,
    seq: ic.nextSeq(),
    eventType: "unit-end",
    data: {
      unitType,
      unitId,
      status: "cancelled",
      artifactVerified: false,
      ...(errorContext ? { errorContext } : {}),
    },
    causedBy: { flowId: ic.flowId, seq: unitStartSeq },
  });
}

export function _buildCancelledUnitStopReason(
  unitType: string,
  unitId: string,
  errorContext?: { message: string; category: string },
): {
  notifyMessage: string;
  stopReason: string;
  loopReason: "session-failed" | "unit-aborted";
} {
  const cancellationMessage = errorContext?.message ?? "unknown";
  const isSessionCreationFailure = errorContext?.category === "session-failed";

  if (isSessionCreationFailure) {
    return {
      notifyMessage: `Session creation failed for ${unitType} ${unitId}: ${cancellationMessage}. Stopping auto-mode.`,
      stopReason: `Session creation failed: ${cancellationMessage}`,
      loopReason: "session-failed",
    };
  }

  return {
    notifyMessage: `Unit ${unitType} ${unitId} aborted after dispatch: ${cancellationMessage}. Stopping auto-mode.`,
    stopReason: `Unit aborted: ${cancellationMessage}`,
    loopReason: "unit-aborted",
  };
}

export function _isPauseOriginCancelledResult(
  isPaused: boolean,
  errorContext?: { message: string; category: string },
): boolean {
  return isPaused && !errorContext;
}
