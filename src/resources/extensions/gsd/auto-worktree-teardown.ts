// gsd-pi — Auto-worktree teardown module.
//
// Owns the teardown path for milestone worktrees: returning to the project
// root, transient state cleanup, legacy DB reconciliation, worktree/branch
// removal, fallback orphan-directory cleanup, and active workspace registry
// clearing.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { GSDError, GSD_IO_ERROR } from "./errors.js";
import {
  CanonicalWorktreeDivergenceError,
  reconcileWorktreeDb,
} from "./gsd-db.js";
import { resolveGsdPathContract } from "./paths.js";
import {
  removeWorktree,
  worktreePath,
  isInsideWorktreesDir,
} from "./worktree-manager.js";
import { nudgeGitBranchCache } from "./worktree.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";
import { autoWorktreeBranch } from "./auto-worktree-branch-lifecycle.js";
import { setActiveWorkspace } from "./auto-worktree-session-registry.js";
import {
  _shouldReconcileWorktreeDb,
  clearProjectRootStateFiles,
} from "./auto-worktree-cleanup.js";
import { logWarning, logError } from "./workflow-logger.js";

function safeCwd(fallback: string): string {
  try {
    return process.cwd();
  } catch {
    return fallback;
  }
}

/**
 * Teardown an auto-worktree: chdir back to original base, then remove
 * the worktree and its branch.
 */
export function teardownAutoWorktree(
  originalBasePath: string,
  milestoneId: string,
  opts: { preserveBranch?: boolean; preserveWorktree?: boolean } = {},
): void {
  originalBasePath = resolveWorktreeProjectRoot(originalBasePath);

  const branch = autoWorktreeBranch(milestoneId);
  const { preserveBranch = false, preserveWorktree = false } = opts;
  const previousCwd = safeCwd(originalBasePath);
  let clearActiveWorkspace = true;

  // Wrap the entire teardown body in a single try/finally so activeWorkspace
  // is cleared on completion or irrecoverable failure — even if process.chdir
  // throws (e.g. originalBasePath was deleted before teardown ran).
  try {
    try {
      process.chdir(originalBasePath);
    } catch (err) {
      throw new GSDError(
        GSD_IO_ERROR,
        `Failed to chdir back to ${originalBasePath} during teardown: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Mirror cleanup steps from mergeMilestoneToMain abort path:

    // 1. Remove transient state files (STATE.md, auto.lock, .gsd/{MID}-META.json).
    //    Non-fatal — must not block teardown.
    try {
      clearProjectRootStateFiles(originalBasePath, milestoneId);
    } catch (err) {
      logWarning(
        "worktree",
        `clearProjectRootStateFiles failed during teardown: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 2. Reconcile worktree-local gsd.db into project root DB if both exist.
    //    Ordinary legacy reconcile failures stay non-fatal. Canonical history
    //    divergence preserves the worktree because deleting it would lose work.
    try {
      const contract = resolveGsdPathContract(previousCwd, originalBasePath);
      const worktreeDbPath = join(
        contract.worktreeGsd ?? join(previousCwd, ".gsd"),
        "gsd.db",
      );
      const mainDbPath = contract.projectDb;
      if (_shouldReconcileWorktreeDb(worktreeDbPath, mainDbPath)) {
        reconcileWorktreeDb(mainDbPath, worktreeDbPath);
      }
    } catch (err) {
      logError(
        "worktree",
        `DB reconciliation failed during teardown: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (err instanceof CanonicalWorktreeDivergenceError) {
        clearActiveWorkspace = false;
        return;
      }
    }

    nudgeGitBranchCache(previousCwd);

    // 3. Remove the worktree unless this exit path explicitly preserves it
    //    (slice-parallel dispatch stops the parent loop but keeps the parent
    //    milestone worktree for restart/re-entry).
    let worktreeRemoved = preserveWorktree;
    if (!preserveWorktree) {
      worktreeRemoved = removeWorktree(originalBasePath, milestoneId, {
        branch,
        deleteBranch: !preserveBranch,
      });
      if (!worktreeRemoved) {
        logWarning(
          "worktree",
          `Worktree removal aborted for ${milestoneId}; uncommitted work was preserved. ` +
            `Manual quarantine recovery may be needed before retrying teardown.`,
          { worktree: milestoneId },
        );
        clearActiveWorkspace = false;
      }
    }

    // Verify cleanup succeeded — warn if the worktree directory is still on disk.
    // On Windows, bash-based cleanup can silently fail when paths contain
    // backslashes (#1436), leaving ~1 GB+ orphaned directories.
    const wtDir = worktreePath(originalBasePath, milestoneId);
    if (!preserveWorktree && worktreeRemoved && existsSync(wtDir)) {
      logWarning(
        "reconcile",
        `Worktree directory still exists after teardown: ${wtDir}. ` +
          `This is likely an orphaned directory consuming disk space. ` +
          `Remove it manually with: rm -rf "${wtDir.replaceAll("\\", "/")}"`,
        { worktree: milestoneId },
      );
      // Attempt a direct filesystem removal as a fallback — but ONLY if the
      // path is safely inside .gsd/worktrees/ to prevent #2365 data loss.
      if (isInsideWorktreesDir(originalBasePath, wtDir)) {
        try {
          rmSync(wtDir, { recursive: true, force: true });
        } catch (err) {
          // Non-fatal — the warning above tells the user how to clean up
          logWarning(
            "worktree",
            `worktree directory removal failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        console.error(
          `[GSD] REFUSING fallback rmSync — path is outside .gsd/worktrees/: ${wtDir}`,
        );
      }
    }
  } finally {
    // Clear module state when teardown completed or failed irrecoverably.
    // When removeWorktree returns false (quarantine failure), preserve the
    // registry so recovery logic still sees the active milestone worktree.
    if (clearActiveWorkspace) {
      setActiveWorkspace(null);
    }
  }
}
