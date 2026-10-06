// Project/App: gsd-pi
// File Purpose: The persisted Lifecycle Kernel (ADR-046, ADR-048): the four
// entry points an auto-mode host calls — start, advance, resume and stop.
//
// advance() selects the next unit from database rows, in this order:
//   1. the dispatch row of a unit that a killed process left in the verify
//      stage: the unit continues at that stage and does not run again. A unit
//      whose post-verification already queued follow-on work, or started a
//      post-unit hook, is not continued: the queue has that work;
//   2. the oldest queued row of the sidecar queue;
//   3. the unit the Auto Orchestration module selects. Its dispatch rules read
//      the stored retry rows and the lifecycle rows, and it claims the
//      unit_dispatches row.
// A custom workflow engine selects its step from the step rows of its run. The
// kernel returns `engine` for it when the sidecar queue has no work.
//
// auto/workflow-kernel.ts is the pure policy layer below this module.

import type { AutoSession } from "./session.js";
import type { AutoAdvanceResult, AutoSessionContext, UnitRef } from "./contracts.js";
import { dequeueSidecarItem, type SidecarDequeuePayload } from "./workflow-sidecar-queue.js";
import { shouldUseCustomEnginePath } from "./workflow-kernel.js";
import { VIRTUAL_MILESTONE_IDS } from "./workflow-dispatch-claim.js";
import { listQueuedSidecarItems, type QueuedSidecarItem } from "../db/unit-dispatch-sidecars.js";
import {
  getInterruptedVerifyDispatch,
  getRecentForUnit,
  markCanceled,
  markCompleted,
  markFailed,
  markRunning,
  recordDispatchClaim,
} from "../db/unit-dispatches.js";
import { isDbAvailable } from "../gsd-db.js";
import { getMilestone } from "../db/queries.js";
import {
  claimMilestoneLease,
  milestoneLeaseTtlSeconds,
  refreshMilestoneLease,
  releaseMilestoneLease,
} from "../db/milestone-leases.js";
import { heartbeatAutoWorker, markWorkerStopping, registerAutoWorker } from "../db/auto-workers.js";
import { getActiveHook } from "../post-unit-hooks.js";
import { scheduleSidecarQueue } from "../uok/execution-graph.js";
import { runWithWorkerHeartbeat } from "./workflow-worker-heartbeat.js";
import { debugLog } from "../debug-logger.js";
import { logWarning } from "../workflow-logger.js";

export type KernelAdvanceResult =
  | AutoAdvanceResult
  /** A unit that left execution before its process was killed. */
  | { kind: "stage"; stage: "verify"; unit: UnitRef; interruptedDispatchId: number }
  | { kind: "sidecar"; item: QueuedSidecarItem }
  /** The custom engine of the session selects the step. */
  | { kind: "engine" }
  /** The session has no Auto Orchestration module. */
  | { kind: "unavailable" };

export interface KernelAdvanceInput {
  executionGraphEnabled: boolean;
  emitSidecarDequeue: (payload: SidecarDequeuePayload) => void;
}

export async function kernelStart(
  s: AutoSession,
  sessionContext: AutoSessionContext,
): Promise<AutoAdvanceResult | undefined> {
  return s.orchestration?.start(sessionContext);
}

export async function kernelAdvance(
  s: AutoSession,
  input: KernelAdvanceInput,
): Promise<KernelAdvanceResult> {
  const customEngine = shouldUseCustomEnginePath({
    activeEngineId: s.activeEngineId,
    hasSidecarItem: false,
    engineBypass: process.env.GSD_ENGINE_BYPASS === "1",
  });

  if (!customEngine && s.currentMilestoneId) {
    const interrupted = getInterruptedVerifyDispatch(
      s.currentMilestoneId,
      process.env.GSD_SLICE_LOCK ?? null,
    );
    // The hook state row holds a hook that the post-verification of the unit
    // started. The start path queued it again when its queue row was missing,
    // and that row has no link to the dispatch row. A second post-verification
    // of the unit would dispatch the hook again.
    const activeHook = getActiveHook();
    const hookStarted = interrupted != null
      && activeHook != null
      && activeHook.triggerUnitType === interrupted.unit_type
      && activeHook.triggerUnitId === interrupted.unit_id;
    if (interrupted && !hookStarted) {
      return {
        kind: "stage",
        stage: "verify",
        unit: { unitType: interrupted.unit_type, unitId: interrupted.unit_id },
        interruptedDispatchId: interrupted.id,
      };
    }
  }

  const sidecarItem = await dequeueSidecarItem({
    queue: listQueuedSidecarItems(),
    executionGraphEnabled: input.executionGraphEnabled,
    scheduleQueue: scheduleSidecarQueue,
    warnSchedulingFailure: message => logWarning("dispatch", `sidecar queue scheduling failed: ${message}`),
    logDequeue: payload => debugLog("autoLoop", { phase: "sidecar-dequeue", ...payload }),
    emitDequeue: input.emitSidecarDequeue,
  });
  if (sidecarItem) return { kind: "sidecar", item: sidecarItem };

  if (customEngine) return { kind: "engine" };

  const orchestration = s.orchestration;
  if (!orchestration) return { kind: "unavailable" };

  // A unit this process already claimed and did not start yet.
  const pending = s.pendingOrchestrationDispatch;
  if (pending) {
    return {
      kind: "advanced",
      unit: { unitType: pending.unitType, unitId: pending.unitId },
      stateSnapshot: pending.state,
      dispatchId: pending.dispatchId ?? 0,
    };
  }
  return orchestration.advance();
}

export async function kernelResume(s: AutoSession): Promise<AutoAdvanceResult | undefined> {
  return s.orchestration?.resume();
}

export async function kernelStop(
  s: AutoSession,
  reason: string,
): Promise<AutoAdvanceResult | undefined> {
  return s.orchestration?.stop(reason);
}

// ── The one-unit bound (ADR-048) ─────────────────────────────────────────────
//
// The guided flow and `/gsd dispatch` run outside the auto loop: no AutoSession,
// no orchestration module, no loop that settles rows. When such a caller
// dispatches one unit it claims that unit through the kernel — the milestone
// lease and the `unit_dispatches` row — so the work has a kernel record and
// makes an older interrupted `verify` row of the milestone history. The bound
// is one unit: the caller claims, runs its one session, and settles.

export interface KernelUnitClaimInput {
  /** Real path of the project root, recorded on the claim's worker row. */
  projectRoot: string;
  milestoneId: string;
  sliceId: string | null;
  taskId: string | null;
  unitType: string;
  unitId: string;
  traceId: string;
}

export type KernelUnitClaim =
  | { kind: "claimed"; dispatchId: number; workerId: string; milestoneId: string; leaseToken: number }
  | {
      /** No claim is made and the caller dispatches as before. */
      kind: "skipped";
      reason: "db-unavailable" | "virtual-milestone" | "milestone-not-in-db";
    }
  | {
      /** Another worker holds the unit or the milestone lease. Do not dispatch. */
      kind: "refused";
      reason: string;
    };

/** The outcome a caller reports for its claimed unit when the unit's turn ends. */
export type KernelUnitClaimOutcome = "completed" | "failed" | "canceled";

/**
 * Claim the one unit the caller is about to dispatch interactively: register a
 * worker row, take the milestone lease, insert the `unit_dispatches` row and
 * mark it running. The same database rules the auto loop claims with guard the
 * claim: a live worker that holds the unit or the lease refuses it, and the
 * active row of a dead worker is taken over.
 */
export function kernelClaimUnit(input: KernelUnitClaimInput): KernelUnitClaim {
  if (!isDbAvailable()) return { kind: "skipped", reason: "db-unavailable" };
  if (VIRTUAL_MILESTONE_IDS.has(input.milestoneId)) {
    return { kind: "skipped", reason: "virtual-milestone" };
  }
  // milestone_leases references milestones, so a unit of a milestone that has
  // no row yet (a guided discuss for a reserved id) claims nothing.
  if (!getMilestone(input.milestoneId)) {
    return { kind: "skipped", reason: "milestone-not-in-db" };
  }

  const workerId = registerAutoWorker({
    projectRootRealpath: input.projectRoot,
    prefix: "dispatch",
  });

  const lease = claimMilestoneLease(workerId, input.milestoneId);
  if (!lease.ok) {
    markWorkerStopping(workerId);
    return {
      kind: "refused",
      reason: `milestone ${input.milestoneId} is held by worker ${lease.byWorker} until ${lease.expiresAt}`,
    };
  }

  const releaseClaim = () => {
    try {
      releaseMilestoneLease(workerId, input.milestoneId, lease.token);
    } catch (err) {
      // The lease lapses with its TTL; the refusal path still must not throw.
      logWarning("dispatch", `interactive claim lease release failed for ${input.milestoneId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    markWorkerStopping(workerId);
  };

  const [attemptRow] = getRecentForUnit(input.unitId, 1);
  const claim = recordDispatchClaim({
    traceId: input.traceId,
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: input.milestoneId,
    sliceId: input.sliceId,
    taskId: input.taskId,
    unitType: input.unitType,
    unitId: input.unitId,
    attemptN: (attemptRow?.attempt_n ?? 0) + 1,
  });
  if (!claim.ok) {
    releaseClaim();
    if (claim.error === "already_active") {
      return {
        kind: "refused",
        reason: `unit ${input.unitId} is already active on worker ${claim.existingWorker}`,
      };
    }
    return { kind: "refused", reason: `stale milestone lease for ${input.milestoneId}` };
  }

  // The auto loop leaves the row of an execute-task `claimed` until the unit's
  // Attempt opens; every other unit runs under a `running` row.
  if (input.unitType !== "execute-task") markRunning(claim.dispatchId);

  debugLog("lifecycleKernel", {
    phase: "interactive-claim",
    dispatchId: claim.dispatchId,
    unitType: input.unitType,
    unitId: input.unitId,
    milestoneId: input.milestoneId,
    workerId,
  });
  return { kind: "claimed", dispatchId: claim.dispatchId, workerId, milestoneId: input.milestoneId, leaseToken: lease.token };
}

/**
 * The interval the auto loop heartbeats at: half the lease TTL, so a renewal
 * always lands before the lease lapses.
 */
const INTERACTIVE_HEARTBEAT_INTERVAL_MS = milestoneLeaseTtlSeconds() * 500;

/**
 * Run the claimed interactive unit's turn with the claim's worker heartbeat
 * and milestone-lease renewal. Without this, a turn longer than the lease TTL
 * (60s) lets another session's auto take the lease and cancel the live
 * `unit_dispatches` row as stale while the turn still runs. The same wrapper
 * guards every auto-loop unit phase; the heartbeat stops when the turn
 * settles.
 */
export function runInteractiveClaimTurn<T>(
  claim: Extract<KernelUnitClaim, { kind: "claimed" }>,
  run: () => Promise<T>,
): Promise<T> {
  return runWithWorkerHeartbeat(
    {
      workerId: claim.workerId,
      currentMilestoneId: claim.milestoneId,
      milestoneLeaseToken: claim.leaseToken,
    },
    {
      heartbeatAutoWorker,
      refreshMilestoneLease,
      logHeartbeatFailure: (err) => debugLog("lifecycleKernel", {
        phase: "heartbeat-failed",
        workerId: claim.workerId,
        error: err instanceof Error ? err.message : String(err),
      }),
      logLeaseRefreshMiss: (details) => debugLog("lifecycleKernel", {
        phase: "lease-refresh-missed",
        ...details,
      }),
    },
    INTERACTIVE_HEARTBEAT_INTERVAL_MS,
    run,
  );
}

/**
 * Settle the row of a claimed interactive unit when its turn ends, and release
 * the lease and the worker row with it. A settle that cannot run is logged, not
 * thrown: the row then stays active until the next claim of the unit or the
 * crash sweep settles it — never silently reused.
 */
export function kernelSettleUnitClaim(
  claim: Extract<KernelUnitClaim, { kind: "claimed" }>,
  outcome: KernelUnitClaimOutcome,
  reason: string,
): void {
  try {
    if (outcome === "completed") {
      markCompleted(claim.dispatchId, { exitReason: reason });
    } else if (outcome === "failed") {
      markFailed(claim.dispatchId, { errorSummary: reason, exitReason: reason });
    } else {
      markCanceled(claim.dispatchId, reason);
    }
  } catch (err) {
    logWarning("dispatch", `interactive dispatch settle failed for ${claim.dispatchId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    releaseMilestoneLease(claim.workerId, claim.milestoneId, claim.leaseToken);
  } catch (err) {
    // The lease lapses with its TTL; the settle above already closed the row.
    logWarning("dispatch", `interactive claim lease release failed for ${claim.milestoneId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    markWorkerStopping(claim.workerId);
  } catch (err) {
    // The crash sweep marks the row later; the settle itself must not throw.
    logWarning("dispatch", `interactive claim worker stop failed for ${claim.workerId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
