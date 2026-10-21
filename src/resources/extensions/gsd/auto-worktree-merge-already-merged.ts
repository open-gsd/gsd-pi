// gsd-pi — Already-merged milestone merge fast path.
//
// Owns the safety invariant for milestone branches already reachable from the
// integration branch: skip the squash merge only when milestone-touched code is
// still anchored on the current integration branch, then run normal cleanup.

import { execFileSync } from "node:child_process";

import { debugLog } from "./debug-logger.js";
import { GSDError, GSD_GIT_ERROR } from "./errors.js";
import {
  nativeDiffNumstat,
  nativeIsAncestor,
} from "./native-git-bridge.js";
import { cleanupMergedMilestoneWorktree } from "./auto-worktree-merge-cleanup.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { pushIntegrationBranchIfAhead } from "./publication.js";
import { logWarning } from "./workflow-logger.js";

export interface AlreadyMergedMilestoneRequest {
  projectRoot: string;
  milestoneId: string;
  milestoneBranch: string;
  mainBranch: string;
  previousCwd: string;
  commitMessage: string;
}

export interface AlreadyMergedMilestoneResult {
  commitMessage: string;
  pushed: boolean;
  /** Set when the closeout auto-push was attempted and failed (#2153). */
  pushError?: string;
  prCreated: false;
  codeFilesChanged: true;
}

export function finalizeAlreadyMergedMilestoneIfReachable(
  request: AlreadyMergedMilestoneRequest,
): AlreadyMergedMilestoneResult | null {
  const {
    projectRoot,
    milestoneId,
    milestoneBranch,
    mainBranch,
    previousCwd,
    commitMessage,
  } = request;

  if (!nativeIsAncestor(projectRoot, milestoneBranch, mainBranch)) {
    return null;
  }

  assertNoUnanchoredRegularMergeCodeChanges({
    projectRoot,
    milestoneBranch,
    mainBranch,
    previousCwd,
  });

  debugLog("mergeMilestoneToMain", {
    action: "skip-squash-already-merged",
    milestoneId,
    milestoneBranch,
    mainBranch,
  });
  cleanupMergedMilestoneWorktree({
    projectRoot,
    milestoneId,
    milestoneBranch,
    previousCwd,
    clearProjectRootState: true,
    chdirWarningContext: "after already-merged cleanup",
  });
  // #2153: the fast path skipped publication entirely, so a re-run after a
  // manual merge never published. Push when auto_push is on and the
  // integration branch is ahead of its upstream; failure is non-fatal.
  const gitPrefs = loadEffectiveGSDPreferences(projectRoot)?.preferences?.git ?? {};
  const publication = pushIntegrationBranchIfAhead({
    basePath: projectRoot,
    branch: mainBranch,
    milestoneId,
    prefs: {
      autoPush: gitPrefs.auto_push === true,
      autoPr: gitPrefs.auto_pr === true,
      remote: gitPrefs.remote,
    },
  });
  return {
    commitMessage,
    pushed: publication.pushed,
    ...(publication.pushError ? { pushError: publication.pushError } : {}),
    prCreated: false,
    codeFilesChanged: true,
  };
}

function assertNoUnanchoredRegularMergeCodeChanges(request: {
  projectRoot: string;
  milestoneBranch: string;
  mainBranch: string;
  previousCwd: string;
}): void {
  const { projectRoot, milestoneBranch, mainBranch, previousCwd } = request;
  const codeChanges = nativeDiffNumstat(
    projectRoot,
    mainBranch,
    milestoneBranch,
  ).filter((entry) => !entry.path.startsWith(".gsd/"));
  if (codeChanges.length === 0) return;

  const regularMergeChangedPaths = findRegularMergeChangedPaths(
    projectRoot,
    milestoneBranch,
    mainBranch,
  );
  const unanchoredCodeChanges = codeChanges.filter((entry) =>
    regularMergeChangedPaths.has(entry.path)
  );
  if (unanchoredCodeChanges.length === 0) return;

  process.chdir(previousCwd);
  throw new GSDError(
    GSD_GIT_ERROR,
    `Milestone branch "${milestoneBranch}" is reachable from "${mainBranch}" ` +
      `but has ${unanchoredCodeChanges.length} milestone-touched code file(s) not on current "${mainBranch}". ` +
      `Aborting worktree teardown to prevent data loss.`,
  );
}

function findRegularMergeChangedPaths(
  basePath: string,
  milestoneBranch: string,
  mainBranch: string,
): Set<string> {
  const changedPaths = new Set<string>();
  let mergeLog = "";
  try {
    mergeLog = execFileSync(
      "git",
      ["rev-list", "--merges", "--parents", mainBranch],
      {
        cwd: basePath,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      },
    ).trim();
  } catch (err) {
    logWarning("worktree", `regular merge lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return changedPaths;
  }

  for (const line of mergeLog.split("\n").filter(Boolean)) {
    const [mergeCommit, firstParent, ...otherParents] = line.split(" ");
    if (!mergeCommit || !firstParent || otherParents.length === 0) continue;
    const mergedMilestone = otherParents.some((parent) => {
      try {
        return nativeIsAncestor(basePath, milestoneBranch, parent);
      } catch {
        return false;
      }
    });
    if (!mergedMilestone) continue;

    try {
      const output = execFileSync(
        "git",
        ["diff", "--name-only", firstParent, mergeCommit],
        {
          cwd: basePath,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf-8",
        },
      ).trim();
      for (const path of output.split("\n").filter(Boolean)) {
        if (!path.startsWith(".gsd/")) changedPaths.add(path);
      }
    } catch (err) {
      logWarning("worktree", `regular merge diff lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return changedPaths;
  }

  return changedPaths;
}
