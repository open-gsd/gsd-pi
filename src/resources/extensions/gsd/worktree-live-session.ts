// gsd-pi — Live auto-mode session detection for a worktree.
//
// A worktree that a running auto-mode session works in looks removable from
// git alone: it can have no diff against main and no uncommitted change, and
// its runtime state under `.gsd/` is git-ignored. The session lock is the
// record of a running session, so the removal commands ask it first.
//
// The `gsd worktree` CLI loads this module on its own, before any session
// exists. It reads the lock files directly and imports nothing from the
// session-lock module, whose imports that loader cannot resolve.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MILESTONE_ID_RE } from "./milestone-ids.js";
import { gsdRoot, normalizeRealPath } from "./paths.js";
import { parseUnitId } from "./unit-id.js";

export interface LiveWorktreeSession {
  pid: number;
  unitType: string;
  unitId: string;
}

export interface LiveSessionWorktree {
  name: string;
  path: string;
  branch: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // This process counts: a command typed into the session that runs auto-mode
  // must not remove that session's worktree.
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read a session lock file whose writer is still running. */
function readLiveLock(lockFile: string): LiveWorktreeSession | null {
  let data: { pid?: unknown; unitType?: unknown; unitId?: unknown };
  try {
    data = JSON.parse(readFileSync(lockFile, "utf-8"));
  } catch {
    return null;
  }
  if (!data || typeof data.pid !== "number" || !isProcessAlive(data.pid)) return null;
  return {
    pid: data.pid,
    unitType: typeof data.unitType === "string" ? data.unitType : "",
    unitId: typeof data.unitId === "string" ? data.unitId : "",
  };
}

/**
 * Whether the project session works in this worktree. The lock names the unit
 * of the session. Before the first unit it names no milestone, and the session
 * may enter any milestone worktree next, so that state counts as in use for a
 * milestone worktree.
 */
function projectSessionUsesWorktree(session: LiveWorktreeSession, worktree: LiveSessionWorktree): boolean {
  const milestone = parseUnitId(session.unitId).milestone;
  if (MILESTONE_ID_RE.test(milestone)) return milestone === worktree.name;
  return worktree.branch.startsWith("milestone/");
}

/**
 * Find a running auto-mode session that works in the given worktree.
 *
 * Reads, in order: the lock of a parallel worker for this milestone
 * (`auto-<name>.lock`), a session lock inside the worktree's own `.gsd/`, and
 * the project session lock (`auto.lock`). A lock counts only while the process
 * that wrote it is alive.
 */
export function findLiveWorktreeSession(
  projectRoot: string,
  worktree: LiveSessionWorktree,
): LiveWorktreeSession | null {
  let projectGsd: string | null = null;
  try {
    projectGsd = gsdRoot(projectRoot);
  } catch {
    // No resolvable project state directory: only the worktree-local lock applies.
  }

  if (projectGsd) {
    const workerSession = readLiveLock(join(projectGsd, `auto-${worktree.name}.lock`));
    if (workerSession) return workerSession;
  }

  const worktreeGsd = join(worktree.path, ".gsd");
  const sharesProjectState =
    projectGsd !== null && normalizeRealPath(worktreeGsd) === normalizeRealPath(projectGsd);
  if (!sharesProjectState) {
    const localSession = readLiveLock(join(worktreeGsd, "auto.lock"));
    if (localSession) return localSession;
  }

  if (projectGsd) {
    const projectSession = readLiveLock(join(projectGsd, "auto.lock"));
    if (projectSession && projectSessionUsesWorktree(projectSession, worktree)) {
      return projectSession;
    }
  }

  return null;
}

/** One-line description of the session, for a "kept" or refusal message. */
export function formatLiveWorktreeSession(session: LiveWorktreeSession): string {
  const unit = [session.unitType, session.unitId].filter(Boolean).join(" ");
  return `in use by a running auto-mode session, pid ${session.pid}${unit ? `, ${unit}` : ""}`;
}
