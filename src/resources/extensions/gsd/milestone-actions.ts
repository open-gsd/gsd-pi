/**
 * GSD Milestone Actions — Park, Unpark, and Discard operations.
 *
 * Park: Creates a PARKED.md marker file. deriveState() skips parked milestones
 * when finding the active milestone, but keeps them in the registry.
 *
 * Unpark: Removes the PARKED.md marker. The milestone resumes normal state
 * derivation (active/pending depending on position and dependencies).
 *
 * Discard: Permanently removes the milestone directory. Also prunes
 * QUEUE-ORDER.json if the discarded milestone was in it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveMilestonePath,
  resolveMilestoneFile,
  buildMilestoneFileName,
  relMilestoneFile,
} from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { loadQueueOrder, saveQueueOrder } from "./queue-order.js";
import {
  assertNoAdoptedLifecycleHistory,
  deleteMilestone,
  executeDomainOperation,
  getMilestone,
  isDbAvailable,
  projectCanonicalStatusToLegacy,
  updateMilestoneStatus,
} from "./gsd-db.js";
import { isMilestoneLifecycleAdopted } from "./db/milestone-closeout-readiness.js";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "./db/writers/lifecycle-commands.js";
import { removeWorktree } from "./worktree-manager.js";
import { logWarning } from "./workflow-logger.js";
import { isAutoActive } from "./auto.js";
import { isClosedStatus } from "./status-guards.js";
import { atomicWriteSync, removeProjectionFileSync } from "./atomic-write.js";
import { removeManagedProjectionTreeExactSync } from "./managed-projection-history.js";
import { GSDError, GSD_STALE_STATE } from "./errors.js";

/**
 * Writer-side assert for mutations that race with auto-mode's squash merge (#4704).
 * Auto-mode is confirmed not to call parkMilestone/discardMilestone/unparkMilestone
 * internally — these throws only surface invariant violations from new or forgotten
 * call sites, which is the correct failure mode to catch loudly.
 */
function assertNotAutoActive(action: string): void {
  if (isAutoActive()) {
    throw new Error(
      `${action} cannot run while auto-mode is active. Stop auto-mode first with /gsd stop.`,
    );
  }
}

/**
 * Milestone status lives in the DB. With no open DB these actions refuse
 * before touching any file, worktree or branch (ADR-046).
 */
function assertDbAvailable(action: string, milestoneId: string): void {
  if (!isDbAvailable()) {
    throw new GSDError(GSD_STALE_STATE, `${action} ${milestoneId} refused: database unavailable`);
  }
}

/**
 * Park/unpark through canonical lifecycle for adopted milestones (#2126).
 * Legacy `parked` maps to canonical `paused`; generic status writes reject
 * that mismatch on adopted rows.
 */
function syncAdoptedMilestoneParkStatus(milestoneId: string, parked: boolean): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: parked ? "milestone.park" : "milestone.unpark",
    idempotencyKey: `command/${parked ? "park" : "unpark"}/${milestoneId}/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "operator",
    sourceTransport: "internal",
    payload: { milestoneId, parked },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId,
      lifecycleStatus: parked ? "paused" : "in_progress",
    });
    projectCanonicalStatusToLegacy(context, {
      entity: "milestone",
      milestoneId,
      status: parked ? "parked" : "active",
    });
    return {
      events: [{
        eventType: parked ? "milestone.parked" : "milestone.unparked",
        entityType: "milestone",
        entityId: milestoneId,
        payload: { milestoneId, parked },
        destinations: ["db"],
      }],
      projections: [{
        projectionKey: `milestone/${milestoneId.toLowerCase()}/${parked ? "parked" : "active"}`,
        projectionKind: "milestone-status",
        rendererVersion: "1",
      }],
    };
  });
}

// ─── Park ──────────────────────────────────────────────────────────────────

/**
 * Park a milestone — records status='parked' in the DB, then creates a
 * PARKED.md marker file with reason and timestamp. Parked milestones are
 * skipped during active-milestone discovery but stay on disk.
 * Returns true if successfully parked, false if milestone not found, already parked, or complete.
 * Throws if the DB sync fails (#2255): no marker file is written in that case,
 * so the caller never reports success for a park that did not take, and a
 * later retry starts clean instead of short-circuiting as already parked (#2256).
 */
export function parkMilestone(basePath: string, milestoneId: string, reason: string): boolean {
  assertNotAutoActive("park milestone");
  assertDbAvailable("parkMilestone", milestoneId);
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (!mDir || !existsSync(mDir)) return false;

  // Guard: do not park a completed milestone — it would corrupt depends_on satisfaction
  const milestone = getMilestone(milestoneId);
  if (milestone && isClosedStatus(milestone.status)) return false;

  // Use relMilestoneFile for layout-aware path (legacy: M001-PARKED.md, flat-phase: 01-PARKED.md)
  const parkedPath = join(basePath, relMilestoneFile(basePath, milestoneId, "PARKED"));
  if (existsSync(parkedPath)) return false; // already parked

  const content = [
    "---",
    `parked_at: ${new Date().toISOString()}`,
    `reason: "${reason.replace(/"/g, '\\"')}"`,
    "---",
    "",
    `# ${milestoneId} — Parked`,
    "",
    `> ${reason}`,
    "",
  ].join("\n");

  // DB write FIRST (#2256): if the sync fails, no marker file is written, so
  // the park can be retried instead of being stuck as file-parked/DB-active.
  // The failure propagates (#2255) — callers must not report success.
  try {
    if (isMilestoneLifecycleAdopted(milestoneId)) {
      syncAdoptedMilestoneParkStatus(milestoneId, true);
    } else {
      updateMilestoneStatus(milestoneId, "parked");
    }
  } catch (err) {
    throw new Error(`parkMilestone DB sync failed for ${milestoneId}: ${(err as Error).message}`);
  }
  // If the marker write fails after the DB sync, the row is parked with no
  // marker on disk. That state is recoverable in both directions: a retry
  // re-runs the idempotent DB write and rewrites the marker, and
  // unparkMilestone repairs DB-parked-without-marker (#3707).
  atomicWriteSync(parkedPath, content, "utf-8");
  invalidateAllCaches();
  return true;
}

// ─── Unpark ────────────────────────────────────────────────────────────────

/**
 * Unpark a milestone — records the DB status, then removes the PARKED.md marker file.
 * Returns true if successfully unparked, false if milestone not found or not parked.
 * Throws if the DB sync fails; the marker is kept so the retry starts clean.
 */
export function unparkMilestone(basePath: string, milestoneId: string): boolean {
  assertNotAutoActive("unpark milestone");
  assertDbAvailable("unparkMilestone", milestoneId);
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (!mDir || !existsSync(mDir)) return false;

  // Use relMilestoneFile for layout-aware path (legacy: M001-PARKED.md, flat-phase: 01-PARKED.md)
  const parkedPath = join(basePath, relMilestoneFile(basePath, milestoneId, "PARKED"));
  const hadParkedFile = existsSync(parkedPath);
  const dbThinksParked = getMilestone(milestoneId)?.status === "parked";

  // Recover the reverse desync too: DB can still say "parked" even when the
  // PARKED marker was lost on disk, and /gsd unpark should repair that state.
  if (!hadParkedFile && !dbThinksParked) return false;

  // Sync DB status FIRST so deriveStateFromDb picks up the unparked milestone (#2694)
  try {
    if (isMilestoneLifecycleAdopted(milestoneId)) {
      syncAdoptedMilestoneParkStatus(milestoneId, false);
    } else {
      updateMilestoneStatus(milestoneId, "active");
    }
  } catch (err) {
    throw new Error(`unparkMilestone DB sync failed for ${milestoneId}: ${(err as Error).message}`);
  }
  if (hadParkedFile) {
    removeProjectionFileSync(parkedPath);
  }
  invalidateAllCaches();
  return true;
}

// ─── Discard ───────────────────────────────────────────────────────────────

/**
 * Discard a milestone — permanently removes the milestone directory and
 * prunes it from QUEUE-ORDER.json if present.
 * Returns true if successfully discarded, false if milestone not found.
 * The DB rows are deleted first; a DB failure throws before any file,
 * worktree or branch is removed.
 */
export function discardMilestone(basePath: string, milestoneId: string): boolean {
  assertNotAutoActive("discard milestone");
  assertDbAvailable("discardMilestone", milestoneId);
  const mDir = resolveMilestonePath(basePath, milestoneId);
  const hasMilestoneDir = !!mDir && existsSync(mDir);
  const hasDbMilestone = getMilestone(milestoneId) !== null;
  if (!hasMilestoneDir && !hasDbMilestone) return false;
  if (hasDbMilestone) {
    assertNoAdoptedLifecycleHistory("discardMilestone", [milestoneId]);
    deleteMilestone(milestoneId);
  }

  try {
    removeWorktree(basePath, milestoneId, {
      branch: `milestone/${milestoneId}`,
      deleteBranch: true,
    });
  } catch (err) {
    logWarning("engine", `discardMilestone worktree cleanup failed for ${milestoneId}: ${(err as Error).message}`);
  }

  if (hasMilestoneDir && mDir) {
    removeManagedProjectionTreeExactSync(basePath, mDir);
  }

  // Prune from queue order if present
  const order = loadQueueOrder(basePath);
  if (order && order.includes(milestoneId)) {
    saveQueueOrder(basePath, order.filter(id => id !== milestoneId));
  }

  invalidateAllCaches();
  return true;
}

// ─── Query ─────────────────────────────────────────────────────────────────

/**
 * Check whether a milestone is parked (PARKED.md exists).
 */
export function isParked(basePath: string, milestoneId: string): boolean {
  return !!resolveMilestoneFile(basePath, milestoneId, "PARKED");
}

/**
 * Read the park reason from PARKED.md frontmatter.
 * Returns null if the milestone is not parked or the reason can't be extracted.
 */
export function getParkedReason(basePath: string, milestoneId: string): string | null {
  const parkedFile = resolveMilestoneFile(basePath, milestoneId, "PARKED");
  if (!parkedFile) return null;

  try {
    const content = readFileSync(parkedFile, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const reasonMatch = match[1].match(/reason:\s*"([^"]*?)"/);
    return reasonMatch ? reasonMatch[1] : null;
  } catch {
    return null;
  }
}
