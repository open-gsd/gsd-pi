// Project/App: gsd-pi
// File Purpose: Shared auto-resolution of safe merge conflict paths.

import { execFileSync } from "node:child_process";

import { logWarning } from "./workflow-logger.js";
import {
  nativeAddPaths,
  nativeCheckoutTheirs,
  nativeRmForce,
} from "./native-git-bridge.js";
import { isSafeToAutoResolve } from "./auto-worktree-conflict-auto-resolve.js";

export { isSafeToAutoResolve } from "./auto-worktree-conflict-auto-resolve.js";

export interface AutoResolveSafePathsResult {
  resolved: string[];
  remaining: string[];
}

/** Resolve a conflict to the project-root side (stage 2) and keep the file. */
function keepOurs(basePath: string, file: string): void {
  const git = (args: string[]) => execFileSync("git", args, { cwd: basePath, stdio: ["ignore", "pipe", "pipe"] });
  try {
    git(["checkout", "--ours", "--", file]);
  } catch { /* Neither side has the file: there is nothing to keep. */ }
  git(["add", "--", file]);
}

/**
 * Auto-resolve paths that are safe to accept from the milestone side
 * (.gsd/ state and build artifacts).
 */
export function autoResolveSafeConflictPaths(
  basePath: string,
  paths: readonly string[],
): AutoResolveSafePathsResult {
  const resolved: string[] = [];
  const remaining: string[] = [];

  for (const file of paths) {
    if (!isSafeToAutoResolve(file)) {
      remaining.push(file);
      continue;
    }
    try {
      nativeCheckoutTheirs(basePath, [file]);
      nativeAddPaths(basePath, [file]);
      resolved.push(file);
    } catch (error) {
      // A `.gsd` projection is never removed to end a conflict. The post-merge
      // rebuild renders it from the database, so the side that is kept has no
      // effect on the result.
      const keep = file.startsWith(".gsd/");
      logWarning(
        "worktree",
        `checkout --theirs failed for ${file}, ${keep ? "keeping the project-root side" : "removing"}: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        if (keep) keepOurs(basePath, file);
        else nativeRmForce(basePath, [file]);
        resolved.push(file);
      } catch {
        remaining.push(file);
      }
    }
  }

  return { resolved, remaining };
}
