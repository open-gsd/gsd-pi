// Project/App: gsd-pi
// File Purpose: UnitRun = the claimed/running unit_dispatches row (ADR-048).

import { isDbAvailable, transaction } from "../gsd-db.js";
import {
  getActiveForWorker,
  getDispatchById,
  markActiveForWorkerCanceled,
  markCanceled,
} from "../db/unit-dispatches.js";
import { isDeadLocalAutoWorker, markWorkerCrashed } from "../db/auto-workers.js";
import { forceReleaseLeasesForWorker } from "../db/milestone-leases.js";
import { debugLog } from "../debug-logger.js";
import { parseUnitId } from "../unit-id.js";
import type { GSDState } from "../types.js";
import type { UnitRef } from "./contracts.js";
import type { AutoSession } from "./session.js";
import type { IterationData } from "./types.js";
import {
  ensureDispatchLease,
  openDispatchClaim,
  type EnsureDispatchLeaseDeps,
  type OpenDispatchClaimDeps,
} from "./workflow-dispatch-claim.js";

export function activeUnitFromWorker(workerId: string | null | undefined): UnitRef | undefined {
  if (!workerId) return undefined;
  const row = getActiveForWorker(workerId);
  if (!row) return undefined;
  return { unitType: row.unit_type, unitId: row.unit_id };
}

export function unitRefForDispatch(dispatchId: number): UnitRef | undefined {
  const row = getDispatchById(dispatchId);
  if (!row) return undefined;
  return { unitType: row.unit_type, unitId: row.unit_id };
}

export type UnitRunAdvanceResolution =
  | { kind: "skip-in-flight" }
  | { kind: "resume"; dispatchId: number }
  | { kind: "claim" };

export function resolveExistingUnitRun(input: {
  workerId: string | null | undefined;
  unitType: string;
  unitId: string;
  unitExecutionInFlight: boolean;
}): UnitRunAdvanceResolution {
  if (!input.workerId) return { kind: "claim" };
  const row = getActiveForWorker(input.workerId);
  if (!row) return { kind: "claim" };
  const same = row.unit_type === input.unitType && row.unit_id === input.unitId;
  if (same && input.unitExecutionInFlight) return { kind: "skip-in-flight" };
  if (same) return { kind: "resume", dispatchId: row.id };
  markCanceled(row.id, "superseded-by-new-advance");
  return { kind: "claim" };
}

export function iterationDataForClaim(
  unitType: string,
  unitId: string,
  state: GSDState,
  session: AutoSession,
): IterationData {
  const parsed = parseUnitId(unitId);
  return {
    unitType,
    unitId,
    prompt: "",
    finalPrompt: "",
    pauseAfterUatDispatch: false,
    state,
    mid: parsed.milestone || session.currentMilestoneId || undefined,
    midTitle: state.activeMilestone?.title,
    isRetry: false,
    previousTier: undefined,
  };
}

export const UNIT_RUN_LEASE_LOG: EnsureDispatchLeaseDeps["logLeaseRecovered"] = (details) => {
  debugLog("unitRun", {
    phase: details.recovered ? "dispatch-lease-recovered" : "dispatch-lease-acquired",
    ...details,
  });
};

export const UNIT_RUN_LEASE_FAIL_LOG: EnsureDispatchLeaseDeps["logLeaseRecoveryFailed"] = (details) => {
  debugLog("unitRun", { phase: "dispatch-lease-recovery-failed", ...details });
};

export const UNIT_RUN_CLAIM_REJECT_LOG: OpenDispatchClaimDeps["logClaimRejected"] = (details) => {
  debugLog("unitRun", { phase: "dispatch-claim-rejected", ...details });
};

export const UNIT_RUN_CLAIM_FAIL_LOG: OpenDispatchClaimDeps["logClaimFailed"] = (err) => {
  debugLog("unitRun", {
    phase: "dispatch-claim-failed",
    error: err instanceof Error ? err.message : String(err),
  });
};

export const IS_DISPATCH_OWNER_DEAD: NonNullable<OpenDispatchClaimDeps["isDispatchOwnerDead"]> =
  isDeadLocalAutoWorker;

export const RECLAIM_DEAD_DISPATCH_OWNER: NonNullable<OpenDispatchClaimDeps["reclaimDeadDispatchOwner"]> =
  (workerId) => {
    markActiveForWorkerCanceled(workerId, "crash-recovered");
    markWorkerCrashed(workerId);
    forceReleaseLeasesForWorker(workerId);
  };

export type ClaimUnitRunResult =
  | { kind: "opened"; dispatchId: number }
  | { kind: "blocked"; reason: string }
  | { kind: "degraded"; reason: string }
  | { kind: "skip"; reason: string };

export function claimUnitRun(input: {
  session: AutoSession;
  flowId: string;
  turnId: string;
  iterData: IterationData;
  leaseDeps: EnsureDispatchLeaseDeps;
  claimDeps: OpenDispatchClaimDeps;
}): ClaimUnitRunResult {
  if (!input.session.workerId) {
    return { kind: "degraded", reason: "missing-worker" };
  }
  if (!isDbAvailable()) {
    return { kind: "degraded", reason: "database-unavailable" };
  }
  return transaction(() => {
    const lease = ensureDispatchLease(input.session, input.iterData.mid, input.leaseDeps);
    if (lease.kind === "blocked" || lease.kind === "failed") {
      return { kind: "blocked" as const, reason: lease.reason };
    }
    if (lease.kind === "degraded") {
      return { kind: "degraded" as const, reason: lease.reason };
    }
    const claim = openDispatchClaim(
      input.session,
      input.flowId,
      input.turnId,
      input.iterData,
      {
        isDispatchOwnerDead: IS_DISPATCH_OWNER_DEAD,
        reclaimDeadDispatchOwner: RECLAIM_DEAD_DISPATCH_OWNER,
        ...input.claimDeps,
      },
    );
    if (claim.kind === "opened") return claim;
    if (claim.kind === "skip") return { kind: "skip" as const, reason: claim.reason };
    return { kind: "degraded" as const, reason: claim.reason };
  });
}
