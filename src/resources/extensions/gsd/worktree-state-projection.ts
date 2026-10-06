// gsd-pi — Worktree State Projection module: directional state-flow rules between project root and auto-worktree.
/**
 * Worktree State Projection module — first-class Module for directional
 * state-file flow between the project root and the auto-worktree.
 *
 * Per ADR-016, this Module owns the project-root to worktree flow of
 * projection files and its invariants (additive milestone copy #1886,
 * WAL/SHM cleanup #2478, .gsd symlink edge case #2184).
 *
 * Per ADR-046, no file flows from the worktree to the project root: the
 * project database is the only authority, and a worktree session writes
 * root projections and runtime files at the project root.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { dirIsContentBearingLegacyMilestone, resolveGsdPathContract } from "./paths.js";
import { copyProjectionFileSync, mergeProjectionTreeSync } from "./atomic-write.js";
import { renderKnowledgeProjection } from "./knowledge-projection.js";
import type { MilestoneScope } from "./workspace.js";
import { logWarning } from "./workflow-logger.js";

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
 * Root-level .gsd/ projections. Every writer resolves them at the project
 * root, also from a worktree session, so the project-root file is the
 * database render and the worktree file is only a copy for the agent that
 * reads `.gsd/<file>` from its worktree cwd.
 */
const ROOT_PROJECTION_FILES = [
  "DECISIONS.md",
  "REQUIREMENTS.md",
  "PROJECT.md",
  "KNOWLEDGE.md",
  "OVERRIDES.md",
  "QUEUE.md",
] as const;

/**
 * Make the worktree copy of each root projection equal to the project-root
 * render. Runs on worktree entry and after every unit, so the worktree copy
 * is never older than one unit. KNOWLEDGE.md is rendered from the database at
 * the project root first. `mcp.json` is configuration, not a projection: it
 * is copied only when the worktree has none.
 *
 * @returns the files whose worktree bytes changed
 */
export function refreshRootProjectionsInWorktree(projectRoot: string, worktreePath: string): string[] {
  const contract = resolveGsdPathContract(worktreePath, projectRoot);
  const prGsd = contract.projectGsd;
  const wtGsd = contract.worktreeGsd ?? join(worktreePath, ".gsd");
  const refreshed: string[] = [];
  if (isSamePath(prGsd, wtGsd)) return refreshed;

  try {
    renderKnowledgeProjection(projectRoot);
  } catch (e) {
    logWarning("worktree", `KNOWLEDGE.md was not rendered: ${(e as Error).message}`);
  }

  mkdirSync(wtGsd, { recursive: true });
  for (const file of ROOT_PROJECTION_FILES) {
    const src = join(prGsd, file);
    const dst = join(wtGsd, file);
    if (!existsSync(src)) continue;
    if (existsSync(dst) && readFileSync(src).equals(readFileSync(dst))) continue;
    copyProjectionFileSync(src, dst, true);
    refreshed.push(file);
  }
  if (existsSync(join(prGsd, "mcp.json")) && !existsSync(join(wtGsd, "mcp.json"))) {
    copyProjectionFileSync(join(prGsd, "mcp.json"), join(wtGsd, "mcp.json"), false);
    refreshed.push("mcp.json");
  }
  return refreshed;
}

// ─── Implementation cores ────────────────────────────────────────────────
//
// The `_*Impl` export takes raw paths so the path-string wrapper in
// `auto-worktree-sync.ts` can delegate to it.

/**
 * Project state from project root onto the auto-worktree (raw-path body).
 *
 * Owns the rules: identity-key safety check (#2184 .gsd symlink), additive
 * milestone copy preserving worktree-local files (#1886),
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

  refreshRootProjectionsInWorktree(projectRoot, worktreePath_);

  // Flat-phase artifacts (phases/NN-slug/NN-CONTEXT.md, NN-DISCUSSION.md,
  // ROADMAP, etc.) must be available before the first worktree dispatch.
  syncFlatPhaseArtifacts(prGsd, wtGsd);

  // Copy milestone directory from project root to worktree — additive only.
  // force:false keeps the files that the worktree session rendered (#1886).
  const prMilestoneDir = join(prGsd, "milestones", milestoneId);
  const wtMilestoneDir = join(wtGsd, "milestones", milestoneId);
  if (dirIsContentBearingLegacyMilestone(prMilestoneDir)) {
    mergeProjectionTreeSync(prMilestoneDir, wtMilestoneDir, false);
  }

  // Additively project the full subtree of every OTHER content-bearing legacy
  // milestone so worktree-bound units can read prior-milestone context artifacts
  // without recreating empty/meta-only milestones/ scaffolds in flat-phase projects.
  syncOtherMilestoneArtifacts(
    join(prGsd, "milestones"),
    join(wtGsd, "milestones"),
    milestoneId,
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
   * Refresh the worktree copies of the root projections from the project
   * root. Called by the post-unit pipeline between Units.
   */
  refreshRootProjections(scope: MilestoneScope): void {
    const worktreeRoot = scope.workspace.worktreeRoot;
    if (!worktreeRoot) return;
    refreshRootProjectionsInWorktree(scope.workspace.projectRoot, worktreeRoot);
  }
}
