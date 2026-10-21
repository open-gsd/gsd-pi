// Project/App: gsd-pi
// File Purpose: Auto-mode bootstrap, worktree recovery, and fresh-start initialization.
/**
 * Auto-mode bootstrap — fresh-start initialization path.
 *
 * Git/state bootstrap, crash lock detection, debug init, worktree recovery,
 * guided flow gate, session init, worktree lifecycle, DB lifecycle,
 * preflight validation.
 *
 * Extracted from startAuto() in auto.ts. The resume path (s.paused)
 * remains in auto.ts — this module handles only the fresh-start path.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@gsd/pi-coding-agent";
import { deriveState } from "./state.js";
import { findWorktreeSegment, isGsdWorktreePath } from "./worktree-root.js";
import { loadFile, getManifestStatus } from "./files.js";
import type { InterruptedSessionAssessment } from "./interrupted-session.js";
import {
  loadEffectiveGSDPreferences,
  loadEffectiveGSDPreferencesWithRegistry,
  modelIdsForProfileResolution,
  resolveProfileAnchorProvider,
  resolveDisabledModelProvidersFromPreferences,
  resolveSkillDiscoveryMode,
  getIsolationMode,
} from "./preferences.js";
import { ensureGsdSymlink, isInheritedRepo, validateProjectId } from "./repo-identity.js";
import { migrateToExternalState, recoverFailedMigration } from "./migrate-external.js";
import { collectSecretsFromManifest } from "../get-secrets-from-user.js";
import { gsdRoot, resolveMilestoneFile } from "./paths.js";
import { findMilestoneIds } from "./milestone-ids.js";
import { milestoneEntryBlockedGuidance } from "./guidance.js";
import { invalidateAllCaches } from "./cache.js";
import { writeLock, clearLock, readCrashLock, isLockProcessAlive } from "./crash-recovery.js";
import {
  acquireSessionLock,
  releaseSessionLock,
  updateSessionLock,
} from "./session-lock.js";
import { ensureGitignore, untrackRuntimeFiles } from "./gitignore.js";
import {
  nativeIsRepo,
  nativeInit,
  nativeAddAll,
  nativeCommit,
  nativeGetCurrentBranch,
  nativeDetectMainBranch,
  nativeBranchList,
  nativeBranchExists,
  nativeBranchListMerged,
  nativeBranchDelete,
  nativeWorktreeRemove,
  nativeCommitCountBetween,
  nativeHasChanges,
} from "./native-git-bridge.js";
import { GitServiceImpl } from "./git-service.js";
import {
  captureIntegrationBranch,
  detectWorktreeName,
  setActiveMilestoneId,
} from "./worktree.js";
import { isInAutoWorktree } from "./auto-worktree-entry.js";
import { getAutoWorktreePath } from "./auto-worktree-path-resolution.js";
import { checkoutBranchWithStashGuard } from "./worktree-git-recovery.js";
import { cleanStaleRuntimeUnits } from "./auto-worktree-runtime-cleanup.js";
import { readResourceVersion } from "./auto-worktree-resource-version.js";
import { queryJournal } from "./journal.js";
import { worktreePath as getWorktreeDir, isInsideWorktreesDir } from "./worktree-manager.js";
import { emitWorktreeOrphaned } from "./worktree-telemetry.js";
import { initMetrics } from "./metrics.js";
import { initRoutingHistory } from "./routing-history.js";
import { restoreHookState, resetHookState, reconcileRestoredHookDispatch, reconcileRestoredGateBlock } from "./post-unit-hooks.js";
import { resetProactiveHealing, setLevelChangeCallback } from "./doctor-proactive.js";
import { snapshotSkills } from "./skill-discovery.js";
import {
  isDbAvailable,
  probeDbWritable,
  getMilestone,
  getAllMilestones,
  insertMilestone,
  updateMilestoneStatus,
} from "./gsd-db.js";
import { readMilestoneMergeObservation } from "./db/milestone-closeout-readiness.js";
import { immediateTransaction } from "./db/engine.js";
import {
  closeAllWorkflowDatabases,
  getWorkflowDatabaseStatus,
  openExistingWorkflowDatabase,
  openWorkflowDatabase,
  resolveProjectRootDbPath,
} from "./db-workspace.js";
import { isClosedStatus } from "./status-guards.js";
import { classifyMilestoneSummaryContent } from "./milestone-summary-classifier.js";
import { extractVerdict } from "./verdict-parser.js";
import { auditOrphanedPreflightStashes } from "./orphan-stash-audit.js";
import { LAYOUT_SEGMENTS } from "./layout-policy.js";

import {
  debugLog,
  enableDebug,
  isDebugEnabled,
  getDebugLogPath,
} from "./debug-logger.js";
import { logWarning, logError } from "./workflow-logger.js";
import { parseUnitId } from "./unit-id.js";
import type { AutoSession } from "./auto/session.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { removeProjectionTreeSync } from "./atomic-write.js";

import { validateDirectory } from "./validate-directory.js";
import {
  isCustomProvider,
  resolveDefaultSessionModel,
  resolveDynamicRoutingConfig,
} from "./preferences-models.js";
import {
  prepareIsolationForNewRun,
  type WorktreeLifecycle,
} from "./worktree-lifecycle.js";
import { getSessionModelOverride } from "./session-model-override.js";
import { setAutoActiveStatus } from "./auto-dashboard.js";

export interface BootstrapDeps {
  shouldUseWorktreeIsolation: (basePath?: string) => boolean;
  registerSigtermHandler: (basePath: string) => void;
  registerAutoWorkerForSession: (basePath: string) => void;
  lockBase: () => string;
  buildLifecycle: () => WorktreeLifecycle;
}

export function resolveIsolationNoneBranchCheckout(
  currentBranch: string,
  integrationBranch: string,
  isolationMode: string,
  isRepo: boolean,
): string | null {
  if (!isRepo || isolationMode !== "none") return null;
  return currentBranch.startsWith("milestone/") ? integrationBranch : null;
}

/**
 * Bootstrap a fresh auto-mode session. Handles everything from git init
 * through secrets collection, returning when ready for the first
 * dispatchNextUnit call.
 *
 * Returns false if the bootstrap aborted (e.g., guided flow returned,
 * concurrent session detected). Returns true when ready to dispatch.
 */

// Guard constant for consecutive bootstrap attempts that found phase === "complete".
// Counter moved to AutoSession.consecutiveCompleteBootstraps so s.reset() clears it.
const MAX_CONSECUTIVE_COMPLETE_BOOTSTRAPS = 2;

export function hasGitIndexLockForTest(basePath: string): boolean {
  return existsSync(join(basePath, ".git", "index.lock"));
}

function isEmptyDirectory(dirPath: string): boolean {
  try {
    return existsSync(dirPath) && readdirSync(dirPath).length === 0;
  } catch {
    return false;
  }
}

export function reconcileFlatPhaseBootstrapLayout(basePath: string): boolean {
  const gsdDir = join(basePath, ".gsd");
  const phasesPath = join(gsdDir, LAYOUT_SEGMENTS.level1);
  const milestonesPath = join(gsdDir, "milestones");

  if (isEmptyDirectory(milestonesPath)) {
    if (!existsSync(phasesPath)) mkdirSync(phasesPath, { recursive: true });
    removeProjectionTreeSync(milestonesPath);
    return true;
  }

  if (!existsSync(phasesPath) && !existsSync(milestonesPath)) {
    mkdirSync(phasesPath, { recursive: true });
    return true;
  }

  return false;
}

export function _shouldAbortBootstrapForUnavailableDbForTest(
  gsdDbPath: string,
  dbAvailable: boolean,
  pathExists: (path: string) => boolean = existsSync,
): boolean {
  return pathExists(gsdDbPath) && !dbAvailable;
}

export async function openProjectDbIfPresent(basePath: string): Promise<void> {
  const gsdDbPath = resolveProjectRootDbPath(basePath);
  if (!existsSync(gsdDbPath) || isDbAvailable()) return;

  const result = openExistingWorkflowDatabase(basePath);
  if (!result.ok && (result.reason === "open-failed" || result.reason === "locked")) {
    logWarning("engine", `gsd-db: failed to open existing database: ${result.error?.message ?? "open failed"}`);
  }
}

class MilestoneMergeObservationMismatchError extends Error {}

export function reconcileMergedMilestonesFromJournal(basePath: string): number {
  if (!isDbAvailable()) return 0;

  try {
    const mergedAtByMilestone = new Map<string, string>();
    for (const entry of queryJournal(basePath, { eventType: "worktree-merged" })) {
      const data = entry.data ?? {};
      const milestoneId = typeof data.milestoneId === "string" ? data.milestoneId : null;
      if (!milestoneId) continue;
      if (data.conflict === true) continue;

      const endedAt = typeof data.endedAt === "string" ? data.endedAt : entry.ts;
      const previous = mergedAtByMilestone.get(milestoneId);
      if (!previous || endedAt > previous) mergedAtByMilestone.set(milestoneId, endedAt);
    }

    const closed = immediateTransaction(() => {
      const preflight = [...mergedAtByMilestone].map(([milestoneId, completedAt]) => ({
        milestoneId,
        completedAt,
        observation: readMilestoneMergeObservation(milestoneId),
      }));
      for (const { milestoneId, observation } of preflight) {
        if (observation.kind === "mismatch") {
          throw new MilestoneMergeObservationMismatchError(
            `Milestone ${milestoneId} canonical and legacy status mismatch ` +
            `(canonical=${observation.canonicalStatus}, legacy=${observation.legacyStatus})`,
          );
        }
      }

      let completed = 0;
      for (const { milestoneId, completedAt, observation } of preflight) {
        if (observation.kind === "completed") continue;
        if (observation.kind === "not-completed") {
          logWarning(
            "bootstrap",
            `Ignoring worktree-merged observation for adopted Milestone ${milestoneId}: ` +
            `canonical lifecycle is ${observation.canonicalStatus}, not completed.`,
          );
          continue;
        }
        const existing = getMilestone(milestoneId);
        if (!existing) {
          insertMilestone({ id: milestoneId, title: milestoneId, status: "complete" });
          updateMilestoneStatus(milestoneId, "complete", completedAt);
          completed++;
          continue;
        }
        if (!isClosedStatus(existing.status)) {
          updateMilestoneStatus(milestoneId, "complete", completedAt);
          completed++;
        }
      }
      return completed;
    });

    if (closed > 0) invalidateAllCaches();
    return closed;
  } catch (err) {
    if (err instanceof MilestoneMergeObservationMismatchError) throw err;
    logWarning(
      "bootstrap",
      `merged-milestone journal reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

/**
 * Audit for orphaned milestone branches at bootstrap.
 *
 * After a milestone completes, the teardown step (merge branch → main,
 * delete branch, remove worktree) runs as a post-completion engine step.
 * If the session ends between completion and teardown, the branch and
 * worktree are orphaned — the DB says "complete" so auto-mode won't
 * re-enter the milestone, and the teardown is never retried.
 *
 * This audit runs on every fresh bootstrap to catch that gap:
 * 1. Lists all local `milestone/*` branches.
 * 2. For each, checks if the milestone's DB status is "complete".
 * 3. If the branch is already merged into main → deletes the branch
 *    and cleans up any orphaned worktree directory (safe, no data loss).
 * 4. If the branch is NOT merged → preserves it and warns the user
 *    so they can merge manually (data safety first).
 *
 * Returns a summary of actions taken for the caller to surface via notify.
 */
/**
 * Decide which survivor-branch recovery action bootstrapAutoSession must
 * run for the current (hasSurvivorBranch, phase) combination. Extracted
 * from the inline chain at `bootstrapAutoSession` (around line 604) so
 * the decision table is testable without constructing a full session.
 *
 * - `none`     — no survivor, or phase doesn't call for recovery. Fall
 *                through to normal bootstrap flow.
 * - `discuss`  — survivor + phase=needs-discussion (#1726). Route to
 *                showSmartEntry.
 * - `finalize` — survivor + phase=complete (#2358). Run mergeAndExit to
 *                merge the milestone branch and clear the worktree.
 *
 * Any other phase with a survivor (pre-planning, planning, executing…)
 * returns `none` — the caller continues its normal flow and the
 * survivor branch participates in whatever auto-mode happens next.
 */
export type SurvivorAction = "none" | "discuss" | "finalize";

export function decideSurvivorAction(
  hasSurvivorBranch: boolean,
  phase: string | null | undefined,
): SurvivorAction {
  if (!hasSurvivorBranch) return "none";
  if (phase === "needs-discussion") return "discuss";
  if (phase === "complete") return "finalize";
  return "none";
}

export function resolveSurvivorRecoveryIsolationMode(
  isolationMode: "worktree" | "branch" | "none",
  phase: string | null | undefined,
): "worktree" | "branch" | "none" {
  if (isolationMode === "none" && phase === "complete") return "branch";
  return isolationMode;
}

export type StrandedWorkRecoveryMode = "worktree" | "branch";

export type OrphanAuditActionKind =
  | "in-progress-stranded-work"
  | "complete-merged-branch"
  | "complete-merged-worktree"
  | "complete-unmerged-branch"
  | "complete-branchless-worktree";

export interface OrphanAuditAction {
  kind: OrphanAuditActionKind;
  milestoneId: string;
  message: string;
  severity: "info" | "warning";
  branch?: string;
  mainBranch?: string;
  commitsAhead?: number;
  dirtyWorktree?: boolean;
  worktreeDirExists?: boolean;
  recoveryMode?: StrandedWorkRecoveryMode;
  blocksAuto: boolean;
}

export interface OrphanAuditResult {
  recovered: string[];
  warnings: string[];
  actions: OrphanAuditAction[];
  blockingStrandedWork: OrphanAuditAction | null;
}

function isBlockingStrandedWorkAction(action: OrphanAuditAction): boolean {
  return action.kind === "in-progress-stranded-work" && action.blocksAuto;
}

function strandedWorkEvidence(args: {
  branch?: string;
  commitsAhead: number;
  mainBranch: string;
  dirtyWorktree: boolean;
}): string[] {
  const evidence: string[] = [];
  if (args.branch && args.commitsAhead > 0) {
    evidence.push(
      `branch ${args.branch} has ${args.commitsAhead} commit(s) ahead of ${args.mainBranch}`,
    );
  }
  if (args.dirtyWorktree) {
    evidence.push("the worktree has uncommitted changes");
  }
  if (evidence.length === 0) {
    evidence.push("physical git evidence exists");
  }
  return evidence;
}

function detectWorktreeEvidence(
  basePath: string,
  milestoneId: string,
  hasChanges: typeof nativeHasChanges,
): { path: string | null; dirExists: boolean; dirty: boolean } {
  const wtDir = getWorktreeDir(basePath, milestoneId);
  const wtPath = getAutoWorktreePath(basePath, milestoneId);
  let dirty = false;
  if (wtPath) {
    try {
      dirty = hasChanges(wtPath);
    } catch {
      dirty = false;
    }
  }
  return {
    path: wtPath,
    dirExists: existsSync(wtDir),
    dirty,
  };
}

function strandedWorkMessage(args: {
  milestoneId: string;
  branch?: string;
  commitsAhead: number;
  mainBranch: string;
  dirtyWorktree: boolean;
  worktreeDirExists: boolean;
  recoveryMode: StrandedWorkRecoveryMode;
}): string {
  const evidence = strandedWorkEvidence(args);

  const wtSuffix = args.worktreeDirExists
    ? ` Worktree directory at .gsd/worktrees/${args.milestoneId}/ holds live work.`
    : "";
  const recovery = args.recoveryMode === "worktree"
    ? "Recovering will adopt the existing worktree."
    : "Recovering will adopt the milestone branch.";

  return (
    `Stranded work for in-progress milestone ${args.milestoneId}: ${evidence.join("; ")}.` +
    wtSuffix +
    ` ${recovery} Park or discard explicitly if abandoning.`
  );
}

function formatStrandedWorkRecoveryMessage(action: OrphanAuditAction): string {
  const recoveryMode = action.recoveryMode === "worktree"
    ? "existing worktree"
    : "milestone branch";
  const evidence = strandedWorkEvidence({
    branch: action.branch,
    commitsAhead: action.commitsAhead ?? 0,
    mainBranch: action.mainBranch ?? "main",
    dirtyWorktree: action.dirtyWorktree ?? false,
  });
  const wtSuffix = action.worktreeDirExists
    ? ` Worktree directory at .gsd/worktrees/${action.milestoneId}/ holds live work.`
    : "";
  return (
    `Resuming saved milestone work for ${action.milestoneId}: ${evidence.join("; ")}.` +
    wtSuffix +
    ` Adopting the ${recoveryMode} before dispatching new units. Park or discard explicitly if abandoning.`
  );
}

function formatStrandedWorkBlockerMessage(
  action: OrphanAuditAction,
  activeMilestoneId: string | null,
): string {
  const target = action.milestoneId;
  const mode = action.recoveryMode === "worktree" ? "existing worktree" : "milestone branch";
  const intro = activeMilestoneId
    ? `Stranded work for ${target} blocks auto-mode before ${activeMilestoneId}.`
    : `Stranded work for ${target} blocks auto-mode, but that milestone is not active in project state.`;

  return [
    intro,
    "Choose one explicit next step:",
    `1. Recover it: run \`/gsd auto ${target}\` to adopt the ${mode}.`,
    `2. Defer it: run \`/gsd park ${target} "reason"\`, then rerun \`/gsd auto\`.`,
    `3. Abandon it: run \`/gsd rethink\` and explicitly discard ${target}.`,
  ].join("\n");
}

export function auditOrphanedMilestoneBranches(
  basePath: string,
  isolationMode: "worktree" | "branch" | "none",
  gitDeps: {
    branchList?: typeof nativeBranchList;
    branchExists?: typeof nativeBranchExists;
    hasChanges?: typeof nativeHasChanges;
  } = {},
): OrphanAuditResult {
  const recovered: string[] = [];
  const warnings: string[] = [];
  const actions: OrphanAuditAction[] = [];
  const branchList = gitDeps.branchList ?? nativeBranchList;
  const branchExists = gitDeps.branchExists ?? nativeBranchExists;
  const hasChanges = gitDeps.hasChanges ?? nativeHasChanges;

  const pushAction = (action: OrphanAuditAction): void => {
    actions.push(action);
    if (action.severity === "info") {
      recovered.push(action.message);
    } else {
      warnings.push(action.message);
    }
  };

  // Skip if DB not available — can't determine completion status
  if (!isDbAvailable()) {
    return { recovered, warnings, actions, blockingStrandedWork: null };
  }

  let milestoneBranches: string[];
  let milestoneBranchListAvailable = true;
  try {
    milestoneBranches = branchList(basePath, "milestone/*");
  } catch {
    milestoneBranchListAvailable = false;
    // git branch list failed — fall through with an empty branch set so the
    // branch-less orphan pass can still run after per-milestone verification.
    milestoneBranches = [];
  }

  // Detect main branch for merge-check
  let mainBranch: string;
  try {
    mainBranch = nativeDetectMainBranch(basePath);
  } catch {
    mainBranch = "main";
  }

  // Get branches already merged into main
  let mergedBranches: Set<string>;
  try {
    mergedBranches = new Set(nativeBranchListMerged(basePath, mainBranch, "milestone/*"));
  } catch {
    mergedBranches = new Set();
  }

  // Detect the branch currently checked out at the project root once — it
  // does not change across loop iterations and is used below to avoid
  // requesting a worktree creation for a branch that git already considers
  // "in use" by the main worktree.
  let currentRootBranch: string | null = null;
  try {
    currentRootBranch = nativeGetCurrentBranch(basePath) || null;
  } catch {
    currentRootBranch = null;
  }

  for (const branch of milestoneBranches) {
    const milestoneId = branch.replace(/^milestone\//, "");
    const milestone = getMilestone(milestoneId);

    if (!milestone) continue;

    const isMerged = mergedBranches.has(branch);
    const worktreeEvidence = detectWorktreeEvidence(basePath, milestoneId, hasChanges);

    // #4762 — in-progress milestone branch with unmerged commits ahead of
    // main. This is the pre-completion orphan case: auto-mode exited without
    // completing the milestone (pause, stop, crash, merge error, blocker) and
    // work is stranded on the branch or in the worktree. Data safety first:
    // we never delete or touch; we just surface a warning so the user knows
    // where to look.
    //
    // Gate on isClosedStatus so we only warn about genuinely open milestones.
    // Parked/other closed statuses go through the legacy complete/unmerged
    // path below where appropriate.
    if (!isClosedStatus(milestone.status)) {
      let commitsAhead = 0;
      try {
        commitsAhead = nativeCommitCountBetween(basePath, mainBranch, branch);
      } catch {
        commitsAhead = 0;
      }
      if ((isMerged || commitsAhead === 0) && !worktreeEvidence.dirty) continue;

      // #812 — the worktree directory being absent on disk does NOT mean the
      // project is branch-mode. getAutoWorktreePath() returns null whenever the
      // directory is merely missing (transient/permanent loss after an
      // interrupted session), which previously collapsed to recoveryMode:
      // "branch" — silently checking out milestone/<id> in the project root with
      // no worktree. When the project is *configured* for worktree isolation,
      // recover as "worktree" so adoptStrandedMilestone re-materializes the
      // worktree from the existing branch (createAutoWorktree with
      // reuseExistingBranch) instead of degrading to branch-mode-in-root.
      //
      // Exception (#812-followup): if the milestone branch is already checked
      // out at the project root (e.g. a leftover from the pre-fix #812 recovery
      // that ran `git checkout milestone/<id>` in the root), git considers that
      // branch "in use by another worktree" and will refuse `git worktree add`,
      // causing bootstrap to abort. Degrade to "branch" in that case — the
      // session resumes on the already-checked-out branch without worktree
      // creation, same as pre-fix behavior, and the configured isolation is
      // restored for subsequent milestones after merge/teardown.
      const isBranchCheckedOutAtRoot = currentRootBranch === branch;
      const recoveryMode: StrandedWorkRecoveryMode =
        worktreeEvidence.path || (isolationMode === "worktree" && !isBranchCheckedOutAtRoot)
          ? "worktree"
          : "branch";
      const message = strandedWorkMessage({
        milestoneId,
        branch,
        commitsAhead,
        mainBranch,
        dirtyWorktree: worktreeEvidence.dirty,
        worktreeDirExists: worktreeEvidence.dirExists,
        recoveryMode,
      });
      pushAction({
        kind: "in-progress-stranded-work",
        milestoneId,
        branch,
        mainBranch,
        commitsAhead,
        dirtyWorktree: worktreeEvidence.dirty,
        worktreeDirExists: worktreeEvidence.dirExists,
        recoveryMode,
        message,
        severity: "warning",
        blocksAuto: true,
      });

      // #4764 telemetry
      try {
        emitWorktreeOrphaned(basePath, milestoneId, {
          reason: "in-progress-unmerged",
          commitsAhead,
          worktreeDirExists: worktreeEvidence.dirExists,
        });
      } catch (err) {
        logWarning("engine", `worktree-orphaned telemetry failed for ${milestoneId}: ${err instanceof Error ? err.message : String(err)}`);
      }

      continue;
    }

    // Only the "complete" status participates in the merged/unmerged cleanup
    // paths below — other closed statuses (parked, etc.) are intentionally
    // left alone.
    if (milestone.status !== "complete") continue;

    if (isMerged) {
      // Branch is merged — safe to delete branch and clean up worktree dir
      try {
        nativeBranchDelete(basePath, branch, true);
        pushAction({
          kind: "complete-merged-branch",
          milestoneId,
          branch,
          message: `Deleted merged branch ${branch} for completed milestone ${milestoneId}.`,
          severity: "info",
          blocksAuto: false,
        });
      } catch (err) {
        warnings.push(`Failed to delete merged branch ${branch}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Clean up orphaned worktree directory if it exists
      const wtDir = getWorktreeDir(basePath, milestoneId);
      if (existsSync(wtDir)) {
        // Try git worktree remove first (handles registered worktrees)
        try {
          nativeWorktreeRemove(basePath, wtDir, true);
        } catch (e) {
          // Not a registered worktree — expected for orphaned dirs
          logWarning("engine", `worktree remove failed (expected for orphaned dirs): ${e instanceof Error ? e.message : String(e)}`);
        }

        // If the directory still exists after git worktree remove (either it
        // wasn't registered or the remove was a noop), fall back to direct
        // filesystem removal — but only inside .gsd/worktrees/ for safety (#2365).
        if (existsSync(wtDir)) {
          if (isInsideWorktreesDir(basePath, wtDir)) {
            try {
              rmSync(wtDir, { recursive: true, force: true });
              pushAction({
                kind: "complete-merged-worktree",
                milestoneId,
                branch,
                worktreeDirExists: true,
                message: `Removed orphaned worktree directory for ${milestoneId}.`,
                severity: "info",
                blocksAuto: false,
              });
            } catch (err2) {
              warnings.push(`Failed to remove worktree directory for ${milestoneId}: ${err2 instanceof Error ? err2.message : String(err2)}`);
            }
          } else {
            warnings.push(`Orphaned worktree directory for ${milestoneId} is outside the GSD worktrees containers — skipping removal for safety.`);
          }
        } else {
          pushAction({
            kind: "complete-merged-worktree",
            milestoneId,
            branch,
            worktreeDirExists: true,
            message: `Removed orphaned worktree directory for ${milestoneId}.`,
            severity: "info",
            blocksAuto: false,
          });
        }
      }
    } else {
      // Branch is NOT merged — preserve for safety, warn the user
      pushAction({
        kind: "complete-unmerged-branch",
        milestoneId,
        branch,
        worktreeDirExists: worktreeEvidence.dirExists,
        message:
          `Branch ${branch} exists for completed milestone ${milestoneId} but is NOT merged into ${mainBranch}. ` +
          `This may contain unmerged work. Merge manually or run \`/gsd doctor fix\` to resolve.`,
        severity: "warning",
        blocksAuto: false,
      });

      // #4764 telemetry
      try {
        emitWorktreeOrphaned(basePath, milestoneId, {
          reason: "complete-unmerged",
          worktreeDirExists: existsSync(getWorktreeDir(basePath, milestoneId)),
        });
      } catch (err) {
        logWarning("engine", `worktree-orphaned telemetry failed for ${milestoneId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Second pass (#5879): catch worktree directories stranded by a previous
  // audit that deleted the milestone/* branch but failed to remove the
  // directory (or the dir was orphaned by a separate path entirely, e.g.
  // postflight-stash-restore-failed during closeout). The branch-keyed loop
  // above is invisible to these cases — `nativeBranchList` returns nothing
  // for the milestone, so the dir-cleanup block at line ~310 is never
  // reached.
  //
  // Keyed on milestones whose DB status is `complete`. We do not iterate
  // over arbitrary directories under .gsd/worktrees/ to avoid touching
  // dirs that belong to an in-progress milestone whose branch was deleted
  // separately — those are handled by the in-progress orphan path above
  // when the branch is present, and by `/gsd doctor` when it is not.
  const seenMilestoneIds = new Set(
    milestoneBranches.map((branch) => branch.replace(/^milestone\//, "")),
  );
  let completedMilestones: readonly { id: string; status: string }[] = [];
  try {
    completedMilestones = getAllMilestones();
  } catch {
    // DB read failure — skip the second pass; the first pass is still useful.
    completedMilestones = [];
  }
  for (const m of completedMilestones) {
    if (!isClosedStatus(m.status)) {
      if (seenMilestoneIds.has(m.id)) continue;
      const worktreeEvidence = detectWorktreeEvidence(basePath, m.id, hasChanges);
      if (!worktreeEvidence.dirty) continue;
      const message = strandedWorkMessage({
        milestoneId: m.id,
        commitsAhead: 0,
        mainBranch,
        dirtyWorktree: true,
        worktreeDirExists: worktreeEvidence.dirExists,
        recoveryMode: "worktree",
      });
      pushAction({
        kind: "in-progress-stranded-work",
        milestoneId: m.id,
        mainBranch,
        commitsAhead: 0,
        dirtyWorktree: true,
        worktreeDirExists: worktreeEvidence.dirExists,
        recoveryMode: "worktree",
        message,
        severity: "warning",
        blocksAuto: true,
      });
      try {
        emitWorktreeOrphaned(basePath, m.id, {
          reason: "in-progress-unmerged",
          commitsAhead: 0,
          worktreeDirExists: worktreeEvidence.dirExists,
        });
      } catch (err) {
        logWarning("engine", `worktree-orphaned telemetry failed for ${m.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    if (m.status !== "complete") continue;
    if (seenMilestoneIds.has(m.id)) continue; // already processed in the branch loop
    if (!milestoneBranchListAvailable) {
      try {
        if (branchExists(basePath, `milestone/${m.id}`)) continue;
      } catch (err) {
        warnings.push(
          `Could not verify whether milestone/${m.id} still exists; skipping branch-less worktree cleanup for safety: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }
    const wtDir = getWorktreeDir(basePath, m.id);
    if (!existsSync(wtDir)) continue;
    if (!isInsideWorktreesDir(basePath, wtDir)) {
      warnings.push(
        `Orphaned worktree directory for ${m.id} is outside the GSD worktrees containers — skipping removal for safety.`,
      );
      continue;
    }
    // Try `git worktree remove` first in case the dir is still registered
    // (defensive — usually it is not when we reach this branch-less pass).
    try {
      nativeWorktreeRemove(basePath, wtDir, true);
    } catch (e) {
      logWarning(
        "engine",
        `worktree remove failed (expected for branch-less orphans): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (existsSync(wtDir)) {
      try {
        rmSync(wtDir, { recursive: true, force: true });
        pushAction({
          kind: "complete-branchless-worktree",
          milestoneId: m.id,
          worktreeDirExists: true,
          message: `Removed orphaned worktree directory for ${m.id} (branch already deleted).`,
          severity: "info",
          blocksAuto: false,
        });
      } catch (err) {
        warnings.push(
          `Failed to remove orphaned worktree directory for ${m.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      pushAction({
        kind: "complete-branchless-worktree",
        milestoneId: m.id,
        worktreeDirExists: true,
        message: `Removed orphaned worktree directory for ${m.id} (branch already deleted).`,
        severity: "info",
        blocksAuto: false,
      });
    }
  }

  return {
    recovered,
    warnings,
    actions,
    blockingStrandedWork: actions.find(isBlockingStrandedWorkAction) ?? null,
  };
}

/**
 * Pure decision function for picking which orphan milestone the auto-loop
 * should resume the merge transition for. Extracted so it can be unit-tested
 * without spinning up a git repo or a SQLite DB.
 *
 * Returns the lexicographically-greatest milestone id (e.g. "M002" beats
 * "M001") whose branch is unmerged AND has commits ahead of main AND whose
 * status is `complete`. Lex-ordering matches the project's M00x convention,
 * which is the most-recently-completed milestone in practice.
 * `isComplete` errors propagate; `commitsAhead` errors are treated as 0.
 */
export function _selectResumableMilestone(
  branchNames: readonly string[],
  mergedBranches: ReadonlySet<string>,
  isComplete: (milestoneId: string) => boolean,
  commitsAhead: (branch: string) => number,
): string | null {
  const candidates: string[] = [];
  for (const branch of branchNames) {
    if (!branch.startsWith("milestone/")) continue;
    const milestoneId = branch.slice("milestone/".length);
    if (mergedBranches.has(branch)) continue;
    if (!isComplete(milestoneId)) continue;
    let ahead = 0;
    try {
      ahead = commitsAhead(branch);
    } catch {
      continue;
    }
    if (ahead <= 0) continue;
    candidates.push(milestoneId);
  }
  if (candidates.length === 0) return null;
  candidates.sort();
  return candidates[candidates.length - 1];
}

/**
 * Find the most-recent completed milestone whose branch still has unmerged
 * commits ahead of the integration branch. Used by `bootstrapAutoSession`
 * to seed `s.currentMilestoneId` so the auto-loop's transition guard at
 * `phases.ts:730` fires on the first iteration after a process restart —
 * without this, the in-memory-only `s.currentMilestoneId` is `null` after
 * restart, the guard short-circuits, and the orphaned milestone branch
 * never gets merged into main (#5538-followup).
 *
 * Returns null when isolation is `none`, the DB is unavailable, or no
 * orphan candidate exists. All git failures degrade silently — startup
 * must never block on this defensive lookup.
 */
export function findUnmergedCompletedMilestone(
  basePath: string,
  isolationMode: "worktree" | "branch" | "none",
): string | null {
  if (isolationMode === "none") return null;

  let milestoneBranches: string[];
  try {
    milestoneBranches = nativeBranchList(basePath, "milestone/*");
  } catch {
    return null;
  }
  if (milestoneBranches.length === 0) return null;

  let mainBranch: string;
  try {
    mainBranch = nativeDetectMainBranch(basePath);
  } catch {
    mainBranch = "main";
  }

  let mergedBranches: Set<string>;
  try {
    mergedBranches = new Set(
      nativeBranchListMerged(basePath, mainBranch, "milestone/*"),
    );
  } catch {
    mergedBranches = new Set();
  }

  return _selectResumableMilestone(
    milestoneBranches,
    mergedBranches,
    (milestoneId) => {
      if (isDbAvailable()) {
        const row = getMilestone(milestoneId);
        if (row) return row.status === "complete";
      }
      return isCompletedMilestoneOnDisk(basePath, milestoneId);
    },
    (branch) => nativeCommitCountBetween(basePath, mainBranch, branch),
  );
}

function isCompletedMilestoneOnDisk(basePath: string, milestoneId: string): boolean {
  const summaryPath = resolveMilestoneFile(basePath, milestoneId, "SUMMARY");
  const validationPath = resolveMilestoneFile(basePath, milestoneId, "VALIDATION");
  if (!summaryPath || !validationPath) return false;

  try {
    const summary = readFileSync(summaryPath, "utf-8");
    if (classifyMilestoneSummaryContent(summary) === "failure") return false;
    const validation = readFileSync(validationPath, "utf-8");
    return extractVerdict(validation) != null;
  } catch {
    return false;
  }
}

/**
 * Run `mergeAndExit` for a milestone whose worktree/branch finalization
 * never completed in a prior session — the active-milestone in phase
 * `complete` with a survivor `milestone/<id>` branch still around.
 *
 * Wraps the call in try/catch so a thrown error from `_mergeBranchMode`
 * (made fail-loud in commit 68ef58a3c) is converted into a user-facing
 * error notify instead of an unhandled exception that propagates through
 * `bootstrapAutoSession` to the slash-command caller's `.catch` block.
 *
 * Returns `{ merged: true }` on success; `{ merged: false, error }` on
 * throw — caller decides whether to abort bootstrap.
 */
export function _finalizeSurvivorBranch(
  lifecycle: WorktreeLifecycle,
  milestoneId: string,
  ui: { notify: (msg: string, level?: "info" | "warning" | "error" | "success") => void },
): { merged: boolean; error?: unknown } {
  ui.notify(
    `Milestone ${milestoneId} is complete but branch/worktree was not finalized. Running merge now.`,
    "info",
  );
  const result = lifecycle.exitMilestone(
    milestoneId,
    { merge: true },
    { notify: ui.notify.bind(ui) },
  );
  if (result.ok) return { merged: true };
  const err = result.cause instanceof Error ? result.cause : new Error(String(result.cause));
  const msg = err.message;
  ui.notify(
    `Survivor-branch finalization for ${milestoneId} failed: ${msg}. Resolve manually and re-run /gsd auto.`,
    "error",
  );
  return { merged: false, error: err };
}

/**
 * Merge a milestone whose DB row is `complete` but whose branch is still
 * unmerged into the integration branch. Called from `bootstrapAutoSession`
 * for orphans surfaced by `findUnmergedCompletedMilestone`.
 *
 * Notifies the user before and after, swallowing errors so a transient git
 * failure never blocks bootstrap. Returns `{ merged: true }` when the
 * underlying `mergeAndExit` completes; `{ merged: false, error }` on throw.
 *
 * Extracted to keep `bootstrapAutoSession` testable: the merge call and the
 * notify shape are exercised against a mock resolver in
 * `tests/orphan-merge-bootstrap.test.ts`.
 */
export function _mergeOrphanCompletedMilestone(
  lifecycle: WorktreeLifecycle,
  orphanId: string,
  ui: { notify: (msg: string, level?: "info" | "warning" | "error" | "success") => void },
): { merged: boolean; error?: unknown } {
  ui.notify(`Detected unmerged completed milestone ${orphanId}. Merging now.`, "info");
  const result = lifecycle.exitMilestone(
    orphanId,
    { merge: true },
    { notify: ui.notify.bind(ui) },
  );
  if (result.ok) return { merged: true };
  const err = result.cause instanceof Error ? result.cause : new Error(String(result.cause));
  const msg = err.message;
  ui.notify(
    `Could not merge orphan milestone ${orphanId}: ${msg}. Resolve manually and re-run /gsd auto.`,
    "warning",
  );
  return { merged: false, error: err };
}

export async function bootstrapAutoSession(
  s: AutoSession,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  base: string,
  verboseMode: boolean,
  requestedStepMode: boolean,
  deps: BootstrapDeps,
  interrupted: InterruptedSessionAssessment,
): Promise<boolean> {
  prepareIsolationForNewRun(s);

  const {
    shouldUseWorktreeIsolation,
    registerSigtermHandler,
    registerAutoWorkerForSession,
    lockBase,
    buildLifecycle,
  } = deps;

  const dirCheck = validateDirectory(base);
  if (dirCheck.severity === "blocked") {
    ctx.ui.notify(dirCheck.reason!, "error");
    return false;
  }

  const startupLock = readCrashLock(base);
  if (startupLock && !isLockProcessAlive(startupLock)) {
    clearLock(base);
    ctx.ui.notify("Cleared stale auto-mode worker state.", "info");
  }

  const lockResult = acquireSessionLock(base);
  if (!lockResult.acquired) {
    ctx.ui.notify(lockResult.reason, "error");
    return false;
  }

  const ownsSessionLockAcquisition = lockResult.reentrant !== true;

  function releaseLockAcquisition(): void {
    if (!ownsSessionLockAcquisition) return;
    releaseSessionLock(base);
    clearLock(base);
  }

  function releaseLockAndReturn(): false {
    releaseLockAcquisition();
    return false;
  }

  // Capture the user's session model before guided-flow dispatch can apply a
  // phase-specific planning model for a discuss turn (#2829).
  //
  // Precedence:
  // 1) Explicit session override via /gsd model or /gsd auto --model (this session)
  // 2) GSD model preferences from PREFERENCES.md (validated against live auth)
  // 3) Current session model from settings/session restore (if provider ready)
  //
  // PREFERENCES.md wins over the ambient session default (#3517) so /gsd auto
  // does not stick on claude-code/claude-sonnet-4-6 when the user configured
  // models via /gsd workflow-preferences or PREFERENCES.md. Custom providers
  // still skip PREFERENCES.md entirely (#4122).
  //
  // Exception (#4122): when the session provider is a custom provider declared
  // in ~/.gsd/agent/models.json (Ollama, vLLM, OpenAI-compatible proxy, etc.),
  // PREFERENCES.md is skipped entirely. PREFERENCES.md cannot reference custom
  // providers, so honoring it would silently reroute auto-mode to a built-in
  // provider the user is not logged into and surface as "Not logged in · Please
  // run /login" before pausing and resetting to claude-code/claude-sonnet-4-6.
  const manualSessionOverride = getSessionModelOverride(ctx.sessionManager.getSessionId());
  const sessionProviderIsCustom = isCustomProvider(ctx.model?.provider, ctx.modelRegistry);
  const profileModelIds = modelIdsForProfileResolution(
    ctx.modelRegistry,
    resolveProfileAnchorProvider(ctx.model?.provider),
    resolveDisabledModelProvidersFromPreferences(),
  );
  const preferredModel = sessionProviderIsCustom
    ? null
    : resolveDefaultSessionModel(ctx.model?.provider, base, profileModelIds, ctx.model?.id);
  // Validate the preferred model against the live registry + provider auth so
  // an unconfigured PREFERENCES.md entry (no API key / OAuth) can't become the
  // start-model snapshot. Without this, every subsequent unit would try to
  // fall back to an unusable model.
  let validatedPreferredModel: { provider: string; id: string } | undefined;
  if (preferredModel) {
    const { resolveModelId } = await import("./auto-model-selection.js");
    const available = ctx.modelRegistry.getAvailable();
    const match = resolveModelId(
      `${preferredModel.provider}/${preferredModel.id}`,
      available,
      ctx.model?.provider,
    );
    if (match) {
      validatedPreferredModel = { provider: match.provider, id: match.id };
    } else {
      const providerLower = preferredModel.provider.toLowerCase();
      const isCopilotProvider = providerLower === "github-copilot" || providerLower === "copilot";
      const preferredIdLower = preferredModel.id.toLowerCase();

      if (isCopilotProvider && preferredIdLower === "claude-sonnet-5") {
        const copilotSonnetFallback = available.find((candidate) => {
          const candidateProvider = candidate.provider.toLowerCase();
          if (candidateProvider !== "github-copilot" && candidateProvider !== "copilot") return false;
          return ["claude-sonnet-4.6", "claude-sonnet-4.5", "claude-sonnet-4"].includes(candidate.id.toLowerCase());
        });

        if (copilotSonnetFallback) {
          validatedPreferredModel = {
            provider: copilotSonnetFallback.provider,
            id: copilotSonnetFallback.id,
          };
          ctx.ui.notify(
            `Preferred model ${preferredModel.provider}/${preferredModel.id} is not currently exposed by Copilot; using ${copilotSonnetFallback.provider}/${copilotSonnetFallback.id} for this session.`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `Preferred model ${preferredModel.provider}/${preferredModel.id} from PREFERENCES.md is not configured; falling back to session default.`,
            "warning",
          );
        }
      } else {
        ctx.ui.notify(
          `Preferred model ${preferredModel.provider}/${preferredModel.id} from PREFERENCES.md is not configured; falling back to session default.`,
          "warning",
        );
      }
    }
  }
  const sessionModelReady =
    ctx.model && ctx.modelRegistry.isProviderRequestReady(ctx.model.provider);
  const currentSessionModel = (sessionModelReady && ctx.model)
    ? { provider: ctx.model.provider, id: ctx.model.id }
    : null;
  const startThinkingSnapshot = pi.getThinkingLevel();
  const startModelSnapshot = manualSessionOverride
    ?? validatedPreferredModel
    ?? currentSessionModel
    ?? null;

  try {
    // Validate GSD_PROJECT_ID early so the user gets immediate feedback
    const customProjectId = process.env.GSD_PROJECT_ID;
    if (customProjectId && !validateProjectId(customProjectId)) {
      ctx.ui.notify(
        `GSD_PROJECT_ID must contain only alphanumeric characters, hyphens, and underscores. Got: "${customProjectId}"`,
        "error",
      );
      return releaseLockAndReturn();
    }

    const gitLockFile = join(base, ".git", "index.lock");
    if (existsSync(gitLockFile)) {
      ctx.ui.notify(
        "Git index lock is present at .git/index.lock. Another git process may be running; resolve the lock before starting GSD.",
        "error",
      );
      debugLog("git-index-lock-present-preflight", { path: gitLockFile });
      return releaseLockAndReturn();
    }

    // Ensure git repo exists *locally* at base.
    // nativeIsRepo() uses `git rev-parse` which traverses up to parent dirs,
    // so a parent repo can make it return true even when base has no .git of
    // its own. Check for a local .git instead (defense-in-depth for the case
    // where isInheritedRepo() returns a false negative, e.g. stale .gsd at
    // the parent git root). See #2393 and related issue.
    const hasLocalGit = existsSync(join(base, ".git"));
    if (!hasLocalGit || isInheritedRepo(base)) {
      const mainBranch =
        loadEffectiveGSDPreferences(base)?.preferences?.git?.main_branch || "main";
      nativeInit(base, mainBranch);
    }

    // Migrate legacy in-project .gsd/ to external state directory.
    // Migration MUST run before ensureGitignore to avoid adding ".gsd" to
    // .gitignore when .gsd/ is git-tracked (data-loss bug #1364).
    recoverFailedMigration(base);
    // startAuto's interrupted-session assessment may already have opened the
    // database. Retire every handle before migration moves the containing
    // directory so the WAL is checkpointed and no cached adapter remains
    // bound to the pre-migration inode.
    closeAllWorkflowDatabases();
    const migration = migrateToExternalState(base);
    if (migration.error) {
      const isAuthoritativeStateGuard = migration.error.includes(
        "External state already exists for this project",
      );
      const severity = isAuthoritativeStateGuard ? "info" : "warning";
      ctx.ui.notify(`External state migration warning: ${migration.error}`, severity);
    }
    // Ensure symlink exists (handles fresh projects and post-migration)
    ensureGsdSymlink(base);

    // Acquisition starts before migration so bootstrap is serialized. Once
    // .gsd points at external state, hand ownership to that physical target
    // before any later process can observe or contend on the new path.
    const migratedLockResult = acquireSessionLock(base);
    if (!migratedLockResult.acquired) {
      ctx.ui.notify(migratedLockResult.reason, "error");
      return releaseLockAndReturn();
    }

    openWorkflowDatabase(base);

    // Ensure .gitignore has baseline patterns.
    // ensureGitignore checks for git-tracked .gsd/ files and skips the
    // ".gsd" pattern if the project intentionally tracks .gsd/ in git.
    const gitPrefs = loadEffectiveGSDPreferences(base)?.preferences?.git;
    const manageGitignore = gitPrefs?.manage_gitignore;
    ensureGitignore(base, { manageGitignore });
    if (manageGitignore !== false) untrackRuntimeFiles(base);

    // Bootstrap the flat-phase projection root and clean empty legacy scaffolds.
    if (reconcileFlatPhaseBootstrapLayout(base)) {
      try {
        nativeAddAll(base);
        nativeCommit(base, "chore: init gsd");
      } catch (err) {
        /* nothing to commit */
        logWarning("engine", `layout bootstrap commit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    {
      const { prepareWorkflowMcpForProject } = await import("./workflow-mcp-auto-prep.js");
      prepareWorkflowMcpForProject(ctx, base);
    }

    // Initialize GitServiceImpl
    s.gitService = new GitServiceImpl(
      s.basePath,
      loadEffectiveGSDPreferences(base)?.preferences?.git ?? {},
    );

    // ── Debug mode ──
    if (!isDebugEnabled() && process.env.GSD_DEBUG === "1") {
      enableDebug(base);
    }
    if (isDebugEnabled()) {
      const { isNativeParserAvailable } =
        await import("./native-parser-bridge.js");
      debugLog("debug-start", {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        model: ctx.model?.id ?? "unknown",
        provider: ctx.model?.provider ?? "unknown",
        nativeParser: isNativeParserAvailable(),
        cwd: base,
      });
      ctx.ui.notify(`Debug logging enabled → ${getDebugLogPath()}`, "info");
    }

    if (interrupted.classification !== "recoverable") {
      s.pendingCrashRecovery = null;
    }

    // Invalidate caches before initial state derivation
    invalidateAllCaches();

    // Open the project-root DB before deriveState so DB-backed state
    // derivation (queue-order, task status) works on a cold start (#2841).
    // Must happen before cleanStaleRuntimeUnits so the cleanup predicate can
    // consult DB status and avoid clearing runtime units for milestones that
    // only have a failure-path SUMMARY on disk (#4663).
    await openProjectDbIfPresent(base);
    registerAutoWorkerForSession(base);
    // Clean stale runtime unit files for completed milestones (#887).
    // DB-authoritative: when DB is available, require DB status to be closed
    // before clearing runtime units. A SUMMARY file alone is no longer
    // trusted as proof of completion (#4663). Fall back to SUMMARY-file
    // presence only when DB is unavailable (legacy/pre-migration).
    cleanStaleRuntimeUnits(
      gsdRoot(base),
      (mid) => {
        if (isDbAvailable()) {
          const row = getMilestone(mid);
          return !!row && isClosedStatus(row.status);
        }
        const summaryFile = resolveMilestoneFile(base, mid, "SUMMARY");
        if (!summaryFile) return false;
        try {
          return classifyMilestoneSummaryContent(readFileSync(summaryFile, "utf-8")) !== "failure";
        } catch {
          return false;
        }
      },
    );

    // ── Orphaned milestone branch audit ──
    // Catches completed milestones whose teardown (merge + branch delete)
    // was lost due to session ending between completion and teardown.
    // Must run after DB open and before worktree entry.
    let orphanAuditRecovered = false;
    let strandedRecoveryActions: OrphanAuditAction[] = [];
    let strandedRecoveryAction: OrphanAuditAction | null = null;
    try {
      const auditResult = auditOrphanedMilestoneBranches(base, getIsolationMode(base));
      strandedRecoveryActions = auditResult.actions.filter(isBlockingStrandedWorkAction);
      strandedRecoveryAction = strandedRecoveryActions[0] ?? null;
      for (const msg of auditResult.recovered) {
        ctx.ui.notify(`Orphan audit: ${msg}`, "info");
      }
      const deferredStrandedMessages = new Set(
        auditResult.actions
          .filter(isBlockingStrandedWorkAction)
          .map((action) => action.message),
      );
      for (const msg of auditResult.warnings) {
        if (deferredStrandedMessages.has(msg)) continue;
        const prefix = msg.startsWith("Stranded work") ? "" : "Orphan audit: ";
        ctx.ui.notify(`${prefix}${msg}`, "warning");
      }
      if (auditResult.recovered.length > 0) {
        orphanAuditRecovered = true;
        debugLog("orphan-audit", {
          recovered: auditResult.recovered,
          warnings: auditResult.warnings,
          strandedRecoveryAction,
          strandedRecoveryActions,
        });
      }
    } catch (err) {
      // Non-fatal — the audit is defensive, never block bootstrap
      logWarning("bootstrap", `orphaned milestone branch audit failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Orphaned preflight-stash audit (#5538-followup) ──
    // Reapplies pre-merge stashes whose milestone is now complete but whose
    // postflight pop was skipped by an interrupted merge in a prior session.
    // Uses `git stash apply` (not pop) so the entry remains as a backup.
    try {
      if (isDbAvailable()) {
        const stashAudit = auditOrphanedPreflightStashes(base, (milestoneId) => {
          const row = getMilestone(milestoneId);
          return !!row && isClosedStatus(row.status);
        });
        for (const entry of stashAudit.applied) {
          ctx.ui.notify(
            `Orphan audit: applied preflight stash ${entry.stashRef} for completed milestone ${entry.milestoneId}. The stash entry is preserved as a backup.`,
            "info",
          );
        }
        for (const msg of stashAudit.warnings) {
          ctx.ui.notify(`Orphan audit: ${msg}`, "warning");
        }
        if (stashAudit.applied.length > 0) {
          debugLog("orphan-stash-audit", {
            applied: stashAudit.applied,
            warnings: stashAudit.warnings,
          });
        }
      }
    } catch (err) {
      logWarning(
        "bootstrap",
        `orphaned preflight-stash audit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let state = await deriveState(base);

    // Stale worktree state recovery (#654)
    if (
      state.activeMilestone &&
      shouldUseWorktreeIsolation(base) &&
      !detectWorktreeName(base)
    ) {
      const wtPath = getAutoWorktreePath(base, state.activeMilestone.id);
      if (wtPath) {
        state = await deriveState(wtPath);
      }
    }

    const requestedMilestoneLock = process.env.GSD_MILESTONE_LOCK?.trim() || null;
    const lockedActiveMilestone =
      requestedMilestoneLock && state.activeMilestone?.id === requestedMilestoneLock;
    let blockingStrandedRecoveryAction: OrphanAuditAction | null;
    if (lockedActiveMilestone) {
      // Parallel worker or explicit `/gsd auto Mxxx`: sibling milestones'
      // stranded work must not block this milestone's resumption, and the
      // downstream `strandedRecoveryAction` (used for currentMilestoneId,
      // setActiveMilestoneId, and adoptStrandedMilestone) must be scoped to
      // the locked milestone only. Falling back to the first sibling action
      // would mis-target adoption (#742).
      const lockMatch = strandedRecoveryActions.find(
        (action) => action.milestoneId === requestedMilestoneLock,
      ) ?? null;
      blockingStrandedRecoveryAction = lockMatch;
      strandedRecoveryAction = lockMatch;
    } else if (state.activeMilestone) {
      blockingStrandedRecoveryAction = strandedRecoveryActions.find(
        (action) => action.milestoneId !== state.activeMilestone?.id,
      ) ?? strandedRecoveryAction;
    } else {
      blockingStrandedRecoveryAction = strandedRecoveryAction;
    }

    if (blockingStrandedRecoveryAction) {
      if (!state.activeMilestone) {
        ctx.ui.notify(
          formatStrandedWorkBlockerMessage(blockingStrandedRecoveryAction, null),
          "error",
        );
        return releaseLockAndReturn();
      }
      if (state.activeMilestone.id !== blockingStrandedRecoveryAction.milestoneId) {
        ctx.ui.notify(
          formatStrandedWorkBlockerMessage(blockingStrandedRecoveryAction, state.activeMilestone.id),
          "error",
        );
        return releaseLockAndReturn();
      }
      strandedRecoveryAction = blockingStrandedRecoveryAction;
      ctx.ui.notify(
        formatStrandedWorkRecoveryMessage(strandedRecoveryAction),
        "info",
      );
    } else if (lockedActiveMilestone) {
      strandedRecoveryAction = null;
    }

    if (
      process.env.GSD_HEADLESS === "1" &&
      orphanAuditRecovered &&
      !state.activeMilestone &&
      state.phase === "complete"
    ) {
      ctx.ui.notify(
        "Auto-mode stopped (Recovered completed milestone cleanup; all milestones complete).",
        "info",
      );
      return releaseLockAndReturn();
    }

    // Milestone branch recovery (#601, #2358)
    // Detect survivor milestone branches in both pre-planning and complete phases.
    // In phase=complete, the milestone artifacts exist but finalization (merge,
    // worktree cleanup) was never run — the survivor branch must be merged.
    // Applies to both worktree and branch isolation modes.
    let hasSurvivorBranch = false;
    let survivorMilestoneId = state.activeMilestone?.id ?? null;
    const configuredIsolationMode = getIsolationMode(base);
    const survivorIsolationMode = resolveSurvivorRecoveryIsolationMode(configuredIsolationMode, state.phase);
    if (!survivorMilestoneId && state.phase === "complete") {
      survivorMilestoneId = findUnmergedCompletedMilestone(base, survivorIsolationMode);
    }
    if (
      survivorMilestoneId &&
      (state.phase === "pre-planning" || state.phase === "complete") &&
      survivorIsolationMode !== "none" &&
      !detectWorktreeName(base) &&
      !isGsdWorktreePath(base)
    ) {
      const milestoneBranch = `milestone/${survivorMilestoneId}`;
      const { nativeBranchExists } = await import("./native-git-bridge.js");
      hasSurvivorBranch = nativeBranchExists(base, milestoneBranch);
      if (hasSurvivorBranch) {
        ctx.ui.notify(
          `Found prior session branch ${milestoneBranch}. Resuming.`,
          "info",
        );
      }
    }

    // Survivor branch exists but milestone still needs discussion (#1726):
    // The worktree/branch was created but the milestone only has CONTEXT-DRAFT.md.
    // Route to the interactive discussion handler instead of falling through to
    // auto-mode, which would immediately stop with "needs discussion".
    if (
      !strandedRecoveryAction &&
      decideSurvivorAction(hasSurvivorBranch, state.phase) === "discuss"
    ) {
      const { showSmartEntry } = await import("./guided-flow.js");
      await showSmartEntry(ctx, pi, base, { step: requestedStepMode });

      invalidateAllCaches();
      const postState = await deriveState(base);
      if (
        postState.activeMilestone &&
        postState.phase !== "needs-discussion"
      ) {
        state = postState;
        // Discussion succeeded — clear survivor flag so normal flow continues
        hasSurvivorBranch = false;
      } else {
        ctx.ui.notify(
          "Discussion completed but milestone draft was not promoted. Run /gsd to try again.",
          "warning",
        );
        return releaseLockAndReturn();
      }
    }

    // Survivor branch exists and milestone is complete (#2358):
    // The milestone artifacts were written but finalization (merge, worktree
    // cleanup) never ran. Run mergeAndExit to finalize, then re-derive state
    // so the normal "all milestones complete" or "next milestone" path runs.
    // Re-evaluate via the helper — the discuss branch above may have cleared
    // hasSurvivorBranch after a successful promotion.
    if (decideSurvivorAction(hasSurvivorBranch, state.phase) === "finalize") {
      const mid = survivorMilestoneId!;
      const lifecycle = buildLifecycle();
      lifecycle.adoptSessionRoot(base);
      // Commit 68ef58a3c made `_mergeBranchMode` throw on wrong-branch
      // instead of returning false silently. Wrap the call so the throw is
      // converted into an error notify + clean bootstrap abort, not an
      // unhandled exception propagating to the slash-command caller (#5549
      // post-merge audit, R2).
      const finalize = _finalizeSurvivorBranch(lifecycle, mid, ctx.ui);
      if (!finalize.merged) {
        return releaseLockAndReturn();
      }
      invalidateAllCaches();
      state = await deriveState(base);
      // Clear survivor flag — finalization is done
      hasSurvivorBranch = false;
    }

    // ── Orphan-completed-milestone merge (#5538-followup) ──
    // A process killed between `complete-milestone` (DB flip + SUMMARY write)
    // and the loop's transition-guard merge strands the milestone branch
    // forever: `s.currentMilestoneId` is in-memory only, so on the next
    // bootstrap the guard at phases.ts:730 sees `mid === s.currentMilestoneId`
    // and short-circuits.
    //
    // The earlier attempt at this fix seeded `s.currentMilestoneId` to the
    // orphan id pre-state-derivation, but the unconditional assignment at
    // line 948 (`s.currentMilestoneId = state.activeMilestone?.id ?? null`)
    // immediately overwrote the seed. Active-merge is the more durable fix:
    // call `mergeAndExit` directly during bootstrap, then re-derive state so
    // the loop's normal flow continues without an in-memory hint.
    //
    // Mirrors the survivor-finalize block above. Failures degrade to a
    // warning notify so a transient git error doesn't block bootstrap.
    {
      const orphan = findUnmergedCompletedMilestone(base, survivorIsolationMode);
      if (orphan && orphan !== state.activeMilestone?.id) {
        // ADR-016 phase 2 / B4 (#5622): the swap-run-revert protocol for
        // the orphan-merge dance is owned by `adoptOrphanWorktree`. The
        // verb snapshots prior `s.basePath` / `s.originalBasePath`, swaps
        // into the orphan worktree, runs the merge callback under the
        // swap, and reverts (or holds the swap) based on the result.
        // Callers can no longer forget the revert step on failure — the
        // pattern that originally motivated this verb.
        const lifecycle = buildLifecycle();
        const result = lifecycle.adoptOrphanWorktree(orphan, base, () =>
          _mergeOrphanCompletedMilestone(lifecycle, orphan, ctx.ui),
        );
        if (!result.merged) {
          // Verb already restored basePath/originalBasePath to `base` and
          // chdir'd there. Return early.
          return releaseLockAndReturn();
        }
        invalidateAllCaches();
        state = await deriveState(base);
      }
    }

    const effectivePrefs = loadEffectiveGSDPreferencesWithRegistry(
      ctx.modelRegistry,
      base,
      resolveProfileAnchorProvider(ctx.model?.provider, startModelSnapshot?.provider),
      startModelSnapshot ? `${startModelSnapshot.provider}/${startModelSnapshot.id}` : undefined,
    )?.preferences;
    const { shouldRunDeepProjectSetup } = await import("./auto-dispatch.js");
    const deepProjectStagePending = shouldRunDeepProjectSetup(
      state,
      effectivePrefs,
      base,
      { hasSurvivorBranch },
    );

    if (deepProjectStagePending && !strandedRecoveryAction) {
      // Deep project-level setup runs before the first milestone exists. Let
      // the auto loop dispatch workflow-preferences / project / requirements
      // units instead of recursing back through showSmartEntry while this
      // bootstrap still holds the session lock.
      s.currentMilestoneId = null;
    }

    if (!hasSurvivorBranch && !deepProjectStagePending && !strandedRecoveryAction) {
      // No active work — start a new milestone via discuss flow
      if (!state.activeMilestone || state.phase === "complete") {
        // Guard against recursive dialog loop (#1348):
        // If we've entered this branch multiple times in quick succession,
        // the discuss workflow isn't producing a milestone. Break the cycle.
        s.consecutiveCompleteBootstraps++;
        if (s.consecutiveCompleteBootstraps > MAX_CONSECUTIVE_COMPLETE_BOOTSTRAPS) {
          s.consecutiveCompleteBootstraps = 0;
          ctx.ui.notify(
            "All milestones are complete and the discussion didn't produce a new one. " +
            "Run /gsd to start a new milestone manually.",
            "warning",
          );
          return releaseLockAndReturn();
        }

        const { showSmartEntry } = await import("./guided-flow.js");
        await showSmartEntry(ctx, pi, base, { step: requestedStepMode });

        // showSmartEntry dispatches via pi.sendMessage() which is fire-and-forget:
        // it queues the message and returns immediately, before the LLM turn runs.
        // Checking postState here would always see the pre-dispatch state, causing
        // the premature "Discussion completed but..." warning (#3420).
        //
        // checkAutoStartAfterDiscuss (in guided-flow.ts) already handles re-entering
        // auto-mode by calling startAutoDetached after the discussion completes.
        // Release the lock and let the async dispatch proceed.
        return releaseLockAndReturn();
      }

      // Active milestone exists but has no roadmap
      if (state.phase === "pre-planning") {
        const mid = state.activeMilestone!.id;
        const contextFile = resolveMilestoneFile(base, mid, "CONTEXT");
        const hasContext = !!(contextFile && (await loadFile(contextFile)));
        if (!hasContext && effectivePrefs?.planning_depth !== "deep") {
          const { showSmartEntry } = await import("./guided-flow.js");
          await showSmartEntry(ctx, pi, base, { step: requestedStepMode });

          // showSmartEntry dispatches via pi.sendMessage() which is fire-and-forget:
          // it queues the message and returns immediately, before the LLM turn runs.
          // Checking postState here fires before the LLM has had a turn, so the
          // pre-planning phase would still appear unchanged and a premature warning
          // would be emitted (#3420).
          //
          // checkAutoStartAfterDiscuss (in guided-flow.ts) already handles re-entering
          // auto-mode by calling startAutoDetached after the discussion completes.
          // Release the lock and let the async dispatch proceed.
          return releaseLockAndReturn();
        }
      }

      // Active milestone has CONTEXT-DRAFT but no full context — needs discussion
      if (state.phase === "needs-discussion") {
        const { showSmartEntry } = await import("./guided-flow.js");
        await showSmartEntry(ctx, pi, base, { step: requestedStepMode });

        invalidateAllCaches();
        const postState = await deriveState(base);
        if (
          postState.activeMilestone &&
          postState.phase !== "needs-discussion"
        ) {
          state = postState;
        } else {
          ctx.ui.notify(
            "Discussion completed but milestone draft was not promoted. Run /gsd to try again.",
            "warning",
          );
          return releaseLockAndReturn();
        }
      }
    }

    // Unreachable safety check
    if (!state.activeMilestone && !deepProjectStagePending && !strandedRecoveryAction) {
      const { showSmartEntry } = await import("./guided-flow.js");
      await showSmartEntry(ctx, pi, base, { step: requestedStepMode });
      return releaseLockAndReturn();
    }

    // Successfully resolved an active milestone — reset the re-entry guard
    s.consecutiveCompleteBootstraps = 0;

    // ── Initialize session state ──
    // Notify shared phase state so subagent conflict checks can fire
    const { activateGSD: activateGSDPhaseState } = await import("../shared/gsd-phase-state.js");
    activateGSDPhaseState();
    s.active = true;
    s.stepMode = requestedStepMode;
    s.verbose = verboseMode;
    s.cmdCtx = ctx;
    // ADR-016 phase 2 / B2 (#5620): single owner of bootstrap basePath
    // mutation. Sets s.basePath = base and s.originalBasePath = base
    // (originalBasePath is empty on a fresh bootstrap).
    buildLifecycle().adoptSessionRoot(base);
    s.unitDispatchCount.clear();
    s.unitRecoveryCount.clear();
    s.lastBudgetAlertLevel = 0;
    s.unitLifetimeDispatches.clear();
    resetHookState();
    restoreHookState(base);
    // A restored activeHook has no live dispatch (the sidecar queue is not
    // persisted); re-enqueue it so the hook runs instead of blocking the next
    // unrelated unit's close-out (#1246).
    reconcileRestoredHookDispatch(base, s.sidecarQueue);
    // A restored gate block has no dispatch either; re-enqueue the blocked
    // hook so a failed blocking gate cannot be bypassed by resuming (#2194).
    reconcileRestoredGateBlock(base, s.sidecarQueue);
    resetProactiveHealing();
    // Notify user on health level transitions (green→yellow→red and back)
    setLevelChangeCallback((_from, to, summary) => {
      const level = to === "red" ? "error" : to === "yellow" ? "warning" : "info";
      ctx.ui.notify(summary, level as "info" | "warning" | "error");
    });
    s.autoStartTime = Date.now();
    s.resourceVersionOnStart = readResourceVersion();
    s.pendingQuickTasks = [];
    s.clearCurrentUnit();
    s.currentMilestoneId ??=
      strandedRecoveryAction?.milestoneId ??
      (deepProjectStagePending ? null : state.activeMilestone?.id ?? null);
    s.originalModelId = startModelSnapshot?.id ?? ctx.model?.id ?? null;
    s.originalModelProvider = startModelSnapshot?.provider ?? ctx.model?.provider ?? null;
    s.originalThinkingLevel = startThinkingSnapshot ?? null;

    // Register SIGTERM handler
    registerSigtermHandler(base);

    // Capture integration branch
    if (s.currentMilestoneId) {
      if (getIsolationMode(base) !== "none" || strandedRecoveryAction) {
        captureIntegrationBranch(base, s.currentMilestoneId);
      }
      setActiveMilestoneId(base, s.currentMilestoneId);
    }

    // Guard against stale milestone branch when isolation:none (#3613).
    // A prior session with isolation:branch/worktree may have left HEAD on
    // milestone/<MID>. Auto-checkout back to the integration branch.
    const isolationMode = getIsolationMode(base);
    const isRepo = nativeIsRepo(base);
    if (isolationMode === "none" && isRepo && !strandedRecoveryAction) {
      try {
        const currentBranch = nativeGetCurrentBranch(base);
        const integrationBranch = nativeDetectMainBranch(base);
        const branchToCheckout = resolveIsolationNoneBranchCheckout(
          currentBranch,
          integrationBranch,
          isolationMode,
          isRepo,
        );
        if (branchToCheckout) {
          checkoutBranchWithStashGuard(base, branchToCheckout, "isolation-none-recovery");
          logWarning("bootstrap", `Returned to "${branchToCheckout}" — HEAD was on stale milestone branch "${currentBranch}" (isolation: none does not use milestone branches).`);
        }
      } catch (err) {
        logWarning("bootstrap", `Could not auto-checkout from stale milestone branch: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Auto-worktree setup ──
    // s.originalBasePath was set to `base` by `adoptSessionRoot(base)` above
    // (ADR-016 phase 2 / B2, #5620). The redundant assignment that used to
    // live here is gone.

    const isUnderGsdWorktrees = (p: string): boolean => {
      const normalized = p.replaceAll("\\", "/");
      if (findWorktreeSegment(normalized) !== null) return true;
      // The container directory itself (no trailing worktree name), in any layout.
      return normalized.endsWith("/.gsd/worktrees")
        || normalized.endsWith("/.gsd-worktrees")
        || /\/\.gsd\/projects\/[^/]+\/worktrees$/.test(normalized);
    };

    if (
      s.currentMilestoneId &&
      (getIsolationMode(base) !== "none" || strandedRecoveryAction?.recoveryMode) &&
      !detectWorktreeName(base) &&
      !isUnderGsdWorktrees(base)
    ) {
      const lifecycle = buildLifecycle();
      const enterResult = strandedRecoveryAction?.recoveryMode
        ? lifecycle.adoptStrandedMilestone(
          s.currentMilestoneId,
          base,
          { notify: ctx.ui.notify.bind(ctx.ui) },
          { mode: strandedRecoveryAction.recoveryMode },
        )
        : lifecycle.enterMilestone(s.currentMilestoneId, {
          notify: ctx.ui.notify.bind(ctx.ui),
        });
      if (!enterResult.ok) {
        s.active = false;
        if (enterResult.reason === "lease-conflict") {
          ctx.ui.notify(
            `Cannot enter milestone ${s.currentMilestoneId}: lease is held by another worker.`,
            "error",
          );
        } else if (enterResult.reason === "creation-failed" || enterResult.reason === "isolation-degraded") {
          ctx.ui.notify(
            milestoneEntryBlockedGuidance(s.currentMilestoneId, enterResult.reason),
            "error",
          );
        } else if (enterResult.reason === "invalid-milestone-id") {
          ctx.ui.notify(
            `Cannot enter milestone ${s.currentMilestoneId}: milestone id is invalid.`,
            "error",
          );
        } else {
          ctx.ui.notify(
            `Auto-mode bootstrap stopped: failed to enter milestone ${s.currentMilestoneId} (${enterResult.reason}).`,
            "error",
          );
        }
        return releaseLockAndReturn();
      }
      if (s.basePath !== base) {
        // Successfully entered worktree — re-register SIGTERM handler at original base
        registerSigtermHandler(s.originalBasePath);
      }
    }

    // ── DB lifecycle ──
    const gsdDbPath = resolveProjectRootDbPath(s.basePath);
    const initialDbOpen = openWorkflowDatabase(s.basePath);
    if (!initialDbOpen.ok && (initialDbOpen.reason === "open-failed" || initialDbOpen.reason === "locked")) {
      logError("engine", `failed to initialize project database: ${initialDbOpen.error?.message ?? "open failed"}`);
    }
    if (_shouldAbortBootstrapForUnavailableDbForTest(gsdDbPath, isDbAvailable())) {
      const retryDbOpen = openWorkflowDatabase(s.basePath);
      if (!retryDbOpen.ok && (retryDbOpen.reason === "open-failed" || retryDbOpen.reason === "locked")) {
        logError("engine", `failed to open existing database: ${retryDbOpen.error?.message ?? "open failed"}`);
      }
    }

    // Gate: abort bootstrap if the DB file exists but the provider is
    // still unavailable after both open attempts above. Without this,
    // auto-mode starts but every gsd_task_complete / gsd_slice_complete
    // call returns "db_unavailable", triggering artifact-retry which
    // re-dispatches the same task — producing an infinite loop (#2419).
    if (existsSync(gsdDbPath) && !isDbAvailable()) {
      const dbStatus = getWorkflowDatabaseStatus();
      const phaseHint = dbStatus.lastPhase === "locked"
        ? "The database is locked by another GSD process"
        : dbStatus.lastPhase === "open"
        ? "The database file could not be opened"
        : dbStatus.lastPhase === "initSchema"
          ? "The database schema could not be initialized"
          : dbStatus.lastPhase === "vacuum-recovery"
            ? "Corruption recovery (VACUUM) failed"
            : dbStatus.attempted
              ? "The database could not be opened (phase unknown)"
              : "The database provider could not be loaded";
      const errorDetail = dbStatus.lastError ? ` (${dbStatus.lastError.message})` : "";
      const providerHint = dbStatus.provider
        ? ` Provider: ${dbStatus.provider}.`
        : " No SQLite provider available — check Node >= 22.18 with node:sqlite enabled.";
      ctx.ui.notify(
        `SQLite database exists but failed to open: ${gsdDbPath}. ${phaseHint}${errorDetail}.${providerHint}`,
        "error",
      );
      return releaseLockAndReturn();
    }

    // Gate: confirm the handle is actually writable, not just open. A
    // schema-current DB does zero writes during open, so a read-only /
    // DBMOVED handle otherwise passes the check above and only fails much
    // later at the first authoritative write (the uok-kernel-enter audit)
    // with an opaque "readonly database" error (#1234).
    if (existsSync(gsdDbPath) && isDbAvailable()) {
      const writable = probeDbWritable();
      if (!writable.ok) {
        const detail = writable.detail ? ` (${writable.detail})` : "";
        ctx.ui.notify(
          `SQLite database is not writable: ${gsdDbPath}.${detail} Check file/WAL permissions or reopen a stale handle before running auto-mode.`,
          "error",
        );
        return releaseLockAndReturn();
      }
    }

    // Initialize metrics
    initMetrics(s.basePath);

    // Initialize routing history
    initRoutingHistory(s.basePath);

    // Restore the model that was active when auto bootstrap began (#650, #2829).
    if (startModelSnapshot) {
      s.autoModeStartModel = {
        provider: startModelSnapshot.provider,
        id: startModelSnapshot.id,
      };
    }
    s.autoModeStartThinkingLevel = startThinkingSnapshot ?? null;
    s.manualSessionModelOverride = manualSessionOverride ?? null;

    // Apply worker model override from parallel orchestrator (#worker-model).
    // GSD_WORKER_MODEL is injected by the coordinator when parallel.worker_model
    // is configured, so parallel milestone workers use a cheaper model than the
    // coordinator session (e.g. Haiku for execution, Sonnet for planning).
    const workerModelOverride = process.env.GSD_WORKER_MODEL;
    if (workerModelOverride && process.env.GSD_PARALLEL_WORKER === "1") {
      const availableModels = ctx.modelRegistry.getAvailable();
      const { resolveModelId } = await import("./auto-model-selection.js");
      const overrideModel = resolveModelId(workerModelOverride, availableModels, ctx.model?.provider);
      if (overrideModel) {
        const ok = await pi.setModel(overrideModel, { persist: false });
        if (ok) {
          // Update start model so all subsequent units use this as the baseline
          s.autoModeStartModel = { provider: overrideModel.provider, id: overrideModel.id };
          ctx.ui.notify(`Worker model override: ${overrideModel.provider}/${overrideModel.id}`, "info");
        }
      }
    }

    // Snapshot installed skills
    if (resolveSkillDiscoveryMode(base) !== "off") {
      snapshotSkills({ cwd: s.basePath });
    }

    setAutoActiveStatus(ctx, s.stepMode ? "next" : "auto");
    ctx.ui.setWidget("gsd-health", undefined);
    const modeLabel = s.stepMode ? "Step-mode" : "Auto-mode";
    const pendingCount = (state.registry ?? []).filter(
      (m) => m.status !== "complete" && m.status !== "parked",
    ).length;
    const scopeMsg =
      deepProjectStagePending
        ? "Will run project setup before milestone planning."
        : pendingCount > 1
        ? `Will loop through ${pendingCount} milestones.`
        : "Will loop until milestone complete.";
    ctx.ui.notify(`${modeLabel} started. ${scopeMsg}`, "info");

    const providerReportedWindow = ctx.model?.contextWindow ?? 0;
    const contextOverride = loadEffectiveGSDPreferences(base)?.preferences.context_window_override;
    if (providerReportedWindow > 500_000 && contextOverride === undefined) {
      ctx.ui.notify(
        `Model reports a ${Math.round(providerReportedWindow / 1000)}K context window. If the provider's real API limit is lower, set context_window_override in .gsd/PREFERENCES.md so wrap-up signals fire before context overflow.`,
        "warning",
      );
    }

    // Show dynamic routing status so users know upfront if models will be
    // downgraded for simple tasks (#3962).
    // Use the same effective logic as selectAndApplyModel: check flat-rate
    // provider suppression and resolve the actual ceiling model.
    const routingConfig = resolveDynamicRoutingConfig();
    const startModelLabel = s.autoModeStartModel
      ? `${s.autoModeStartModel.provider}/${s.autoModeStartModel.id}`
      : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "default";

    // Flat-rate providers (e.g. GitHub Copilot, claude-code, user-declared
    // subscription proxies, externalCli CLIs) suppress routing only when the
    // user explicitly opts out with allow_flat_rate_providers: false. Reflect
    // that in the banner. Thread the same
    // FlatRateContext used by selectAndApplyModel so user-declared
    // flat-rate providers and externalCli auto-detection are respected.
    const { isFlatRateProvider, buildFlatRateContext } = await import("./auto-model-selection.js");
    const bannerPrefs = loadEffectiveGSDPreferencesWithRegistry(
      ctx.modelRegistry,
      base,
      resolveProfileAnchorProvider(ctx.model?.provider, s.autoModeStartModel?.provider),
      s.autoModeStartModel ? `${s.autoModeStartModel.provider}/${s.autoModeStartModel.id}` : undefined,
    )?.preferences;
    const effectiveProvider = s.autoModeStartModel?.provider ?? ctx.model?.provider;
    const effectivelyEnabled = routingConfig.enabled
      && (routingConfig.allow_flat_rate_providers !== false
        || !(effectiveProvider && isFlatRateProvider(
          effectiveProvider,
          buildFlatRateContext(effectiveProvider, ctx, bannerPrefs),
        )));

    // The actual ceiling may come from tier_models.heavy, not the start model.
    const effectiveCeiling = (routingConfig.enabled && routingConfig.tier_models?.heavy)
      ? routingConfig.tier_models.heavy
      : startModelLabel;

    if (effectivelyEnabled) {
      ctx.ui.notify(
        `Dynamic routing: enabled — simple tasks may use cheaper models (ceiling: ${effectiveCeiling})`,
        "info",
      );
    } else {
      ctx.ui.notify(
        `Dynamic routing: disabled — all tasks will use ${startModelLabel}`,
        "info",
      );
    }

    updateSessionLock(
      lockBase(),
      "starting",
      s.currentMilestoneId ?? "unknown",
    );
    writeLock(lockBase(), "starting", s.currentMilestoneId ?? "unknown");

    // Secrets collection gate
    const mid = state.activeMilestone?.id;
    if (mid) {
      try {
        const manifestStatus = await getManifestStatus(base, mid, s.originalBasePath || base);
        if (manifestStatus && manifestStatus.pending.length > 0) {
          const result = await collectSecretsFromManifest(base, mid, ctx);
          if (
            result &&
            result.applied &&
            result.skipped &&
            result.existingSkipped
          ) {
            ctx.ui.notify(
              `Secrets collected: ${result.applied.length} applied, ${result.skipped.length} skipped, ${result.existingSkipped.length} already set.`,
              "info",
            );
          } else {
            ctx.ui.notify("Secrets collection skipped.", "info");
          }
        }
      } catch (err) {
        ctx.ui.notify(
          `Secrets collection error: ${err instanceof Error ? err.message : String(err)}. Continuing with next task.`,
          "warning",
        );
      }
    }

    // Pre-flight: validate milestone queue
    try {
      const milestoneIds = findMilestoneIds(base);
      if (milestoneIds.length > 1) {
        const issues: string[] = [];
        for (const id of milestoneIds) {
          // Skip completed/parked milestones — a leftover CONTEXT-DRAFT.md
          // on a finished milestone is harmless residue, not an actionable warning.
          if (isDbAvailable()) {
            const ms = getMilestone(id);
            if (ms?.status === "complete" || ms?.status === "parked") continue;
          }
          const draft = resolveMilestoneFile(base, id, "CONTEXT-DRAFT");
          if (draft)
            issues.push(
              `${id}: has CONTEXT-DRAFT.md (will pause for discussion)`,
            );
        }
        if (issues.length > 0) {
          ctx.ui.notify(
            `Pre-flight: ${milestoneIds.length} milestones queued.\n${issues.map((i) => `  ⚠ ${i}`).join("\n")}`,
            "warning",
          );
        } else {
          ctx.ui.notify(
            `Pre-flight: ${milestoneIds.length} milestones queued. All have full context.`,
            "info",
          );
        }
      }
    } catch (err) {
      /* non-fatal */
      logWarning("engine", `preflight validation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return true;
  } catch (err) {
    releaseLockAcquisition();
    throw err;
  }
}
