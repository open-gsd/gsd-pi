// Project/App: gsd-pi
// File Purpose: Recover missing milestone lease state for resumed isolated workers.

import { randomUUID } from "node:crypto";

import { debugLog } from "../debug-logger.js";
import { insertAuditEvent } from "../gsd-db.js";
import { isDeadLocalAutoWorker, markWorkerCrashed } from "../db/auto-workers.js";
import {
  claimMilestoneLease,
  forceReleaseMilestoneLeaseForWorker,
  getMilestoneLease,
  type ClaimResult,
} from "../db/milestone-leases.js";
import { normalizeRealPath } from "../paths.js";
import { resolveWorktreeOwningProjectRoot } from "../worktree-root.js";
import { worktreePathFor } from "../worktree-placement.js";
import type { getIsolationMode } from "../preferences.js";

type IsolationMode = ReturnType<typeof getIsolationMode>;

export interface MilestoneLeaseSession {
  workerId: string | null;
  currentMilestoneId: string | null;
  milestoneLeaseToken: number | null;
  /** Canonical project root — the probe scope for dead-holder reclaim (#2851). */
  canonicalProjectRoot?: string | null;
  basePath?: string | null;
  originalBasePath?: string | null;
}

/** The claim result plus the dead holder whose lease was force-released, if any. */
export interface ReclaimingClaimResult {
  claim: ClaimResult;
  /**
   * Set when a verifiably-dead local holder's lease was force-released so the
   * claim could proceed — even if a third worker then won the retry race.
   */
  reclaimedFrom: string | null;
}

/**
 * The project root a dead-holder liveness probe runs against: the session's
 * canonical root when known, else the environment-independent owning-root
 * resolution of its paths.
 */
export function sessionProjectRootForLeaseProbe(session: MilestoneLeaseSession): string {
  if (session.canonicalProjectRoot) return session.canonicalProjectRoot;
  return normalizeRealPath(
    resolveWorktreeOwningProjectRoot(session.basePath || session.originalBasePath || ""),
  );
}

/**
 * The project identities a holder worker could have been registered under for
 * this milestone: the caller's base, its environment-independent owning
 * repository root, and the milestone's canonical worktree path. Auto workers
 * register the repository root while the interactive kernel claim registers
 * the milestone worktree (`resolveCanonicalMilestoneRoot`), so probing a
 * single spelling misses dead-holder reclaims across that boundary (#2851).
 * The owning-root resolver is used instead of `resolveWorktreeProjectRoot`
 * because the latter honors `GSD_PROJECT_ROOT`, which would probe a foreign
 * project on a stale environment. All candidates derive from the caller's
 * own base and milestone id — never another project.
 */
function leaseProbeRoots(projectRootRealpath: string, milestoneId: string): string[] {
  const repoRoot = resolveWorktreeOwningProjectRoot(projectRootRealpath);
  return [
    projectRootRealpath,
    repoRoot,
    worktreePathFor(repoRoot, milestoneId),
  ];
}

function holderIsDeadLocalInProject(holderWorkerId: string, probeRoots: string[]): boolean {
  return probeRoots.some((root) => isDeadLocalAutoWorker(holderWorkerId, root));
}

/**
 * Claim the milestone lease, first reclaiming it when the holder is a
 * verifiably-dead local auto worker (#2375, extended to every claim site by
 * #2851). Mirrors the `gsd_plan_milestone` reclaim from PR #2382: probe the
 * holder with OS PID liveness, mark it crashed, release its held lease, then
 * retry the claim. Two deliberate tightenings over the reference worker-wide
 * sweep: the release is bound to the fencing token observed on the held row
 * and scoped to this milestone, so a concurrent recovery claim under the dead
 * worker's id or a competing reclaimer that moves the row off
 * (worker_id, fencing_token) is never revoked and never journaled as this
 * call's release; and the retry claim runs unconditionally so the returned
 * holder/expiry always reflect the current row. The retry is an ordinary
 * `claimMilestoneLease`: it can only win an expired/released (or re-entrant)
 * lease and bumps the fencing token in one transaction. Alive, remote, or
 * unprobeable holders are never stolen from.
 *
 * Known subsystem boundary (pre-existing since PR #2382): a live process that
 * deliberately adopted the dead worker's identity — task-settle's recovery
 * lease claimed before this call's probe — is indistinguishable from the
 * orphaned lease and can still be released; fencing tokens make that
 * fail-safe (the fenced write aborts loudly). Disambiguating the two needs a
 * cross-process attestation and is an owner design call (the #2448 family).
 */
export function claimMilestoneLeaseReclaimingDeadHolder(
  workerId: string,
  milestoneId: string,
  projectRootRealpath: string,
): ReclaimingClaimResult {
  let claim = claimMilestoneLease(workerId, milestoneId);
  if (claim.ok) return { claim, reclaimedFrom: null };
  if (claim.error !== "held_by" || !claim.byWorker || claim.byWorker === workerId) {
    return { claim, reclaimedFrom: null };
  }
  const holder = claim.byWorker;
  if (!holderIsDeadLocalInProject(holder, leaseProbeRoots(projectRootRealpath, milestoneId))) {
    return { claim, reclaimedFrom: null };
  }
  markWorkerCrashed(holder);
  const held = getMilestoneLease(milestoneId);
  let reclaimedFrom: string | null = null;
  if (held && held.worker_id === holder && held.status === "held") {
    const released = forceReleaseMilestoneLeaseForWorker(holder, milestoneId, held.fencing_token);
    if (released) {
      reclaimedFrom = holder;
      // markWorkerCrashed only journals active rows — journal the reclaim
      // itself so a non-active holder row still leaves a trail (PR #2382
      // discipline), naming exactly the lease this call released.
      insertAuditEvent({
        eventId: randomUUID(),
        traceId: holder,
        category: "orchestration",
        type: "milestone-lease-reclaimed",
        ts: new Date().toISOString(),
        payload: {
          workerId: holder,
          milestoneId,
          fencingToken: held.fencing_token,
          reclaimedBy: workerId,
        },
      });
    }
  }
  // Re-claim unconditionally: a competing reclaimer may have freed (and
  // possibly re-taken) the lease between the probe and the release, which
  // would make the first claim's holder/expiry snapshot stale.
  claim = claimMilestoneLease(workerId, milestoneId);
  return { claim, reclaimedFrom };
}

export function hasHeldMilestoneLease(
  session: MilestoneLeaseSession,
  milestoneId: string | null | undefined,
): boolean {
  return (
    Boolean(milestoneId) &&
    session.currentMilestoneId === milestoneId &&
    typeof session.milestoneLeaseToken === "number"
  );
}

export function reclaimMissingMilestoneLease(
  session: MilestoneLeaseSession,
  milestoneId: string | null | undefined,
  isolationMode: IsolationMode,
  phase: string,
): void {
  if (isolationMode === "none") return;
  if (!session.workerId || !milestoneId) return;
  if (hasHeldMilestoneLease(session, milestoneId)) return;
  // Note: we intentionally do NOT bail just because the session already holds a
  // lease for a *different* milestone. When dispatch advances to a new
  // milestone the session's stale `currentMilestoneId`/token are for the prior
  // one, and the active milestone's lease must still be claimed — otherwise
  // worktree safety sees `held: false` and fails dispatch (#760). Claiming is
  // safe: claimMilestoneLease refuses to steal a lease another worker holds —
  // a verifiably-dead local holder is the one exception (#2375, #2851).

  try {
    const { claim, reclaimedFrom } = claimMilestoneLeaseReclaimingDeadHolder(
      session.workerId,
      milestoneId,
      sessionProjectRootForLeaseProbe(session),
    );
    if (reclaimedFrom) {
      debugLog("worktreeSafety", {
        phase: "dead-holder-lease-reclaimed",
        source: phase,
        milestoneId,
        workerId: session.workerId,
        holderWorkerId: reclaimedFrom,
      });
    }
    if (claim.ok) {
      session.currentMilestoneId = milestoneId;
      session.milestoneLeaseToken = claim.token;
      debugLog("worktreeSafety", {
        phase: "lease-reclaimed",
        source: phase,
        milestoneId,
        workerId: session.workerId,
        token: claim.token,
      });
    } else {
      debugLog("worktreeSafety", {
        phase: "lease-reclaim-blocked",
        source: phase,
        milestoneId,
        workerId: session.workerId,
        holderWorkerId: claim.byWorker,
        expiresAt: claim.expiresAt,
      });
    }
  } catch (err) {
    debugLog("worktreeSafety", {
      phase: "lease-reclaim-failed",
      source: phase,
      milestoneId,
      workerId: session.workerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
