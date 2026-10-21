// gsd-pi — Auto-worktree runtime cleanup module.
//
// Owns stale worktree cwd escape and runtime unit cleanup during auto startup.

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { gsdHome } from "./gsd-home.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import {
  normalizeWorktreePathForCompare,
  projectRootFromWorktreePath,
} from "./worktree-root.js";
import { logWarning } from "./workflow-logger.js";

const LEGACY_DEEP_SETUP_RUNTIME_UNIT_FILES = new Set([
  "workflow-preferences-WORKFLOW-PREFS.json",
  "discuss-project-PROJECT.json",
  "discuss-requirements-REQUIREMENTS.json",
  "research-decision-RESEARCH-DECISION.json",
  "research-project-RESEARCH-PROJECT.json",
]);

/**
 * Detect and escape a stale worktree cwd (#608).
 *
 * After milestone completion + merge, the worktree directory is removed but
 * the process cwd may still point inside `.gsd/worktrees/<MID>/`.
 * When a new session starts, `process.cwd()` is passed as `base` to startAuto
 * and all subsequent writes land in the wrong directory. This function detects
 * that scenario and chdir back to the project root.
 *
 * Returns the corrected base path.
 */
export function escapeStaleWorktree(base: string): string {
  const projectRoot = projectRootFromWorktreePath(base);
  if (projectRoot === null) return base;

  // Guard: If the candidate project root's .gsd IS the user-level ~/.gsd,
  // the string-slice heuristic matched the wrong /.gsd/ boundary. This happens
  // when .gsd is a symlink into ~/.gsd/projects/<hash> and process.cwd()
  // resolved through the symlink. Returning ~ would be catastrophic (#1676).
  const candidateGsd = normalizeWorktreePathForCompare(join(projectRoot, ".gsd"));
  const gsdHomeNorm = normalizeWorktreePathForCompare(gsdHome());
  if (candidateGsd === gsdHomeNorm || candidateGsd.startsWith(gsdHomeNorm + "/")) {
    // Don't chdir to home — return base unchanged.
    // resolveProjectRoot() in worktree.ts has the full git-file-based recovery
    // and will be called by the caller (startAuto → projectRoot()).
    return base;
  }

  try {
    process.chdir(projectRoot);
  } catch (e) {
    // If chdir fails, return the original — caller will handle errors downstream
    logWarning("worktree", `escapeStaleWorktree chdir failed: ${(e as Error).message}`);
    return base;
  }
  return projectRoot;
}

/**
 * Clean stale runtime unit files for completed milestones.
 *
 * After restart, stale runtime/units/*.json from prior milestones can
 * cause deriveState to resume the wrong milestone (#887). Removes files
 * for milestones that have a SUMMARY (fully complete).
 */
export function cleanStaleRuntimeUnits(
  gsdRootPath: string,
  hasMilestoneSummary: (mid: string) => boolean,
): number {
  const runtimeUnitsDir = join(gsdRootPath, "runtime", "units");
  if (!existsSync(runtimeUnitsDir)) return 0;

  let cleaned = 0;
  try {
    for (const file of readdirSync(runtimeUnitsDir)) {
      if (!file.endsWith(".json")) continue;
      if (shouldRemoveRuntimeUnit(file, hasMilestoneSummary)) {
        cleaned += unlinkRuntimeUnit(runtimeUnitsDir, file);
      }
    }
  } catch (err) {
    logWarning(
      "worktree",
      `stale runtime unit cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return cleaned;
}

function shouldRemoveRuntimeUnit(
  file: string,
  hasMilestoneSummary: (mid: string) => boolean,
): boolean {
  if (LEGACY_DEEP_SETUP_RUNTIME_UNIT_FILES.has(file)) return true;

  const staleDiscussMatch = file.match(/^discuss-milestone-(.+)\.json$/);
  if (staleDiscussMatch && !MILESTONE_ID_RE.test(staleDiscussMatch[1])) {
    return true;
  }

  const midMatch = file.match(/(M\d+(?:-[a-z0-9]{6})?)/);
  return Boolean(midMatch && hasMilestoneSummary(midMatch[1]));
}

function unlinkRuntimeUnit(runtimeUnitsDir: string, file: string): number {
  try {
    unlinkSync(join(runtimeUnitsDir, file));
    return 1;
  } catch (err) {
    logWarning(
      "worktree",
      `stale runtime unit unlink failed (${file}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}
