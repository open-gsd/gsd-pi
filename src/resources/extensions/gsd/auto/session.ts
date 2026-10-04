// Project/App: gsd-pi
// File Purpose: Mutable auto-mode session state container.
/**
 * AutoSession — encapsulates all mutable auto-mode state into a single instance.
 *
 * Replaces ~40 module-level variables scattered across auto.ts with typed
 * properties on a class instance. Benefits:
 *
 * - reset() clears everything in one call (was 25+ manual resets in stopAuto)
 * - toJSON() provides diagnostic snapshots
 * - grep `s.` shows every state access
 * - Constructable for testing
 *
 * MAINTENANCE RULE: All new mutable auto-mode state MUST be added here as a
 * class property, not as a module-level variable in auto.ts. If the state
 * needs clearing on stop, add it to reset(). Tests in
 * auto-session-encapsulation.test.ts enforce that auto.ts has no module-level
 * `let` or `var` declarations.
 */

import type { Api, Model } from "@gsd/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import type { GitServiceImpl } from "../git-service.js";
import { SourceObservationStore, supportsSourceObservationsForUnit } from "../source-observations.js";
import type { BudgetAlertLevel } from "../auto-budget.js";
import type { AutoOrchestrationModule } from "./contracts.js";
import { resolveWorktreeProjectRoot } from "../worktree-root.js";
import { normalizeRealPath } from "../paths.js";
import { noteGlobalIdleWatchdogUnitStarted } from "./global-idle-watchdog.js";
import type { MilestoneScope } from "../workspace.js";
import type { RootDirtySnapshot } from "../root-write-leak-guard.js";
import type { MilestoneSettlementOutcome } from "../milestone-settlement.js";
import type { ToolSurfaceSnapshot } from "../tool-surface-snapshot.js";

// ─── Exported Types ──────────────────────────────────────────────────────────

export interface CurrentUnit {
  type: string;
  id: string;
  startedAt: number;
  workspaceRoot?: string;
}

export interface UnitRouting {
  tier: string;
  modelDowngraded: boolean;
}

export interface StartModel {
  provider: string;
  id: string;
}

export type ThinkingLevelSnapshot = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export interface PendingVerificationRetry {
  unitId: string;
  failureContext: string;
  signature?: string;
  attempt: number;
}

export interface PendingOrchestrationDispatch {
  unitType: string;
  unitId: string;
  prompt: string;
  pauseAfterUatDispatch: boolean;
  state: import("../types.js").GSDState;
  mid: string | undefined;
  midTitle: string | undefined;
  dispatchId?: number;
}

/**
 * A typed item enqueued by postUnitPostVerification for the main loop to
 * drain via the standard runUnit path. Replaces inline dispatch
 * (pi.sendMessage / s.cmdCtx.newSession()) for hooks, triage, and quick-tasks.
 * The queue is the unit_dispatch_sidecars table (db/unit-dispatch-sidecars.ts).
 */
export interface SidecarItem {
  kind: "hook" | "triage" | "quick-task";
  unitType: string;
  unitId: string;
  prompt: string;
  /** Model override for hook units (e.g. "anthropic/claude-3-5-sonnet"). */
  model?: string;
  /** Capture ID for quick-task items. */
  captureId?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const STUB_RECOVERY_THRESHOLD = 2;
export const NEW_SESSION_TIMEOUT_MS = 120_000;

// ─── AutoSession ─────────────────────────────────────────────────────────────

export class AutoSession {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  active = false;
  paused = false;
  completionStopInProgress = false;
  preserveStepSurfaceAfterLoopExit = false;
  stepMode = false;
  verbose = false;
  activeEngineId: string | null = null;
  activeRunDir: string | null = null;
  cmdCtx: ExtensionCommandContext | null = null;

  // ── Paths ────────────────────────────────────────────────────────────────
  basePath = "";
  originalBasePath = "";
  // TODO(C8): remove basePath/originalBasePath once all readers use s.scope
  scope: MilestoneScope | null = null;

  // ── Coordination identity (Phase B — DB-backed coordination) ────────────
  /**
   * Worker registry ID set by registerAutoWorker() at session start. Used by
   * heartbeatAutoWorker() each loop iteration and by recordDispatchClaim()
   * to fence dispatch ledger writes against stale workers.
   */
  workerId: string | null = null;
  /**
   * Active milestone lease fencing token, set by claimMilestoneLease() inside
   * WorktreeLifecycle.enterMilestone(). Threaded into recordDispatchClaim()
   * as milestone_lease_token so out-of-band dispatches by a stale worker
   * are detectable.
   */
  milestoneLeaseToken: number | null = null;
  previousProjectRootEnv: string | null = null;
  hadProjectRootEnv = false;
  projectRootEnvCaptured = false;
  previousMilestoneLockEnv: string | null = null;
  hadMilestoneLockEnv = false;
  milestoneLockEnvCaptured = false;
  sessionMilestoneLock: string | null = null;
  gitService: GitServiceImpl | null = null;

  // ── Dispatch counters ────────────────────────────────────────────────────
  readonly unitDispatchCount = new Map<string, number>();
  readonly unitLifetimeDispatches = new Map<string, number>();

  // ── Timers ───────────────────────────────────────────────────────────────
  unitTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  wrapupWarningHandle: ReturnType<typeof setTimeout> | null = null;
  idleWatchdogHandle: ReturnType<typeof setInterval> | null = null;
  continueHereHandle: ReturnType<typeof setInterval> | null = null;

  // ── Current unit ─────────────────────────────────────────────────────────
  currentUnit: CurrentUnit | null = null;
  unitExecutionInFlight = false;
  currentTraceId: string | null = null;
  currentTurnId: string | null = null;
  currentUnitRouting: UnitRouting | null = null;
  currentMilestoneId: string | null = null;
  readonly sourceObservations = new SourceObservationStore();

  /** Live tool-surface snapshot for dashboard / runtime telemetry while auto is active. */
  toolSurfaceSnapshot: ToolSurfaceSnapshot | null = null;

  // ── Model state ──────────────────────────────────────────────────────────
  autoModeStartModel: StartModel | null = null;
  /** Explicit /gsd model pin captured at bootstrap (session-scoped policy override). */
  manualSessionModelOverride: StartModel | null = null;
  currentUnitModel: Model<Api> | null = null;
  /** Fully-qualified model ID (provider/id) set after selectAndApplyModel + hook overrides (#2899). */
  currentDispatchedModelId: string | null = null;
  originalModelId: string | null = null;
  originalModelProvider: string | null = null;
  autoModeStartThinkingLevel: ThinkingLevelSnapshot | null = null;
  originalThinkingLevel: ThinkingLevelSnapshot | null = null;
  lastBudgetAlertLevel: BudgetAlertLevel = 0;
  /** True after the budget guard looked for metrics.json spend that the database does not hold. */
  uncountedLedgerSpendNotified = false;

  // ── Recovery ─────────────────────────────────────────────────────────────
  pendingCrashRecovery: string | null = null;
  pendingVerificationRetry: PendingVerificationRetry | null = null;
  /**
   * recoveryActionId of the terminal agent-owned abort minted by the last host
   * verification pass. It is the only key `gsd_task_recovery_resume` accepts, so
   * finalize prints it in the `verification-abort` break reason (#1593).
   */
  lastTaskRecoveryAbortId: string | null = null;
  /**
   * Recovery action minted when the safety evidence cross-reference blocked an
   * execute-task unit (#1641 / #1649). Finalize prints it in the
   * `safety-evidence-block` break reason so the sanctioned exit reaches the
   * journal, the dispatch ledger, and the operator.
   */
  lastSafetyBlockRecovery: { recoveryActionId?: string; resumeInstruction: string } | null = null;
  /**
   * Verification retry counts of custom-engine steps, saved in
   * custom-verify-retries.json. A dev-engine unit keeps its count on its
   * dispatch row (budget kind `verification`).
   */
  readonly verificationRetryCount = new Map<string, number>();
  /**
   * Budget counts for units that run with no unit_dispatches row (custom-engine
   * steps, no database). A unit with a dispatch row keeps its counts on that
   * row instead — see db/unit-dispatch-budgets.ts (ADR-048).
   */
  readonly unclaimedUnitBudgets = new Map<string, number>();
  pausedSessionFile: string | null = null;
  /** The dispatch row the open pause links to (auto_pauses.dispatch_id). */
  pausedDispatchId: number | null = null;
  resourceVersionOnStart: string | null = null;

  // ── Tool invocation errors (#2883) ──────────────────────────────────
  /** Set when a GSD tool execution ends with isError due to malformed/truncated
   *  JSON arguments. Checked by postUnitPreVerification to break retry loops. */
  lastToolInvocationError: string | null = null;
  /** Agent-end messages from the just-finished unit, consumed during finalize. */
  lastUnitAgentEndMessages: unknown[] | null = null;
  /** Set when turn-level git action fails during closeout. */
  lastGitActionFailure: string | null = null;
  /** Last turn-level git action status captured during finalize. */
  lastGitActionStatus: "ok" | "failed" | null = null;

  // ── Isolation degradation ────────────────────────────────────────────
  /** Set to true when worktree creation fails; prevents merge of nonexistent branch. */
  isolationDegraded = false;
  /** Temporary recovery mode for stranded work adopted from physical git evidence. */
  strandedRecoveryIsolationMode: "worktree" | "branch" | null = null;
  /** Project-root dirty snapshot captured before an isolated worktree unit runs. */
  rootWriteBaseline: RootDirtySnapshot | null = null;

  // ── Merge guard ──────────────────────────────────────────────────────
  /** Set to true after phases.ts successfully calls mergeAndExit, so that
   *  stopAuto does not attempt the same merge a second time (#2645). */
  milestoneMergedInPhases = false;
  /** Last milestone settlement result observed by Auto Orchestration. */
  milestoneSettlement: MilestoneSettlementOutcome | null = null;

  // #4765 — slice-cadence collapse: main-branch SHAs at the moment each
  // milestone's first slice merge began. Used by resquashMilestoneOnMain at
  // milestone completion to collapse N slice commits into one. Cleared when
  // the milestone finishes (or resquash runs).
  milestoneStartShas: Map<string, string> = new Map();

  // ── Dispatch circuit breakers ──────────────────────────────────────
  rewriteAttemptCount = 0;
  /** Tracks consecutive bootstrap attempts that found phase === "complete".
   *  Moved from module-level to per-session so s.reset() clears it (#1348). */
  consecutiveCompleteBootstraps = 0;

  // ── Metrics ──────────────────────────────────────────────────────────────
  autoStartTime = 0;
  lastPromptCharCount: number | undefined;
  lastBaselineCharCount: number | undefined;
  /** Timestamp of the last LLM request dispatch (ms since epoch). Used for proactive rate limiting. */
  lastRequestTimestamp = 0;

  // ── Safety harness ───────────────────────────────────────────────────────
  /** SHA of the pre-unit git checkpoint ref. Cleared on success or rollback. */
  checkpointSha: string | null = null;

  // ── Signal handler ───────────────────────────────────────────────────────
  sigtermHandler: (() => void) | null = null;

  // ── Remote command polling ───────────────────────────────────────────────
  /** Cleanup function returned by startCommandPolling(); null when not running. */
  commandPollingCleanup: (() => void) | null = null;

  // ── Orchestration seam ───────────────────────────────────────────────────
  orchestration: AutoOrchestrationModule | null = null;
  pendingOrchestrationDispatch: PendingOrchestrationDispatch | null = null;

  // ── Loop promise state ──────────────────────────────────────────────────
  // Per-unit resolve function and session-switch guard live at module level
  // in auto-loop.ts (_currentResolve, _sessionSwitchInFlight).

  // ── Methods ──────────────────────────────────────────────────────────────

  clearTimers(): void {
    if (this.unitTimeoutHandle) { clearTimeout(this.unitTimeoutHandle); this.unitTimeoutHandle = null; }
    if (this.wrapupWarningHandle) { clearTimeout(this.wrapupWarningHandle); this.wrapupWarningHandle = null; }
    if (this.idleWatchdogHandle) { clearInterval(this.idleWatchdogHandle); this.idleWatchdogHandle = null; }
    if (this.continueHereHandle) { clearInterval(this.continueHereHandle); this.continueHereHandle = null; }
  }

  resetDispatchCounters(): void {
    this.unitDispatchCount.clear();
    this.unitLifetimeDispatches.clear();
  }

  setCurrentUnit(unit: CurrentUnit): void {
    this.currentUnit = unit;
    // A unit just appeared: the session-level idle watchdog (#2373) re-arms
    // exactly here — covering every unit appearance path, including resumed
    // host-verification contexts that never run startUnitSupervision. No-op
    // when the watchdog is not running for this session.
    noteGlobalIdleWatchdogUnitStarted(this);
    if (!supportsSourceObservationsForUnit(unit.type)) {
      this.sourceObservations.clear();
      return;
    }
    this.sourceObservations.beginUnit({
      unitType: unit.type,
      unitId: unit.id,
      startedAt: unit.startedAt,
      basePath: unit.workspaceRoot ?? this.basePath,
    });
  }

  clearCurrentUnit(): void {
    this.currentUnit = null;
    this.sourceObservations.clear();
  }

  get lockBasePath(): string {
    return resolveWorktreeProjectRoot(this.basePath, this.originalBasePath);
  }

  /**
   * Canonical project root for state-derivation reads AND writer paths.
   *
   * Prefers the realpath-normalized projectRoot from the MilestoneScope
   * (introduced by PR #5236), falling back to resolveWorktreeProjectRoot
   * during early lifecycle / engine-bypass paths where scope may be null.
   *
   * Always realpath-normalized so cache keys (e.g. deriveState's _stateCache)
   * cannot drift across worktree↔project-root path-string variants for the
   * same filesystem location.
   */
  get canonicalProjectRoot(): string {
    const root =
      this.scope?.workspace.projectRoot
        ?? resolveWorktreeProjectRoot(this.basePath, this.originalBasePath);
    return normalizeRealPath(root);
  }

  reset(): void {
    this.clearTimers();

    // Lifecycle
    this.active = false;
    this.paused = false;
    this.completionStopInProgress = false;
    this.preserveStepSurfaceAfterLoopExit = false;
    this.stepMode = false;
    this.verbose = false;
    this.activeEngineId = null;
    this.activeRunDir = null;
    this.cmdCtx = null;

    // Paths
    this.basePath = "";
    this.originalBasePath = "";
    this.scope = null;
    this.workerId = null;
    this.milestoneLeaseToken = null;
    this.previousProjectRootEnv = null;
    this.hadProjectRootEnv = false;
    this.projectRootEnvCaptured = false;
    this.previousMilestoneLockEnv = null;
    this.hadMilestoneLockEnv = false;
    this.milestoneLockEnvCaptured = false;
    this.sessionMilestoneLock = null;
    this.gitService = null;

    // Dispatch
    this.unitDispatchCount.clear();
    this.unitLifetimeDispatches.clear();

    // Unit
    this.clearCurrentUnit();
    this.unitExecutionInFlight = false;
    this.toolSurfaceSnapshot = null;
    this.currentTraceId = null;
    this.currentTurnId = null;
    this.currentUnitRouting = null;
    this.currentMilestoneId = null;

    // Model
    this.autoModeStartModel = null;
    this.manualSessionModelOverride = null;
    this.currentUnitModel = null;
    this.currentDispatchedModelId = null;
    this.originalModelId = null;
    this.originalModelProvider = null;
    this.autoModeStartThinkingLevel = null;
    this.originalThinkingLevel = null;
    this.lastBudgetAlertLevel = 0;
    this.uncountedLedgerSpendNotified = false;

    // Recovery
    this.pendingCrashRecovery = null;
    this.pendingVerificationRetry = null;
    this.lastTaskRecoveryAbortId = null;
    this.lastSafetyBlockRecovery = null;
    this.verificationRetryCount.clear();
    this.unclaimedUnitBudgets.clear();
    this.pausedSessionFile = null;
    this.pausedDispatchId = null;
    this.resourceVersionOnStart = null;

    // Metrics
    this.autoStartTime = 0;
    this.lastPromptCharCount = undefined;
    this.lastBaselineCharCount = undefined;
    this.lastRequestTimestamp = 0;
    this.rewriteAttemptCount = 0;
    this.consecutiveCompleteBootstraps = 0;
    this.lastToolInvocationError = null;
    this.lastUnitAgentEndMessages = null;
    this.lastGitActionFailure = null;
    this.lastGitActionStatus = null;
    this.isolationDegraded = false;
    this.strandedRecoveryIsolationMode = null;
    this.rootWriteBaseline = null;
    this.milestoneMergedInPhases = false;
    this.milestoneSettlement = null;
    this.milestoneStartShas = new Map();
    this.checkpointSha = null;

    // Signal handler
    this.sigtermHandler = null;

    // Remote command polling — cleanup must be called before reset (auto.ts stopAuto)
    this.commandPollingCleanup = null;

    // Orchestration seam
    this.orchestration = null;
    this.pendingOrchestrationDispatch = null;

    // Loop promise state lives in auto-loop.ts module scope
  }

  resetAfterStop(options: { preserveCompletionSurface?: boolean } = {}): void {
    const completionStopInProgress = options.preserveCompletionSurface ? this.completionStopInProgress : false;
    this.reset();
    this.completionStopInProgress = completionStopInProgress;
  }

  toJSON(): Record<string, unknown> {
    const orchestrationStatus = this.orchestration?.getStatus();
    return {
      active: this.active,
      paused: this.paused,
      stepMode: this.stepMode,
      basePath: this.basePath,
      activeEngineId: this.activeEngineId,
      activeRunDir: this.activeRunDir,
      currentMilestoneId: this.currentMilestoneId,
      currentUnit: this.currentUnit,
      orchestrationPhase: orchestrationStatus?.phase,
      orchestrationTransitionCount: orchestrationStatus?.transitionCount,
      orchestrationLastTransitionAt: orchestrationStatus?.lastTransitionAt,
      unitDispatchCount: Object.fromEntries(this.unitDispatchCount),
    };
  }
}
