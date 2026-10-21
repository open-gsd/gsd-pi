// Project/App: gsd-pi
// File Purpose: Shared auto-resolution of safe merge conflict paths.

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
      logWarning(
        "worktree",
        `checkout --theirs failed for ${file}, removing: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        nativeRmForce(basePath, [file]);
        resolved.push(file);
      } catch {
        remaining.push(file);
      }
    }
  }

  return { resolved, remaining };
}
