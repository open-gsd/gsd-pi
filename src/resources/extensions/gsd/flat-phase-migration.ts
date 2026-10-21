// Project/App: gsd-pi
// File Purpose: One-time migration from legacy nested .gsd/milestones/ to
// flat-phase .gsd/phases/. Used by startup and pre-reconciliation layout settlement.

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { renderAllFromDb, renderRoadmapFromDb } from "./markdown-renderer.js";
import {
  deleteArtifactByPath,
  deleteArtifactsByPathPrefix,
  getAllMilestones,
  getArtifactsByPathPrefix,
  getMilestoneSlices,
  getSliceTasks,
} from "./gsd-db.js";
import { withFileLock } from "./file-lock.js";
import { countDbHierarchy, scanMarkdownHierarchy } from "./migration-auto-check.js";
import { logWarning } from "./workflow-logger.js";
import { LAYOUT_SEGMENTS } from "./layout-policy.js";
import {
  canonicalPhaseDirName,
  dirIsContentBearingLegacyMilestone,
  gsdProjectionRoot,
  milestonesDir,
  resolveMilestonePath,
} from "./paths.js";
import {
  copyProjectionTreeSync,
  createProjectionDirectorySync,
  removeProjectionFileSync,
  removeProjectionTreeSync,
} from "./atomic-write.js";

const LEGACY_MIGRATING_SEGMENT = "milestones.migrating";
const EXPLICIT_RECOVERY_REQUIRED =
  "flat-phase migration skipped: legacy markdown contains state absent from the canonical DB. " +
  "Recommended: run `/gsd recover` and approve its exact Preview hash to import explicitly.";
const RM_RETRY_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;
type FlatPhaseMigrationStage = "before-remove" | "after-remove" | "before-move" | "after-move";
let flatPhaseMigrationBoundaryForTest: ((stage: FlatPhaseMigrationStage, path: string) => void) | null = null;

export function _setFlatPhaseMigrationBoundaryForTest(
  boundary: ((stage: FlatPhaseMigrationStage, path: string) => void) | null,
): void {
  flatPhaseMigrationBoundaryForTest = boundary;
}

function legacyMigratingPath(basePath: string): string {
  return join(basePath, ".gsd", LEGACY_MIGRATING_SEGMENT);
}

function ensureMigrationLockDirectory(path: string): void {
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`flat-phase migration lock path contains an unsupported symbolic link or non-directory: ${path}`);
  }
}

function flatPhaseMigrationLockTarget(basePath: string): string {
  const migrationRoot = join(gsdProjectionRoot(basePath), "migration");
  ensureMigrationLockDirectory(migrationRoot);
  const lockTarget = join(migrationRoot, "flat-phase-migration");
  ensureMigrationLockDirectory(lockTarget);
  return lockTarget;
}

function removeManagedPath(path: string): void {
  flatPhaseMigrationBoundaryForTest?.("before-remove", path);
  if (!existsSync(path)) return;
  if (lstatSync(path).isDirectory()) removeProjectionTreeSync(path);
  else removeProjectionFileSync(path);
  flatPhaseMigrationBoundaryForTest?.("after-remove", path);
}

function moveManagedTree(src: string, dst: string): void {
  flatPhaseMigrationBoundaryForTest?.("before-move", src);
  copyProjectionTreeSync(src, dst);
  removeProjectionTreeSync(src);
  flatPhaseMigrationBoundaryForTest?.("after-move", src);
}

function expectedPhaseDirs(basePath: string): string[] {
  return getAllMilestones().map((milestone) =>
    resolveMilestonePath(basePath, milestone.id) ??
      join(milestonesDir(basePath), canonicalPhaseDirName(milestone.id, milestone.title)),
  );
}

/**
 * Return the most-recent existing `.gsd-backups/migrate-<ts>/` snapshot, or null.
 *
 * The flat-phase migration can re-fire when the legacy `.gsd/milestones/`
 * layout reappears (issue #1292). Creating a new snapshot on every startup
 * leaks `migrate-<ts>/` directories. Refresh an existing snapshot in place to
 * retain one recovery copy of the current legacy projection.
 */
function existingMigrateBackup(basePath: string): string | null {
  const backupRoot = join(basePath, ".gsd-backups");
  if (!existsSync(backupRoot)) return null;
  try {
    let latest: { path: string; mtimeMs: number } | null = null;
    for (const entry of readdirSync(backupRoot)) {
      if (!entry.startsWith("migrate-")) continue;
      const dirPath = join(backupRoot, entry);
      try {
        const st = statSync(dirPath);
        if (!st.isDirectory()) continue;
        if (!hasLegacyMilestoneSubdirs(dirPath)) continue;
        if (!latest || st.mtimeMs > latest.mtimeMs) latest = { path: dirPath, mtimeMs: st.mtimeMs };
      } catch {
        // Non-fatal: skip unreadable entries.
      }
    }
    return latest?.path ?? null;
  } catch {
    return null;
  }
}

function hasLegacyMilestoneSubdirs(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false;
  try {
    return readdirSync(dirPath).some(
      (e) => statSync(join(dirPath, e)).isDirectory() && dirIsContentBearingLegacyMilestone(join(dirPath, e)),
    );
  } catch {
    return false;
  }
}

function milestoneIdFromLegacyDirName(name: string): string | null {
  if (/^\d+$/.test(name)) return name;
  return name.match(/^(M\d{3}(?:-[a-z0-9]{6})?)(?:-|$)/)?.[1] ?? null;
}

function canonicalLegacyMilestoneId(
  legacyId: string,
  dbMilestones: ReadonlySet<string>,
): string | null {
  if (dbMilestones.has(legacyId)) return legacyId;
  const bare = legacyId.match(/^M(\d{3})$/);
  if (!bare) return null;

  const candidates = new Set<string>();
  const suffixedIdPattern = new RegExp(`^${legacyId}-[a-z0-9]{6}$`);
  for (const dbId of dbMilestones) {
    if (/^\d+$/.test(dbId) && `M${dbId.padStart(3, "0")}` === legacyId) candidates.add(dbId);
    if (suffixedIdPattern.test(dbId)) candidates.add(dbId);
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
}

function alignLegacyHierarchyIdentity(
  identity: string,
  milestoneAliases: ReadonlyMap<string, string>,
): string | null {
  const [milestoneId, ...rest] = identity.split("/");
  const canonicalMilestoneId = milestoneAliases.get(milestoneId!);
  return canonicalMilestoneId ? [canonicalMilestoneId, ...rest].join("/") : null;
}

function legacyHierarchyContainsUnknownIdentity(basePath: string, legacyRoot: string): boolean {
  const milestones = getAllMilestones();
  const dbMilestones = new Set(milestones.map((milestone) => milestone.id));
  const dbSlices = new Set<string>();
  const dbTasks = new Set<string>();

  for (const milestone of milestones) {
    for (const slice of getMilestoneSlices(milestone.id)) {
      dbSlices.add(`${milestone.id}/${slice.id}`);
      for (const task of getSliceTasks(milestone.id, slice.id)) {
        dbTasks.add(`${milestone.id}/${slice.id}/${task.id}`);
      }
    }
  }

  const milestoneAliases = new Map<string, string>();
  for (const milestoneEntry of readdirSync(legacyRoot, { withFileTypes: true })) {
    if (!milestoneEntry.isDirectory()) continue;
    const milestonePath = join(legacyRoot, milestoneEntry.name);
    if (!dirIsContentBearingLegacyMilestone(milestonePath)) continue;

    const legacyMilestoneId = milestoneIdFromLegacyDirName(milestoneEntry.name);
    if (!legacyMilestoneId) return true;
    const milestoneId = canonicalLegacyMilestoneId(legacyMilestoneId, dbMilestones);
    if (!milestoneId) return true;
    milestoneAliases.set(legacyMilestoneId, milestoneId);
    milestoneAliases.set(milestoneId, milestoneId);

    const slicesPath = join(milestonePath, "slices");
    if (!existsSync(slicesPath)) continue;
    for (const sliceEntry of readdirSync(slicesPath, { withFileTypes: true })) {
      if (!sliceEntry.isDirectory()) continue;
      const sliceId = sliceEntry.name.match(/^(S\d+)(?:-|$)/i)?.[1]?.toUpperCase();
      if (!sliceId || !dbSlices.has(`${milestoneId}/${sliceId}`)) return true;

      const tasksPath = join(slicesPath, sliceEntry.name, "tasks");
      if (!existsSync(tasksPath)) continue;
      for (const taskEntry of readdirSync(tasksPath, { withFileTypes: true })) {
        const taskId = taskEntry.name.match(/^(T\d+)(?:-|$)/i)?.[1]?.toUpperCase();
        if (taskId && !dbTasks.has(`${milestoneId}/${sliceId}/${taskId}`)) return true;
        if (!taskId && taskEntry.isDirectory()) return true;
      }
    }
  }

  const markdown = scanMarkdownHierarchy(basePath);
  return (
    [...markdown.milestones].some((id) => {
      const aligned = alignLegacyHierarchyIdentity(id, milestoneAliases);
      return aligned !== null && !dbMilestones.has(aligned);
    }) ||
    [...markdown.slices].some((id) => {
      const aligned = alignLegacyHierarchyIdentity(id, milestoneAliases);
      return aligned !== null && !dbSlices.has(aligned);
    }) ||
    [...markdown.tasks].some((id) => {
      const aligned = alignLegacyHierarchyIdentity(id, milestoneAliases);
      return aligned !== null && !dbTasks.has(aligned);
    })
  );
}

function backupFlatProjectionIfPresent(basePath: string, phasesPath: string, backupDir: string): void {
  if (!existsSync(phasesPath)) return;
  const phaseBackupDir = join(backupDir, "__phases");
  try {
    mkdirSync(backupDir, { recursive: true });
    if (existsSync(phaseBackupDir)) {
      rmSync(phaseBackupDir, RM_RETRY_OPTIONS);
    }
    cpSync(phasesPath, phaseBackupDir, { recursive: true, force: true });
  } catch (err) {
    logWarning("migration", `flat-phase projection backup failed: ${(err as Error).message}`);
    throw err;
  }
}

function isInsideFlatProjectionBackup(backupDir: string, src: string): boolean {
  const phaseBackupDir = join(backupDir, "__phases");
  return src === phaseBackupDir || src.startsWith(`${phaseBackupDir}/`) || src.startsWith(`${phaseBackupDir}\\`);
}

function removeFlatProjectionBackup(backupDir: string): void {
  const phaseBackupDir = join(backupDir, "__phases");
  if (!existsSync(phaseBackupDir)) return;
  try {
    rmSync(phaseBackupDir, { ...RM_RETRY_OPTIONS, force: true });
  } catch (err) {
    logWarning(
      "migration",
      `flat-phase migration succeeded but could not remove temporary ${LAYOUT_SEGMENTS.level1}/ backup: ${(err as Error).message}`,
    );
  }
}

function restoreFlatProjectionFromBackup(basePath: string, backupDir: string): void {
  const phaseBackupDir = join(backupDir, "__phases");
  if (!existsSync(phaseBackupDir)) return;
  const phasesPath = join(basePath, ".gsd", LAYOUT_SEGMENTS.level1);
  try {
    if (existsSync(phasesPath)) {
      removeManagedPath(phasesPath);
    }
    mkdirSync(join(basePath, ".gsd"), { recursive: true });
    copyProjectionTreeSync(phaseBackupDir, phasesPath);
  } catch (restoreErr) {
    logWarning(
      "migration",
      `rollback: could not restore ${LAYOUT_SEGMENTS.level1}/ from backup: ${(restoreErr as Error).message}`,
    );
    throw restoreErr;
  }
}

function pruneStaleFlatPhaseArtifactRows(basePath: string): number {
  const projectionRoot = gsdProjectionRoot(basePath);
  let pruned = 0;
  for (const row of getArtifactsByPathPrefix(`${LAYOUT_SEGMENTS.level1}/`)) {
    if (existsSync(join(projectionRoot, row.path))) continue;
    const staleTaskPlan = row.artifact_type.toUpperCase() === "PLAN" && Boolean(row.task_id);
    const skippedEmptyArtifact = row.full_content.trim() === "";
    if (!staleTaskPlan && !skippedEmptyArtifact) continue;
    deleteArtifactByPath(row.path);
    pruned++;
  }
  return pruned;
}

function rollbackPartialMigration(
  basePath: string,
  backupDir: string,
  migratingPath?: string,
  backupCreatedThisRun = true,
): void {
  // Remove the partially-written phases/ dir.
  try {
    removeManagedPath(join(basePath, ".gsd", LAYOUT_SEGMENTS.level1));
  } catch (removeErr) {
    logWarning(
      "migration",
      `rollback: could not remove partial ${LAYOUT_SEGMENTS.level1}/: ${(removeErr as Error).message}`,
    );
  }
  // Only the standalone .gsd-backups/migrate-<ts>/ copy is disposable once the
  // restore succeeds. When resuming an interrupted migration, backupDir IS the
  // preserved migrating tree (the sole surviving data source) and must never be
  // removed here. Deleting the backup after a successful rollback keeps the gate
  // from leaking one .gsd-backups/migrate-<ts>/ per session_start.
  const isDisposableBackup =
    Boolean(backupDir) && backupDir !== migratingPath && backupCreatedThisRun;
  const cleanupBackup = (): void => {
    if (!isDisposableBackup || !existsSync(backupDir)) return;
    try {
      rmSync(backupDir, { ...RM_RETRY_OPTIONS, force: true });
    } catch (cleanupErr) {
      logWarning(
        "migration",
        `rollback: could not clean backup ${backupDir}: ${(cleanupErr as Error).message}`,
      );
    }
  };

  // Restore milestones/ — prefer renaming the preserved migrating copy back.
  const milestonesPath = join(basePath, ".gsd", "milestones");
  try {
    if (migratingPath && existsSync(migratingPath) && !existsSync(milestonesPath)) {
      moveManagedTree(migratingPath, milestonesPath);
      restoreFlatProjectionFromBackup(basePath, backupDir);
      cleanupBackup();
      return;
    }
    if (existsSync(backupDir)) {
      copyProjectionTreeSync(backupDir, milestonesPath, src => !isInsideFlatProjectionBackup(backupDir, src));
      restoreFlatProjectionFromBackup(basePath, backupDir);
      cleanupBackup();
    }
    if (migratingPath && existsSync(migratingPath)) {
      removeManagedPath(migratingPath);
    }
  } catch (restoreErr) {
    logWarning(
      "migration",
      `rollback: could not restore milestones/: ${(restoreErr as Error).message}`,
    );
    // Non-fatal: backup still exists at backupDir for manual recovery.
  }
}

/**
 * Detect whether the project uses the legacy nested layout.
 * True when .gsd/milestones/ exists AND contains at least one milestone
 * subdirectory. An empty milestones/ dir (created by old bootstrap code
 * before it was fixed) is not a real legacy layout and must not trigger
 * a migration that would thrash the reconciler.
 */
export function needsFlatPhaseMigration(basePath: string): boolean {
  if (hasLegacyMilestoneSubdirs(join(basePath, ".gsd", "milestones"))) return true;
  // Resume an interrupted migration where the legacy tree was renamed aside.
  return hasLegacyMilestoneSubdirs(legacyMigratingPath(basePath));
}

/**
 * Is a flat-phase migration mid-flight right now?
 *
 * True only while the legacy tree sits at `.gsd/milestones.migrating` — the
 * window between moving it aside and rendering `.gsd/phases/`, during which the
 * slice plans exist in neither layout. Distinct from `needsFlatPhaseMigration`,
 * which is also true for a settled legacy project that has not started
 * migrating: callers that must not misread a transient gap want this one.
 */
export function isFlatPhaseMigrationInFlight(basePath: string): boolean {
  return hasLegacyMilestoneSubdirs(legacyMigratingPath(basePath));
}

/** Retention window before flat-phase migration backups are auto-pruned. */
export const FLAT_PHASE_BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Remove stale flat-phase migration backups after the retention window.
 * Only runs when migration is complete (.gsd/phases/ exists, legacy layout gone).
 * Returns the number of migrate-* directories removed.
 */
export function pruneStaleFlatPhaseBackups(basePath: string): number {
  if (needsFlatPhaseMigration(basePath)) return 0;

  const phasesPath = join(basePath, ".gsd", LAYOUT_SEGMENTS.level1);
  if (!existsSync(phasesPath)) return 0;

  const backupRoot = join(basePath, ".gsd-backups");
  if (!existsSync(backupRoot)) return 0;

  const now = Date.now();
  let removed = 0;
  for (const entry of readdirSync(backupRoot)) {
    if (!entry.startsWith("migrate-")) continue;
    const dirPath = join(backupRoot, entry);
    try {
      const st = statSync(dirPath);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs < FLAT_PHASE_BACKUP_RETENTION_MS) continue;
      rmSync(dirPath, { recursive: true, force: true });
      removed++;
    } catch {
      // Non-fatal: leave backup for manual recovery.
    }
  }

  try {
    if (readdirSync(backupRoot).length === 0) {
      rmSync(backupRoot, { recursive: true, force: true });
    }
  } catch {
    // Non-fatal.
  }

  return removed;
}

/**
 * Migrate from legacy nested .gsd/milestones/ to flat-phase .gsd/phases/.
 *
 * Steps:
 * 1. Backup .gsd/milestones/ to .gsd-backups/migrate-<ts>/
 * 2. Rename .gsd/milestones/ aside so path resolvers target phases/
 * 3. Render flat-phase from the DB (which already has the data)
 * 4. Verify counts match
 * 5. Prune legacy milestones/ artifact rows
 * 6. Remove the renamed legacy tree
 *
 * Idempotent and resumable: no-ops when migration is complete and resumes an
 * interrupted `.gsd/milestones.migrating/` tree when present.
 */
export async function migrateToFlatPhase(basePath: string): Promise<void> {
  if (!needsFlatPhaseMigration(basePath)) return;

  // With no milestone rows, every content-bearing legacy milestone is outside
  // database authority. Refuse before creating the persistent lock anchors so
  // an implicit migration attempt remains read-only.
  if (getAllMilestones().length === 0) {
    throw new Error(EXPLICIT_RECOVERY_REQUIRED);
  }

  const migrationLockTarget = flatPhaseMigrationLockTarget(basePath);

  // Headless runs the gsd extension in two processes (host + RPC child) and both
  // fire session_start, so two migrations race over the same tree: one moves
  // milestones/ aside or clears phases/ while the other is mid-render, and the
  // loser dies on ENOENT. A whole-migration cross-process lock is the only
  // ordering that helps — the steps are not individually idempotent.
  // Stale window is well above file-lock's 10s default: migration renders the
  // entire projection and can legitimately run for minutes on a large project.
  try {
    await withFileLock(
      migrationLockTarget,
      async () => {
        // Re-check under the lock: the winner may have completed the migration
        // while this process was waiting, which makes the loser a clean no-op
        // rather than a second destructive pass.
        if (!needsFlatPhaseMigration(basePath)) return;
        await migrateToFlatPhaseLocked(basePath);
      },
      // Migration is mostly synchronous fs work, so it blocks the event loop and
      // proper-lockfile's mtime keepalive timer cannot fire while it runs. The
      // stale window therefore has to exceed the whole migration, not the gap
      // between keepalives, or a waiting process declares the lock dead and
      // steals it mid-render.
      { realpath: false, retries: 30, stale: 600_000 },
    );
  } catch (err) {
    // If the lock was stolen anyway, the holder's release() throws even though
    // its migration finished. Outcome decides: a completed migration makes that
    // release error noise, an incomplete one is a real failure.
    const message = (err as Error)?.message ?? "";
    if (!/already released|compromised/i.test(message) || needsFlatPhaseMigration(basePath)) throw err;
    logWarning("migration", `flat-phase migration lock released early but migration completed: ${message}`);
  }
}

async function migrateToFlatPhaseLocked(basePath: string): Promise<void> {
  const milestonesPath = join(basePath, ".gsd", "milestones");
  const migratingPath = legacyMigratingPath(basePath);
  const phasesPath = join(basePath, ".gsd", LAYOUT_SEGMENTS.level1);
  const resumingInterrupted =
    !hasLegacyMilestoneSubdirs(milestonesPath) && hasLegacyMilestoneSubdirs(migratingPath);

  // Markdown is a projection, never startup authority. Refuse the layout
  // conversion before touching disk only when the legacy tree contains identities
  // the canonical DB does not hold; explicit recovery owns that import. Content
  // for known identities is archived in the migration backup, then rebuilt from DB.
  const legacySource = resumingInterrupted ? migratingPath : milestonesPath;
  if (legacyHierarchyContainsUnknownIdentity(basePath, legacySource)) {
    throw new Error(EXPLICIT_RECOVERY_REQUIRED);
  }

  const milestonesBefore = getAllMilestones().length;
  if (milestonesBefore === 0) {
    logWarning(
      "migration",
      "flat-phase migration skipped: legacy milestones/ exists but DB has no milestone rows — will retry when DB is populated",
    );
    return;
  }

  const priorBackup = existingMigrateBackup(basePath);
  const backupDir = priorBackup ?? join(basePath, ".gsd-backups", `migrate-${Date.now()}`);
  const backupCreatedThisRun = !priorBackup;
  try {
    mkdirSync(join(basePath, ".gsd-backups"), { recursive: true });
    cpSync(legacySource, backupDir, { recursive: true, force: true });
  } catch (err) {
    logWarning("migration", `flat-phase migration backup failed: ${(err as Error).message}`);
    throw err;
  }
  if (priorBackup) {
    logWarning(
      "migration",
      `flat-phase migration re-fired; refreshed existing backup ${priorBackup} instead of creating another (issue #1292)`,
    );
  }

  if (!resumingInterrupted) {
    if (existsSync(migratingPath)) {
      removeManagedPath(migratingPath);
    }

    // 3. Move the legacy tree aside before rendering so path resolvers target
    // phases/ instead of writing back into the nested milestones/ layout.
    // Keep the full tree on disk until render+verify succeed.
    try {
      moveManagedTree(milestonesPath, migratingPath);
    } catch (err) {
      logWarning("migration", `failed to move legacy milestones/ before render: ${(err as Error).message}`);
      throw err;
    }
  }

  // Clear any stale or partially-rendered flat projection before this run
  // writes. Verification below checks the current DB render, not leftovers.
  try {
    backupFlatProjectionIfPresent(basePath, phasesPath, backupDir);
    removeManagedPath(phasesPath);
  } catch (err) {
    logWarning("migration", `failed to clear stale phases/ before render: ${(err as Error).message}`);
    rollbackPartialMigration(basePath, backupDir, migratingPath, backupCreatedThisRun);
    throw err;
  }

  // 4. Render flat-phase from DB
  let renderResult: { rendered: number; skipped: number; errors: string[] };
  try {
    renderResult = await renderAllFromDb(basePath);
    // Slice-less milestones still need a phase directory for flat-phase layout.
    for (const milestone of getAllMilestones()) {
      if (getMilestoneSlices(milestone.id).length > 0) continue;
      const roadmapResult = await renderRoadmapFromDb(basePath, milestone.id);
      if ("skipped" in roadmapResult) {
        const phaseDir = resolveMilestonePath(basePath, milestone.id) ??
          join(milestonesDir(basePath), canonicalPhaseDirName(milestone.id, milestone.title));
        createProjectionDirectorySync(phaseDir);
        continue;
      }
      renderResult.rendered++;
    }
  } catch (err) {
    logWarning("migration", `flat-phase render failed: ${(err as Error).message}`);
    rollbackPartialMigration(basePath, backupDir, migratingPath, backupCreatedThisRun);
    throw err;
  }

  // 5. Verify render succeeded and flat-phase projection was written
  if (renderResult.errors.length > 0) {
    logWarning(
      "migration",
      `flat-phase render had ${renderResult.errors.length} error(s): ${renderResult.errors.join("; ")}`,
    );
    rollbackPartialMigration(basePath, backupDir, migratingPath, backupCreatedThisRun);
    throw new Error(
      `flat-phase migration render failed: ${renderResult.errors.slice(0, 3).join("; ")}`,
    );
  }

  const db = countDbHierarchy();
  const missingPhaseDirs = expectedPhaseDirs(basePath).filter((phaseDir) => !existsSync(phaseDir));
  if (db.milestones > 0 && missingPhaseDirs.length > 0) {
    logWarning(
      "migration",
      `flat-phase migration missing ${missingPhaseDirs.length} expected phase dir(s): ${missingPhaseDirs.join(", ")}`,
    );
    rollbackPartialMigration(basePath, backupDir, migratingPath, backupCreatedThisRun);
    throw new Error("flat-phase migration verification failed: missing rendered phase directories");
  }
  if (db.slices > 0 && renderResult.rendered === 0) {
    logWarning(
      "migration",
      "flat-phase migration verification failed: render produced no artifacts for populated DB",
    );
    rollbackPartialMigration(basePath, backupDir, migratingPath, backupCreatedThisRun);
    throw new Error("flat-phase migration verification failed: no artifacts rendered");
  }

  // 6. Verified — prune legacy artifact rows now that renderAllFromDb has
  // re-inserted flat-phase rows for artifacts that still have files. Also
  // prune flat-phase rows whose files the renderer intentionally no longer
  // materializes, such as task PLAN files and empty-content artifacts.
  try {
    deleteArtifactsByPathPrefix("milestones/");
    pruneStaleFlatPhaseArtifactRows(basePath);
  } catch (err) {
    logWarning("migration", `flat-phase migration could not prune legacy artifact rows: ${(err as Error).message}`);
    rollbackPartialMigration(basePath, backupDir, migratingPath, backupCreatedThisRun);
    throw err;
  }

  // 7. Remove the renamed legacy tree (backup already on disk).
  try {
    removeManagedPath(migratingPath);
  } catch (err) {
    logWarning(
      "migration",
      `flat-phase migration succeeded but could not remove ${LEGACY_MIGRATING_SEGMENT}: ${(err as Error).message}`,
    );
  }
  removeFlatProjectionBackup(backupDir);
}
