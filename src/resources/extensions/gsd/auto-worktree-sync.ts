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

import {
  _isSamePath as isSamePath,
  _shouldReconcileWorktreeDb,
} from "./auto-worktree-cleanup.js";
import { dirIsContentBearingLegacyMilestone, resolveGsdPathContract } from "./paths.js";
import type { MilestoneScope } from "./workspace.js";
import { WorktreeStateProjection } from "./worktree-state-projection.js";
import { logWarning } from "./workflow-logger.js";

const PROJECT_PREFERENCES_FILE = "PREFERENCES.md";
const LEGACY_PROJECT_PREFERENCES_FILE = "preferences.md";

/**
 * Root-level .gsd/ projections copied from project root into worktrees for
 * compatibility. Project root remains the canonical state/projection root.
 */
const ROOT_STATE_FILES = [
  "DECISIONS.md",
  "REQUIREMENTS.md",
  "PROJECT.md",
  "KNOWLEDGE.md",
  "OVERRIDES.md",
  "QUEUE.md",
  "completed-units.json",
  "metrics.json",
  "mcp.json",
  // NOTE: project preferences are intentionally NOT in ROOT_STATE_FILES.
  // Forward-sync (main → worktree) is handled explicitly in syncGsdStateToWorktree().
  // Back-sync (worktree → main) must NEVER overwrite the project root's copy
  // because the project root is authoritative for preferences (#2684).
] as const;

/**
 * Path-string entry point to WorktreeStateProjection.projectRootToWorktree.
 * Production code goes through the Module class; this delegator survives so
 * the projection-invariant tests (#1886, #2184, #2478, #2821) can exercise
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
 * Path-string entry point to WorktreeStateProjection.projectWorktreeToRoot.
 * Production code goes through the Module class; this delegator survives so
 * the projection-invariant tests can exercise the body with raw paths.
 */
export function syncStateToProjectRoot(
  worktreePath_: string,
  projectRoot: string,
  milestoneId: string | null,
): void {
  new WorktreeStateProjection().projectWorktreeToRootPaths(
    worktreePath_,
    projectRoot,
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
 * the worktree has its own copy that may be stale. This function copies
 * missing milestones, CONTEXT, ROADMAP, DECISIONS, REQUIREMENTS, and
 * PROJECT files from the main repo's .gsd/ into the worktree's .gsd/.
 *
 * Only adds missing content — never overwrites existing files in the worktree.
 * Worktree files are compatibility projections; DB/project root remains
 * authoritative for runtime state.
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
  syncRootStateFiles(mainGsd, wtGsd, synced);
  syncProjectPreferences(mainGsd, wtGsd, synced);
  syncMilestoneLayouts(mainGsd, wtGsd, synced);

  return { synced };
}

function syncRootStateFiles(
  mainGsd: string,
  wtGsd: string,
  synced: string[],
): void {
  for (const file of ROOT_STATE_FILES) {
    const src = join(mainGsd, file);
    const dst = join(wtGsd, file);
    if (!existsSync(src) || existsSync(dst)) continue;

    try {
      cpSync(src, dst);
      synced.push(file);
    } catch (err) {
      logWarning(
        "worktree",
        `file copy failed (${file}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
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

/**
 * Sync compatibility artifacts from worktree back to the main external state
 * directory. Canonical workflow state lives in the project DB; worktree .gsd
 * content is legacy projection/diagnostic data only.
 *
 * Syncs:
 *   1. Legacy worktree DBs are reconciled into the canonical project DB.
 *   2. Runtime diagnostic files may be copied for operator visibility.
 *
 * Markdown milestone directories are projections and are not copied from
 * worktrees into the project root. Current workflow state must arrive through
 * the shared project DB or the pre-upgrade DB reconciliation path above.
 */
export function syncWorktreeStateBack(
  mainBasePath: string,
  worktreePath: string,
  milestoneId: string,
): { synced: string[] } {
  return new WorktreeStateProjection().finalizeProjectionForMergePaths(
    mainBasePath,
    worktreePath,
    milestoneId,
  );
}

export { _shouldReconcileWorktreeDb } from "./auto-worktree-cleanup.js";
