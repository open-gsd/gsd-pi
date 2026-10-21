// gsd-pi — Worktree State Projection module: directional state-flow rules between project root and auto-worktree.
/**
 * Worktree State Projection module — first-class Module for directional
 * state-file flow between the project root and the auto-worktree.
 *
 * Per ADR-016, this Module owns:
 *   - The direction-and-rules of state file flow (project-root authoritative
 *     for some classes, worktree authoritative for others)
 *   - The bug-hardened invariants encoded in `syncProjectRootToWorktree` /
 *     `syncStateToProjectRoot` (additive milestone copy #1886, ASSESSMENT
 *     verdict overwrite #2821, completed-units forward-sync, WAL/SHM
 *     cleanup #2478, .gsd symlink edge case #2184)
 *
 * Slice 7 (#5591): the bodies of the three projection verbs and their
 * private helpers (`isSamePath`, `forceOverwriteAssessmentsWithVerdict`,
 * `ROOT_DIAGNOSTIC_FILES`) live here. The legacy `syncProjectRootToWorktree`,
 * `syncStateToProjectRoot`, `syncWorktreeStateBack` exports in
 * `auto-worktree.ts` are thin wrappers around the `_*Impl` exports below
 * until the legacy-helper cleanup step retires them.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { reconcileWorktreeDb } from "./gsd-db.js";
import { dirIsContentBearingLegacyMilestone, resolveGsdPathContract } from "./paths.js";
import { copyProjectionFileSync, mergeProjectionTreeSync } from "./atomic-write.js";
import type { MilestoneScope } from "./workspace.js";
import { logError, logWarning } from "./workflow-logger.js";

// ─── Private helpers ──────────────────────────────────────────────────────

/**
 * Check if two filesystem paths resolve to the same real location.
 * Returns false if either path cannot be resolved (e.g. doesn't exist).
 *
 * Detects the .gsd-as-symlink case (#2184) where the worktree's `.gsd`
 * resolves to the same physical directory as the project root's `.gsd` —
 * a `cpSync` over those would fail with `ERR_FS_CP_EINVAL`.
 */
function isSamePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    logWarning("worktree", `isSamePath failed: ${(e as Error).message}`);
    return false;
  }
}

/** Regex matching YAML frontmatter `verdict:` field. */
const VERDICT_RE = /verdict:\s*[\w-]+/i;

/**
 * Walk a milestone directory and force-overwrite ASSESSMENT files in the
 * destination when the source copy contains a `verdict:` field.
 *
 * Targeted fix for the UAT stuck-loop (#2821): the main `safeCopyRecursive`
 * uses `force:false` to protect worktree-local projection files (#1886),
 * but ASSESSMENT files written by run-uat must be forward-synced when the
 * project root has a verdict. Without this, the worktree retains a stale
 * FAIL or missing ASSESSMENT and `checkNeedsRunUat` re-dispatches run-uat
 * indefinitely.
 *
 * Only overwrites when the source has a verdict — never clobbers a
 * worktree ASSESSMENT with a verdictless project-root copy.
 */
function forceOverwriteValidationWithVerdict(
  srcMilestoneDir: string,
  dstMilestoneDir: string,
  milestoneId: string,
): void {
  if (!existsSync(srcMilestoneDir) || !milestoneId) return;

  const srcFile = join(srcMilestoneDir, `${milestoneId}-VALIDATION.md`);
  if (!existsSync(srcFile)) return;

  try {
    const srcContent = readFileSync(srcFile, "utf-8");
    if (!VERDICT_RE.test(srcContent)) return;

    copyProjectionFileSync(srcFile, join(dstMilestoneDir, `${milestoneId}-VALIDATION.md`), true);
  } catch (err) {
    logWarning(
      "worktree",
      `validation force-copy failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function forceOverwriteAssessmentsWithVerdict(
  srcMilestoneDir: string,
  dstMilestoneDir: string,
): void {
  if (!existsSync(srcMilestoneDir)) return;

  const slicesDir = join(srcMilestoneDir, "slices");
  if (!existsSync(slicesDir)) return;

  try {
    for (const sliceEntry of readdirSync(slicesDir, { withFileTypes: true })) {
      if (!sliceEntry.isDirectory()) continue;
      const srcSliceDir = join(slicesDir, sliceEntry.name);
      const dstSliceDir = join(dstMilestoneDir, "slices", sliceEntry.name);

      try {
        for (const fileEntry of readdirSync(srcSliceDir, { withFileTypes: true })) {
          if (!fileEntry.isFile()) continue;
          if (!fileEntry.name.endsWith("-ASSESSMENT.md")) continue;

          const srcFile = join(srcSliceDir, fileEntry.name);
          try {
            const srcContent = readFileSync(srcFile, "utf-8");
            if (!VERDICT_RE.test(srcContent)) continue;

            copyProjectionFileSync(srcFile, join(dstSliceDir, fileEntry.name), true);
          } catch (err) {
            logWarning(
              "worktree",
              `assessment force-copy failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        logWarning(
          "worktree",
          `assessment slice scan failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    logWarning(
      "worktree",
      `assessment sync failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function syncOtherMilestoneArtifacts(
  srcMilestonesDir: string,
  dstMilestonesDir: string,
  currentMilestoneId: string,
): void {
  if (!existsSync(srcMilestonesDir)) return;

  try {
    for (const milestoneEntry of readdirSync(srcMilestonesDir, { withFileTypes: true })) {
      if (!milestoneEntry.isDirectory()) continue;
      // The current milestone is already fully projected by the caller's
      // additive safeCopyRecursive; skip it here to avoid redundant work.
      if (milestoneEntry.name === currentMilestoneId) continue;
      const srcMilestoneDir = join(srcMilestonesDir, milestoneEntry.name);
      if (!dirIsContentBearingLegacyMilestone(srcMilestoneDir)) continue;
      const dstMilestoneDir = join(dstMilestonesDir, milestoneEntry.name);

      // Additively project the entire milestone subtree (force:false), not just
      // top-level files. Prior completed milestones keep their per-slice and
      // per-task SUMMARY.md / UAT.md on disk so the worktree's stale-render
      // detector doesn't flag them as missing (DB has summary, disk doesn't).
      // force:false preserves any worktree-local files (#1886 invariant) and
      // only fills in files absent from the worktree projection.
      mergeProjectionTreeSync(srcMilestoneDir, dstMilestoneDir, false);
    }
  } catch (err) {
    logWarning(
      "worktree",
      `milestone artifact scan failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function syncFlatPhaseArtifacts(prGsd: string, wtGsd: string): void {
  mergeProjectionTreeSync(join(prGsd, "phases"), join(wtGsd, "phases"), false);
}

/**
 * Root-level .gsd/ files copied from worktree back to project root for
 * post-merge diagnostics. Markdown projections are NOT in this list — DB
 * remains authoritative.
 */
const ROOT_DIAGNOSTIC_FILES = [
  "completed-units.json",
  "metrics.json",
] as const;

/**
 * Root-level .gsd/ projections copied from project root into worktrees for
 * compatibility reads. Project root remains authoritative; copy-back still
 * excludes these markdown projections.
 */
const ROOT_FORWARD_PROJECTION_FILES = [
  "DECISIONS.md",
  "REQUIREMENTS.md",
  "PROJECT.md",
  "KNOWLEDGE.md",
  "OVERRIDES.md",
  "QUEUE.md",
  "completed-units.json",
  "metrics.json",
  "mcp.json",
] as const;

function syncRootProjectionFilesToWorktree(prGsd: string, wtGsd: string): void {
  mkdirSync(wtGsd, { recursive: true });

  for (const file of ROOT_FORWARD_PROJECTION_FILES) {
    const src = join(prGsd, file);
    const dst = join(wtGsd, file);
    if (!existsSync(src) || existsSync(dst)) continue;

    copyProjectionFileSync(src, dst, false);
  }
}

// ─── Implementation cores ────────────────────────────────────────────────
//
// The `_*Impl` exports take raw paths so the deprecated path-string
// wrappers in `auto-worktree.ts` can delegate to them during the slice-7
// migration window. They will be inlined into the class methods and made
// non-exported once the legacy wrappers retire.

/**
 * Project state from project root onto the auto-worktree (raw-path body).
 *
 * Owns the rules: identity-key safety check (#2184 .gsd symlink), additive
 * milestone copy preserving worktree-local files (#1886), ASSESSMENT
 * verdict force-overwrite (#2821), forward-sync of `completed-units.json`,
 * WAL/SHM cleanup on legacy worktree-local DB (#2478).
 */
export function _projectRootToWorktreeImpl(
  projectRoot: string,
  worktreePath_: string,
  milestoneId: string | null,
): void {
  if (!worktreePath_ || !projectRoot || worktreePath_ === projectRoot) return;
  if (!milestoneId) return;

  const contract = resolveGsdPathContract(worktreePath_, projectRoot);
  const prGsd = contract.projectGsd;
  const wtGsd = contract.worktreeGsd ?? join(worktreePath_, ".gsd");

  // When .gsd is a symlink to the same external directory in both locations,
  // cpSync rejects the copy because source === destination (ERR_FS_CP_EINVAL).
  // Compare realpaths and skip when they resolve to the same physical path (#2184).
  if (isSamePath(prGsd, wtGsd)) return;

  // Root PROJECT/REQUIREMENTS/DECISIONS projections must be readable from a
  // worktree-bound unit; the project root remains authoritative.
  syncRootProjectionFilesToWorktree(prGsd, wtGsd);

  // Flat-phase artifacts (phases/NN-slug/NN-CONTEXT.md, NN-DISCUSSION.md,
  // ROADMAP, etc.) must be available before the first worktree dispatch.
  syncFlatPhaseArtifacts(prGsd, wtGsd);

  // Copy milestone directory from project root to worktree — additive only.
  // force:false prevents cpSync from overwriting existing worktree files.
  // Without this, worktree-local files (e.g. VALIDATION.md written
  // by validate-milestone) get clobbered by stale project root copies,
  // causing an infinite re-validation loop (#1886).
  const prMilestoneDir = join(prGsd, "milestones", milestoneId);
  const wtMilestoneDir = join(wtGsd, "milestones", milestoneId);
  if (dirIsContentBearingLegacyMilestone(prMilestoneDir)) {
    mergeProjectionTreeSync(prMilestoneDir, wtMilestoneDir, false);

    // Force-sync ASSESSMENT files that have a verdict from project root (#2821).
    // The additive-only copy above preserves worktree-local files, but
    // ASSESSMENT files are special: after run-uat writes a verdict and post-unit
    // syncs it to the project root, the worktree may retain a stale copy (e.g.
    // verdict:fail while the project root has verdict:pass from a retry). On
    // session resume the DB is rebuilt from disk, and if the stale ASSESSMENT
    // persists, checkNeedsRunUat finds no passing verdict → re-dispatches
    // run-uat indefinitely (stuck-loop ×9).
    forceOverwriteValidationWithVerdict(prMilestoneDir, wtMilestoneDir, milestoneId);
    forceOverwriteAssessmentsWithVerdict(prMilestoneDir, wtMilestoneDir);
  }

  // Additively project the full subtree of every OTHER content-bearing legacy
  // milestone so worktree-bound units can read prior-milestone context artifacts
  // without recreating empty/meta-only milestones/ scaffolds in flat-phase projects.
  syncOtherMilestoneArtifacts(
    join(prGsd, "milestones"),
    join(wtGsd, "milestones"),
    milestoneId,
  );

  // Forward-sync completed-units.json from project root to worktree.
  // Project root is authoritative for completion state after crash recovery;
  // without this, the worktree re-dispatches already-completed units (#1886).
  copyProjectionFileSync(
    join(prGsd, "completed-units.json"),
    join(wtGsd, "completed-units.json"),
    true,
  );

  // Delete a legacy worktree-local gsd.db ONLY if it is empty (0 bytes).
  // Runtime opens contract.projectDb; this cleanup only removes corrupt
  // pre-upgrade local DB projections.
  try {
    const wtDb = join(wtGsd, "gsd.db");
    let deleteSidecars = false;
    if (existsSync(wtDb)) {
      const size = statSync(wtDb).size;
      if (size === 0) {
        unlinkSync(wtDb);
        deleteSidecars = true;
      }
    } else {
      // Main DB already missing — sidecars are orphaned from a previous
      // partial cleanup and must still be removed.
      deleteSidecars = true;
    }
    // Always clean up WAL/SHM sidecar files when the main DB was deleted
    // or is already missing. Orphaned WAL/SHM files cause SQLite WAL
    // recovery on next open, which triggers a CPU spin on Node 24's
    // node:sqlite DatabaseSync implementation (#2478).
    if (deleteSidecars) {
      for (const suffix of ["-wal", "-shm"]) {
        const f = wtDb + suffix;
        if (existsSync(f)) {
          unlinkSync(f);
        }
      }
    }
  } catch (err) {
    logWarning(
      "worktree",
      `worktree DB cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Project state from auto-worktree back onto project root (raw-path body).
 *
 * Owns the rules: project-root authoritative for diagnostics; markdown
 * projections do NOT flow back; non-fatal — sync failure must not block
 * the caller.
 */
export function _projectWorktreeToRootImpl(
  worktreePath_: string,
  projectRoot: string,
  milestoneId: string | null,
): void {
  if (!worktreePath_ || !projectRoot || worktreePath_ === projectRoot) return;
  if (!milestoneId) return;

  const contract = resolveGsdPathContract(worktreePath_, projectRoot);
  const wtGsd = contract.worktreeGsd ?? join(worktreePath_, ".gsd");
  const prGsd = contract.projectGsd;

  // When .gsd is a symlink to the same external directory in both locations,
  // cpSync rejects the copy because source === destination (ERR_FS_CP_EINVAL).
  // Compare realpaths and skip when they resolve to the same physical path (#2184).
  if (isSamePath(wtGsd, prGsd)) return;

  // metrics.json — session cost/token tracking (#2313).
  // Without this, metrics accumulated in the worktree are invisible from the
  // project root and never appear in the dashboard or skill-health reports.
  copyProjectionFileSync(join(wtGsd, "metrics.json"), join(prGsd, "metrics.json"), true);

  // completed-units.json — runtime completion diagnostics used to avoid
  // re-dispatching work already completed in an isolated worktree.
  copyProjectionFileSync(
    join(wtGsd, "completed-units.json"),
    join(prGsd, "completed-units.json"),
    true,
  );

  // Runtime records — unit dispatch diagnostics used by selfHealRuntimeRecords().
  // Without this, a crash during a unit leaves the runtime record only in the
  // worktree. If the next session resolves basePath before worktree re-entry,
  // selfHeal can't find or clear the stale record (#769).
  mergeProjectionTreeSync(
    join(wtGsd, "runtime", "units"),
    join(prGsd, "runtime", "units"),
    true,
  );
}

/**
 * Final projection from auto-worktree to project root before teardown
 * (raw-path body).
 *
 * Owns the rules: pre-upgrade DB reconciliation, root-level diagnostic
 * file copy. DB/project-root state remains authoritative; markdown
 * milestone directories are NOT copied back.
 */
export function _finalizeProjectionForMergeImpl(
  mainBasePath: string,
  worktreePath: string,
  milestoneId: string,
): { synced: string[] } {
  const contract = resolveGsdPathContract(worktreePath, mainBasePath);
  const mainGsd = contract.projectGsd;
  const wtGsd = contract.worktreeGsd ?? join(worktreePath, ".gsd");
  const synced: string[] = [];

  // If both resolve to the same directory (symlink), no sync needed
  if (isSamePath(mainGsd, wtGsd)) return { synced };

  if (!existsSync(wtGsd) || !existsSync(mainGsd)) return { synced };

  // ── 0. Pre-upgrade worktree DB reconciliation ────────────────────────
  // If the worktree has its own gsd.db (copied before the WAL transition),
  // reconcile its hierarchy data into the project root DB before syncing
  // files. This handles in-flight worktrees that were created before the
  // upgrade to shared WAL mode.
  const wtLocalDb = join(wtGsd, "gsd.db");
  const mainDb = contract.projectDb;
  if (existsSync(wtLocalDb) && existsSync(mainDb)) {
    try {
      reconcileWorktreeDb(mainDb, wtLocalDb);
      synced.push("gsd.db (pre-upgrade reconcile)");
    } catch (err) {
      // Non-fatal — file sync below is the fallback
      logError(
        "worktree",
        `DB reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── 1. Sync root-level diagnostic files back ─────────────────────────
  // Markdown/JSON state projections remain project-root/DB authoritative.
  // These diagnostic files are copied for observability only.
  for (const f of ROOT_DIAGNOSTIC_FILES) {
    const src = join(wtGsd, f);
    const dst = join(mainGsd, f);
    if (existsSync(src)) {
      try {
        cpSync(src, dst, { force: true });
        synced.push(f);
      } catch (err) {
        logWarning(
          "worktree",
          `state file copy-back failed (${f}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return { synced };
}

// ─── Module class ────────────────────────────────────────────────────────

/**
 * Worktree State Projection Module instance.
 *
 * Stateless — methods are pure functions of their `MilestoneScope` input.
 * The class form is retained for testability and to keep the Interface
 * shape consistent with `WorktreeLifecycle`.
 */
export class WorktreeStateProjection {
  /**
   * Project state from the project root onto the auto-worktree for the scope
   * pair. `worktreeScope` may be omitted only for project-only/same-path
   * callers where the helper intentionally fast-paths to a no-op.
   * Called by Lifecycle's enter path after a successful create/enter, before
   * any Unit dispatches.
   */
  projectRootToWorktree(scope: MilestoneScope): void {
    this.projectRootToWorktreePaths(
      scope.workspace.projectRoot,
      scope.workspace.worktreeRoot ?? scope.workspace.projectRoot,
      scope.milestoneId,
    );
  }

  projectRootToWorktreePaths(
    projectRoot: string,
    worktreePath: string,
    milestoneId: string | null,
  ): void {
    _projectRootToWorktreeImpl(projectRoot, worktreePath, milestoneId);
  }

  /**
   * Project state from the auto-worktree back onto the project root for `scope`.
   * Called by the post-unit pipeline between Units.
   */
  projectWorktreeToRoot(scope: MilestoneScope): void {
    this.projectWorktreeToRootPaths(
      scope.workspace.worktreeRoot ?? scope.workspace.projectRoot,
      scope.workspace.projectRoot,
      scope.milestoneId,
    );
  }

  projectWorktreeToRootPaths(
    worktreePath: string,
    projectRoot: string,
    milestoneId: string | null,
  ): void {
    _projectWorktreeToRootImpl(worktreePath, projectRoot, milestoneId);
  }

  /**
   * Final projection from the auto-worktree to the project root before
   * teardown. Called by Lifecycle's exit path after a successful merge,
   * before the worktree directory is removed.
   *
   * Returns `{ synced }` describing which file classes were captured —
   * mirrors the pre-deepening contract for callers that want post-merge
   * telemetry on what crossed the boundary.
   */
  finalizeProjectionForMerge(scope: MilestoneScope): { synced: string[] } {
    return this.finalizeProjectionForMergePaths(
      scope.workspace.projectRoot,
      scope.workspace.worktreeRoot ?? scope.workspace.projectRoot,
      scope.milestoneId,
    );
  }

  finalizeProjectionForMergePaths(
    projectRoot: string,
    worktreePath: string,
    milestoneId: string,
  ): { synced: string[] } {
    return _finalizeProjectionForMergeImpl(projectRoot, worktreePath, milestoneId);
  }
}
