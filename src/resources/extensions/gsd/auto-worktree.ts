// Project/App: gsd-pi
// File Purpose: Compatibility barrel for auto-mode worktree modules.

/**
 * GSD Auto-Worktree compatibility barrel.
 *
 * New code should import from the focused modules (`auto-worktree-creation`,
 * `auto-worktree-teardown`, `auto-worktree-sync`, `auto-worktree-merge`, etc.).
 * This file preserves the historical interface while the module extraction
 * completes.
 */

export {
  autoWorktreeBranch,
  enterBranchModeForMilestone,
  fastForwardReusedMilestoneBranchIfSafe,
  _isBranchCheckedOutElsewhere,
  _resolveAutoWorktreeStartPoint,
} from "./auto-worktree-branch-lifecycle.js";

export {
  _gitPathspecForWorktreePath,
  _isExpectedWorktreeUnlinkError,
  _isSamePath,
  _shouldReconcileWorktreeDb,
} from "./auto-worktree-cleanup.js";

export {
  isSafeToAutoResolve,
  SAFE_AUTO_RESOLVE_PATTERNS,
} from "./auto-worktree-conflict-auto-resolve.js";

export { createAutoWorktree } from "./auto-worktree-creation.js";

export {
  enterAutoWorktree,
  getAutoWorktreePath,
  isInAutoWorktree,
} from "./auto-worktree-entry.js";

export {
  mergeMilestoneToMain,
  _setRestoreEntryFnForTests,
} from "./auto-worktree-merge.js";

export {
  checkResourcesStale,
  readResourceVersion,
} from "./auto-worktree-resource-version.js";

export {
  cleanStaleRuntimeUnits,
  escapeStaleWorktree,
} from "./auto-worktree-runtime-cleanup.js";

export {
  getActiveAutoWorktreeContext,
  getAutoWorktreeOriginalBase,
  _resetAutoWorktreeOriginalBaseForTests,
} from "./auto-worktree-session-registry.js";

export {
  syncGsdStateToWorktree,
  syncGsdStateToWorktreeByScope,
  syncProjectRootToWorktree,
  syncStateToProjectRoot,
  syncWorktreeStateBack,
} from "./auto-worktree-sync.js";

export { teardownAutoWorktree } from "./auto-worktree-teardown.js";
export { runWorktreePostCreateHook } from "./worktree-post-create-hook.js";
