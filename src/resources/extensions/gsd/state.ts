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
import { getRequestedMilestoneLock } from './state/derive/db-open.js';

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
  getMilestone,
  getMilestoneSlices,
  hasSavedArtifact,
} from './gsd-db.js';
import { readMilestone, readMilestones } from './db/lifecycle-read.js';

/**
 * A "ghost" milestone directory contains only META.json (and no substantive
 * files like CONTEXT, CONTEXT-DRAFT, ROADMAP, or SUMMARY).  These appear when
 * a milestone is created but never initialised.  Treating them as active causes
 * auto-mode to stall or falsely declare completion.
 *
 * However, a milestone is NOT a ghost if:
 * - It has a DB row. The one exception is a queued row with no saved CONTEXT
 *   or CONTEXT-DRAFT row and no slice rows (see below); files do not decide.
 * - It has a worktree directory — a worktree proves the milestone was
 *   legitimately created and is expected to be populated.
 *
 * Fixes #2921: queued milestones with worktrees were incorrectly classified
 * as ghosts, causing auto-mode to skip them entirely.
 */
export function isGhostMilestone(basePath: string, mid: string): boolean {
  // If the milestone has a DB row, it's usually a known milestone — not a ghost.
  // Exception: a "queued" row with no saved context and no slice rows is a
  // phantom from gsd_milestone_generate_id that was never planned (#3645).
  // The rows decide; a projection file on disk is not read.
  if (isDbAvailable()) {
    const dbRow = readMilestone(mid);
    if (dbRow) {
      if (dbRow.status === 'queued') {
        return !hasSavedArtifact(mid, null, "CONTEXT")
          && !hasSavedArtifact(mid, null, "CONTEXT-DRAFT")
          && getMilestoneSlices(mid).length === 0;
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
    // Fail closed: with no DB the locked milestone cannot be confirmed open.
    if (!isDbAvailable()) return null;
    const locked = readMilestone(milestoneLock);
    if (!locked || locked.closed || locked.parked) return null;
    return locked.id;
  }

  // DB-first: the first milestone in workflow order that is not closed and not parked
  if (isDbAvailable()) {
    return readMilestones().find(m => !m.closed && !m.parked)?.id ?? null;
  }

  // Fail closed: an unavailable DB is not a license to parse markdown (T022).
  return null;
}
