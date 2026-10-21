// Project/App: gsd-pi
// File Purpose: Shared helpers used across auto-loop phase modules.

import { debugLog } from "../debug-logger.js";
import { resolveWorktreeProjectRoot, normalizeWorktreePathForCompare } from "../worktree-root.js";
import { decideVerificationRetry, verificationRetryKey } from "./verification-retry-policy.js";
import type { AutoSession } from "./session.js";
import type { IterationContext, IterationData, LoopState, PhaseResult } from "./types.js";
import type { Phase } from "../types.js";

/** Compare two paths for physical identity, tolerating trailing slashes and symlinks. */
export function isSamePathLocal(a: string, b: string): boolean {
  return normalizeWorktreePathForCompare(a) === normalizeWorktreePathForCompare(b);
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
  const key = unitType && retryInfo
    ? verificationRetryKey(unitType, retryInfo.unitId)
    : undefined;
  // Task host verification only returns retry after durable recovery authorizes it.
  // Repeated evidence belongs to that policy, not this legacy loop guard.
  const durableTaskRetry = unitType === "execute-task" && phase === "verification-retry";
  const decision = decideVerificationRetry({
    unitType,
    retryInfo,
    previousFailureHash: !durableTaskRetry && key
      ? s.verificationRetryFailureHashes.get(key)
      : undefined,
  });

  if (decision.action === "pause") {
    s.pendingVerificationRetry = null;
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

  s.verificationRetryFailureHashes.set(decision.key, decision.failureHash);
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

export function rememberRetryDispatch(
  s: AutoSession,
  unit: { type: string; id: string } | null,
  iterData: IterationData,
): void {
  if (!unit) return;
  s.pendingVerificationRetryDispatch = {
    unitType: unit.type,
    unitId: unit.id,
    prompt: iterData.prompt,
    pauseAfterUatDispatch: iterData.pauseAfterUatDispatch,
    state: iterData.state,
    mid: iterData.mid,
    midTitle: iterData.midTitle,
  };
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
