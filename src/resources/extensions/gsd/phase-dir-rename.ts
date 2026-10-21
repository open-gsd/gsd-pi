// Project/App: gsd-pi
// File Purpose: Rename the on-disk phase directory when a milestone title changes.

import { existsSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

import {
  canonicalPhaseDirName,
  clearPathCache,
  isLegacyMilestonesLayout,
  milestonesDir,
  resolveMilestonePath,
} from "./paths.js";

/**
 * Move `phases/NN-old-slug` → `phases/NN-canonical` after a title change.
 * No-op when the old dir is missing, the new dir already exists, names match,
 * or the project is still on the legacy milestones/ layout. (#1526)
 */
export function renamePhaseDirOnTitleChange(
  basePath: string,
  milestoneId: string,
  previousTitle: string | undefined,
  nextTitle: string,
): boolean {
  if (!nextTitle.trim()) return false;
  if (isLegacyMilestonesLayout(basePath)) return false;

  const nextName = canonicalPhaseDirName(milestoneId, nextTitle);
  const phasesDir = milestonesDir(basePath);
  const nextPath = join(phasesDir, nextName);
  if (existsSync(nextPath)) return false;

  const existingPath = resolveMilestonePath(basePath, milestoneId);
  const predictedOldPath = join(
    phasesDir,
    canonicalPhaseDirName(milestoneId, previousTitle || milestoneId),
  );
  const fromPath = existingPath && existsSync(existingPath) ? existingPath : predictedOldPath;

  if (!existsSync(fromPath)) return false;
  if (basename(fromPath) === nextName) return false;

  renameSync(fromPath, nextPath);
  clearPathCache();
  return true;
}
