// Project/App: gsd-pi
// File Purpose: Runtime state derivation from the GSD workflow database.
// GSD Extension — State Derivation
// DB-authoritative runtime derivation. Markdown is never a live-path fallback.

import type {
  Roadmap,
  SlicePlan,
} from './types.js';

import {
  resolveMilestoneFile,
  gsdRoot,
} from './paths.js';

import { findMilestoneIds } from './milestone-ids.js';
import { isClosedStatus } from './status-guards.js';
import { join } from 'path';
import { existsSync } from 'node:fs';
import { extractVerdict } from './verdict-parser.js';
import {
  deriveState,
  getDeriveTelemetry,
  invalidateStateCache,
  resetDeriveTelemetry,
  type DeriveStateOptions,
} from './state/derive/index.js';
import { deriveStateFromDb } from './state/derive/from-db.js';
import { getRequestedMilestoneLock, syncQueueOrderProjectionToDb } from './state/derive/db-open.js';

export {
  deriveState,
  deriveStateFromDb,
  getDeriveTelemetry,
  invalidateStateCache,
  resetDeriveTelemetry,
  type DeriveStateOptions,
};

import {
  isDbAvailable,
  getAllMilestones,
  getMilestone,
} from './gsd-db.js';

/**
 * A "ghost" milestone directory contains only META.json (and no substantive
 * files like CONTEXT, CONTEXT-DRAFT, ROADMAP, or SUMMARY).  These appear when
 * a milestone is created but never initialised.  Treating them as active causes
 * auto-mode to stall or falsely declare completion.
 *
 * However, a milestone is NOT a ghost if:
 * - It has a DB row with a meaningful status (queued, active, etc.) — the DB
 *   knows about it even if content files haven't been created yet.
 * - It has a worktree directory — a worktree proves the milestone was
 *   legitimately created and is expected to be populated.
 *
 * Fixes #2921: queued milestones with worktrees were incorrectly classified
 * as ghosts, causing auto-mode to skip them entirely.
 */
export function isGhostMilestone(basePath: string, mid: string): boolean {
  // If the milestone has a DB row, it's usually a known milestone — not a ghost.
  // Exception: a "queued" row with no disk artifacts is a phantom from
  // gsd_milestone_generate_id that was never planned (#3645).
  if (isDbAvailable()) {
    const dbRow = getMilestone(mid);
    if (dbRow) {
      if (dbRow.status === 'queued') {
        const hasContent = resolveMilestoneFile(basePath, mid, "CONTEXT")
          || resolveMilestoneFile(basePath, mid, "ROADMAP")
          || resolveMilestoneFile(basePath, mid, "SUMMARY");
        return !hasContent;
      }
      return false;
    }
  }

  // If a worktree exists for this milestone, it was legitimately created.
  const root = gsdRoot(basePath);
  const wtPath = join(root, 'worktrees', mid);
  if (existsSync(wtPath)) return false;

  // Fall back to content-file check: no substantive files means ghost.
  const context   = resolveMilestoneFile(basePath, mid, "CONTEXT");
  const draft     = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
  const roadmap   = resolveMilestoneFile(basePath, mid, "ROADMAP");
  const summary   = resolveMilestoneFile(basePath, mid, "SUMMARY");
  return !context && !draft && !roadmap && !summary;
}

/**
 * A "reusable ghost" milestone is an orphaned filesystem stub that is safe
 * to reclaim as the next milestone ID.
 *
 * Stricter than `isGhostMilestone`: returns true ONLY when ALL of the
 * following hold:
 *   1. No DB row exists for `mid` (any status, including "queued") — a DB row
 *      means the milestone was intentionally registered by
 *      `gsd_milestone_generate_id` and may have an in-flight discuss flow.
 *      Reusing it would collide with that flow. (#4996 race window)
 *   2. No worktree directory exists at `gsdRoot/worktrees/{mid}` — a worktree
 *      means the milestone is legitimately in-flight.
 *   3. No content files exist (CONTEXT, CONTEXT-DRAFT, ROADMAP, SUMMARY) —
 *      any content means the discuss flow already ran.
 *
 * The looser `isGhostMilestone` also classifies queued-row-without-content as
 * a ghost to help state queries filter phantoms. `isReusableGhostMilestone`
 * intentionally does NOT reclaim those — a queued row is sufficient proof of
 * a live in-flight ID reservation.
 *
 * Used by `nextMilestoneIdReserved` and both MCP ID-generator tools to fill
 * gaps left by phantom directories before resorting to max+1.
 */
export function isReusableGhostMilestone(basePath: string, mid: string): boolean {
  // Condition 1: no DB row (any status).
  if (!isDbAvailable()) return false;
  const dbRow = getMilestone(mid);
  if (dbRow != null) return false;

  // Condition 2: no worktree.
  const root = gsdRoot(basePath);
  const wtPath = join(root, 'worktrees', mid);
  if (existsSync(wtPath)) return false;

  // Condition 3: no content files.
  const context = resolveMilestoneFile(basePath, mid, "CONTEXT");
  const draft   = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
  const roadmap = resolveMilestoneFile(basePath, mid, "ROADMAP");
  const summary = resolveMilestoneFile(basePath, mid, "SUMMARY");
  return !context && !draft && !roadmap && !summary;
}

// ─── Query Functions ───────────────────────────────────────────────────────

/**
 * Check if all tasks in a slice plan are done.
 */
export function isSliceComplete(plan: SlicePlan): boolean {
  return plan.tasks.length > 0 && plan.tasks.every(t => t.done);
}

/**
 * Check if all slices in a roadmap are done.
 */
export function isMilestoneComplete(roadmap: Roadmap): boolean {
  return roadmap.slices.length > 0 && roadmap.slices.every(s => s.done);
}

/**
 * Check whether a VALIDATION file's verdict is terminal.
 * Any successfully extracted verdict (pass, needs-attention, needs-remediation,
 * fail, etc.) means validation completed. Only return false when no verdict
 * could be parsed — i.e. extractVerdict() returns undefined (#2769).
 */
export function isValidationTerminal(validationContent: string): boolean {
  return extractVerdict(validationContent) != null;
}

export async function getActiveMilestoneId(basePath: string): Promise<string | null> {
  // Milestone-scoped execution. Parallel workers and explicit solo commands
  // such as `/gsd auto M002` both set GSD_MILESTONE_LOCK; state derivation must
  // honor it so recovery/adoption sees the requested milestone, not the first
  // open milestone in queue order.
  const milestoneLock = getRequestedMilestoneLock();
  if (milestoneLock) {
    if (isDbAvailable()) {
      const locked = getAllMilestones().find(m => m.id === milestoneLock);
      if (!locked || isClosedStatus(locked.status) || locked.status === "parked") return null;
      return locked.id;
    }

    const milestoneIds = findMilestoneIds(basePath);
    if (!milestoneIds.includes(milestoneLock)) return null;
    const lockedParked = resolveMilestoneFile(basePath, milestoneLock, "PARKED");
    if (lockedParked) return null;
    return milestoneLock;
  }

  // DB-first: query milestones table for the first non-complete, non-parked milestone
  if (isDbAvailable()) {
    syncQueueOrderProjectionToDb(basePath);
    const allMilestones = getAllMilestones();
    if (allMilestones.length > 0) {
      for (const m of allMilestones) {
        if (isClosedStatus(m.status) || m.status === "parked") continue;
        return m.id;
      }
      return null;
    }
    return null;
  }

  // Fail closed: an unavailable DB is not a license to parse markdown (T022).
  return null;
}
