// gsd-pi — Auto-worktree merge module.
//
// Owns milestone merge/closeout for auto-worktrees: dirty-state capture, DB
// reconciliation, integration-branch merge, stash/shelter recovery, publication,
// and safe teardown.

import { atomicWriteSync } from "./atomic-write.js";
import { debugLog } from "./debug-logger.js";
import { GSDError, GSD_GIT_ERROR } from "./errors.js";
import { autoResolveSafeConflictPaths } from "./git-conflict-resolve.js";
import {
  MergeConflictError,
  RUNTIME_EXCLUSION_PATHS,
} from "./git-service.js";
import {
  getMilestone,
  isDbAvailable,
} from "./gsd-db.js";
import {
  nativeAddAllWithExclusions,
  nativeCommit,
  nativeConflictFiles,
  nativeGetCurrentBranch,
  nativeMergeRegular,
  nativeMergeSquash,
  nativeWorkingTreeStatus,
} from "./native-git-bridge.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { publishMilestone } from "./publication.js";
import {
  autoWorktreeBranch,
} from "./auto-worktree-branch-lifecycle.js";
import { createMilestoneDirectoryShelter } from "./auto-worktree-milestone-shelter.js";
import { getActiveWorkspace } from "./auto-worktree-session-registry.js";
import {
  assertNoUnanchoredCodeChangesAfterEmptyMerge,
  detectMergedCodeFilesChanged,
} from "./auto-worktree-merge-code-changes.js";
import { reconcileMilestoneBranchHead } from "./auto-worktree-merge-branch-head.js";
import { finalizeAlreadyMergedMilestoneIfReachable } from "./auto-worktree-merge-already-merged.js";
import { cleanupMergedMilestoneWorktree } from "./auto-worktree-merge-cleanup.js";
import { assertMilestoneDbReadyForMerge } from "./auto-worktree-merge-db-ready.js";
import { prepareIntegrationBranchForMilestoneMerge } from "./auto-worktree-merge-integration-branch.js";
import { buildMilestoneMergeMessage } from "./auto-worktree-merge-message.js";
import { assertMilestoneWorktreeCleanBeforeTeardown } from "./auto-worktree-merge-pre-teardown.js";
import { createPreMergeStash } from "./auto-worktree-merge-stash.js";
import {
  cleanupConflictState,
  removeMergeStateFiles,
} from "./worktree-git-recovery.js";
import { logError, logWarning } from "./workflow-logger.js";

export { _setRestoreEntryFnForTests } from "./auto-worktree-milestone-shelter.js";


// ─── Merge Milestone -> Main ───────────────────────────────────────────────

/**
 * Auto-commit any dirty (uncommitted) state in the given directory.
 * Returns true if a commit was made, false if working tree was clean.
 */
function autoCommitDirtyState(cwd: string): boolean {
  try {
    const status = nativeWorkingTreeStatus(cwd);
    if (!status) return false;
    nativeAddAllWithExclusions(cwd, RUNTIME_EXCLUSION_PATHS);
    const result = nativeCommit(
      cwd,
      "chore: auto-commit before milestone merge",
    );
    return result !== null;
  } catch (e) {
    debugLog("autoCommitDirtyState", { error: String(e) });
    throw new GSDError(
      GSD_GIT_ERROR,
      `Failed to auto-commit dirty worktree state before milestone merge: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Squash-merge the milestone branch into main with a rich commit message
 * listing all completed slices, then tear down the worktree.
 *
 * Sequence:
 *  1. Stash dirty state, prove closeout, then restore and auto-commit
 *  2. chdir to originalBasePath
 *  3. git checkout main
 *  4. git merge --squash milestone/<MID>
 *  5. git commit with rich message
 *  6. Auto-push if enabled
 *  7. Delete milestone branch
 *  8. Remove worktree directory
 *  9. Clear originalBase
 *
 * On merge conflict: throws MergeConflictError.
 * On "nothing to commit" after squash: safe only if milestone work is already
 * on the integration branch.  Throws if unanchored code changes would be lost.
 *
 * @internal **Do not call directly.** This is the inner squash-merge primitive
 * for the Worktree Lifecycle Module (ADR-016 phase 2 / A3, issue #5619).
 * Production callers must go through `WorktreeLifecycle.mergeMilestoneStandalone`
 * or `WorktreeLifecycle.exitMilestone({ merge: true })`. The export keyword
 * is preserved for legacy tests and the default transaction adapter; production
 * wiring depends on `createDefaultMilestoneMergeTransaction()` instead.
 */
export function mergeMilestoneToMain(
  originalBasePath_: string,
  milestoneId: string,
  roadmapContent: string,
): { commitMessage: string; pushed: boolean; prCreated: boolean; codeFilesChanged: boolean } {
  const worktreeCwd = process.cwd();
  const milestoneBranch = autoWorktreeBranch(milestoneId);

  // 1. Protect dirty state while proving closeout, then auto-commit it before
  //    leaving. Verification revisions include untracked paths, so committing
  //    before this proof changes the source revision the proof is checking and
  //    permanently wedges retries (#1793).
  //    Guard: when we entered through an auto-worktree (originalBase is set),
  //    only auto-commit when cwd is on the milestone branch. In parallel mode,
  //    cwd may be on the integration branch after a prior merge's
  //    MergeConflictError left cwd unrestored. Auto-committing on the
  //    integration branch captures dirty files from OTHER milestones under a
  //    misleading commit message, contaminating the main branch (#2929).
  //
  //    When activeWorkspace is null (branch mode, no worktree), autoCommitDirtyState
  //    runs unconditionally — the caller is responsible for cwd placement.
  let shouldAutoCommit = true;
  if (getActiveWorkspace() !== null) {
    try {
      const currentBranch = nativeGetCurrentBranch(worktreeCwd);
      shouldAutoCommit = currentBranch === milestoneBranch;
    } catch {
      // If we can't determine the branch, skip the auto-commit to be safe
      shouldAutoCommit = false;
    }
  }

  const authorizationStash = shouldAutoCommit
    ? createPreMergeStash(
        worktreeCwd,
        milestoneId,
        process.platform === "win32" && isDbAvailable(),
        { excludeGsdState: true },
      )
    : null;
  authorizationStash?.stash();
  try {
    // Reconcile DB state and prove closeout against the validated tree before
    // GSD mutates it with its own pre-merge commit.
    assertMilestoneDbReadyForMerge({
      milestoneId,
      projectRoot: originalBasePath_,
      worktreeCwd,
    });
    // This is a success-path invariant: if protected files cannot be restored,
    // abort before committing or tearing down the milestone branch.
    authorizationStash?.restoreBeforeAutoCommit();
  } catch (error) {
    authorizationStash?.restoreForMergeFailure();
    throw error;
  }
  if (shouldAutoCommit) autoCommitDirtyState(worktreeCwd);

  // 2. Build completed-slice summaries and rich commit message.
  const { commitMessage, milestoneTitle, sliceSummaries } = buildMilestoneMergeMessage({
    milestoneId,
    milestoneBranch,
    roadmapContent,
  });

  // 3. chdir to original base
  // Note: previousCwd captures the cwd at this point — i.e. the worktree cwd
  // entering the function. Subsequent throws restore to previousCwd, leaving
  // the caller in worktree-cwd; callers (worktree-resolver) are responsible
  // for any further cwd movement on the error path.
  const previousCwd = process.cwd();
  process.chdir(originalBasePath_);

  // 4/5. Resolve and prepare the integration branch. The integration-branch
  //      module owns stale metadata fallback, self-merge fail-closed behavior,
  //      detached HEAD protection, transient state cleanup, and checkout.
  const prefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
  const { mainBranch } = prepareIntegrationBranchForMilestoneMerge({
    milestoneBranch,
    milestoneId,
    prefs,
    previousCwd,
    projectRoot: originalBasePath_,
  });

  // 6b. Reconcile worktree HEAD with milestone branch ref (#1846).
  //     The branch-head module owns the data-loss guard: fast-forward stale
  //     branch refs to detached worktree commits, and fail loudly on divergence.
  reconcileMilestoneBranchHead({
    projectRoot: originalBasePath_,
    worktreeCwd,
    milestoneBranch,
    previousCwd,
  });

  // Already regular-merged milestones can skip the squash path and proceed to cleanup (#5831).
  const alreadyMerged = finalizeAlreadyMergedMilestoneIfReachable({
    projectRoot: originalBasePath_,
    milestoneId,
    milestoneBranch,
    mainBranch,
    previousCwd,
    commitMessage,
  });
  if (alreadyMerged) return alreadyMerged;

  // 7. Shelter queued milestone directories before the squash merge (#2505).
  // MUST run before the pre-merge stash so queued CONTEXT files are not swept
  // into a stash that may later fail to pop and strand user work.
  const milestoneDirectoryShelter = createMilestoneDirectoryShelter(
    originalBasePath_,
    milestoneId,
    getMilestone(milestoneId)?.title,
  );

  // 7a. Stash pre-existing dirty files so the squash merge is not blocked by
  //     unrelated local changes (#2151). The stash module also owns Windows DB
  //     handle cycling and later stash-pop conflict recovery.
  const preMergeStash = createPreMergeStash(
    originalBasePath_,
    milestoneId,
    process.platform === "win32" && isDbAvailable(),
  );
  preMergeStash.stash();

  // 7b. Clean up stale merge state before attempting the merge (#2912).
  // A leftover MERGE_HEAD (from a previous failed merge, libgit2 native path,
  // or interrupted operation) causes git merge to refuse with
  // "fatal: You have not concluded your merge (MERGE_HEAD exists)".
  // Defensively remove merge artifacts before starting.
  removeMergeStateFiles(originalBasePath_, "pre-merge");

  // 8. Merge — respect merge_strategy preference (#549).
  // "squash" (default): stages changes without a merge commit; caller commits.
  // "merge": --no-ff --no-commit so caller can supply the commit message while
  // git records a real merge commit (MERGE_HEAD present when nativeCommit runs).
  const effectiveStrategy = prefs.merge_strategy === "merge" ? "merge" : "squash";
  const mergeResult = effectiveStrategy === "merge"
    ? nativeMergeRegular(originalBasePath_, milestoneBranch)
    : nativeMergeSquash(originalBasePath_, milestoneBranch);
  preMergeStash.reopenDbAfterMerge();

  if (!mergeResult.success) {
    // Dirty working tree — the merge was rejected before it started (e.g.
    // untracked .gsd/ files left by syncStateToProjectRoot).  Preserve the
    // milestone branch so commits are not lost.
    if (mergeResult.conflicts.includes("__dirty_working_tree__")) {
      // Defensively clean merge state — the native path may leave MERGE_HEAD
      // even when the merge is rejected (#2912).
      removeMergeStateFiles(originalBasePath_, "dirty-tree rejection");

      // Pop stash before throwing so local work is not lost.
      preMergeStash.restoreForMergeFailure();
      milestoneDirectoryShelter.restore();
      // Restore cwd so the caller is not stranded on the integration branch
      process.chdir(previousCwd);
      // Surface the actual dirty filenames from git stderr instead of
      // generically blaming .gsd/ (#2151).
      const fileList = mergeResult.dirtyFiles?.length
        ? `Dirty files:\n${mergeResult.dirtyFiles.map((f) => `  ${f}`).join("\n")}`
        : `Check \`git status\` in the project root for details.`;
      throw new GSDError(
        GSD_GIT_ERROR,
        `${effectiveStrategy === "merge" ? "Merge" : "Squash merge"} of ${milestoneBranch} rejected: working tree has dirty or untracked files ` +
          `that conflict with the merge. ${fileList}`,
      );
    }

    // Check for conflicts — use merge result first, fall back to nativeConflictFiles
    const conflictedFiles =
      mergeResult.conflicts.length > 0
        ? mergeResult.conflicts
        : nativeConflictFiles(originalBasePath_);

    if (conflictedFiles.length > 0) {
      // Separate auto-resolvable conflicts (GSD state files + build artifacts)
      // from real code conflicts. GSD state files diverge between branches
      // during normal operation. Build artifacts are machine-generated and
      // regenerable. Both are safe to accept from the milestone branch.
      const { resolved: autoResolved, remaining: codeConflicts } = autoResolveSafeConflictPaths(
        originalBasePath_,
        conflictedFiles,
      );
      if (autoResolved.length > 0) {
        logWarning("worktree", `auto-resolved safe merge conflicts: ${autoResolved.join(", ")}`);
      }

      // If there are still real code conflicts, escalate
      if (codeConflicts.length > 0) {
        cleanupConflictState(originalBasePath_);

        // Pop stash before throwing so local work is not lost (#2151).
        preMergeStash.restoreForMergeFailure();
        milestoneDirectoryShelter.restore();
        // Restore cwd so the caller is not stranded on the integration branch.
        // Without this, the next mergeMilestoneToMain call in a parallel merge
        // sequence uses process.cwd() (now the project root) as worktreeCwd,
        // causing autoCommitDirtyState to commit unrelated milestone files to
        // the integration branch (#2929).
        process.chdir(previousCwd);
        throw new MergeConflictError(
          codeConflicts,
          effectiveStrategy,
          milestoneBranch,
          mainBranch,
        );
      }
    }
    // No conflicts detected — possibly "already up to date", fall through to commit
  }

  // 9. Commit (handle nothing-to-commit gracefully)
  const commitResult = nativeCommit(originalBasePath_, commitMessage);
  const nothingToCommit = commitResult === null;

  // 9a. Clean up merge state files left by git merge --squash (#1853, #2912).
  // git only removes SQUASH_MSG when the commit reads it directly (plain
  // `git commit`).  nativeCommit uses `-F -` (stdin) or libgit2, neither
  // of which trigger git's SQUASH_MSG cleanup.  MERGE_HEAD is created by
  // libgit2's merge even in squash mode and is not removed by nativeCommit.
  // If left on disk, doctor reports `corrupt_merge_state` on every subsequent run.
  removeMergeStateFiles(originalBasePath_, "post-commit");

  // 9a-ii. Restore stashed files now that the merge+commit is complete (#2151).
  preMergeStash.restoreAfterCommit();

  // 9a-iii. Restore sheltered queued milestone directories (#2505).
  milestoneDirectoryShelter.restore();

  // 9b. Safety check (#1792): if nothing was committed, verify the milestone
  // work is already on the integration branch before allowing teardown.
  try {
    assertNoUnanchoredCodeChangesAfterEmptyMerge(
      originalBasePath_,
      mainBranch,
      milestoneBranch,
      effectiveStrategy,
      nothingToCommit,
    );
  } catch (err) {
    process.chdir(previousCwd);
    throw err;
  }

  // 9c. Detect whether any non-.gsd/ code files were actually merged (#1906).
  const codeFilesChanged = detectMergedCodeFilesChanged(originalBasePath_, nothingToCommit);

  const finalizeMilestoneCleanup = (): void => {
    cleanupMergedMilestoneWorktree({
      projectRoot: originalBasePath_,
      milestoneId,
      milestoneBranch,
      previousCwd,
      chdirWarningContext: "after merge",
    });
  };

  let shouldCleanup = false;
  try {
    // 10/9b. Publication (auto-push / draft PR) — Publication module seam (ADR-034).
    const publication = publishMilestone({
      basePath: originalBasePath_,
      milestoneId,
      milestoneTitle,
      integrationBranch: mainBranch,
      milestoneBranch,
      sliceSummaries,
      nothingToCommit,
      prefs: {
        autoPush: prefs.auto_push === true,
        autoPr: prefs.auto_pr === true,
        remote: prefs.remote,
        prTargetBranch: prefs.pr_target_branch,
      },
    });
    const { pushed, prCreated } = publication;

    // 11. Guard removed — step 9b (#1792) now handles this with a smarter check:
    //     throws only when the milestone has unanchored code changes, passes
    //     through when the code is genuinely already on the integration branch.

    // 11a. Pre-teardown safety net (#1853): preserve the milestone branch if
    // the source worktree still has uncommitted changes after the merge commit.
    assertMilestoneWorktreeCleanBeforeTeardown({
      milestoneBranch,
      previousCwd,
      worktreeCwd,
    });

    shouldCleanup = true;
    return { commitMessage, pushed, prCreated, codeFilesChanged };
  } finally {
    if (shouldCleanup) {
      finalizeMilestoneCleanup();
    } else {
      logWarning(
        "worktree",
        `Skipping worktree cleanup for ${milestoneBranch}; merge did not reach safe-cleanup point and milestone work is preserved for manual recovery.`,
      );
    }
  }
}
