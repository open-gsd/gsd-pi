// gsd-pi — Worktree removal for the user-facing commands.
//
// One removal path for `/gsd worktree`, `/worktree`, `gsd worktree`,
// `/gsd cleanup worktrees` and the doctor fix, so they agree on two things:
// a worktree with a running auto-mode session is not removed, and a removal
// that left the directory on disk is not reported as done.

import {
  findLiveWorktreeSession,
  formatLiveWorktreeSession,
  type LiveSessionWorktree,
  type LiveWorktreeSession,
} from "./worktree-live-session.js";
import { removeWorktreeDetailed } from "./worktree-manager.js";

export type GuardedWorktreeRemoval =
  | { status: "removed" }
  | { status: "live-session"; session: LiveWorktreeSession }
  | { status: "preserved" }
  | { status: "partial"; path: string; cleanupCommand?: string };

export interface GuardedWorktreeRemovalOptions {
  deleteBranch?: boolean;
  /** Remove the worktree even when a running session works in it. */
  ignoreLiveSession?: boolean;
}

/**
 * Remove a listed worktree unless a running auto-mode session works in it.
 * The branch passed to git is the listed one: a milestone worktree is on
 * `milestone/<MID>`, not on the `worktree/<name>` default.
 */
export function removeWorktreeGuarded(
  projectRoot: string,
  worktree: LiveSessionWorktree,
  opts: GuardedWorktreeRemovalOptions = {},
): GuardedWorktreeRemoval {
  if (!opts.ignoreLiveSession) {
    const session = findLiveWorktreeSession(projectRoot, worktree);
    if (session) return { status: "live-session", session };
  }

  const result = removeWorktreeDetailed(projectRoot, worktree.name, {
    branch: worktree.branch,
    deleteBranch: opts.deleteBranch ?? true,
  });
  if (result.status === "partial") {
    return { status: "partial", path: result.path, cleanupCommand: result.cleanupCommand };
  }
  return { status: result.status };
}

/** Why a worktree is not fully gone, as a short clause. Null when it was removed. */
export function formatUnremovedWorktreeReason(removal: GuardedWorktreeRemoval): string | null {
  switch (removal.status) {
    case "removed":
      return null;
    case "live-session":
      return formatLiveWorktreeSession(removal.session);
    case "preserved":
      return "uncommitted changes could not be quarantined";
    case "partial":
      return removal.cleanupCommand
        ? `git no longer tracks it, but the directory could not be deleted: ${removal.path} — close the programs using it, then run: ${removal.cleanupCommand}`
        : `the directory is outside the worktrees directory and was left in place: ${removal.path}`;
  }
}
