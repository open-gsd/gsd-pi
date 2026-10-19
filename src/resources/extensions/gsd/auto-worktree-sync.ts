// gsd-pi — Auto-worktree state sync module.
//
// Owns project-root/worktree projection compatibility seams while the project DB
// remains authoritative for workflow state.

import {
  cpSync,
  existsSync,
  lstatSync as lstatSyncFn,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

import { _isSamePath as isSamePath } from "./auto-worktree-cleanup.js";
import { dirIsContentBearingLegacyMilestone, resolveGsdPathContract } from "./paths.js";
import type { MilestoneScope } from "./workspace.js";
import { refreshRootProjectionsInWorktree, WorktreeStateProjection } from "./worktree-state-projection.js";
import { logWarning } from "./workflow-logger.js";

const PROJECT_PREFERENCES_FILE = "PREFERENCES.md";
const LEGACY_PROJECT_PREFERENCES_FILE = "preferences.md";

/**
 * Path-string entry point to WorktreeStateProjection.projectRootToWorktree.
 * Production code goes through the Module class; this delegator survives so
 * the projection-invariant tests (#1886, #2184, #2478) can exercise
 * the bodies with raw paths.
 */
export function syncProjectRootToWorktree(
  projectRoot: string,
  worktreePath_: string,
  milestoneId: string | null,
): void {
  new WorktreeStateProjection().projectRootToWorktreePaths(
    projectRoot,
    worktreePath_,
    milestoneId,
  );
}

/**
 * Scope-typed variant of syncGsdStateToWorktree.
 *
 * Takes an explicit (rootScope, worktreeScope) pair. Note: milestoneId is not
 * used by syncGsdStateToWorktree — this variant only requires workspace
 * identity. Asserts both scopes belong to the same workspace identity to
 * prevent silent mismatch bugs.
 */
export function syncGsdStateToWorktreeByScope(
  rootScope: MilestoneScope,
  worktreeScope: MilestoneScope,
): { synced: string[] } {
  if (rootScope.workspace.identityKey !== worktreeScope.workspace.identityKey) {
    throw new Error(
      `syncGsdStateToWorktreeByScope: scope identity mismatch — ` +
        `rootScope.identityKey="${rootScope.workspace.identityKey}" ` +
        `worktreeScope.identityKey="${worktreeScope.workspace.identityKey}"`,
    );
  }
  const mainBasePath = rootScope.workspace.projectRoot;
  const worktreePath = worktreeScope.workspace.worktreeRoot
    ?? worktreeScope.workspace.projectRoot;
  return syncGsdStateToWorktree(mainBasePath, worktreePath);
}

/**
 * Sync .gsd/ state from the main repo into the worktree.
 *
 * When .gsd/ is a symlink to the external state directory, both the main
 * repo and worktree share the same directory — no sync needed.
 *
 * When .gsd/ is a real directory (e.g., git-tracked or manage_gitignore:false),
 * the worktree has its own copy that may be stale. This function refreshes
 * the root projections (DECISIONS, REQUIREMENTS, PROJECT, KNOWLEDGE, OVERRIDES,
 * QUEUE) from the project-root render and copies missing milestone files and
 * preferences from the main repo's .gsd/ into the worktree's .gsd/.
 *
 * Milestone files and preferences are only added — an existing worktree file
 * is not overwritten. Worktree files are projections; the project DB remains
 * authoritative for workflow state.
 * @deprecated Use syncGsdStateToWorktreeByScope instead.
 * TODO(C-future): remove once all callers migrated.
 */
export function syncGsdStateToWorktree(
  mainBasePath: string,
  worktreePath_: string,
): { synced: string[] } {
  const contract = resolveGsdPathContract(worktreePath_, mainBasePath);
  const mainGsd = contract.projectGsd;
  const wtGsd = contract.worktreeGsd ?? join(worktreePath_, ".gsd");
  const synced: string[] = [];

  if (isSamePath(mainGsd, wtGsd)) return { synced };
  if (!existsSync(mainGsd)) return { synced };

  mkdirSync(wtGsd, { recursive: true });
  synced.push(...refreshRootProjectionsInWorktree(mainBasePath, worktreePath_));
  syncProjectPreferences(mainGsd, wtGsd, synced);
  syncMilestoneLayouts(mainGsd, wtGsd, synced);

  return { synced };
}

function syncProjectPreferences(
  mainGsd: string,
  wtGsd: string,
  synced: string[],
): void {
  const worktreeHasPreferences = existsSync(join(wtGsd, PROJECT_PREFERENCES_FILE))
    || existsSync(join(wtGsd, LEGACY_PROJECT_PREFERENCES_FILE));
  if (worktreeHasPreferences) return;

  for (const file of [PROJECT_PREFERENCES_FILE, LEGACY_PROJECT_PREFERENCES_FILE] as const) {
    const src = join(mainGsd, file);
    const dst = join(wtGsd, file);
    if (!existsSync(src)) continue;

    try {
      cpSync(src, dst);
      synced.push(file);
    } catch (err) {
      logWarning(
        "worktree",
        `preferences copy failed (${file}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
}

function syncMilestoneLayouts(
  mainGsd: string,
  wtGsd: string,
  synced: string[],
): void {
  for (const layoutSegment of ["phases", "milestones"] as const) {
    syncMilestoneLayout(mainGsd, wtGsd, layoutSegment, synced);
  }
}

function syncMilestoneLayout(
  mainGsd: string,
  wtGsd: string,
  layoutSegment: "phases" | "milestones",
  synced: string[],
): void {
  const mainMilestonesDir = join(mainGsd, layoutSegment);
  const wtMilestonesDir = join(wtGsd, layoutSegment);
  if (!existsSync(mainMilestonesDir)) return;

  try {
    const mainMilestones = readdirSync(mainMilestonesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) =>
        layoutSegment !== "milestones" ||
        dirIsContentBearingLegacyMilestone(join(mainMilestonesDir, name)),
      );

    if (mainMilestones.length === 0) return;

    mkdirSync(wtMilestonesDir, { recursive: true });

    for (const milestoneId of mainMilestones) {
      syncMilestoneDirectory(
        mainMilestonesDir,
        wtMilestonesDir,
        milestoneId,
        synced,
      );
    }
  } catch (err) {
    logWarning(
      "worktree",
      `milestone directory sync failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function syncMilestoneDirectory(
  mainMilestonesDir: string,
  wtMilestonesDir: string,
  milestoneId: string,
  synced: string[],
): void {
  const srcDir = join(mainMilestonesDir, milestoneId);
  const dstDir = join(wtMilestonesDir, milestoneId);

  if (!existsSync(dstDir)) {
    try {
      cpSync(srcDir, dstDir, { recursive: true });
      // Preserve the legacy telemetry string used before this extraction. The
      // actual layout may be `phases/`; callers only consumed this as a coarse
      // "milestone projection copied" marker.
      synced.push(`milestones/${milestoneId}/`);
    } catch (err) {
      logWarning(
        "worktree",
        `milestone copy failed (${milestoneId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  try {
    syncMilestoneTopLevelFiles(srcDir, dstDir, milestoneId, synced);
    syncSlicesDirectory(srcDir, dstDir, milestoneId, synced);
  } catch (err) {
    logWarning(
      "worktree",
      `milestone file sync failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function syncMilestoneTopLevelFiles(
  srcDir: string,
  dstDir: string,
  milestoneId: string,
  synced: string[],
): void {
  const srcFiles = readdirSync(srcDir).filter(
    (file) => file.endsWith(".md") || file.endsWith(".json"),
  );

  for (const file of srcFiles) {
    const srcFile = join(srcDir, file);
    const dstFile = join(dstDir, file);
    if (existsSync(dstFile)) continue;

    try {
      const srcStat = lstatSyncFn(srcFile);
      if (!srcStat.isFile()) continue;

      cpSync(srcFile, dstFile);
      synced.push(`milestones/${milestoneId}/${file}`);
    } catch (err) {
      logWarning(
        "worktree",
        `milestone file copy failed (${milestoneId}/${file}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function syncSlicesDirectory(
  srcDir: string,
  dstDir: string,
  milestoneId: string,
  synced: string[],
): void {
  const srcSlicesDir = join(srcDir, "slices");
  const dstSlicesDir = join(dstDir, "slices");
  if (!existsSync(srcSlicesDir)) return;

  if (!existsSync(dstSlicesDir)) {
    try {
      cpSync(srcSlicesDir, dstSlicesDir, { recursive: true });
      synced.push(`milestones/${milestoneId}/slices/`);
    } catch (err) {
      logWarning(
        "worktree",
        `slices copy failed (${milestoneId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  const srcSlices = readdirSync(srcSlicesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const sliceId of srcSlices) {
    const srcSlice = join(srcSlicesDir, sliceId);
    const dstSlice = join(dstSlicesDir, sliceId);
    if (existsSync(dstSlice)) continue;

    try {
      cpSync(srcSlice, dstSlice, { recursive: true });
      synced.push(`milestones/${milestoneId}/slices/${sliceId}/`);
    } catch (err) {
      logWarning(
        "worktree",
        `slice copy failed (${milestoneId}/${sliceId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
