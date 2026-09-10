// Project/App: gsd-pi
// File Purpose: Auto-mode orchestration, session lifecycle, and stop handling.
/**
 * GSD Auto Mode — Fresh Session Per Unit
 *
 * State machine driven by the project database and the UnitRun
 * (`unit_dispatches` row with status claimed|running; ADR-048). Each "unit"
 * of work (plan slice, execute task, complete slice) gets a fresh session via
 * the stashed ctx.newSession() pattern.
 *
 * After each agent_end, the orchestrator decides the next unit, claims it in
 * the same advance() step, creates a fresh session, and injects a focused
 * prompt telling the LLM which files to read and what to do.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  SessionMessageEntry,
} from "@gsd/pi-coding-agent";

import { deriveState, invalidateStateCache } from "./state.js";
import {
  buildRequirementsBacklogSummaryLines,
  countUnmappedActiveRequirements,
  getUnmappedActiveRequirements,
} from "./requirements-backlog.js";
import { parseUnitId } from "./unit-id.js";
import type { GSDState } from "./types.js";
import {
  assessInterruptedSession,
  readPausedSessionMetadata,
  PAUSED_SESSION_KV_KEY,
  type InterruptedSessionAssessment,
  type PausedSessionMetadata,
} from "./interrupted-session.js";
import {
  setRuntimeKv,
  deleteRuntimeKv,
} from "./db/runtime-kv.js";
import { extractSection, getManifestStatus, splitFrontmatter, parseFrontmatterMap } from "./files.js";
export { inlinePriorMilestoneSummary } from "./files.js";
import { collectSecretsFromManifest } from "../get-secrets-from-user.js";

import {
  gsdRoot,
  resolveMilestoneFile,
  resolveSliceFile,
  resolveSlicePath,
  resolveMilestonePath,
  resolveDir,
  resolveTasksDir,
  resolveTaskFile,
  milestonesDir,
  legacyMilestonesDir,
  isLegacyMilestonesLayout,
  buildTaskFileName,
  canonicalPhaseDirName,
} from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { clearActivityLogState } from "./activity-log.js";
import {
  synthesizeCrashRecovery,
  getDeepDiagnostic,
  readActiveMilestoneId,
} from "./session-forensics.js";
import {
  writeLock,
  clearLock,
  clearStaleWorkerLock,
  readCrashLock,
  isLockProcessAlive,
  formatCrashInfo,
  emitCrashRecoveredUnitEnd,
  emitOpenUnitEndForUnit,
} from "./crash-recovery.js";
import {
  acquireSessionLock,
  getSessionLockStatus,
  releaseSessionLock,
  updateSessionLock,
} from "./session-lock.js";
import type { SessionLockStatus } from "./session-lock.js";
import {
  resolveAutoSupervisorConfig,
  loadEffectiveGSDPreferences,
  loadEffectiveGSDPreferencesWithRegistry,
  resolveProfileAnchorProvider,
  getIsolationMode,
  resolveEffectiveUnitIsolationMode,
} from "./preferences.js";
import { playNotificationBell, sendDesktopNotification } from "./notifications.js";
import type { GSDPreferences } from "./preferences.js";
import {
  type BudgetAlertLevel,
  getBudgetAlertLevel,
  getNewBudgetAlertLevel,
  getBudgetEnforcementAction,
  getContextPauseAction,
  HARD_CONTEXT_REROOT_THRESHOLD_PERCENT,
  resolveCompactionThresholdPercent,
  shouldRerootStepSessionForContext,
  shouldWarnStepSessionForContext,
} from "./auto-budget.js";
import {
  markToolStart as _markToolStart,
  markToolEnd as _markToolEnd,
  getOldestInFlightToolAgeMs as _getOldestInFlightToolAgeMs,
  getInFlightToolCount,
  getOldestInFlightToolStart,
  hasInteractiveToolInFlight,
  clearInFlightTools,
  updateToolInvocationError,
} from "./auto-tool-tracking.js";
import { closeoutUnit } from "./auto-unit-closeout.js";
import { recoverTimedOutUnit } from "./auto-timeout-recovery.js";
import { selectAndApplyModel, resolveModelId, clearToolBaseline, isModelUnavailable, applyThinkingLevelForModel } from "./auto-model-selection.js";
import { resolveModelWithFallbacksForUnit } from "./preferences-models.js";
import { resetRoutingHistory, recordOutcome } from "./routing-history.js";
import {
  checkPostUnitHooks,
  getActiveHook,
  resetHookState,
  isRetryPending,
  consumeRetryTrigger,
  runPreDispatchHooks,
  persistHookState,
  restoreHookState,
  reconcileRestoredHookDispatch,
  reconcileRestoredGateBlock,
  clearPersistedHookState,
} from "./post-unit-hooks.js";
import { runGSDDoctor, rebuildState } from "./doctor.js";
import {
  preDispatchHealthGate,
  recordHealthSnapshot,
  checkHealEscalation,
  resetProactiveHealing,
  setLevelChangeCallback,
  formatHealthSummary,
  getConsecutiveErrorUnits,
} from "./doctor-proactive.js";
import { clearSkillSnapshot } from "./skill-discovery.js";
import {
  captureAvailableSkills,
  resetSkillTelemetry,
} from "./skill-telemetry.js";
import { getInstalledSkillNames } from "./skills.js";
import { effectiveSkillNamesForUnit } from "./skill-scope.js";
import { getRtkSessionSavings } from "../shared/rtk-session-stats.js";
import { deactivateGSD } from "../shared/gsd-phase-state.js";
import {
  initMetrics,
  resetMetrics,
  getLedger,
  getProjectTotals,
  filterUnitsForMilestone,
  formatCost,
  formatTokenCount,
} from "./metrics.js";
import { setLogBasePath, logWarning, logError } from "./workflow-logger.js";
import { preflightCleanRoot, postflightPopStash } from "./clean-root-preflight.js";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { atomicWriteSync } from "./atomic-write.js";
import {
  autoCommitCurrentBranch,
  captureIntegrationBranch,
  detectWorktreeName,
  getCurrentBranch,
  getMainBranch,
  MergeConflictError,
  parseSliceBranch,
  setActiveMilestoneId,
  resolveProjectRoot,
} from "./worktree.js";
import { GitServiceImpl } from "./git-service.js";
import { nativeCheckoutBranch } from "./native-git-bridge.js";
import { getPriorSliceCompletionBlocker } from "./dispatch-guard.js";
import { autoWorktreeBranch, enterBranchModeForMilestone } from "./auto-worktree-branch-lifecycle.js";
import { createAutoWorktree } from "./auto-worktree-creation.js";
import { enterAutoWorktree, isInAutoWorktree } from "./auto-worktree-entry.js";
import { getAutoWorktreePath } from "./auto-worktree-path-resolution.js";
import { checkResourcesStale, readResourceVersion } from "./auto-worktree-resource-version.js";
import { escapeStaleWorktree } from "./auto-worktree-runtime-cleanup.js";
import { teardownWarmedBrowserDaemons } from "./browser-daemon-auto-prep.js";
import { getAutoWorktreeOriginalBase } from "./auto-worktree-session-registry.js";
import { syncWorktreeStateBack } from "./auto-worktree-sync.js";
import { teardownAutoWorktree } from "./auto-worktree-teardown.js";
import { pruneQueueOrder } from "./queue-order.js";
import { startCommandPolling as _startCommandPolling, isRemoteConfigured } from "../remote-questions/manager.js";
import { createDefaultMilestoneMergeTransaction } from "./milestone-merge-transaction.js";

import { debugLog, isDebugEnabled, writeDebugSummary } from "./debug-logger.js";
import {
  buildLoopRemediationSteps,
  reconcileMergeState,
  verifyExpectedArtifact,
} from "./auto-recovery.js";
import { classifyMilestoneSummaryContent } from "./milestone-summary-classifier.js";
import { resolveDispatch, DISPATCH_RULES, milestoneIdsDispatchCompatible } from "./auto-dispatch.js";
import { getErrorMessage } from "./error-utils.js";
import { recoverFailedMigration } from "./migrate-external.js";
import { initRegistry, convertDispatchRules } from "./rule-registry.js";
import { emitJournalEvent as _emitJournalEvent, type JournalEntry } from "./journal.js";
import { isClosedStatus } from "./status-guards.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import {
  type AutoDashboardData,
  updateProgressWidget as _updateProgressWidget,
  setCompletionProgressWidget,
  setAutoOutcomeWidget,
  setAutoActiveStatus,
  updateSliceProgressCache,
  clearSliceProgressCache,
  describeNextUnit as _describeNextUnit,
  unitVerb,
  formatAutoElapsed as _formatAutoElapsed,
  formatWidgetTokens,
  type WidgetStateAccessors,
} from "./auto-dashboard.js";
import {
  registerSigtermHandler as _registerSigtermHandler,
  deregisterSigtermHandler as _deregisterSigtermHandler,
  detectWorkingTreeActivity,
} from "./auto-supervisor.js";
import {
  isDbAvailable,
  getMilestone,
  getMilestoneSlices,
  getSlice,
  getTask,
} from "./gsd-db.js";
import {
  checkpointWorkflowDatabase,
  closeWorkflowDatabase,
  getWorkflowDatabaseStatus,
  resolveProjectRootDbPath,
} from "./db-workspace.js";
import { markActiveForWorkerCanceled } from "./db/unit-dispatches.js";
import { writeUnitRuntimeRecord } from "./unit-runtime.js";
import { countPendingCaptures } from "./captures.js";
import { CMUX_CHANNELS, type CmuxLogLevel } from "../shared/cmux-events.js";
import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
import { acknowledgeWedge, formatWedgeRefusalNotice, getOpenWedge } from "./auto-liveness-backstop.js";
import { getValidationBlockMessageForBase } from "./validation-block-guard.js";
import { getUnmergedMilestoneBlockMessageForBase } from "./unmerged-milestone-guard.js";
import { clearSessionModelOverride } from "./session-model-override.js";
import {
  formatLockedWorkflowDatabaseNotice,
  listWorkflowDbLockHolderPids,
} from "./workflow-db-locks.js";

function makeCmuxEmitters(pi: ExtensionAPI) {
  return {
    syncCmuxSidebar: (preferences: GSDPreferences | undefined, state: GSDState) =>
      pi.events.emit(CMUX_CHANNELS.SIDEBAR, { action: "sync" as const, preferences, state }),
    logCmuxEvent: (preferences: GSDPreferences | undefined, message: string, level?: CmuxLogLevel) =>
      pi.events.emit(CMUX_CHANNELS.LOG, { preferences, message, level: level ?? "info" }),
    clearCmuxSidebar: (preferences: GSDPreferences | undefined) =>
      pi.events.emit(CMUX_CHANNELS.SIDEBAR, { action: "clear" as const, preferences }),
  };
}

// ── Extracted modules ──────────────────────────────────────────────────────
import { startUnitSupervision } from "./auto-timers.js";
import { runPostUnitVerification } from "./auto-verification.js";
import {
  autoCommitUnit,
  postUnitPreVerification,
  postUnitPostVerification,
} from "./auto-post-unit.js";
import {
  bootstrapAutoSession,
  openProjectDbIfPresent,
  type BootstrapDeps,
} from "./auto-start.js";
import { initHealthWidget } from "./health-widget.js";
import { runLegacyAutoLoop, runUokKernelLoop } from "./auto/loop.js";
import { resolveAgentEnd, resolveAgentEndCancelled, _resetPendingResolve, isSessionSwitchInFlight } from "./auto/resolve.js";
import type { LoopDeps, PauseAutoOptions, PauseAutoUnitIdentity, StopAutoOptions } from "./auto/loop-deps.js";
import type { ErrorContext } from "./auto/types.js";
import { runAutoLoopWithUok } from "./uok/kernel.js";
import { resolveUokFlags } from "./uok/flags.js";
import { validateDirectory } from "./validate-directory.js";
import { createAutoOrchestrator } from "./auto/orchestrator.js";
import type { AutoAdvanceResult, AutoOrchestrationModule } from "./auto/contracts.js";
import {
  repairAutoWorktreeSafetyFailure,
  resolvePausedAutoWorktreePath,
} from "./auto-worktree-repair.js";
// Slice-level parallelism (#2340)
import { getEligibleSlices } from "./slice-parallel-eligibility.js";
import { startSliceParallel } from "./slice-parallel-orchestrator.js";
import {
  WorktreeLifecycle,
  type WorktreeLifecycleDeps,
} from "./worktree-lifecycle.js";
import { WorktreeStateProjection } from "./worktree-state-projection.js";
import { reorderForCaching } from "./prompt-ordering.js";
import { initTokenCounter } from "./token-counter.js";

// Warm the tiktoken encoder at extension startup so context-budget computations
// can use accurate token counts via countTokensSync without paying the load
// cost mid-prompt-build. Fire-and-forget — failure falls back to the
// provider-aware char-ratio estimator already used by getCharsPerToken().
// Catch rejections explicitly: an unhandled rejection at module-import time
// can destabilize startup before the engine logger is configured.
void initTokenCounter().catch((err) => {
  logWarning(
    "engine",
    `token counter warm-up failed: ${err instanceof Error ? err.message : String(err)}`,
  );
});

// ─── Session State ─────────────────────────────────────────────────────────

import {
  STUB_RECOVERY_THRESHOLD,
  NEW_SESSION_TIMEOUT_MS,
} from "./auto/session.js";
import type {
  CurrentUnit,
  UnitRouting,
  StartModel,
  AutoSession,
} from "./auto/session.js";
export {
  STUB_RECOVERY_THRESHOLD,
  NEW_SESSION_TIMEOUT_MS,
} from "./auto/session.js";
export type {
  CurrentUnit,
  UnitRouting,
  StartModel,
} from "./auto/session.js";
import { autoSession as s, getAutoRuntimeSnapshot } from "./auto-runtime-state.js";
import { gsdHome } from "./gsd-home.js";
import { createWorkspace, scopeMilestone } from "./workspace.js";
import {
  registerAutoWorker,
  markWorkerStopping,
} from "./db/auto-workers.js";
import { releaseMilestoneLease } from "./db/milestone-leases.js";
import { normalizeRealPath } from "./paths.js";
import {
  formatStopNoticePrefix,
  isBlockedStopReason,
  stopNoticeDisplayReason,
} from "./stop-notice.js";
import { abortActiveUnitTurn } from "./auto/unit-turn-abort.js";

// ── ENCAPSULATION INVARIANT ─────────────────────────────────────────────────
// ALL mutable auto-mode state lives in the AutoSession class (auto/session.ts).
// This file must NOT declare module-level `let` or `var` variables for state.
// The single shared `s` instance below is the only mutable AutoSession binding.
//
// When adding features or fixing bugs:
//   - New mutable state → add a property to AutoSession, not a module-level variable
//   - New constants → module-level `const` is fine (immutable)
//   - New state that needs reset on stopAuto → add to AutoSession.reset()
//
// Tests in auto-session-encapsulation.test.ts enforce this invariant.
// ─────────────────────────────────────────────────────────────────────────────

/** Throttle STATE.md rebuilds — at most once per 30 seconds */
const STATE_REBUILD_MIN_INTERVAL_MS = 30_000;

export function formatAutoStopNotification(prefix: string, totals: { cost: number; tokens: { total: number } }, unitCount: number): string {
  return [
    `${prefix}.`,
    `Session: ${formatCost(totals.cost)} · ${formatTokenCount(totals.tokens.total)} tokens · ${unitCount} units`,
  ].join("\n");
}

export { formatStopNoticePrefix as formatAutoStopNotificationPrefix } from "./stop-notice.js";

function clearSessionModelOverrideForCommandSession(ctx?: ExtensionContext | null): void {
  const sessionId =
    s.cmdCtx?.sessionManager?.getSessionId?.() ??
    ctx?.sessionManager?.getSessionId?.();
  if (sessionId) clearSessionModelOverride(sessionId);
}

/**
 * Phase B — register this auto-mode process in the workers table so other
 * workers and janitors can detect liveness via heartbeat. Best-effort: if
 * the DB is unavailable (e.g. fresh project before init) we skip registration
 * silently rather than blocking session start.
 */
function registerAutoWorkerForSession(
  session: AutoSession,
  projectRootOverride?: string,
): void {
  if (session.workerId) return; // already registered (e.g. resume re-runs)
  try {
    const projectRootRealpath = normalizeRealPath(
      projectRootOverride
        ?? session.scope?.workspace.projectRoot
        ?? (session.originalBasePath || session.basePath),
    );
    session.workerId = registerAutoWorker({ projectRootRealpath });
  } catch (err) {
    debugLog("autoLoop", {
      phase: "register-worker-failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function captureProjectRootEnv(projectRoot: string): void {
  if (!s.projectRootEnvCaptured) {
    s.hadProjectRootEnv = Object.prototype.hasOwnProperty.call(process.env, "GSD_PROJECT_ROOT");
    s.previousProjectRootEnv = process.env.GSD_PROJECT_ROOT ?? null;
    s.projectRootEnvCaptured = true;
  }
  process.env.GSD_PROJECT_ROOT = projectRoot;
}

function restoreProjectRootEnv(): void {
  if (!s.projectRootEnvCaptured) return;

  if (s.hadProjectRootEnv && s.previousProjectRootEnv !== null) {
    process.env.GSD_PROJECT_ROOT = s.previousProjectRootEnv;
  } else {
    delete process.env.GSD_PROJECT_ROOT;
  }

  s.previousProjectRootEnv = null;
  s.hadProjectRootEnv = false;
  s.projectRootEnvCaptured = false;
}

export function _captureProjectRootEnvForTest(projectRoot: string): void {
  captureProjectRootEnv(projectRoot);
}

export function _restoreProjectRootEnvForTest(): void {
  restoreProjectRootEnv();
}

function captureMilestoneLockEnv(milestoneId: string | null): void {
  if (!s.milestoneLockEnvCaptured) {
    s.hadMilestoneLockEnv = Object.prototype.hasOwnProperty.call(process.env, "GSD_MILESTONE_LOCK");
    s.previousMilestoneLockEnv = process.env.GSD_MILESTONE_LOCK ?? null;
    s.milestoneLockEnvCaptured = true;
  }

  if (milestoneId) {
    process.env.GSD_MILESTONE_LOCK = milestoneId;
  } else {
    delete process.env.GSD_MILESTONE_LOCK;
  }
  // The derive cache is keyed on basePath only; GSD_MILESTONE_LOCK changes
  // what deriveState computes, so a lock flip must not serve a cached result.
  invalidateStateCache();
}

function restoreMilestoneLockEnv(): void {
  if (!s.milestoneLockEnvCaptured) return;

  if (s.hadMilestoneLockEnv && s.previousMilestoneLockEnv !== null) {
    process.env.GSD_MILESTONE_LOCK = s.previousMilestoneLockEnv;
  } else {
    delete process.env.GSD_MILESTONE_LOCK;
  }

  s.previousMilestoneLockEnv = null;
  s.hadMilestoneLockEnv = false;
  s.milestoneLockEnvCaptured = false;
  invalidateStateCache();
}

/**
 * Rebuild s.scope from the current s.basePath / s.originalBasePath / s.currentMilestoneId.
 *
 * Pass the worktree path as rawPath when entering a worktree so createWorkspace
 * can detect the worktree layout and set mode="worktree". When no worktree is
 * active, rawPath should equal the project root.
 *
 * Clears s.scope when milestoneId is absent — scope is only meaningful when a
 * milestone is active.
 *
 * TODO(C8): remove basePath/originalBasePath once all readers use s.scope.
 */
function rebuildScope(rawPath: string, milestoneId: string | null): void {
  if (!milestoneId) {
    s.scope = null;
    return;
  }
  try {
    const workspace = createWorkspace(rawPath);
    s.scope = scopeMilestone(workspace, milestoneId);
  } catch {
    // Non-fatal — scope is additive. Existing readers still use basePath.
    s.scope = null;
  }
}

function normalizeSessionFilePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) return null;

  // Guard against accidental message concatenation by trimming to .jsonl.
  const jsonlIndex = firstLine.toLowerCase().indexOf(".jsonl");
  const candidate = jsonlIndex >= 0 ? firstLine.slice(0, jsonlIndex + ".jsonl".length) : firstLine;
  if (!isAbsolute(candidate)) return null;
  if (!candidate.toLowerCase().endsWith(".jsonl")) return null;
  return candidate;
}

function synthesizePausedSessionRecovery(
  basePath: string,
  unitType: string,
  unitId: string,
  sessionFile: string,
): ReturnType<typeof synthesizeCrashRecovery> {
  const activityDir = join(gsdRoot(basePath), "activity");
  return synthesizeCrashRecovery(basePath, unitType, unitId, sessionFile, activityDir);
}

export function _synthesizePausedSessionRecoveryForTest(
  basePath: string,
  unitType: string,
  unitId: string,
  sessionFile: string,
): ReturnType<typeof synthesizeCrashRecovery> {
  return synthesizePausedSessionRecovery(basePath, unitType, unitId, sessionFile);
}

type PausedResumeRecoverySessionState = {
  pausedSessionFile: string | null;
  currentUnit: { type: string; id: string } | null;
  pausedUnitType: string | null;
  pausedUnitId: string | null;
  pendingCrashRecovery: string | null;
};

function handlePausedSessionResumeRecovery(
  basePath: string,
  state: PausedResumeRecoverySessionState,
  notify: (message: string) => void,
): { skippedReplay: boolean } {
  if (!state.pausedSessionFile) return { skippedReplay: false };

  const pausedRecoveryUnitType = state.currentUnit?.type ?? state.pausedUnitType ?? null;
  const pausedRecoveryUnitId = state.currentUnit?.id ?? state.pausedUnitId ?? null;

  // When the paused-session metadata never captured the unit identity (the
  // pause happened between units, or the worker died before currentUnit was
  // set), we have nothing to verify against and nothing correct to target. A
  // replay synthesized with an "unknown" unit re-injects an unbounded,
  // mis-identified tool-call blob into the fresh resume context — exactly the
  // thrash that turns one stuck unit into several. Disk state has already been
  // rebuilt (rebuildState + doctor) before this runs, so skip the replay and
  // let the normal dispatcher recompute the next unit from disk.
  if (!pausedRecoveryUnitType || !pausedRecoveryUnitId) {
    state.pausedSessionFile = null;
    state.pausedUnitType = null;
    state.pausedUnitId = null;
    state.pendingCrashRecovery = null;
    notify("Paused session had no recorded unit identity. Skipping tool-call replay and resuming from disk state.");
    return { skippedReplay: true };
  }

  const completedPausedUnit = verifyExpectedArtifact(
    pausedRecoveryUnitType,
    pausedRecoveryUnitId,
    basePath,
  );

  if (completedPausedUnit) {
    state.pausedSessionFile = null;
    state.pausedUnitType = null;
    state.pausedUnitId = null;
    state.pendingCrashRecovery = null;
    return { skippedReplay: true };
  }

  const recovery = synthesizePausedSessionRecovery(
    basePath,
    pausedRecoveryUnitType,
    pausedRecoveryUnitId,
    state.pausedSessionFile,
  );
  if (recovery && recovery.trace.toolCallCount > 0) {
    state.pendingCrashRecovery = recovery.prompt;
    notify(`Recovered ${recovery.trace.toolCallCount} tool calls from paused session. Resuming with context.`);
  }
  state.pausedSessionFile = null;
  state.pausedUnitType = null;
  state.pausedUnitId = null;
  return { skippedReplay: false };
}

/**
 * Route a paused-session resume against current project state (#1643 / #1654).
 *
 * The pre-existing checks only discarded the pin when the paused milestone was
 * gone or closed. A milestone that is still open but no longer the project's
 * active milestone (superseded — e.g. a new milestone reordered ahead of it)
 * passed both checks, got pinned into `session.currentMilestoneId`, and then
 * every dispatch iteration hit the milestone-mismatch guard and stopped —
 * a permanent wedge with no field escape short of hand-editing the
 * `paused_session` runtime_kv row. Per ADR-047 the guard stays; this makes the
 * exit reachable by never restoring a superseded pin in the first place.
 *
 * Id comparison uses the dispatch guard's own normalization
 * (`milestoneIdsDispatchCompatible`, #1317) so bare-vs-suffixed aliases of the
 * same milestone never count as superseded.
 */
export type PausedSessionResumeRoute =
  | { route: "restore" }
  | { route: "discard"; reason: "missing" | "terminal" }
  | { route: "adopt-active"; activeMilestoneId: string };

export function routePausedSessionResume(args: {
  milestoneDirExists: boolean;
  summaryIsTerminal: boolean;
  pausedMilestoneId: string;
  activeMilestoneId: string | null | undefined;
}): PausedSessionResumeRoute {
  if (!args.milestoneDirExists) return { route: "discard", reason: "missing" };
  if (args.summaryIsTerminal) return { route: "discard", reason: "terminal" };
  if (
    args.activeMilestoneId
    && !milestoneIdsDispatchCompatible(args.activeMilestoneId, args.pausedMilestoneId)
  ) {
    return { route: "adopt-active", activeMilestoneId: args.activeMilestoneId };
  }
  return { route: "restore" };
}

export function _handlePausedSessionResumeRecoveryForTest(
  basePath: string,
  state: PausedResumeRecoverySessionState,
): { skippedReplay: boolean } {
  return handlePausedSessionResumeRecovery(basePath, state, () => {});
}

// `_resolvePausedResumeBasePathForTest` was retired in ADR-016 phase 2 / B3
// (#5621). Production callers go through
// `WorktreeLifecycle.resumeFromPausedSession`; the pure helper for tests is
// `resolvePausedResumeBasePath` exported from `worktree-lifecycle.ts`.

const DETACHED_AUTO_KEEPALIVE_INTERVAL_MS = 30_000;

function withDetachedAutoKeepalive<T>(run: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, DETACHED_AUTO_KEEPALIVE_INTERVAL_MS);
  return run.finally(() => {
    clearInterval(keepAlive);
  });
}

export const _withDetachedAutoKeepaliveForTest = withDetachedAutoKeepalive;

export function startAutoDetached(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  base: string,
  verboseMode: boolean,
  options?: {
    step?: boolean;
    interrupted?: InterruptedSessionAssessment;
    milestoneLock?: string | null;
    resumeWedgeId?: string | null;
  },
): void {
  void withDetachedAutoKeepalive(startAuto(ctx, pi, base, verboseMode, options)).catch(async (err) => {
    const message = getErrorMessage(err);
    ctx.ui.notify(`Auto-start failed: ${message}`, "error");
    logWarning("engine", `auto start error: ${message}`, { file: "auto.ts" });
    debugLog("auto-start-failed", { error: message });
    // Backstop cleanup (#1235): if startAuto threw after auto-mode was activated
    // (e.g. an exception during bootstrap, before the loop's try/finally could
    // run cleanupAfterLoopExit), s.active and the on-disk auto lock leak, so the
    // re-entry guard silently no-ops every later /gsd auto until restart. Clear
    // the leaked activation here so a failed start is always recoverable.
    if (s.active) {
      try {
        await cleanupAfterLoopExit(ctx);
      } catch (cleanupErr) {
        logWarning(
          "engine",
          `auto start cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          { file: "auto.ts" },
        );
      }
    }
  });
}

/** Returns true if the project is configured for `isolation:worktree` mode. */
export function shouldUseWorktreeIsolation(basePath?: string): boolean {
  return getIsolationMode(basePath) === "worktree";
}

type AutoIsolationMode = ReturnType<typeof getIsolationMode>;

export function _resolveEffectiveUnitIsolationModeForTest(
  configuredMode: AutoIsolationMode,
  isolationDegraded: boolean,
  strandedRecoveryIsolationMode: "worktree" | "branch" | null = null,
): AutoIsolationMode {
  return resolveEffectiveUnitIsolationMode(
    configuredMode,
    isolationDegraded,
    strandedRecoveryIsolationMode,
  );
}

function getEffectiveUnitIsolationMode(basePath: string): AutoIsolationMode {
  return resolveEffectiveUnitIsolationMode(
    getIsolationMode(basePath),
    s.isolationDegraded,
    s.strandedRecoveryIsolationMode,
  );
}

/** Crash recovery prompt — set by startAuto, consumed by the main loop */

/** Pending verification retry — set when gate fails with retries remaining, consumed by autoLoop */

/** Verification retry count per unitId — separate from s.unitDispatchCount which tracks artifact-missing retries */

/** Session file path captured at pause — used to synthesize recovery briefing on resume */

/** Dashboard tracking */

/** Track dynamic routing decision for the current unit (for metrics) */

/** Queue of quick-task captures awaiting dispatch after triage resolution */

/**
 * Model captured at auto-mode start. Used to prevent model bleed between
 * concurrent GSD instances sharing the same global settings.json (#650).
 * When preferences don't specify a model for a unit type, this ensures
 * the session's original model is re-applied instead of reading from
 * the shared global settings (which another instance may have overwritten).
 */

/** Track current milestone to detect transitions */

/** Model the user had selected before auto-mode started */

/** Progress-aware timeout supervision */

/** Context-pressure continue-here monitor — fires once when context usage >= 70% */

/** Prompt character measurement for token savings analysis (R051). */

/** SIGTERM handler registered while auto-mode is active — cleared on stop/pause. */

/**
 * Tool calls currently being executed — prevents false idle detection during long-running tools.
 * Maps toolCallId → start timestamp (ms) so the idle watchdog can detect tools that have been
 * running suspiciously long (e.g., a Bash command hung because `&` kept stdout open).
 */
// Re-export budget utilities for external consumers
export {
  getBudgetAlertLevel,
  getNewBudgetAlertLevel,
  getBudgetEnforcementAction,
  getContextPauseAction,
  resolveCompactionThresholdPercent,
  shouldRerootStepSessionForContext,
  shouldWarnStepSessionForContext,
} from "./auto-budget.js";

function closeOutSignalInterruptedUnit(currentBasePath: string): void {
  const currentUnit = s.currentUnit;
  if (!currentUnit) return;

  abortActiveUnitTurn(s.cmdCtx);

  const reason = "Auto-mode process received a termination signal";
  const errorContext: ErrorContext = {
    message: reason,
    category: "aborted",
    isTransient: false,
  };
  const basePath = s.basePath || currentBasePath;

  try {
    emitOpenUnitEndForUnit(basePath, currentUnit.type, currentUnit.id, "cancelled", errorContext);
  } catch (err) {
    logWarning("engine", `signal unit-end cleanup failed: ${getErrorMessage(err)}`, { file: "auto.ts" });
  }

  try {
    writeUnitRuntimeRecord(basePath, currentUnit.type, currentUnit.id, currentUnit.startedAt, {
      phase: "crashed",
      lastProgressAt: Date.now(),
      lastProgressKind: "signal",
    });
  } catch (err) {
    logWarning("engine", `signal runtime cleanup failed: ${getErrorMessage(err)}`, { file: "auto.ts" });
  }

  try {
    if (s.workerId) markActiveForWorkerCanceled(s.workerId, "signal-exit");
  } catch (err) {
    logWarning("engine", `signal dispatch cleanup failed: ${getErrorMessage(err)}`, { file: "auto.ts" });
  }

  try {
    resolveAgentEndCancelled(errorContext);
  } catch (err) {
    logWarning("engine", `signal resolve cleanup failed: ${getErrorMessage(err)}`, { file: "auto.ts" });
  }
}

/** Wrapper: register SIGTERM handler and store reference. */
function registerSigtermHandler(currentBasePath: string): void {
  s.sigtermHandler = _registerSigtermHandler(
    currentBasePath,
    s.sigtermHandler,
    () => {
      closeOutSignalInterruptedUnit(currentBasePath);
      try {
        if (s.workerId) {
          markWorkerStopping(s.workerId);
          s.workerId = null;
        }
      } catch (err) {
        logWarning("engine", `signal worker cleanup failed: ${getErrorMessage(err)}`, { file: "auto.ts" });
      }
    },
  );
}

/** Wrapper: deregister SIGTERM handler and clear reference. */
function deregisterSigtermHandler(): void {
  _deregisterSigtermHandler(s.sigtermHandler);
  s.sigtermHandler = null;
}

/**
 * Wrapper: start background command polling for the configured remote channel
 * (currently Telegram only). Stores the cleanup function on the session so
 * every exit path can stop the interval via stopCommandPolling().
 * No-op when no remote channel is configured.
 */
function startAutoCommandPolling(basePath: string): void {
  if (!isRemoteConfigured()) return;
  // Clear any existing interval before starting a new one (e.g. resume path).
  stopAutoCommandPolling();
  s.commandPollingCleanup = _startCommandPolling(basePath);
}

/** Wrapper: stop background command polling and clear the stored cleanup. */
function stopAutoCommandPolling(): void {
  if (s.commandPollingCleanup) {
    s.commandPollingCleanup();
    s.commandPollingCleanup = null;
  }
}

export { type AutoDashboardData } from "./auto-dashboard.js";

export function getAutoDashboardData(): AutoDashboardData {
  const ledger = getLedger();
  const runtimeSnapshot = getAutoRuntimeSnapshot();
  const totals = ledger ? getProjectTotals(ledger.units) : null;
  const sessionId = s.cmdCtx?.sessionManager?.getSessionId?.() ?? null;
  const rtkSavings = sessionId && s.basePath
    ? getRtkSessionSavings(s.basePath, sessionId)
    : null;
  const rtkEnabled = loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences.experimental?.rtk === true;
  // Pending capture count — lazy check, non-fatal
  let pendingCaptureCount = 0;
  try {
    if (s.basePath) {
      pendingCaptureCount = countPendingCaptures(s.basePath);
    }
  } catch (err) {
    // Non-fatal — captures module may not be loaded
    logWarning("engine", `capture count failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }
  return {
    active: s.active,
    paused: s.paused,
    stepMode: s.stepMode,
    startTime: s.autoStartTime,
    elapsed: s.active || s.paused
      ? (s.autoStartTime > 0 ? Date.now() - s.autoStartTime : 0)
      : 0,
    currentUnit: s.currentUnit ? { ...s.currentUnit } : null,
    basePath: s.basePath,
    totalCost: totals?.cost ?? 0,
    totalTokens: totals?.tokens.total ?? 0,
    pendingCaptureCount,
    rtkSavings,
    rtkEnabled,
    toolSurface: runtimeSnapshot.toolSurface,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function isAutoActive(): boolean {
  return s.active;
}

export function isAutoCompletionStopInProgress(): boolean {
  return s.completionStopInProgress;
}

/** Test-only seam for validating auto-mode guards (#4704). Do not use in production code. */
export function _setAutoActiveForTest(active: boolean): void {
  s.active = active;
}

/**
 * Test-only seam: emit the missing-worktree warning exactly as the resume path
 * does.  Allows unit tests to verify the warning is produced without
 * bootstrapping the full auto-mode entry point.  Do not use in production code.
 */
export function _warnIfWorktreeMissingForTest(
  worktreePath: string | null | undefined,
  milestoneId: string,
): boolean {
  if (worktreePath && !existsSync(worktreePath)) {
    logWarning(
      "session",
      `Worktree was expected at ${worktreePath} but is missing. Resuming from project root; /gsd next will recreate the worktree when isolation is enabled.`,
      { file: "auto.ts", milestoneId },
    );
    return true;
  }
  return false;
}

export function anchorProcessCwdForAutoResume(
  basePath: string,
  fallbackPaths: string[] = [],
): boolean {
  const candidates = [basePath, ...fallbackPaths].filter(
    (candidate, index, all) =>
      Boolean(candidate) && all.indexOf(candidate) === index,
  );
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      process.chdir(candidate);
      return true;
    } catch (err) {
      logWarning(
        "session",
        `resume cwd anchor failed for ${candidate}: ${err instanceof Error ? err.message : String(err)}`,
        { file: "auto.ts", basePath: candidate },
      );
    }
  }
  logWarning(
    "session",
    `resume cwd anchor failed: no usable directory among ${candidates.join(", ")}`,
    { file: "auto.ts" },
  );
  return false;
}

export function isAutoPaused(): boolean {
  return s.paused;
}

export interface ResumeResourceRefreshDeps {
  env?: NodeJS.ProcessEnv;
  importModule?: (specifier: string) => Promise<any>;
  openProjectDb?: (basePath: string) => Promise<void>;
}

export async function refreshResumeResourcesAndDb(
  basePath: string,
  deps: ResumeResourceRefreshDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const importModule = deps.importModule ?? ((specifier: string) => import(specifier));
  const agentDir = env.GSD_CODING_AGENT_DIR || join(gsdHome(), "agent");
  const pkgRoot = env.GSD_PKG_ROOT;
  const resourceLoaderPath = pkgRoot
    ? pathToFileURL(join(pkgRoot, "dist", "resource-loader.js")).href
    : new URL("../../../resource-loader.js", import.meta.url).href;
  const { initResources } = await importModule(resourceLoaderPath);
  initResources(agentDir);
  const { primeCache } = await importModule("./prompt-loader.js");
  primeCache();
  await (deps.openProjectDb ?? openProjectDbIfPresent)(basePath);
}

export function setActiveEngineId(id: string | null): void {
  s.activeEngineId = id;
}

export function getActiveEngineId(): string | null {
  return s.activeEngineId;
}

export function setActiveRunDir(runDir: string | null): void {
  s.activeRunDir = runDir;
}

export function getActiveRunDir(): string | null {
  return s.activeRunDir;
}

/**
 * Return the model captured at auto-mode start for this session.
 * Used by error-recovery to fall back to the session's own model
 * instead of reading (potentially stale) preferences from disk (#1065).
 */
export function getAutoModeStartModel(): {
  provider: string;
  id: string;
} | null {
  return s.autoModeStartModel;
}

/**
 * Update the dashboard-facing dispatched model label.
 * Used when runtime recovery switches models mid-unit (e.g. provider fallback)
 * so the AUTO box reflects the active model immediately.
 */
export function setCurrentDispatchedModelId(model: { provider: string; id: string } | null): void {
  s.currentDispatchedModelId = model ? `${model.provider}/${model.id}` : null;
}

/**
 * Update the active unit model after runtime recovery switches models mid-unit.
 * The next session restore path reads this field before dispatching again.
 */
export function setCurrentUnitModelForRecovery(model: any | null): void {
  s.currentUnitModel = model;
}

// Tool tracking — delegates to auto-tool-tracking.ts
export function markToolStart(toolCallId: string, toolName?: string): void {
  _markToolStart(toolCallId, s.active, toolName);
}

export function markToolEnd(toolCallId: string): void {
  _markToolEnd(toolCallId);
}

/**
 * Record a tool invocation error on the current session (#2883).
 * Called from tool_execution_end when a GSD tool fails with isError.
 * Stores the error if it matches:
 *   - tool-invocation-error pattern (malformed/truncated JSON)
 *   - failed ScheduleWakeup continuation validation (#1379)
 *   - queued-user-message skip pattern
 *   - deterministic policy rejection (#4973, e.g. context_write_blocked)
 */
export function recordToolInvocationError(toolName: string, errorMsg: string): void {
  if (!s.active) return;
  s.lastToolInvocationError = updateToolInvocationError(
    s.lastToolInvocationError,
    toolName,
    errorMsg,
  );
}

export function getOldestInFlightToolAgeMs(): number {
  return _getOldestInFlightToolAgeMs();
}

/**
 * Return the base path to use for the auto.lock file.
 * Always uses the original project root (not the worktree) so that
 * a second terminal can discover and stop a running auto-mode session.
 *
 * Delegates to AutoSession.lockBasePath — the single source of truth.
 */
function lockBase(): string {
  return s.lockBasePath;
}

/**
 * Attempt to stop a running auto-mode session from a different process.
 * Reads the lock file at the project root, checks if the PID is alive,
 * and sends SIGTERM to gracefully stop it.
 *
 * Returns true if a remote session was found and signaled, false otherwise.
 */
export function stopAutoRemote(projectRoot: string): {
  found: boolean;
  pid?: number;
  error?: string;
} {
  const lock = readCrashLock(projectRoot);
  if (!lock) return { found: false };

  // Never SIGTERM ourselves — a stale lock with our own PID is not a remote
  // session, it is leftover from a prior loop exit in this process. (#2730)
  if (lock.pid === process.pid) {
    clearLock(projectRoot);
    return { found: false };
  }

  if (!isLockProcessAlive(lock)) {
    // Stale lock — clean it up
    clearLock(projectRoot);
    return { found: false };
  }

  // Send SIGTERM — the auto-mode process has a handler that clears the lock and exits
  try {
    process.kill(lock.pid, "SIGTERM");
    return { found: true, pid: lock.pid };
  } catch (err) {
    return { found: false, error: (err as Error).message };
  }
}

/**
 * Force-stop a remote auto-mode session before stealing its lock.
 * The normal stop path stays SIGTERM-only so cooperative sessions can clean up;
 * this path is only for the explicit "Force start" action.
 */
// Grace window between SIGTERM and SIGKILL so the target can run its cleanup
// handler (lock release, DB snapshot flush, worktree teardown). Polled so a
// process that exits early is not made to wait the full window.
const FORCE_STOP_GRACE_MS = 3000;
const FORCE_STOP_POLL_MS = 100;

export function forceStopAutoRemote(projectRoot: string): {
  found: boolean;
  pid?: number;
  error?: string;
} {
  const lock = readCrashLock(projectRoot);
  if (!lock) return { found: false };

  if (lock.pid === process.pid) {
    clearLock(projectRoot);
    return { found: false };
  }

  if (!isLockProcessAlive(lock)) {
    clearLock(projectRoot);
    return { found: false };
  }

  try {
    process.kill(lock.pid, "SIGTERM");
    // Poll for graceful exit before escalating. Synchronous sleep keeps this
    // function sync for its callers (Atomics.wait times out with no notify).
    const deadline = Date.now() + FORCE_STOP_GRACE_MS;
    while (Date.now() < deadline) {
      if (!isLockProcessAlive(lock)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FORCE_STOP_POLL_MS);
    }
    if (isLockProcessAlive(lock)) {
      process.kill(lock.pid, "SIGKILL");
    }
    clearLock(projectRoot);
    return { found: true, pid: lock.pid };
  } catch (err) {
    return { found: false, error: (err as Error).message };
  }
}

/**
 * Check if a remote auto-mode session is running (from a different process).
 * Reads the crash lock, checks PID liveness, and returns session details.
 * Used by the guard in commands.ts to prevent bare /gsd, /gsd next, and
 * /gsd auto from stealing the session lock.
 */
export function checkRemoteAutoSession(projectRoot: string): {
  running: boolean;
  pid?: number;
  unitType?: string;
  unitId?: string;
  startedAt?: string;
} {
  const lock = readCrashLock(projectRoot);
  if (!lock) return { running: false };

  // Our own PID is not a "remote" session — it is a stale lock left by this
  // process (e.g. after step-mode exit without full cleanup). (#2730)
  if (lock.pid === process.pid) return { running: false };

  if (!isLockProcessAlive(lock)) {
    // Stale lock from a dead process — not a live remote session
    clearLock(projectRoot);
    return { running: false };
  }

  return {
    running: true,
    pid: lock.pid,
    unitType: lock.unitType,
    unitId: lock.unitId,
    startedAt: lock.startedAt,
  };
}

export function isStepMode(): boolean {
  return s.stepMode;
}

function clearUnitTimeout(): void {
  if (s.unitTimeoutHandle) {
    clearTimeout(s.unitTimeoutHandle);
    s.unitTimeoutHandle = null;
  }
  if (s.wrapupWarningHandle) {
    clearTimeout(s.wrapupWarningHandle);
    s.wrapupWarningHandle = null;
  }
  if (s.idleWatchdogHandle) {
    clearInterval(s.idleWatchdogHandle);
    s.idleWatchdogHandle = null;
  }
  if (s.continueHereHandle) {
    clearInterval(s.continueHereHandle);
    s.continueHereHandle = null;
  }
  clearInFlightTools();
}

/** Build snapshot metric opts. */
function buildSnapshotOpts(
  _unitType: string,
  _unitId: string,
): {
  autoSessionKey?: string;
  continueHereFired?: boolean;
  promptCharCount?: number;
  baselineCharCount?: number;
  traceId?: string;
  turnId?: string;
  gitAction?: "commit" | "snapshot" | "status-only";
  gitPush?: boolean;
  gitStatus?: "ok" | "failed";
  gitError?: string;
} & Record<string, unknown> {
  const prefs = loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences;
  const uokFlags = resolveUokFlags(prefs);
  return {
    ...(s.autoStartTime > 0 ? { autoSessionKey: String(s.autoStartTime) } : {}),
    promptCharCount: s.lastPromptCharCount,
    baselineCharCount: s.lastBaselineCharCount,
    traceId: s.currentTraceId ?? undefined,
    turnId: s.currentTurnId ?? undefined,
    ...(uokFlags.gitops
      ? {
          gitAction: uokFlags.gitopsTurnAction,
          gitPush: uokFlags.gitopsTurnPush,
          gitStatus: s.lastGitActionStatus ?? undefined,
          gitError: s.lastGitActionFailure ?? undefined,
        }
      : {}),
    ...(s.currentUnitRouting ?? {}),
  };
}

function currentUnitLabel(): string | null {
  if (!s.currentUnit) return null;
  return `${unitVerb(s.currentUnit.type)} ${s.currentUnit.id}`;
}

export function capturePauseAutoUnitIdentity(): PauseAutoUnitIdentity | null {
  if (!s.currentUnit) return null;
  return {
    type: s.currentUnit.type,
    id: s.currentUnit.id,
    startedAt: s.currentUnit.startedAt,
  };
}

function pauseAutoUnitIdentityMatches(expected: PauseAutoUnitIdentity | null): boolean {
  if (!s.currentUnit) return expected === null;
  return expected !== null &&
    s.currentUnit.type === expected.type &&
    s.currentUnit.id === expected.id &&
    s.currentUnit.startedAt === expected.startedAt;
}

function shouldPreserveCoordinationForPause(errorContext?: ErrorContext): boolean {
  return errorContext?.category === "provider" && errorContext.isTransient === true;
}

function resolvePauseLifecyclePresentation(errorContext?: ErrorContext): {
  status: "paused" | "blocked";
  title: string;
  detail: string;
  nextAction: string;
  commands: string[];
  notifyLevel: "info" | "warning";
  notifyPrefix: string;
} {
  const resumeCmd = s.stepMode ? "/gsd next" : "/gsd auto";
  const modeLabel = s.stepMode ? "Step" : "Auto";
  const defaultPresentation = {
    status: "paused" as const,
    title: `${modeLabel}-mode paused`,
    detail: errorContext?.message ?? "Paused by user request.",
    nextAction: `Type to steer, or run ${resumeCmd} to resume.`,
    commands: [resumeCmd, "/gsd status for overview", "/gsd notifications for history"],
    notifyLevel: "info" as const,
    notifyPrefix: `${modeLabel}-mode paused`,
  };

  const message = errorContext?.message ?? "";
  if (
    message.includes("completed closeout dispatch history") ||
    message.includes("completed complete-milestone dispatch history")
  ) {
    const milestoneMatch = message.match(/Milestone (M\d+[A-Z0-9-]*)/);
    const milestoneId = milestoneMatch?.[1] ?? "this milestone";
    return {
      status: "blocked",
      title: `${modeLabel}-mode blocked`,
      detail: message,
      nextAction: `Run \`/gsd dispatch complete-milestone ${milestoneId}\` to finish closeout, then ${resumeCmd}.`,
      commands: [
        `/gsd dispatch complete-milestone ${milestoneId}`,
        `/gsd status ${milestoneId}`,
        resumeCmd,
      ],
      notifyLevel: "warning",
      notifyPrefix: `${modeLabel}-mode blocked`,
    };
  }

  return defaultPresentation;
}

function setLifecycleOutcome(
  ctx: ExtensionContext | undefined,
  input: {
    status: "paused" | "stopped" | "blocked" | "failed" | "complete" | "waiting" | "step";
    title: string;
    detail?: string | null;
    nextAction: string;
    commands?: string[];
    unitLabel?: string | null;
  },
): void {
  if (!ctx?.hasUI) return;
  const { unitLabel: unitLabelOverride, ...rest } = input;
  setAutoOutcomeWidget(ctx, {
    ...rest,
    unitLabel: unitLabelOverride !== undefined ? unitLabelOverride : currentUnitLabel(),
    startedAt: s.autoStartTime,
  });
}

const TERMINAL_CLOSEOUT_COMMANDS = [
  "/gsd status for overview",
  "/gsd visualize to inspect",
  "/gsd notifications for history",
  "/gsd start for new work",
];

function setTerminalCloseoutOutcome(
  ctx: ExtensionContext | undefined,
  input: {
    milestoneId?: string | null;
    milestoneTitle?: string | null;
    allMilestonesComplete?: boolean;
    reason?: string;
  },
): void {
  if (!ctx?.hasUI) return;
  const milestoneLabel = input.milestoneId ? `Milestone ${input.milestoneId}` : "Milestone";
  const title = input.allMilestonesComplete ? "All milestones complete" : `${milestoneLabel} complete`;
  const titleLine = input.milestoneTitle && input.milestoneId
    ? `${input.milestoneTitle}. `
    : "";
  const nextAction = input.allMilestonesComplete
    ? "Review the closeout, then start new work when ready."
    : "Review the closeout, then start the next milestone when ready.";

  ctx.ui.setHeader?.(() => ({
    render(): string[] { return []; },
    invalidate(): void {},
  }));
  ctx.ui.setStatus?.("gsd-step", undefined);
  ctx.ui?.setGsdProgress?.(undefined);
  ctx.ui.setWidget?.("gsd-progress", undefined);
  const detail = input.allMilestonesComplete && input.milestoneTitle
    ? `${input.milestoneTitle}. All milestones complete`
    : `${titleLine}${input.reason ?? "Milestone closeout finished."}`;
  setLifecycleOutcome(ctx, {
    status: "complete",
    title,
    detail,
    nextAction,
    commands: TERMINAL_CLOSEOUT_COMMANDS,
    unitLabel: input.milestoneId ? `complete-milestone ${input.milestoneId}` : null,
  });
}

function handleLostSessionLock(
  ctx?: ExtensionContext,
  lockStatus?: SessionLockStatus,
): void {
  debugLog("session-lock-lost", {
    lockBase: lockBase(),
    reason: lockStatus?.failureReason,
    existingPid: lockStatus?.existingPid,
    expectedPid: lockStatus?.expectedPid,
  });
  s.active = false;
  s.paused = false;
  deactivateGSD();
  clearUnitTimeout();
  stopAutoCommandPolling();
  restoreProjectRootEnv();
  restoreMilestoneLockEnv();
  deregisterSigtermHandler();
  const base = lockBase();
  const lockFilePath = base ? join(gsdRoot(base), "auto.lock") : "unknown";
  const recoverySuggestion = "\nTo recover, run: gsd doctor --fix";
  const message =
    lockStatus?.failureReason === "pid-mismatch"
      ? lockStatus.existingPid
        ? `Session lock (${lockFilePath}) moved to PID ${lockStatus.existingPid} — another GSD process appears to have taken over. Stopping gracefully.${recoverySuggestion}`
        : `Session lock (${lockFilePath}) moved to a different process — another GSD process appears to have taken over. Stopping gracefully.${recoverySuggestion}`
      : lockStatus?.failureReason === "missing-metadata"
        ? `Session lock metadata (${lockFilePath}) disappeared, so ownership could not be confirmed. Stopping gracefully.${recoverySuggestion}`
        : lockStatus?.failureReason === "compromised"
          ? `Session lock (${lockFilePath}) was compromised during heartbeat checks (PID ${process.pid}). This can happen after long event loop stalls during subagent execution.${recoverySuggestion}`
          : `Session lock lost (${lockFilePath}). Stopping gracefully.${recoverySuggestion}`;
  ctx?.ui.notify(
    message,
    "error",
  );
  ctx?.ui.setStatus("gsd-auto", undefined);
  ctx?.ui.setWidget("gsd-progress", undefined);
  if (ctx) initHealthWidget(ctx);
}

/**
 * Lightweight cleanup after autoLoop exits via step-wizard break.
 *
 * Unlike stopAuto (which tears down the entire session), this only clears
 * the stale unit state, progress widget, status badge, and restores CWD so
 * the dashboard does not show an orphaned timer and the shell is usable.
 */
export async function rerootCommandSession(
  cmdCtx: Pick<ExtensionCommandContext, "newSession"> | null | undefined,
  workspaceRoot: string,
): Promise<{ status: "skipped" | "ok" | "cancelled" | "failed"; error?: string }> {
  if (!cmdCtx || !workspaceRoot) return { status: "skipped" };
  try {
    const result = await cmdCtx.newSession({ workspaceRoot });
    return result.cancelled ? { status: "cancelled" } : { status: "ok" };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * After a completed step-mode unit, warn when usage reaches the configurable
 * soft context threshold. At the fixed hard boundary, write a context-mode
 * snapshot and re-root the visible command session while leaving the NEXT
 * progress surface.
 */
export async function maybeRerootStepSessionForHighContext(
  ctx: ExtensionContext,
  workspaceRoot: string,
  cmdCtx: Pick<ExtensionCommandContext, "getContextUsage" | "newSession"> | null | undefined,
  originalBasePath?: string | null,
): Promise<{ rerooted: boolean }> {
  if (!cmdCtx) return { rerooted: false };

  const contextPercent = cmdCtx.getContextUsage?.()?.percent;
  const { loadEffectiveGSDPreferences } = await import("./preferences.js");
  const prefs = loadEffectiveGSDPreferences(workspaceRoot);
  const compactionThreshold = prefs?.preferences.context_management?.compaction_threshold_percent;

  const shouldWarn = shouldWarnStepSessionForContext(contextPercent, compactionThreshold);
  const shouldReroot = shouldRerootStepSessionForContext(contextPercent);
  if (!shouldWarn && !shouldReroot) {
    return { rerooted: false };
  }

  const displayPercent = (contextPercent as number).toFixed(1);
  const thresholdDisplay = resolveCompactionThresholdPercent(compactionThreshold).toFixed(0);
  if (!shouldReroot) {
    ctx.ui.notify(
      `Step complete — context at ${displayPercent}% (soft threshold: ${thresholdDisplay}%). Use /compact when convenient; continuing in this session is still safe.`,
      "info",
    );
    return { rerooted: false };
  }

  const { resolveWorktreeProjectRoot } = await import("./worktree-root.js");
  const snapshotBase = resolveWorktreeProjectRoot(workspaceRoot, originalBasePath);
  const { writeContextModeCompactionSnapshot } = await import("./context-mode-snapshot.js");
  await writeContextModeCompactionSnapshot(snapshotBase);

  const result = await rerootCommandSession(cmdCtx, workspaceRoot);
  if (result.status === "ok") {
    ctx.ui.notify(
      `Step complete — context at ${displayPercent}% (hard threshold: ${HARD_CONTEXT_REROOT_THRESHOLD_PERCENT}%). Fresh session ready for /gsd next.`,
      "info",
    );
    return { rerooted: true };
  }
  if (result.status === "cancelled") {
    logWarning(
      "engine",
      "step-boundary session re-root was cancelled",
      { file: "auto.ts", basePath: workspaceRoot },
    );
  } else if (result.status === "failed") {
    logWarning(
      "engine",
      `step-boundary session re-root failed: ${result.error ?? "unknown"}`,
      { file: "auto.ts", basePath: workspaceRoot },
    );
  }
  return { rerooted: false };
}

export async function cleanupAfterLoopExit(ctx: ExtensionContext): Promise<void> {
  const preserveStepSurface = s.preserveStepSurfaceAfterLoopExit;
  const preserveCompletionSurface = s.completionStopInProgress;
  const preservePausedSurface = s.paused;
  s.clearCurrentUnit();
  s.active = false;
  deactivateGSD();
  clearUnitTimeout();
  stopAutoCommandPolling();
  restoreProjectRootEnv();
  restoreMilestoneLockEnv();
  if (!preservePausedSurface) clearSessionModelOverrideForCommandSession(ctx);

  // Clear crash lock and release session lock so the next `/gsd next` does
  // not see a stale lock with the current PID and treat it as a "remote"
  // session (which would cause it to SIGTERM itself). (#2730)
  try {
    if (lockBase()) clearLock(lockBase());
    if (lockBase()) releaseSessionLock(lockBase());
  } catch (err) {
    /* best-effort — mirror stopAuto cleanup */
    logWarning("session", `lock cleanup failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }

  // Symmetric teardown for the browser-UAT warm-up preflight (#1259): stop any
  // gsd-browser daemon this session started so the Chrome process does not
  // linger after the loop exits. Re-warms on the next browser-backed run-uat.
  try {
    for (const { projectRoot, error } of teardownWarmedBrowserDaemons()) {
      logWarning("session", `gsd-browser daemon stop failed for ${projectRoot}: ${error}`, { file: "auto.ts" });
    }
  } catch (err) {
    logWarning("session", `browser daemon teardown failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }

  // A transient provider-error pause intentionally leaves the paused badge
  // visible so the user still has a resumable auto-mode signal on screen.
  if (!s.paused) {
    if (preserveCompletionSurface) {
      ctx.ui.setStatus("gsd-auto", undefined);
      if (preserveStepSurface) {
        s.preserveStepSurfaceAfterLoopExit = false;
      }
    } else if (preserveStepSurface) {
      s.preserveStepSurfaceAfterLoopExit = false;
    } else {
      ctx.ui.setStatus("gsd-auto", undefined);
      ctx.ui.setWidget("gsd-progress", undefined);
      if (s.completionStopInProgress) {
        s.completionStopInProgress = false;
      }
      initHealthWidget(ctx);
    }
  }

  // ADR-016 phase 3 (#5693): the stop-path basePath restore + chdir routes
  // through `Lifecycle.restoreToProjectRoot()`, the sole owner of both
  // `s.basePath` mutation and the paired `process.chdir` for auto-loop
  // transitions. The verb assigns `s.basePath` before any throwable work, so
  // a thrown error still leaves basePath restored.
  if (s.originalBasePath && !preserveStepSurface && !preservePausedSurface) {
    try {
      buildLifecycle().restoreToProjectRoot();
    } catch (err) {
      logWarning(
        "engine",
        `restore project root failed: ${err instanceof Error ? err.message : String(err)}`,
        { file: "auto.ts" },
      );
    }
  }

  if (s.originalBasePath && s.cmdCtx && !preserveStepSurface && !preservePausedSurface) {
    const result = await rerootCommandSession(s.cmdCtx, s.originalBasePath);
    if (result.status === "cancelled") {
      logWarning("engine", "post-loop session re-root was cancelled", { file: "auto.ts", basePath: s.originalBasePath });
    } else if (result.status === "failed") {
      logWarning("engine", `post-loop session re-root failed: ${result.error ?? "unknown"}`, { file: "auto.ts", basePath: s.originalBasePath });
    }
  }

  if (preserveStepSurface && s.cmdCtx) {
    const workspaceRoot = s.basePath || s.originalBasePath;
    if (workspaceRoot) {
      await maybeRerootStepSessionForHighContext(ctx, workspaceRoot, s.cmdCtx, s.originalBasePath);
    }
  }
}

export function _cleanupAfterLoopExitForTest(ctx: ExtensionContext): Promise<void> {
  return cleanupAfterLoopExit(ctx);
}

export type AutoWorktreeExitAction = "skip" | "merge" | "preserve";

interface MilestoneCompletionRollup {
  milestoneTitle?: string;
  oneLiner?: string;
  successCriteriaResults?: string;
  definitionOfDoneResults?: string;
  requirementOutcomes?: string;
  deviations?: string;
  followUps?: string;
  keyDecisions?: string[];
  keyFiles?: string[];
  lessonsLearned?: string[];
}

function normalizeFrontmatterList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => typeof item === "string" ? item.trim() : "")
    .filter(item => item.length > 0 && item !== "(none)");
}

function firstBoldParagraph(body: string): string | undefined {
  const match = body.match(/\*\*([^*\n][\s\S]*?)\*\*/);
  return match?.[1]?.replace(/\s+/g, " ").trim() || undefined;
}

function loadMilestoneCompletionRollup(basePath: string, milestoneId: string | null | undefined): MilestoneCompletionRollup {
  if (!milestoneId) return {};
  const summaryPath = resolveMilestoneFile(basePath, milestoneId, "SUMMARY");
  if (!summaryPath || !existsSync(summaryPath)) return {};

  try {
    const raw = readFileSync(summaryPath, "utf-8");
    const [frontmatterLines, body] = splitFrontmatter(raw);
    const frontmatter = frontmatterLines ? parseFrontmatterMap(frontmatterLines) : {};
    return {
      milestoneTitle: typeof frontmatter.title === "string" ? frontmatter.title : undefined,
      oneLiner: firstBoldParagraph(body),
      successCriteriaResults: extractSection(body, "Success Criteria Results") ?? undefined,
      definitionOfDoneResults: extractSection(body, "Definition of Done Results") ?? undefined,
      requirementOutcomes: extractSection(body, "Requirement Outcomes") ?? undefined,
      deviations: extractSection(body, "Deviations") ?? undefined,
      followUps: extractSection(body, "Follow-ups") ?? undefined,
      keyDecisions: normalizeFrontmatterList(frontmatter.key_decisions),
      keyFiles: normalizeFrontmatterList(frontmatter.key_files),
      lessonsLearned: normalizeFrontmatterList(frontmatter.lessons_learned),
    };
  } catch (err) {
    logWarning("dashboard", `completion roll-up summary read failed: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

export function _resolveAutoWorktreeExitActionForTest(
  currentMilestoneId: string | null | undefined,
  milestoneMergedInPhases: boolean,
  milestoneComplete: boolean,
): AutoWorktreeExitAction {
  const action = _selectStopAutoWorktreeExit({
    currentMilestoneId: currentMilestoneId ?? null,
    milestoneComplete,
    milestoneMergedInPhases,
  });
  return action === "none" ? "skip" : action;
}

/**
 * Stop the running auto engine: tears down timers, releases locks, exits the
 * current milestone (with optional worktree preservation for slice-parallel
 * dispatch), and resets all engine state. Safe to call when the engine is
 * already stopped.
 */
export async function stopAuto(
  ctx?: ExtensionContext,
  pi?: ExtensionAPI,
  reason?: string,
  options: StopAutoOptions = {},
): Promise<void> {
  if (!s.active && !s.paused) return;
  const loadedPreferences = loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences;
  const stopNotificationPrefix = formatStopNoticePrefix(reason);
  const displayReason = stopNoticeDisplayReason(reason);
  const isHeadlessStop = process.env.GSD_HEADLESS === "1";
  const completionStopRequested = Boolean(options.completionWidget);
  const preserveCloseoutTranscript = !isHeadlessStop && (
    options.preserveCloseoutTranscript ?? completionStopRequested
  );
  const installCompletionWidget = completionStopRequested && !preserveCloseoutTranscript;
  const installTerminalCloseoutOutcome = completionStopRequested && preserveCloseoutTranscript;
  const preserveCompletionSurface = completionStopRequested || preserveCloseoutTranscript;
  s.completionStopInProgress = preserveCompletionSurface;
  try {
    checkpointWorkflowDatabase();
  } catch (e) {
    debugLog("stop-checkpoint-failed", { error: e instanceof Error ? e.message : String(e) });
  }
  playNotificationBell("stop", loadedPreferences?.notifications);

  // #4764 — telemetry: record the exit reason, isolation mode, whether an auto
  // worktree was active, and whether the current milestone was merged before
  // stopAuto. The unmerged-work warning is only meaningful for real worktrees.
  try {
    const {
      autoExitReasonForTerminalOutcome,
      emitAutoExit,
      normalizeAutoExitReason,
    } = await import("./worktree-telemetry.js");
    // Normalize the free-form reason to a closed set so the telemetry
    // aggregator buckets stably. Raw detail is preserved in the phases.ts
    // notification and the notify'd error string.
    const rawReason = reason ?? "stop";
    const normalizedReason = autoExitReasonForTerminalOutcome(options.terminalOutcome)
      ?? normalizeAutoExitReason(rawReason);
    const telemetryBase = s.originalBasePath || s.basePath;
    emitAutoExit(telemetryBase, {
      reason: normalizedReason,
      rawReason,
      milestoneId: s.currentMilestoneId ?? undefined,
      milestoneMerged: s.milestoneMergedInPhases === true,
      isolationMode: getIsolationMode(telemetryBase),
      worktreeActive: isInAutoWorktree(s.basePath),
    });
  } catch (err) {
    logWarning("engine", `auto-exit telemetry failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    // ── Step 1: Timers and locks ──
    try {
      clearUnitTimeout();
      stopAutoCommandPolling();
      if (lockBase()) clearLock(lockBase());
      if (lockBase()) releaseSessionLock(lockBase());
    } catch (e) {
      debugLog("stop-cleanup-locks", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 1b: Coordination cleanup (Phase B) ──
    // Release any active milestone lease so other workers don't have to
    // wait for TTL expiry, then mark this worker as stopping. Best-effort:
    // DB unavailability or stale state must not block shutdown.
    try {
      if (s.workerId && s.currentMilestoneId && s.milestoneLeaseToken) {
        releaseMilestoneLease(s.workerId, s.currentMilestoneId, s.milestoneLeaseToken);
      }
      if (s.workerId) {
        markWorkerStopping(s.workerId);
      }
      s.workerId = null;
      s.milestoneLeaseToken = null;
    } catch (e) {
      debugLog("stop-cleanup-coordination", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 1b: Flush queued follow-up messages (#3512) ──
    // Late async notifications (async_job_result, gsd-auto-wrapup) can trigger
    // extra LLM turns after stop. Flush them the same way run-unit.ts does.
    try {
      const cmdCtxAny = s.cmdCtx as Record<string, unknown> | null;
      if (typeof cmdCtxAny?.clearQueue === "function") {
        (cmdCtxAny.clearQueue as () => unknown)();
      }
    } catch (e) {
      debugLog("stop-cleanup-queue", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 2: Skill state ──
    try {
      clearSkillSnapshot();
      resetSkillTelemetry();
    } catch (e) {
      debugLog("stop-cleanup-skills", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 3: SIGTERM handler ──
    try {
      deregisterSigtermHandler();
    } catch (e) {
      debugLog("stop-cleanup-sigterm", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 4: Auto-worktree exit ──
    // When the milestone is complete (has a SUMMARY), merge the worktree branch
    // back to main so code isn't stranded on the worktree branch (#2317).
    // For incomplete milestones, preserve the branch for later resumption.
    //
    // Skip if phases.ts already merged this milestone — avoids the double
    // mergeAndExit that fails because the branch was already deleted (#2645).
    try {
      const stopMilestoneId = _resolveStopAutoMilestoneId(
        s.currentMilestoneId,
        s.basePath,
      );
      if (stopMilestoneId && !s.milestoneMergedInPhases) {
        const notifyCtx = ctx
          ? { notify: ctx.ui.notify.bind(ctx.ui) }
          : { notify: () => {} };
        const lifecycle = buildLifecycle();

        // Check if the milestone is complete. DB status is the authoritative
        // signal — only a successful gsd_complete_milestone call flips it to
        // "complete" (tools/complete-milestone.ts). SUMMARY file presence is
        // NOT sufficient: a blocker placeholder stub or a partial write can
        // leave a file behind without the milestone actually being done,
        // which previously caused stopAuto to merge a failed milestone and
        // emit a misleading metadata-only merge warning (#4175).
        // DB-unavailable projects fall back to SUMMARY-file presence.
        let milestoneComplete = false;
        try {
          if (isDbAvailable()) {
            const dbRow = getMilestone(stopMilestoneId);
            milestoneComplete = dbRow?.status === "complete";
          } else {
            const summaryPath = resolveMilestoneFile(
              s.originalBasePath || s.basePath,
              stopMilestoneId,
              "SUMMARY",
            );
            if (!summaryPath) {
              // Also check in the worktree path (SUMMARY may not be synced yet)
              const wtSummaryPath = resolveMilestoneFile(
                s.basePath,
                stopMilestoneId,
                "SUMMARY",
              );
              milestoneComplete = wtSummaryPath !== null;
            } else {
              milestoneComplete = true;
            }
          }
        } catch (err) {
          // Non-fatal — fall through to preserveBranch path
          logWarning("engine", `milestone summary check failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
        }

        const exitAction = _selectStopAutoWorktreeExit({
          currentMilestoneId: stopMilestoneId,
          milestoneComplete,
          milestoneMergedInPhases: s.milestoneMergedInPhases,
          preserveCompletedMilestoneBranch: options.preserveCompletedMilestoneBranch,
        });

        if (exitAction === "merge") {
          // Milestone is complete — merge worktree branch back to main
          const r = lifecycle.exitMilestone(
            stopMilestoneId,
            { merge: true },
            notifyCtx,
          );
          if (!r.ok && r.cause instanceof Error) throw r.cause;
        } else if (exitAction === "preserve") {
          // Milestone still in progress — preserve branch for later resumption
          const r = lifecycle.exitMilestone(
            stopMilestoneId,
            {
              merge: false,
              preserveBranch: true,
              preserveWorktree: options.preserveWorktree ?? false,
            },
            notifyCtx,
          );
          if (!r.ok && r.cause instanceof Error) throw r.cause;
        }
      }
    } catch (e) {
      ctx?.ui.notify(
        `Worktree cleanup failed for ${s.currentMilestoneId ?? "current milestone"}: ${e instanceof Error ? e.message : String(e)}. Resolve the preserved branch/worktree and run /gsd auto to resume.`,
        "warning",
      );
      debugLog("stop-cleanup-worktree", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 5: Rebuild state while DB is still open (#3599) ──
    // rebuildState() calls deriveState() which needs the DB for authoritative
    // state. Previously this ran after closeDatabase(), forcing a filesystem
    // fallback that could disagree with the DB-backed dispatch decisions —
    // a split-brain where dispatch says "blocked" but STATE.md shows work.
    if (s.basePath) {
      try {
        await rebuildState(s.basePath);
      } catch (e) {
        debugLog("stop-rebuild-state-failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Pre-compute completion widget slice counts while the DB is still open.
    // Step 8 runs after closeDatabase(), so DB-backed slice lookups must happen here.
    const completionMilestoneId = options.completionWidget?.milestoneId ?? s.currentMilestoneId;
    let completedSlices: number | null = null;
    let totalSlices: number | null = null;
    if (preserveCompletionSurface && options.completionWidget && completionMilestoneId && isDbAvailable()) {
      try {
        const slices = getMilestoneSlices(completionMilestoneId);
        completedSlices = slices.filter(slice => isClosedStatus(slice.status)).length;
        totalSlices = slices.length;
      } catch (err) {
        logWarning("dashboard", `completion slice stats lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Step 6: DB cleanup ──
    if (isDbAvailable()) {
      try {
        closeWorkflowDatabase();
      } catch (e) {
        debugLog("db-close-failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // ── Step 7: Restore basePath and chdir (ADR-016 phase 3, #5693) ──
    // `restoreToProjectRoot` owns both s.basePath restore and process.chdir;
    // no paired chdir is needed at the call site.
    if (s.originalBasePath) {
      try {
        buildLifecycle().restoreToProjectRoot();
      } catch (e) {
        debugLog("stop-cleanup-basepath", { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Re-root the active command session/tool runtime after worktree teardown.
    // mergeAndExit restores process.cwd(), but AgentSession has already captured
    // its own cwd for tools and system prompt; refresh it before returning to the
    // user so follow-up commands do not target a removed milestone worktree.
    if (s.originalBasePath && ctx && s.cmdCtx) {
      const result = await rerootCommandSession(s.cmdCtx, s.originalBasePath);
      if (result.status === "cancelled") {
        logWarning("engine", "post-stop session re-root was cancelled", { file: "auto.ts", basePath: s.originalBasePath });
      } else if (result.status === "failed") {
        logWarning("engine", `post-stop session re-root failed: ${result.error ?? "unknown"}`, { file: "auto.ts", basePath: s.originalBasePath });
      }
    }

    // ── Step 8: Ledger notification ──
    try {
      if (!preserveCompletionSurface) {
        const ledger = getLedger();
        const isAllComplete = (reason ?? "").startsWith("All milestones complete");
        const isMilestoneComplete = /^Milestone\s+\S+\s+complete$/i.test(reason ?? "");
        const notificationPrefix = isAllComplete
          ? "All milestones complete"
          : isMilestoneComplete
            ? `${reason}. Auto-mode finished this milestone`
            : stopNotificationPrefix;
        if (ledger && ledger.units.length > 0) {
          const totals = getProjectTotals(ledger.units);
          ctx?.ui.notify(
            formatAutoStopNotification(notificationPrefix, totals, ledger.units.length),
            "info",
          );
        } else {
          ctx?.ui.notify(`${notificationPrefix}.`, "info");
        }
      }
    } catch (e) {
      debugLog("stop-cleanup-ledger", { error: e instanceof Error ? e.message : String(e) });
    }

    if (installCompletionWidget && ctx && options.completionWidget) {
      const ledger = getLedger();
      const units = filterUnitsForMilestone(ledger?.units ?? [], completionMilestoneId);
      const totals = units.length > 0 ? getProjectTotals(units) : null;
      let totalInput = 0;
      let totalCacheRead = 0;
      try {
        for (const entry of s.cmdCtx?.sessionManager?.getEntries?.() ?? []) {
          if (entry.type === "message") {
            const msgEntry = entry as SessionMessageEntry;
            if (msgEntry.message?.role === "assistant") {
              const usage = (msgEntry.message as any).usage;
              if (usage) {
                totalInput += usage.input || 0;
                totalCacheRead += usage.cacheRead || 0;
              }
            }
          }
        }
      } catch (err) {
        logWarning("dashboard", `completion stats lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const contextUsage = s.cmdCtx?.getContextUsage?.();
      const milestoneId = completionMilestoneId;
      const rollup = loadMilestoneCompletionRollup(s.originalBasePath || s.basePath, milestoneId);
      const unmappedActiveRequirements = options.completionWidget.allMilestonesComplete
        ? countUnmappedActiveRequirements()
        : 0;
      const requirementsBacklogPreview = unmappedActiveRequirements > 0
        ? buildRequirementsBacklogSummaryLines(
          unmappedActiveRequirements,
          getUnmappedActiveRequirements(),
          3,
        ).slice(1)
        : undefined;
      setCompletionProgressWidget(ctx, {
        milestoneId,
        milestoneTitle: options.completionWidget.milestoneTitle ?? rollup.milestoneTitle,
        oneLiner: rollup.oneLiner,
        successCriteriaResults: rollup.successCriteriaResults,
        definitionOfDoneResults: rollup.definitionOfDoneResults,
        requirementOutcomes: rollup.requirementOutcomes,
        deviations: rollup.deviations,
        followUps: rollup.followUps,
        keyDecisions: rollup.keyDecisions,
        keyFiles: rollup.keyFiles,
        lessonsLearned: rollup.lessonsLearned,
        reason: reason ?? "Milestone complete",
        startedAt: s.autoStartTime,
        totalCost: totals?.cost ?? 0,
        totalTokens: totals?.tokens.total ?? 0,
        unitCount: units.length,
        cacheHitRate: totalCacheRead + totalInput > 0
          ? (totalCacheRead / (totalCacheRead + totalInput)) * 100
          : null,
        contextPercent: contextUsage?.percent ?? null,
        contextWindow: contextUsage?.contextWindow ?? s.cmdCtx?.model?.contextWindow ?? null,
        completedSlices,
        totalSlices,
        allMilestonesComplete: options.completionWidget.allMilestonesComplete,
        unmappedActiveRequirements,
        requirementsBacklogPreview,
        basePath: s.originalBasePath || s.basePath || null,
      });
      if (process.env.GSD_HEADLESS === "1") {
        ctx.ui.notify(`${stopNotificationPrefix}.`, "info");
      }
    }

    if (installTerminalCloseoutOutcome && ctx && options.completionWidget) {
      setTerminalCloseoutOutcome(ctx, {
        milestoneId: completionMilestoneId,
        milestoneTitle: options.completionWidget.milestoneTitle ?? null,
        allMilestonesComplete: options.completionWidget.allMilestonesComplete,
        reason: reason ?? "Milestone closeout finished.",
      });
    }

    // ── Step 9: Cmux sidebar / event log ──
    try {
      pi?.events.emit(CMUX_CHANNELS.SIDEBAR, { action: "clear" as const, preferences: loadedPreferences });
      pi?.events.emit(CMUX_CHANNELS.LOG, {
        preferences: loadedPreferences,
        message: `${stopNotificationPrefix}.`,
        level: isBlockedStopReason(reason) ? "warning" : "info",
      });
    } catch (e) {
      debugLog("stop-cleanup-cmux", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 10: Debug summary ──
    try {
      if (isDebugEnabled()) {
        const logPath = writeDebugSummary();
        if (logPath && !preserveCompletionSurface) {
          ctx?.ui.notify(`Debug log written → ${logPath}`, "info");
        }
      }
    } catch (e) {
      debugLog("stop-cleanup-debug", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 11: Reset metrics, routing, hooks ──
    try {
      resetMetrics();
      resetRoutingHistory();
      resetHookState();
      if (s.basePath) clearPersistedHookState(s.basePath);
    } catch (e) {
      debugLog("stop-cleanup-metrics", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 12: Remove paused-session metadata (#1383) ──
    // Phase C pt 2: deleteRuntimeKv replaces unlinkSync(paused-session.json).
    try {
      deleteRuntimeKv("global", "", PAUSED_SESSION_KV_KEY);
    } catch (err) { /* non-fatal */
      logWarning("engine", `paused-session DB delete failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }

    // ── Step 13: Restore original model + thinking (before reset clears IDs) ──
    try {
      if (pi && ctx && s.originalModelId && s.originalModelProvider) {
        const original = ctx.modelRegistry.find(
          s.originalModelProvider,
          s.originalModelId,
        );
        if (original) await pi.setModel(original);
      }
      if (pi && s.originalThinkingLevel) {
        pi.setThinkingLevel(s.originalThinkingLevel);
      }
    } catch (e) {
      debugLog("stop-cleanup-model", { error: e instanceof Error ? e.message : String(e) });
    }

    // ── Step 14: Unblock pending unitPromise (#1799) ──
    // resolveAgentEnd unblocks autoLoop's `await unitPromise` so it can see
    // s.active === false and exit cleanly. Without this, autoLoop hangs
    // forever and the interactive loop is blocked.
    try {
      resolveAgentEnd({ messages: [] });
      _resetPendingResolve();
    } catch (e) {
      debugLog("stop-cleanup-pending-resolve", { error: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    // ── Critical invariants: these MUST execute regardless of errors ──
    // Browser teardown — prevent orphaned Chrome processes across retries (#1733)
    try {
      const { getBrowser } = await import("../browser-tools/state.js");
      if (getBrowser()) {
        const { closeBrowser } = await import("../browser-tools/lifecycle.js");
        await closeBrowser();
      }
    } catch (err) { /* non-fatal: browser-tools may not be loaded */
      logWarning("engine", `browser teardown failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }

    // External cleanup (not covered by session reset)
    clearInFlightTools();
    clearSliceProgressCache();
    clearActivityLogState();
    setLevelChangeCallback(null);
    resetProactiveHealing();

    // UI cleanup
    ctx?.ui.setStatus("gsd-auto", undefined);
    if (installCompletionWidget) {
      // Completion stops keep the durable final closeout surface visible.
    } else if (preserveCompletionSurface) {
      // Foreground closeout-boundary stops preserve the transcript that the
      // completing unit already printed. Avoid replacing it with a widget or
      // clearing the progress slot, which can push the closeout into scrollback.
    } else {
      ctx?.ui.setWidget("gsd-progress", undefined);
      const status = isBlockedStopReason(reason) ? "blocked" : reason?.toLowerCase().includes("fail") ? "failed" : "stopped";
      setLifecycleOutcome(ctx, {
        status,
        title: status === "blocked" ? "Auto-mode blocked" : status === "failed" ? "Auto-mode stopped with an issue" : "Auto-mode stopped",
        detail: displayReason || "Auto-mode stopped.",
        nextAction: status === "blocked"
          ? "Fix the blocker, then run /gsd auto to resume."
          : "Run /gsd status to inspect the current project state, or /gsd auto to continue.",
        commands: ["/gsd status to inspect", "/gsd auto to run", "/gsd report for snapshots", "/gsd notifications for history"],
      });
      if (ctx) initHealthWidget(ctx);
    }
    restoreProjectRootEnv();
    restoreMilestoneLockEnv();

    // Drop the active-tool baseline so a subsequent /gsd auto run on the
    // same `pi` instance recaptures from the live tool set rather than
    // restoring this session's snapshot and silently undoing any tool
    // changes the user made between sessions (#4959).
    if (pi) clearToolBaseline(pi);

    try {
      await s.orchestration?.stop(reason ?? "stop");
    } catch (err) {
      debugLog("stop-orchestration-stop", { error: err instanceof Error ? err.message : String(err) });
    }

    clearSessionModelOverrideForCommandSession(ctx);

    // Reset all session state in one call
    s.resetAfterStop({ preserveCompletionSurface });
  }
}

export type StopAutoWorktreeExitAction = "none" | "merge" | "preserve";

export function _resolveStopAutoMilestoneId(
  currentMilestoneId: string | null,
  basePath: string,
): string | null {
  if (currentMilestoneId) return currentMilestoneId;
  const detected = detectWorktreeName(basePath);
  return detected && MILESTONE_ID_RE.test(detected) ? detected : null;
}

export function _selectStopAutoWorktreeExit(args: {
  currentMilestoneId: string | null;
  milestoneComplete: boolean;
  milestoneMergedInPhases: boolean;
  preserveCompletedMilestoneBranch?: boolean;
}): StopAutoWorktreeExitAction {
  if (!args.currentMilestoneId || args.milestoneMergedInPhases) return "none";
  if (args.milestoneComplete && args.preserveCompletedMilestoneBranch) return "preserve";
  return args.milestoneComplete ? "merge" : "preserve";
}

/**
 * Pause auto-mode without destroying state. Context is preserved.
 * The user can interact with the agent, then `/gsd auto` resumes
 * from disk state. Called when the user presses Escape or runs `/gsd pause`.
 */
export async function pauseAuto(
  ctx?: ExtensionContext,
  _pi?: ExtensionAPI,
  _errorContext?: ErrorContext,
  options: PauseAutoOptions = {},
): Promise<void> {
  if (!s.active) return;
  if (
    Object.prototype.hasOwnProperty.call(options, "expectedCurrentUnit") &&
    !pauseAutoUnitIdentityMatches(options.expectedCurrentUnit ?? null)
  ) {
    debugLog("pause-auto-stale-unit-guard", {
      expectedCurrentUnit: options.expectedCurrentUnit ?? null,
      currentUnit: s.currentUnit,
    });
    return;
  }

  anchorProcessCwdForAutoResume(s.basePath || s.originalBasePath || "", [
    s.originalBasePath,
    lockBase(),
  ].filter((path): path is string => Boolean(path)));

  s.active = false;
  s.paused = true;
  if (options.abortActiveTurn && ctx && !ctx.isIdle()) ctx.abort();
  clearUnitTimeout();
  stopAutoCommandPolling();

  // Flush queued follow-up messages (#3512).
  // Late async notifications (async_job_result, gsd-auto-wrapup) can trigger
  // extra LLM turns after pause. Flush them the same way run-unit.ts does.
  try {
    const cmdCtxAny = s.cmdCtx as Record<string, unknown> | null;
    if (typeof cmdCtxAny?.clearQueue === "function") {
      (cmdCtxAny.clearQueue as () => unknown)();
    }
  } catch (e) {
    debugLog("pause-cleanup-queue", { error: e instanceof Error ? e.message : String(e) });
  }

  // Unblock any pending unit promise so the auto-loop is not orphaned.
  // Pass errorContext so runUnitPhase can distinguish user-initiated pause
  // from provider-error pause and avoid hard-stopping (#2762).
  resolveAgentEndCancelled(_errorContext);

  s.pausedSessionFile = normalizeSessionFilePath(ctx?.sessionManager?.getSessionFile() ?? null);

  // Persist paused-session metadata so resume survives /exit (#1383).
  // Phase C pt 2: persisted to runtime_kv (global scope, key
  // PAUSED_SESSION_KV_KEY) instead of runtime/paused-session.json. The
  // fresh-start bootstrap below reads from the same key.
  try {
    const pausedWorktreePath = resolvePausedAutoWorktreePath({
      basePath: s.basePath,
      originalBasePath: s.originalBasePath,
      currentMilestoneId: s.currentMilestoneId,
      isolationMode: getIsolationMode(s.originalBasePath || s.basePath),
      baseIsAutoWorktree: isInAutoWorktree(s.basePath),
    });
    const pausedMeta: PausedSessionMetadata = {
      milestoneId: s.currentMilestoneId ?? undefined,
      worktreePath: pausedWorktreePath,
      originalBasePath: s.originalBasePath,
      stepMode: s.stepMode,
      pausedAt: new Date().toISOString(),
      sessionFile: s.pausedSessionFile,
      unitType: s.currentUnit?.type ?? undefined,
      unitId: s.currentUnit?.id ?? undefined,
      activeEngineId: s.activeEngineId ?? undefined,
      activeRunDir: s.activeRunDir,
      autoStartTime: s.autoStartTime,
      milestoneLock: s.sessionMilestoneLock ?? undefined,
      pauseReason: _errorContext?.message,
      lastPreExecFailure: s.lastPreExecFailure
        ? {
            ...s.lastPreExecFailure,
            blockingFindings: [...s.lastPreExecFailure.blockingFindings],
          }
        : null,
      preExecRetryCount: Object.fromEntries(s.preExecRetryCount),
    };
    setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, pausedMeta);
  } catch (err) {
    // Non-fatal — resume will still work via full bootstrap, just without worktree context
    logWarning("engine", `paused-session DB write failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }

  const pausedUnitLabel = currentUnitLabel();

  // Close out the current unit so its runtime record doesn't stay at "dispatched"
  if (s.currentUnit && ctx) {
    try {
      await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt);
    } catch (err) {
      // Non-fatal — best-effort closeout on pause
      logWarning("engine", `unit closeout on pause failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }
    s.clearCurrentUnit();
  }

  // Keep STATE.md aligned with the DB-backed state before releasing pause state.
  // Without this, an interrupted deep run can leave STATE.md saying "no active
  // milestone" even after the DB/disk reconciliation has recovered the next unit.
  if (s.basePath) {
    try {
      await rebuildState(s.basePath);
    } catch (e) {
      debugLog("pause-rebuild-state-failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (lockBase()) {
    releaseSessionLock(lockBase());
    clearLock(lockBase());
  }

  if (s.workerId && !shouldPreserveCoordinationForPause(_errorContext)) {
    try {
      if (s.currentMilestoneId && s.milestoneLeaseToken) {
        releaseMilestoneLease(s.workerId, s.currentMilestoneId, s.milestoneLeaseToken);
      }
      markWorkerStopping(s.workerId);
    } catch (err) {
      logWarning("engine", `pause worker cleanup failed: ${getErrorMessage(err)}`, { file: "auto.ts" });
    }
    s.workerId = null;
    s.milestoneLeaseToken = null;
  }

  deregisterSigtermHandler();

  try {
    await s.orchestration?.stop("pause");
  } catch (err) {
    debugLog("pause-orchestration-stop", { error: err instanceof Error ? err.message : String(err) });
  }

  deactivateGSD();
  restoreProjectRootEnv();
  restoreMilestoneLockEnv();
  s.pendingVerificationRetry = null;
  ctx?.ui.setStatus("gsd-auto", "paused");
  ctx?.ui.setWidget("gsd-progress", undefined);
  const lifecycle = resolvePauseLifecyclePresentation(_errorContext);
  setLifecycleOutcome(ctx, {
    status: lifecycle.status,
    title: lifecycle.title,
    detail: lifecycle.detail,
    nextAction: lifecycle.nextAction,
    commands: lifecycle.commands,
    unitLabel: pausedUnitLabel,
  });
  if (ctx) initHealthWidget(ctx);
  const pauseMessage = _errorContext?.message
    ? `${lifecycle.notifyPrefix}: ${_errorContext.message}`
    : `${lifecycle.notifyPrefix} (Escape). Type to interact, or ${lifecycle.commands[0] ?? (s.stepMode ? "/gsd next" : "/gsd auto")} to resume.`;
  ctx?.ui.notify(
    pauseMessage,
    lifecycle.notifyLevel,
  );
}

function restorePausedPreExecRepairState(
  meta: PausedSessionMetadata,
  session: Pick<AutoSession, "lastPreExecFailure" | "preExecRetryCount">,
): void {
  session.lastPreExecFailure = meta.lastPreExecFailure
    ? {
        ...meta.lastPreExecFailure,
        blockingFindings: [...meta.lastPreExecFailure.blockingFindings],
      }
    : null;
  session.preExecRetryCount.clear();
  for (const [unitId, count] of Object.entries(meta.preExecRetryCount ?? {})) {
    if (Number.isSafeInteger(count) && count > 0) {
      session.preExecRetryCount.set(unitId, count);
    }
  }
}

export const _restorePausedPreExecRepairStateForTest = restorePausedPreExecRepairState;

/**
 * Build a WorktreeLifecycle Module wrapping the current session.
 *
 * Per ADR-016, the Lifecycle Module is the typed-Interface owner of milestone
 * entry/exit/merge verbs and calls Projection on lifecycle transitions. The
 * deps bag is intentionally focused — Lifecycle does not see the wider auto-
 * mode dependency graph.
 */
/**
 * Construct a `WorktreeLifecycleDeps` bag without binding to any session.
 *
 * Exported so session-less callers (currently `parallel-merge.ts`) can build
 * the same deps and call `mergeMilestoneStandalone` through the Worktree
 * Lifecycle Module instead of bypassing it (ADR-016 phase 2 / A2).
 */
export function buildWorktreeLifecycleDeps(): WorktreeLifecycleDeps {
  // ADR-016 phase 2 / C-track close-out:
  //   C1 (#5624) — fs + git-CLI primitives inlined
  //   C2 (#5625) — worktree-manager helpers inlined
  //   C3 (#5626) — cache + preferences + paths inlined
  //   C4 (#5627) — GitServiceImpl constructor → gitServiceFactory
  //
  // Final WorktreeLifecycleDeps shape: 3 fields (gitServiceFactory,
  // worktreeProjection, mergeMilestone transaction runner). Down from 18 at slice-7
  // closure.
  return {
    gitServiceFactory: (basePath: string) => {
      const gitConfig =
        loadEffectiveGSDPreferences()?.preferences?.git ?? {};
      return new GitServiceImpl(basePath, gitConfig);
    },
    worktreeProjection: new WorktreeStateProjection(),
    mergeMilestone: createDefaultMilestoneMergeTransaction(),
  };
}

function buildLifecycle(): WorktreeLifecycle {
  return new WorktreeLifecycle(s, buildWorktreeLifecycleDeps());
}

function notifyResumeBlocked(ctx: ExtensionContext, result: Extract<AutoAdvanceResult, { kind: "blocked" }>): void {
  const resumeCmd = s.stepMode ? "/gsd next" : "/gsd auto";
  ctx.ui.notify(`Auto-mode blocked: ${result.reason}. Fix and run ${resumeCmd} to resume.`, "warning");
  setLifecycleOutcome(ctx, {
    status: "blocked",
    title: "Auto-mode blocked",
    detail: result.reason,
    nextAction: `Fix the blocker, then run ${resumeCmd} to resume.`,
    commands: ["/gsd status for overview", `${resumeCmd} to resume`, "/gsd doctor to diagnose"],
  });
}

function ensureOrchestrationModule(ctx: ExtensionContext, pi: ExtensionAPI, basePath: string): void {
  s.orchestration = createAutoOrchestrator({
    ctx,
    pi,
    dispatchBasePath: basePath,
    runtimeBasePath: lockBase(),
    session: s,
  });
}

/**
 * Build the LoopDeps object from auto.ts private scope.
 * This bundles all private functions that autoLoop needs without exporting them.
 */
function buildLoopDeps(pi: ExtensionAPI, ctx: ExtensionContext): LoopDeps {
  // Initialize the unified rule registry with converted dispatch rules.
  // Must happen before LoopDeps is assembled so facade functions
  // (resolveDispatch, runPreDispatchHooks, etc.) delegate to the registry.
  initRegistry(convertDispatchRules(DISPATCH_RULES));

  const cmux = makeCmuxEmitters(pi);
  const worktreeProjection = new WorktreeStateProjection();

  return {
    lockBase,
    buildSnapshotOpts,
    stopAuto,
    pauseAuto,
    clearUnitTimeout,
    checkpointWorkflowDatabase,
    updateProgressWidget,
    ...cmux,
    handleLostSessionLock: (ctx: ExtensionContext | undefined, lockStatus: SessionLockStatus | undefined) => {
      cmux.clearCmuxSidebar(loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences);
      handleLostSessionLock(ctx, lockStatus);
    },

    // State and cache
    invalidateAllCaches,
    deriveState,
    rebuildState,
    loadEffectiveGSDPreferences: () =>
      loadEffectiveGSDPreferencesWithRegistry(
        ctx.modelRegistry,
        s.basePath || undefined,
        resolveProfileAnchorProvider(ctx.model?.provider, s.autoModeStartModel?.provider),
        s.autoModeStartModel ? `${s.autoModeStartModel.provider}/${s.autoModeStartModel.id}` : undefined,
      ),

    // Pre-dispatch health gate
    preDispatchHealthGate,

    // Worktree state projection (ADR-016 — single Module Interface)
    worktreeProjection,

    // Resource version guard
    checkResourcesStale,

    // Session lock
    validateSessionLock: getSessionLockStatus,
    updateSessionLock,

    // Milestone transition
    sendDesktopNotification,
    setActiveMilestoneId,
    pruneQueueOrder,
    isInAutoWorktree,
    shouldUseWorktreeIsolation,
    teardownAutoWorktree,
    createAutoWorktree,
    captureIntegrationBranch,
    getIsolationMode,
    getCurrentBranch,
    autoWorktreeBranch,
    resolveMilestoneFile,
    reconcileMergeState,

    // Budget/context/secrets
    getLedger,
    getProjectTotals,
    formatCost,
    getBudgetAlertLevel,
    getNewBudgetAlertLevel,
    getBudgetEnforcementAction,
    getManifestStatus,
    collectSecretsFromManifest,

    // Dispatch
    resolveDispatch,
    runPreDispatchHooks,
    getPriorSliceCompletionBlocker,
    getMainBranch,
    // Unit closeout + runtime records
    closeoutUnit,
    autoCommitUnit,
    recordOutcome,
    writeLock,
    captureAvailableSkills: () => {
      const unitType = s.currentUnit?.type;
      captureAvailableSkills(effectiveSkillNamesForUnit(unitType, getInstalledSkillNames()));
    },
    ensurePreconditions,
    updateSliceProgressCache,

    // Model selection + supervision
    selectAndApplyModel,
    resolveModelId,
    startUnitSupervision,

    // Prompt helpers
    getDeepDiagnostic: (basePath: string) => {
      const mid = readActiveMilestoneId(basePath);
      const wtPath = mid ? getAutoWorktreePath(basePath, mid) : undefined;
      return getDeepDiagnostic(basePath, wtPath ?? undefined);
    },
    isDbAvailable,
    reorderForCaching,

    // Filesystem
    existsSync,
    readFileSync: (path: string, encoding: string) =>
      readFileSync(path, encoding as BufferEncoding),
    atomicWriteSync,

    // Git
    GitServiceImpl: GitServiceImpl as unknown as LoopDeps["GitServiceImpl"],

    // Worktree Lifecycle Module (ADR-016 — single Module Interface for the
    // milestone create/enter/exit/merge verbs)
    lifecycle: buildLifecycle(),

    // Post-unit processing
    postUnitPreVerification,
    runPostUnitVerification,
    postUnitPostVerification,

    // Session manager
    getSessionFile: (ctx: ExtensionContext) => {
      try {
        return ctx.sessionManager?.getSessionFile() ?? "";
      } catch {
        return "";
      }
    },

    // Journal
    emitJournalEvent: (entry: JournalEntry) => _emitJournalEvent(s.basePath, entry),

    // Clean-root preflight gate (#2909)
    preflightCleanRoot,
    postflightPopStash,
  } as unknown as LoopDeps;
}

/**
 * Start auto-mode. Handles both fresh-start and resume paths, sets up session
 * state, enters the milestone worktree or branch, and dispatches the first unit.
 * No-ops if auto-mode is already active.
 */
export async function startAuto(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  base: string,
  verboseMode: boolean,
  options?: {
    step?: boolean;
    interrupted?: InterruptedSessionAssessment;
    milestoneLock?: string | null;
    resumeWedgeId?: string | null;
  },
): Promise<void> {
  if (s.active) {
    debugLog("startAuto", { phase: "already-active", skipping: true });
    return;
  }

  // On a *fresh* start, drop any stale active-tool baseline left by a prior
  // auto session that didn't run stopAuto cleanly.  Skip on resume: pauseAuto
  // leaves the last provider-trimmed active tools in place, so clearing here
  // would let the next selectAndApplyModel recapture that already-narrowed
  // set as the new baseline — exactly the cross-unit poisoning this PR is
  // fixing (#4959).  The pre-pause baseline survives in
  // the WeakMap keyed by `pi`.
  if (!s.paused) clearToolBaseline(pi);

  const requestedStepMode = options?.step ?? false;
  const interruptedAssessment = options?.interrupted ?? null;
  if (options?.milestoneLock !== undefined) {
    s.sessionMilestoneLock = options.milestoneLock ?? null;
  }
  if (s.sessionMilestoneLock) {
    captureMilestoneLockEnv(s.sessionMilestoneLock);
  }

  // Escape stale worktree cwd from a previous milestone (#608).
  base = escapeStaleWorktree(base);

  const dirCheck = validateDirectory(base);
  if (dirCheck.severity === "blocked") {
    ctx.ui.notify(dirCheck.reason!, "error");
    return;
  }

  // Heal .gsd.migrating before any branching — covers both fresh-start and
  // resume paths (#4416). The matching call in auto-start.ts covers the
  // bootstrap-only path; this call ensures the resume path is also protected.
  if (recoverFailedMigration(base)) {
    ctx.ui.notify("Recovered unfinished external state migration.", "info");
  }

  const unmergedStartMessage = await getUnmergedMilestoneBlockMessageForBase(base, "auto");
  if (unmergedStartMessage) {
    ctx.ui.notify(unmergedStartMessage, "warning");
    debugLog("startAuto", { phase: "unmerged-milestone-blocked", base });
    return;
  }

  const blockedStartMessage = await getValidationBlockMessageForBase(base, "auto");
  if (blockedStartMessage) {
    ctx.ui.notify(blockedStartMessage, "warning");
    debugLog("startAuto", { phase: "validation-blocked", base });
    return;
  }

  // ADR-047 §5: while an unacknowledged wedge record exists, auto-mode
  // refuses to re-enter and reprints the exit instructions — restarting is no
  // longer a silent counter reset. `/gsd auto --resume-wedge <id>` is the one
  // sanctioned re-entry.
  if (!(await ensureDbOpen(base))) {
    const dbStatus = getWorkflowDatabaseStatus();
    if (dbStatus.lastPhase === "locked") {
      const holderPids = listWorkflowDbLockHolderPids(resolveProjectRootDbPath(base));
      ctx.ui.notify(
        formatLockedWorkflowDatabaseNotice(holderPids),
        "error",
      );
      return;
    }
    ctx.ui.notify(
      "Auto-mode blocked — liveness backstop unavailable: workflow database could not be opened. Run `/gsd doctor --fix` before retrying.",
      "error",
    );
    return;
  }
  const openWedgeResult = getOpenWedge(normalizeRealPath(base) || base);
  if (!openWedgeResult.ok) {
    ctx.ui.notify(
      `Auto-mode blocked — liveness backstop unavailable: ${openWedgeResult.error}. Run \`/gsd doctor --fix\` before retrying.`,
      "error",
    );
    return;
  }
  const openWedge = openWedgeResult.wedge;
  if (openWedge && options?.resumeWedgeId !== openWedge.wedgeId) {
    ctx.ui.notify(`Auto-mode blocked — ${formatWedgeRefusalNotice(openWedge)}`, "error");
    debugLog("startAuto", { phase: "wedge-blocked", wedgeId: openWedge.wedgeId, base });
    return;
  }
  if (!openWedge && options?.resumeWedgeId) {
    ctx.ui.notify(`Cannot acknowledge wedge ${options.resumeWedgeId}: no open wedge exists for this project.`, "error");
    return;
  }

  const acknowledgeRequestedWedge = async (): Promise<boolean> => {
    const wedgeId = options?.resumeWedgeId;
    if (!wedgeId) return true;
    if (!s.orchestration?.recheckWedge) {
      ctx.ui.notify(`Cannot acknowledge wedge ${wedgeId}: auto orchestration is unavailable.`, "error");
      return false;
    }
    const scopeId = normalizeRealPath(base) || base;
    const recheckWedge = s.orchestration.recheckWedge.bind(s.orchestration);
    const ack = await acknowledgeWedge(scopeId, wedgeId, recheckWedge);
    if (!ack.ok) {
      ctx.ui.notify(`Cannot acknowledge wedge ${wedgeId}: ${ack.reason}`, "error");
      return false;
    }
    ctx.ui.notify(
      `Wedge ${wedgeId} acknowledged — its originating guard is clear. Re-entering auto-mode.`,
      "info",
    );
    return true;
  };

  const freshStartAssessment = await (interruptedAssessment
    ?? (() => {
      return ensureDbOpen(base).then(() => assessInterruptedSession(base));
    })());

  if (freshStartAssessment.classification === "running") {
    const pid = freshStartAssessment.lock?.pid;
    ctx.ui.notify(
      pid
        ? `Another auto-mode session (PID ${pid}) appears to be running.\nRun \`/gsd stop\` for graceful shutdown, or choose "Force start" from \`/gsd auto\` to terminate it.`
        : "Another auto-mode session appears to be running.",
      "error",
    );
    return;
  }

  // If resuming from paused state, just re-activate and dispatch next unit.
  // Check persisted paused-session first (#1383) — survives /exit.
  // Phase C pt 2: persisted in runtime_kv (global scope) instead of
  // runtime/paused-session.json. The `clearPausedSession` helper
  // replaces every prior unlinkSync(pausedPath) call.
  const clearPausedSession = (logTag: string): void => {
    try {
      deleteRuntimeKv("global", "", PAUSED_SESSION_KV_KEY);
    } catch (err) {
      logWarning("session", `${logTag}: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }
  };

  if (!s.paused) {
    try {
      const meta = freshStartAssessment.pausedSession ?? readPausedSessionMetadata(base);
      if (meta?.activeEngineId && meta.activeEngineId !== "dev") {
        // Custom workflow resume — restore engine state
        s.activeEngineId = meta.activeEngineId;
        s.activeRunDir = meta.activeRunDir ?? null;
        s.originalBasePath = meta.originalBasePath || base;
        s.stepMode = meta.stepMode ?? requestedStepMode;
        s.autoStartTime = meta.autoStartTime || Date.now();
        s.sessionMilestoneLock = meta.milestoneLock ?? null;
        s.paused = true;
        ctx.ui.notify(
          `Resuming paused custom workflow${meta.activeRunDir ? ` (${meta.activeRunDir})` : ""}.`,
          "info",
        );
      } else if (meta?.milestoneId) {
        const shouldResumePausedSession =
          freshStartAssessment.classification === "recoverable"
          && (
            freshStartAssessment.hasResumableDiskState
            || !!freshStartAssessment.recoveryPrompt
            || !!freshStartAssessment.lock
          );
        if (shouldResumePausedSession) {
          // Validate the milestone still exists and isn't already complete (#1664).
          // DB status is authoritative when available; SUMMARY.md is a legacy
          // fallback only for unmigrated/offline projects.
          const mDir = resolveMilestonePath(base, meta.milestoneId);
          let summaryIsTerminal = false;
          let dbAvailable = isDbAvailable();
          let milestoneRow = dbAvailable ? getMilestone(meta.milestoneId) : null;
          if (!milestoneRow) {
            const opened = await ensureDbOpen(base);
            dbAvailable = opened || isDbAvailable();
            if (dbAvailable) {
              milestoneRow = getMilestone(meta.milestoneId);
            }
          }
          if (dbAvailable) {
            summaryIsTerminal = !!milestoneRow && isClosedStatus(milestoneRow.status);
          } else {
            const summaryFile = resolveMilestoneFile(base, meta.milestoneId, "SUMMARY");
            if (summaryFile) {
              try {
                summaryIsTerminal = classifyMilestoneSummaryContent(readFileSync(summaryFile, "utf-8")) !== "failure";
              } catch {
                summaryIsTerminal = false;
              }
            }
          }
          // #1643 / #1644 share this seam: `routePausedSessionResume` subsumes
          // `getSupersedingActiveMilestoneId` here — it discards a missing or
          // terminal pin and, instead of merely starting fresh on a superseded
          // pin, adopts the project's current active milestone.
          const resumeRoute = routePausedSessionResume({
            milestoneDirExists: !!mDir,
            summaryIsTerminal,
            pausedMilestoneId: meta.milestoneId,
            activeMilestoneId: freshStartAssessment.state?.activeMilestone?.id ?? null,
          });
          if (resumeRoute.route === "discard") {
            clearPausedSession("paused-session DB cleanup failed (milestone gone/complete)");
            ctx.ui.notify(
              `Paused milestone ${meta.milestoneId} is ${resumeRoute.reason === "missing" ? "missing" : "already complete"}. Starting fresh.`,
              "info",
            );
          } else if (resumeRoute.route === "adopt-active") {
            // #1643: the paused milestone is still open but a different
            // milestone is now the project's active one. Restoring the stale
            // pin would wedge every iteration on the dispatch mismatch guard,
            // so clear the row and adopt the active milestone (mirroring
            // shouldAdoptActiveMilestone semantics in auto/orchestrator.ts).
            clearPausedSession("paused-session DB cleanup failed (milestone superseded)");
            s.currentMilestoneId = resumeRoute.activeMilestoneId;
            s.milestoneLeaseToken = null;
            ctx.ui.notify(
              `Paused milestone ${meta.milestoneId} was superseded — ${resumeRoute.activeMilestoneId} is now the project's active milestone. Adopting ${resumeRoute.activeMilestoneId}; ${meta.milestoneId} remains open for later dispatch.`,
              "info",
            );
          } else {
            s.currentMilestoneId = meta.milestoneId;
            s.originalBasePath = meta.originalBasePath || base;
            s.stepMode = meta.stepMode ?? requestedStepMode;
            s.pausedSessionFile = normalizeSessionFilePath(meta.sessionFile ?? null);
            s.pausedUnitType = meta.unitType ?? null;
            s.pausedUnitId = meta.unitId ?? null;
            s.autoStartTime = meta.autoStartTime || Date.now();
            s.sessionMilestoneLock = meta.milestoneLock ?? null;
            restorePausedPreExecRepairState(meta, s);
            s.paused = true;
            // Build scope from persisted state. Use worktreePath when present and
            // still on disk so mode is detected correctly; fall back to project root.
            {
              const persistedWorktreePath = meta.worktreePath ?? null;
              if (persistedWorktreePath && !existsSync(persistedWorktreePath)) {
                logWarning(
                  "session",
                  `Worktree was expected at ${persistedWorktreePath} but is missing. Resuming from project root; /gsd next will recreate the worktree when isolation is enabled.`,
                  { file: "auto.ts", milestoneId: meta.milestoneId ?? "" },
                );
              }
              const rawForScope = (persistedWorktreePath && existsSync(persistedWorktreePath))
                ? persistedWorktreePath
                : (s.originalBasePath || base);
              rebuildScope(rawForScope, s.currentMilestoneId);
            }
            ctx.ui.notify(
              `Resuming paused session for ${meta.milestoneId}${meta.worktreePath && existsSync(meta.worktreePath) ? ` (worktree)` : ""}.`,
              "info",
            );
          }
        } else if (meta) {
          // Stale paused-session metadata that the assessment chose not to
          // resume — clean it up so the next bootstrap starts fresh.
          clearPausedSession("stale paused-session DB cleanup failed");
        }
      }
    } catch (err) {
      // Malformed or missing — proceed with fresh bootstrap
      logWarning("session", `paused-session restore failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }
    // Guard against zero/missing autoStartTime after resume (#3585)
    if (!s.autoStartTime || s.autoStartTime <= 0) s.autoStartTime = Date.now();
  }

  if (s.sessionMilestoneLock) {
    captureMilestoneLockEnv(s.sessionMilestoneLock);
  }

  if (!s.paused) {
    s.stepMode = requestedStepMode;
  }

  if (freshStartAssessment.lock) {
    // Emit a synthetic unit-end for any unit-start that has no closing event.
    // This closes the journal gap reported in #3348 where the worker wrote side
    // effects (SUMMARY.md, DB updates) but died before emitting unit-end.
    emitCrashRecoveredUnitEnd(base, freshStartAssessment.lock);
    clearStaleWorkerLock(base);
  }

  if (!s.paused) {
    s.pendingCrashRecovery =
      freshStartAssessment.classification === "recoverable"
        ? freshStartAssessment.recoveryPrompt
        : null;

    if (freshStartAssessment.classification === "recoverable" && freshStartAssessment.lock) {
      const info = formatCrashInfo(freshStartAssessment.lock);
      if (freshStartAssessment.recoveryToolCallCount > 0) {
        ctx.ui.notify(
          `${info}\nRecovered ${freshStartAssessment.recoveryToolCallCount} tool calls from crashed session. Resuming with full context.`,
          "warning",
        );
      } else if (freshStartAssessment.hasResumableDiskState) {
        ctx.ui.notify(`${info}\nResuming from disk state.`, "warning");
      }
    }
  }

  if (s.paused) {
    const resumeLock = acquireSessionLock(base);
    if (!resumeLock.acquired) {
      // Reset paused state so isAutoPaused() doesn't stick true after lock failure.
      // Pause file is preserved on disk for retry — not deleted.
      s.paused = false;
      ctx.ui.notify(`Cannot resume: ${resumeLock.reason}`, "error");
      return;
    }

    s.paused = false;
    s.active = true;
    s.verbose = verboseMode;
    s.stepMode = requestedStepMode;
    s.cmdCtx = ctx;
    // ADR-016 phase 2 / B2 (#5620): bootstrap basePath transition before
    // the resume path consults persisted worktree state. Defensive about
    // s.originalBasePath — the meta-restore above (line 2003 / 2055) may
    // have already populated it from paused metadata; the verb preserves
    // that value.
    buildLifecycle().adoptSessionRoot(base);
    // ── Resume worktree: if the paused session was inside a milestone worktree,
    // apply that path as the dispatch basePath immediately (#3723).
    // This ensures the dispatch loop runs from the worktree directory even when
    // enterMilestone guard conditions differ between the original and resumed
    // session (e.g. isolation mode changed, detectWorktreeName differs across
    // process restarts).  We guard with existsSync so a stale or deleted
    // worktree directory safely falls back to the project root.
    const resumeWorktreePath = freshStartAssessment.pausedSession?.worktreePath ?? null;
    if (resumeWorktreePath && !existsSync(resumeWorktreePath)) {
      logWarning(
        "session",
        `Worktree was expected at ${resumeWorktreePath} but is missing. Resuming from project root; /gsd next will recreate the worktree when isolation is enabled.`,
        { file: "auto.ts", milestoneId: s.currentMilestoneId ?? "" },
      );
    }
    // ADR-016 phase 2 / B3 (#5621): paused-resume worktree-path adoption.
    buildLifecycle().resumeFromPausedSession(base, resumeWorktreePath);
    anchorProcessCwdForAutoResume(s.basePath || base, [
      base,
      s.originalBasePath || base,
    ]);
    // Rebuild scope now that s.basePath reflects the actual worktree (or project root).
    rebuildScope(s.basePath, s.currentMilestoneId);
    // Ensure the workflow-logger audit log is pinned to the project root
    // even when auto-mode is entered via a path that bypasses the
    // bootstrap/dynamic-tools ensureDbOpen() → setLogBasePath() chain
    // (e.g. /clear resume, hot-reload).
    setLogBasePath(base);
    s.unitDispatchCount.clear();
    s.unitLifetimeDispatches.clear();
    if (!getLedger()) initMetrics(base);
    if (s.currentMilestoneId) setActiveMilestoneId(base, s.currentMilestoneId);
    await openProjectDbIfPresent(base);
    registerAutoWorkerForSession(s, base);

    // Re-register health level notification callback lost across process restart
    setLevelChangeCallback((_from, to, summary) => {
      const level = to === "red" ? "error" : to === "yellow" ? "warning" : "info";
      ctx.ui.notify(summary, level as "info" | "warning" | "error");
    });

    // ── Auto-worktree / branch-mode: re-enter on resume ──
    if (
      s.currentMilestoneId &&
      getIsolationMode(s.originalBasePath || s.basePath) !== "none" &&
      s.originalBasePath &&
      !isInAutoWorktree(s.basePath) &&
      !detectWorktreeName(s.basePath) &&
      !detectWorktreeName(s.originalBasePath)
    ) {
      const enterResult = buildLifecycle().enterMilestone(s.currentMilestoneId, {
        notify: ctx.ui.notify.bind(ctx.ui),
      });
      if (!enterResult.ok && enterResult.reason === "lease-conflict") {
        ctx.ui.notify(
          `Cannot resume milestone ${s.currentMilestoneId}: lease is held by another worker.`,
          "error",
        );
        await stopAuto(ctx, pi, "lease-conflict during resume");
        return;
      }
      // s.basePath may have been updated to a worktree path by enterMilestone.
      rebuildScope(s.basePath, s.currentMilestoneId);
    }

    const loopDeps = buildLoopDeps(pi, ctx);
    ensureOrchestrationModule(ctx, pi, s.basePath || base);
    if (!(await acknowledgeRequestedWedge())) {
      await cleanupAfterLoopExit(ctx);
      return;
    }
    registerSigtermHandler(lockBase());

    setAutoActiveStatus(ctx, s.stepMode ? "next" : "auto");
    ctx.ui.setWidget("gsd-health", undefined);
    ctx.ui.notify(
      s.stepMode ? "Step-mode resumed." : "Auto-mode resumed.",
      "info",
    );
    restoreHookState(s.basePath);
    // A restored activeHook has no live dispatch (the sidecar queue is not
    // persisted); re-enqueue it so the hook runs instead of blocking the next
    // unrelated unit's close-out (#1246).
    reconcileRestoredHookDispatch(s.basePath, s.sidecarQueue);
    // A restored gate block has no dispatch either; re-enqueue the blocked
    // hook so a failed blocking gate cannot be bypassed by resuming (#2194).
    reconcileRestoredGateBlock(s.basePath, s.sidecarQueue);
    // Re-sync managed resources on resume so long-lived auto sessions pick up
    // bundled extension updates before resume-time verification/state logic runs.
    // GSD_PKG_ROOT is set by loader.ts and points to the gsd-pi package root.
    // The relative import ("../../../resource-loader.js") only works from the source
    // tree; deployed extensions live at ~/.gsd/agent/extensions/gsd/ where the
    // relative path resolves to ~/.gsd/agent/resource-loader.js which doesn't exist.
    // Using GSD_PKG_ROOT constructs a correct absolute path in both contexts (#3949).
    await refreshResumeResourcesAndDb(s.basePath);
    try {
      await rebuildState(s.basePath);
      pi.events.emit(CMUX_CHANNELS.SIDEBAR, { action: "sync" as const, preferences: loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences, state: await deriveState(s.basePath) });
    } catch (e) {
      debugLog("resume-rebuild-state-failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    try {
      const report = await runGSDDoctor(s.basePath, { fix: true });
      if (report.fixesApplied.length > 0) {
        ctx.ui.notify(
          `Resume: applied ${report.fixesApplied.length} fix(es) to state.`,
          "info",
        );
      }
    } catch (e) {
      debugLog("resume-doctor-failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    invalidateAllCaches();

    handlePausedSessionResumeRecovery(
      s.basePath,
      s,
      (message) => ctx.ui.notify(message, "info"),
    );

    captureProjectRootEnv(s.originalBasePath || s.basePath);
    registerAutoWorkerForSession(s);
    updateSessionLock(
      lockBase(),
      "resuming",
      s.currentMilestoneId ?? "unknown",
    );
    if (s.workerId) {
      writeLock(
        lockBase(),
        "resuming",
        s.currentMilestoneId ?? "unknown",
      );
    }
    clearPausedSession("paused-session DB cleanup failed (resume activation)");
    pi.events.emit(CMUX_CHANNELS.LOG, { preferences: loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences, message: s.stepMode ? "Step-mode resumed." : "Auto-mode resumed.", level: "progress" });

    try {
      const resumeResult = await s.orchestration?.resume();
      if (resumeResult?.kind === "blocked" && resumeResult.action === "stop") {
        notifyResumeBlocked(ctx, resumeResult);
        await cleanupAfterLoopExit(ctx);
        return;
      }
      if (resumeResult?.kind === "blocked") {
        notifyResumeBlocked(ctx, resumeResult);
      }
    } catch (err) {
      debugLog("resume-orchestration-resume", { error: err instanceof Error ? err.message : String(err) });
    }
    startAutoCommandPolling(s.basePath);
    try {
      await runAutoLoopWithUok({
        ctx,
        pi,
        s,
        deps: loopDeps,
        runKernelLoop: runUokKernelLoop,
        runLegacyLoop: runLegacyAutoLoop,
      });
    } finally {
      await cleanupAfterLoopExit(ctx);
    }
    return;
  }

  // ── Fresh start path — delegated to auto-start.ts ──

  // ADR-047 §5 (#2219): acknowledge a requested `--resume-wedge <id>` before
  // any bootstrap work. Once bootstrap has taken over the session, this ctx's
  // notify surface only persists to notifications.jsonl — a refusal fired
  // there never renders and the command looks like a hang. The ack needs only
  // the orchestration recheck (session-independent) and the project-root
  // scope, so it runs safely pre-bootstrap. On refusal, restore the
  // milestone-lock env (captured earlier in startAuto) and return — nothing
  // has been registered or bootstrapped yet.
  if (options?.resumeWedgeId) {
    ensureOrchestrationModule(ctx, pi, s.basePath || base);
    if (!(await acknowledgeRequestedWedge())) {
      restoreMilestoneLockEnv();
      return;
    }
  }

  const bootstrapDeps: BootstrapDeps = {
    shouldUseWorktreeIsolation,
    registerSigtermHandler,
    registerAutoWorkerForSession: (projectRoot) => registerAutoWorkerForSession(s, projectRoot),
    lockBase,
    buildLifecycle,
  };

  // Register the worker before bootstrap enters a milestone worktree.
  // This ensures enterMilestone can claim a lease and seed dispatch claims
  // for crash-recovery fidelity (#5405).
  registerAutoWorkerForSession(s, base);

  const ready = await bootstrapAutoSession(
    s,
    ctx,
    pi,
    base,
    verboseMode,
    requestedStepMode,
    bootstrapDeps,
    freshStartAssessment,
  );
  if (!ready) {
    // bootstrapAutoSession sets s.active = true (auto-start.ts) before several
    // post-activation bail-outs return false without a loop ever running (e.g.
    // the SQLite-unavailable gate). Without this, s.active and the auto lock
    // leak and every later /gsd auto silently no-ops via the re-entry guard
    // (#1235). Run the canonical cleanup so a failed bootstrap stays recoverable.
    if (s.active) await cleanupAfterLoopExit(ctx);
    return;
  }

  // Build scope after bootstrap has populated s.basePath / s.originalBasePath /
  // s.currentMilestoneId (including worktree setup inside bootstrapAutoSession).
  rebuildScope(s.basePath, s.currentMilestoneId);
  const loopDeps = buildLoopDeps(pi, ctx);
  // Rebuild the orchestration module now that bootstrap populated the session
  // base paths. The requested wedge (if any) was already acknowledged
  // pre-bootstrap above, so no post-bootstrap ack gate is needed here (#2219).
  ensureOrchestrationModule(ctx, pi, s.basePath || base);
  captureProjectRootEnv(s.originalBasePath || s.basePath);
  registerAutoWorkerForSession(s);
  try {
    pi.events.emit(CMUX_CHANNELS.SIDEBAR, { action: "sync" as const, preferences: loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences, state: await deriveState(s.basePath) });
  } catch (err) {
    // Best-effort only — sidebar sync must never block auto-mode startup
    logWarning("engine", `cmux sync failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }
  pi.events.emit(CMUX_CHANNELS.LOG, { preferences: loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences, message: requestedStepMode ? "Step-mode started." : "Auto-mode started.", level: "progress" });

  try {
    await s.orchestration?.start({ basePath: s.basePath, trigger: "auto-loop" });
  } catch (err) {
    debugLog("start-orchestration-start", { error: err instanceof Error ? err.message : String(err) });
  }

  startAutoCommandPolling(s.basePath);

  // Dispatch the first unit
  try {
    await runAutoLoopWithUok({
      ctx,
      pi,
      s,
      deps: loopDeps,
      runKernelLoop: runUokKernelLoop,
      runLegacyLoop: runLegacyAutoLoop,
    });
  } finally {
    await cleanupAfterLoopExit(ctx);
  }
}

// describeNextUnit is imported from auto-dashboard.ts and re-exported
export { describeNextUnit } from "./auto-dashboard.js";

/** Thin wrapper: delegates to auto-dashboard.ts, passing state accessors. */
function updateProgressWidget(
  ctx: ExtensionContext,
  unitType: string,
  unitId: string,
  state: GSDState,
): void {
  _updateProgressWidget(ctx, unitType, unitId, state, widgetStateAccessors);
}

/** State accessors for the widget — closures over module globals. */
const widgetStateAccessors: WidgetStateAccessors = {
  getAutoStartTime: () => s.autoStartTime,
  isStepMode: () => s.stepMode,
  getCmdCtx: () => s.cmdCtx,
  getBasePath: () => s.basePath,
  isVerbose: () => s.verbose,
  isSessionSwitching: isSessionSwitchInFlight,
  getCurrentDispatchedModelId: () => s.currentDispatchedModelId,
};

// ─── Preconditions ────────────────────────────────────────────────────────────

/**
 * Ensure directories, branches, and other prerequisites exist before
 * dispatching a unit. The LLM should never need to mkdir or git checkout.
 */
export function ensurePreconditions(
  unitType: string,
  unitId: string,
  base: string,
  state: GSDState,
): void {
  const { milestone: mid, slice: sid } = parseUnitId(unitId);

  const mDir = resolveMilestonePath(base, mid);
  if (!mDir) {
    // Fix #4996: When dispatching a slice unit against an unrecognised milestone,
    // only create the directory if the milestone has a DB row.
    // Without this guard, forward-referenced unit IDs (e.g. from REQUIREMENTS.md)
    // silently scaffold empty stub directories that later skew nextMilestoneId.
    if (sid !== undefined) {
      const hasDbRow = isDbAvailable() && getMilestone(mid) != null;
      if (!hasDbRow) {
        logWarning("engine", `ensurePreconditions: skipping mkdir for unrecognised milestone ${mid} referenced by slice unit ${unitId} — no DB row exists`, { file: "auto.ts" });
        return;
      }
    }
    // Layout-aware: if the legacy milestones/ dir exists, place the new milestone dir
    // there (preserves the existing project layout). Otherwise use flat-phase phases/.
    const legacyBase = legacyMilestonesDir(base);
    const isLegacyLayout = isLegacyMilestonesLayout(base);
    const targetBase = isLegacyLayout ? legacyBase : milestonesDir(base);
    // Flat-phase: look up the milestone title to build the canonical NN-slug dir name
    // (e.g. "01-foundation") that resolveMilestonePath will later find by prefix.
    // Legacy layout keeps the raw milestone id (e.g. "M001").
    const dirName = isLegacyLayout
      ? mid
      : canonicalPhaseDirName(mid, getMilestone(mid)?.title);
    const newDir = join(targetBase, dirName);
    // Legacy projects use a slices/ subdir; flat-phase uses top-level plan files (no slices/).
    mkdirSync(isLegacyLayout ? join(newDir, "slices") : newDir, { recursive: true });
  }

  if (sid !== undefined) {
    const isLegacyLayout = isLegacyMilestonesLayout(base);
    // Flat-phase: tasks are checkboxes in NN-MM-PLAN.md — no slices/ subdir needed.
    if (!isLegacyLayout) return;

    const mDirResolved = resolveMilestonePath(base, mid);
    if (mDirResolved) {
      const slicesDir = join(mDirResolved, "slices");
      const sDir = resolveDir(slicesDir, sid);
      if (!sDir) {
        mkdirSync(join(slicesDir, sid, "tasks"), { recursive: true });
      }
      const resolvedSliceDir = resolveDir(slicesDir, sid) ?? sid;
      const tasksDir = join(slicesDir, resolvedSliceDir, "tasks");
      if (!existsSync(tasksDir)) {
        mkdirSync(tasksDir, { recursive: true });
      }
    }
  }
}

export async function dispatchHookUnit(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  hookName: string,
  triggerUnitType: string,
  triggerUnitId: string,
  hookPrompt: string,
  hookModel: string | undefined,
  targetBasePath: string,
): Promise<boolean> {
  const wasActive = s.active;
  const previousBasePath = s.basePath;
  const previousCurrentUnit = s.currentUnit ? { ...s.currentUnit } : null;

  if (!s.active) {
    s.active = true;
    s.stepMode = true;
    s.cmdCtx = ctx as ExtensionCommandContext;
    s.autoStartTime = Date.now();
    s.clearCurrentUnit();
    s.pendingQuickTasks = [];
  }

  // ADR-016 phase 2 / B2 (#5620): hook-trigger basePath transition. Treats
  // the trigger as a bootstrap variant — if the session is fresh,
  // `originalBasePath` gets set to `targetBasePath`; if the session was
  // already active with an established `originalBasePath`, the verb
  // preserves it.
  buildLifecycle().adoptSessionRoot(targetBasePath);
  if (!s.orchestration) {
    ensureOrchestrationModule(ctx, pi, s.basePath);
  }

  const hookUnitType = `hook/${hookName}`;
  const hookStartedAt = Date.now();

  s.setCurrentUnit({
    type: triggerUnitType,
    id: triggerUnitId,
    startedAt: hookStartedAt,
    workspaceRoot: s.basePath,
  });

  const cmdCtx = s.cmdCtx;
  if (typeof cmdCtx?.newSession !== "function") {
    const message = "Auto-mode has no command context for dispatch.";
    ctx.ui.notify(message, "error");
    const unitToCommit = previousCurrentUnit ?? s.currentUnit;
    if (unitToCommit) {
      await autoCommitUnit(s.basePath, unitToCommit.type, unitToCommit.id, ctx);
    }
    await stopAuto(ctx, pi, message, { preserveWorktree: true });
    return false;
  }

  const result = await cmdCtx.newSession({ workspaceRoot: s.basePath });
  if (result.cancelled) {
    await stopAuto(ctx, pi);
    return false;
  }

  s.setCurrentUnit({
    type: hookUnitType,
    id: triggerUnitId,
    startedAt: hookStartedAt,
    workspaceRoot: s.basePath,
  });

  // Resolve the hook's model honoring the configured `fallbacks[]` chain
  // (#1229). The manual trigger path bypasses selectAndApplyModel, so resolve
  // the primary→fallbacks order here and apply the first candidate available in
  // the registry — a blocked or unconfigured primary then transparently drops
  // to a fallback instead of silently reverting to the session model.
  const availableModels = ctx.modelRegistry.getAvailable();
  const availableModelIds = availableModels.map(
    (m: { provider: string; id: string }) => `${m.provider}/${m.id}`,
  );
  const hookModelConfig = resolveModelWithFallbacksForUnit(
    hookUnitType,
    targetBasePath,
    availableModelIds,
  );
  const modelCandidates = hookModelConfig
    ? [hookModelConfig.primary, ...hookModelConfig.fallbacks]
    : hookModel
      ? [hookModel]
      : [];
  if (modelCandidates.length > 0) {
    let applied = false;
    for (const candidate of modelCandidates) {
      const match = resolveModelId(candidate, availableModels, ctx.model?.provider);
      if (!match) continue;
      // Skip models the runtime has marked blocked or temporarily unavailable
      // (e.g. a primary that just tripped a provider limit) so the configured
      // fallbacks[] chain actually engages — parity with auto-mode's
      // selectAndApplyModel, which consults the same blocked-models store (#1229).
      if (isModelUnavailable(targetBasePath, match.provider, match.id)) continue;
      try {
        if (await pi.setModel(match)) {
          // The manual trigger path bypasses selectAndApplyModel, so apply the
          // hook's per-field `thinking` (from `post_unit_hooks[].model`'s object
          // form) here against the just-set model rather than leaving the hook at
          // the session level (#1269). Absent → session level, unchanged.
          if (hookModelConfig?.thinking) {
            applyThinkingLevelForModel(pi, hookModelConfig.thinking, match, ctx);
          }
          applied = true;
          break;
        }
      } catch (err) {
        /* non-fatal — try the next fallback */
        logWarning("dispatch", `hook model set failed for ${candidate}: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
      }
    }
    if (!applied) {
      ctx.ui.notify(
        `Hook model${modelCandidates.length > 1 ? "s" : ""} "${modelCandidates.join(", ")}" not available. ` +
        `Falling back to current session model. ` +
        `Ensure the model is defined in models.json and has auth configured.`,
        "warning",
      );
    }
  }

  const sessionFile = normalizeSessionFilePath(ctx.sessionManager.getSessionFile());
  writeLock(
    lockBase(),
    hookUnitType,
    triggerUnitId,
    sessionFile ?? undefined,
  );

  clearUnitTimeout();
  const supervisor = resolveAutoSupervisorConfig();
  const hookHardTimeoutMs = (supervisor.hard_timeout_minutes ?? 30) * 60 * 1000;
  s.unitTimeoutHandle = setTimeout(async () => {
    s.unitTimeoutHandle = null;
    if (!s.active) return;
    ctx.ui.notify(
      `Hook ${hookName} exceeded ${supervisor.hard_timeout_minutes ?? 30}min timeout. Pausing auto-mode.`,
      "warning",
    );
    resetHookState();
    await pauseAuto(ctx, pi);
  }, hookHardTimeoutMs);

  setAutoActiveStatus(ctx, s.stepMode ? "next" : "auto");
  ctx.ui.notify(`Running post-unit hook: ${hookName}`, "info");

  debugLog("dispatchHookUnit", {
    phase: "send-message",
    promptLength: hookPrompt.length,
  });
  pi.sendMessage(
    { customType: "gsd-auto", content: hookPrompt, display: true },
    { triggerTurn: true },
  );

  return true;
}

// Re-export recovery functions for external consumers
export {
  buildLoopRemediationSteps,
} from "./auto-recovery.js";
export { resolveExpectedArtifactPath } from "./auto-artifact-paths.js";
