// Project/App: gsd-pi
// File Purpose: Rename the on-disk phase directory when a milestone title changes.

import { existsSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import {
  canonicalPhaseDirName,
  clearPathCache,
  isLegacyMilestonesLayout,
  milestonesDir,
  resolveMilestonePath,
} from "./paths.js";
import { logWarning } from "./workflow-logger.js";

/**
 * True when `dirName` is an established phase directory of `milestoneId`: one
 * named for the milestone's previous real title. Placeholder names (the bare
 * id, "New milestone <id>") and the dir of an untitled milestone are not
 * established.
 */
function isEstablishedPhaseDir(milestoneId: string, dirName: string, previousTitle: string | undefined): boolean {
  const title = previousTitle?.trim() ?? "";
  if (!title) return false;
  if (dirName === canonicalPhaseDirName(milestoneId)) return false;
  if (dirName === canonicalPhaseDirName(milestoneId, `New milestone ${milestoneId}`)) return false;
  return dirName === canonicalPhaseDirName(milestoneId, title);
}

/**
 * Move `phases/NN-old-slug` → `phases/NN-canonical` after a title change.
 * No-op when the old dir is missing, the new dir already exists, names match,
 * or the project is still on the legacy milestones/ layout. (#1526)
 *
 * Only a placeholder dir follows the title. An established dir, named for the
 * previous real title, keeps its name: renaming it moves every planning file
 * of the milestone and breaks the paths that refer to them. Resolvers find the
 * kept dir by its number prefix.
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
  if (isEstablishedPhaseDir(milestoneId, basename(fromPath), previousTitle)) {
    logWarning("db", `phase dir ${basename(fromPath)} of ${milestoneId} kept after a title change: an established phase dir is not renamed`);
    return false;
  }

  renameSync(fromPath, nextPath);
  clearPathCache();
  return true;
}

/**
 * True when the canonical phase directory for `milestoneId`/`title` already
 * exists on disk under `basePath` — i.e. the rename's target state already
 * holds, so artifact rows are safe to reconcile to it (#2633).
 */
export function canonicalPhaseDirExists(basePath: string, milestoneId: string, title: string): boolean {
  if (isLegacyMilestonesLayout(basePath)) return false;
  try {
    return statSync(join(milestonesDir(basePath), canonicalPhaseDirName(milestoneId, title))).isDirectory();
  } catch {
    return false;
  }
}
