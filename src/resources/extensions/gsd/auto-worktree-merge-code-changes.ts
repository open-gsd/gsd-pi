// gsd-pi — Code-change safety checks for auto-worktree merge closeout.
//
// Owns the git diff policy that decides whether a completed milestone actually
// changed user code, and whether an empty merge result is safe to clean up.

import { execFileSync } from "node:child_process";

import { GSDError, GSD_GIT_ERROR } from "./errors.js";
import { nativeDiffNumstat } from "./native-git-bridge.js";
import { logWarning } from "./workflow-logger.js";

const GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function assertNoUnanchoredCodeChangesAfterEmptyMerge(
  basePath: string,
  mainBranch: string,
  milestoneBranch: string,
  effectiveStrategy: "merge" | "squash",
  nothingToCommit: boolean,
): void {
  if (!nothingToCommit) return;

  const codeChanges = nativeDiffNumstat(basePath, mainBranch, milestoneBranch)
    .filter((entry) => !entry.path.startsWith(".gsd/"));
  if (codeChanges.length === 0) return;

  throw new GSDError(
    GSD_GIT_ERROR,
    `${effectiveStrategy === "merge" ? "Merge" : "Squash merge"} produced nothing to commit but milestone branch "${milestoneBranch}" ` +
      `has ${codeChanges.length} code file(s) not on "${mainBranch}". ` +
      `Aborting worktree teardown to prevent data loss.`,
  );
}

export function detectMergedCodeFilesChanged(basePath: string, nothingToCommit: boolean): boolean {
  if (nothingToCommit) return false;

  try {
    const diffTreeOutput = execFileSync(
      "git",
      ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "HEAD"],
      { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
    ).trim();
    return containsCodeFile(diffTreeOutput);
  } catch (err) {
    return detectCodeFilesChangedFromEmptyTree(basePath, err);
  }
}

function detectCodeFilesChangedFromEmptyTree(basePath: string, originalError: unknown): boolean {
  try {
    const fallbackOutput = execFileSync(
      "git",
      ["diff", "--name-only", GIT_EMPTY_TREE, "HEAD"],
      { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
    ).trim();
    return containsCodeFile(fallbackOutput);
  } catch {
    // Truly unable to determine — assume code was changed to avoid silent data loss.
    logWarning(
      "worktree",
      `diff-tree and empty-tree fallback both failed (assuming code changed): ${originalError instanceof Error ? originalError.message : String(originalError)}`,
    );
    return true;
  }
}

function containsCodeFile(output: string): boolean {
  const files = output ? output.split("\n").filter(Boolean) : [];
  return files.some((file) => !file.startsWith(".gsd/"));
}
