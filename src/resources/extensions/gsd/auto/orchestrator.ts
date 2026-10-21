// Project/App: gsd-pi
// File Purpose: Auto Orchestration module implementation and ADR-015 invariant pipeline owner.
//
// Phase 2 of #442 collapsed the nine single-implementation adapter seams
// (DispatchAdapter, RecoveryAdapter, StateReconciliationAdapter,
// ToolContractAdapter, WorktreeAdapter, HealthAdapter, UokGateAdapter,
// RuntimePersistenceAdapter, NotificationAdapter) into this class. The
// orchestrator now constructs from the concrete extension context and calls
// the real collaborators (state-reconciliation, doctor-proactive,
// auto-dispatch, recovery-classification, tool-contract, worktree-safety,
// uok/gate-runner, journal, session-lock, ctx.ui.notify) directly.

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import type { AutoAdvanceResult, AutoOrchestrationModule, AutoSessionContext, AutoStatus, AutoTerminalOutcome, UnitRef, WedgeRecheckResult, WedgeRecheckTarget } from "./contracts.js";
import { UNIT_ALREADY_ACTIVE_SKIP_CODE, UNIT_ALREADY_ACTIVE_SKIP_REASON } from "./contracts.js";
import type { AutoSession, PendingOrchestrationDispatch } from "./session.js";
import type { GSDState, Phase } from "../types.js";
import type { MinimalModelRegistry } from "../context-budget.js";

type BlockedAdvanceResult = Extract<AutoAdvanceResult, { kind: "blocked" }>;
export type AutoAdvanceFailureResult = Extract<AutoAdvanceResult, { kind: "paused" | "error" | "stopped" }>;

import { debugCount, debugLog, debugTime } from "../debug-logger.js";
import {
  reconcileBeforeDispatch,
  type ReconciliationBlockerDetail,
} from "../state-reconciliation.js";
import { isLegalEdge, IllegalPhaseTransitionError } from "../state-transition-matrix.js";
import { hasPendingDeepStage, resolveDispatch } from "../auto-dispatch.js";
import { classifyFailure } from "../recovery-classification.js";
import { compileUnitToolContract } from "../tool-contract.js";
import { createWorktreeSafetyModule } from "../worktree-safety.js";
import { repairAutoWorktreeSafetyFailure } from "../auto-worktree-repair.js";
import { resolveManifest } from "../unit-context-manifest.js";
import {
  preDispatchHealthGate,
  recordHealthSnapshot,
} from "../doctor-proactive.js";
import { autoWorktreeBranch } from "../auto-worktree-branch-lifecycle.js";
import { checkResourcesStale } from "../auto-worktree-resource-version.js";
import { getSessionLockStatus } from "../session-lock.js";
import { resolveUokFlags } from "../uok/flags.js";
import { emitJournalEvent as _emitJournalEvent } from "../journal.js";
import { loadEffectiveGSDPreferences, loadEffectiveGSDPreferencesWithRegistry, getIsolationMode, resolveEffectiveUnitIsolationMode, resolveProfileAnchorProvider } from "../preferences.js";
import {
  detectWorktreeName,
  getMainBranch,
  resolveProjectRoot,
  resolveWorktreeProjectRoot,
} from "../worktree.js";
import { getDispatchAuthorityBlocker, getPriorSliceCompletionBlocker } from "../dispatch-guard.js";
import { GitServiceImpl } from "../git-service.js";
import { WorktreeStateProjection } from "../worktree-state-projection.js";
import { WorktreeLifecycle } from "../worktree-lifecycle.js";
import { createDefaultMilestoneMergeTransaction } from "../milestone-merge-transaction.js";
import { createWorkspace, scopeMilestone } from "../workspace.js";
import { supportsStructuredQuestions } from "../workflow-mcp.js";
import { getRegisteredToolSnapshot, getToolBaselineSnapshot } from "../auto-model-selection.js";
import { deriveState } from "../state.js";
import { isSkippedForDispatch } from "../status-guards.js";
import { getErrorMessage } from "../error-utils.js";
import { parseUnitId } from "../unit-id.js";
import { logWarning } from "../workflow-logger.js";
import { normalizeRealPath } from "../paths.js";
import { preserveProjectionChanges } from "../projection-worker.js";
import { throwIfTransientProjectionLockError } from "../projection-root-errors.js";
import { buildDispatchKey } from "./dispatch-key.js";
import { stableClaimSignature } from "./lease-conflict-notice.js";
import { abortActiveUnitTurn } from "./unit-turn-abort.js";
import { clearInFlightTools } from "../auto-tool-tracking.js";
import {
  COMPLETED_NO_ADVANCE_GUARD_ID,
  formatWedgeRefusalNotice,
  formatWedgeTripNotice,
  getOpenWedge,
  hashBackstopInput,
  lookupLatestLedgerError,
  recordNonAdvancingOutcome,
  recordNonAdvancingRecurrence,
  serializeNonAdvancingEvidence,
  snapshotUnitTargetRows,
} from "../auto-liveness-backstop.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  recordDispatchClaim,
  markRunning as markDispatchRunning,
  markCompleted as markDispatchCompleted,
  markFailed as markDispatchFailed,
  markCanceled as markDispatchCanceled,
  getRecentForUnit as getRecentDispatchesForUnit,
  getActiveForWorker,
  getDispatchById,
} from "../db/unit-dispatches.js";
import { claimMilestoneLease } from "../db/milestone-leases.js";
import { isAutoWorkerLive } from "../db/auto-workers.js";
import type { IterationRunOutcome } from "./iteration-run.js";
import {
  activeUnitFromWorker,
  claimUnitRun,
  iterationDataForClaim,
  resolveExistingUnitRun,
  unitRefForDispatch,
  UNIT_RUN_CLAIM_FAIL_LOG,
  UNIT_RUN_CLAIM_REJECT_LOG,
  UNIT_RUN_LEASE_FAIL_LOG,
  UNIT_RUN_LEASE_LOG,
} from "./unit-run.js";
import { evaluateAllCompleteSettlement } from "../milestone-settlement.js";
import { hasHeldMilestoneLease, reclaimMissingMilestoneLease } from "./milestone-lease-reclaim.js";
import {
  getAlreadyClosedDispatchReason as getDispatchAlreadyClosedReason,
  shouldBypassAlreadyClosedForVerificationRetry,
} from "./dispatch.js";
import { readLatestTaskAttempt } from "../task-execution-domain-operation.js";
import { readTaskRecoveryRoute } from "../task-recovery-domain-operation.js";

type UokFlags = ReturnType<typeof resolveUokFlags>;

interface OrphanedActiveUnitBlocker {
  reason: string;
  inputPayload: string;
}

function now(): number {
  return Date.now();
}

/**
 * Optional override for the post-settlement markdown projection rebuild
 * (mergePendingCompleteMilestone). Production leaves this null so the real
 * rebuild runs; tests inject a throwing function to deterministically exercise
 * the best-effort failure path (orchestrator.ts:637), which is otherwise only
 * reachable by driving advance() through a full merge-pending milestone
 * settlement and then contriving a projection-rebuild fault.
 * @internal
 */
let _projectionRebuildFn: ((projectRoot: string) => Promise<void>) | null = null;
let _preserveProjectionChangesFn: typeof preserveProjectionChanges | null = null;

function noRemainingUnitsOutcome(stateSnapshot: GSDState): AutoTerminalOutcome {
  if (stateSnapshot.phase === "complete") {
    return {
      code: "all-complete",
      displayReason: "All milestones complete",
      allMilestonesComplete: true,
    };
  }
  return {
    code: "no-remaining-units",
    displayReason: "No remaining units",
    allMilestonesComplete: false,
  };
}

/**
 * Concrete construction context for the Auto Orchestrator.
 *
 * Phase 2 of #442 replaced the nine adapter interfaces with this bundle of the
 * real values the wiring factory used to close over: the extension context and
 * API, the dispatch/runtime base paths, and the shared {@link AutoSession}
 * singleton.
 */
export interface OrchestratorContext {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  dispatchBasePath: string;
  runtimeBasePath: string;
  session: AutoSession;
}

/** Result type of a single dispatch decision. */
export type DispatchDecision =
  | { kind: "blocked"; reason: string; action: "pause" | "stop"; guardId: string }
  | { kind: "skipped"; reason: string; code: "no-dispatch" | "already-closed" }
  | { unitType: string; unitId: string; reason: string; preconditions: string[] }
  | null;

/** Inputs to a dispatch decision. Caller-supplied fields override ctx-derived ones. */
export interface DispatchDecisionInput {
  stateSnapshot: GSDState;
  /** Optional live session context, forwarded to dispatch rules that need session-derived state. */
  session?: AutoSession;
  /** Mirrors `DispatchContext.structuredQuestionsAvailable` — "true"/"false" string per the dispatch contract. */
  structuredQuestionsAvailable?: "true" | "false";
  /** Session model context window in tokens, forwarded to the budget engine. */
  sessionContextWindow?: number;
  /** Session model provider, used for provider-specific effective context windows. */
  sessionProvider?: string;
  /** Model registry for executor-model lookups inside the budget engine. */
  modelRegistry?: MinimalModelRegistry;
}

function shouldAdoptActiveMilestone(
  state: GSDState,
  activeSession: AutoSession | undefined,
  activeDispatchBasePath: string,
): boolean {
  const activeMilestoneId = state.activeMilestone?.id;
  const currentMilestoneId = activeSession?.currentMilestoneId;
  if (!activeSession || !activeMilestoneId || !currentMilestoneId || activeMilestoneId === currentMilestoneId) {
    return false;
  }

  const scopedWorktreeMilestone =
    (activeSession.basePath ? detectWorktreeName(activeSession.basePath) : null) ??
    detectWorktreeName(activeDispatchBasePath);
  if (scopedWorktreeMilestone && scopedWorktreeMilestone !== activeMilestoneId) {
    return false;
  }

  // Adopt the active milestone whenever the session's current milestone is no
  // longer a valid dispatch target per the canonical isSkippedForDispatch
  // predicate (a derived milestone status is only complete/active/pending/parked,
  // so in practice "closed or parked"), rather than the narrower isClosedStatus.
  // This is the root-cause fix for the permanent dispatch-mismatch guard: a
  // parked current milestone previously left currentMilestoneId stuck because
  // isClosedStatus ignored it.
  const currentMilestone = state.registry.find((milestone) => milestone.id === currentMilestoneId);
  return !!currentMilestone && isSkippedForDispatch(currentMilestone.status);
}

/**
 * Pure dispatch-decision function — formerly `createWiredDispatchAdapter`'s
 * `decideNextUnit`. Folded out of the closure so the orchestrator can call it
 * directly and tests can drive the exact dispatch decision logic against real
 * fixtures without re-introducing an adapter seam.
 *
 * Derives session-derived dispatch inputs the same way phases.ts:runDispatch
 * does (#5789): prefers caller-supplied values when present so test harnesses
 * and alternative wirings can inject deterministic snapshots; otherwise pulls
 * from the captured pi/ctx references.
 */
export async function decideOrchestratorDispatch(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  dispatchBasePath: string,
  session: AutoSession | undefined,
  input: DispatchDecisionInput,
): Promise<DispatchDecision> {
  const state = input.stateSnapshot;
  const active = state.activeMilestone;
  const activeSession = input.session ?? session;
  const activeDispatchBasePath = activeSession?.basePath || dispatchBasePath;
  const prefs = loadEffectiveGSDPreferencesWithRegistry(
    ctx.modelRegistry,
    activeDispatchBasePath,
    resolveProfileAnchorProvider(ctx.model?.provider, session?.autoModeStartModel?.provider),
    activeSession?.autoModeStartModel
      ? `${activeSession.autoModeStartModel.provider}/${activeSession.autoModeStartModel.id}`
      : undefined,
  )?.preferences;
  if (!active) {
    if (state.phase !== "pre-planning") return null;
    if (!hasPendingDeepStage(prefs, activeDispatchBasePath)) {
      return {
        kind: "blocked",
        reason: state.nextAction || "No active milestone. Run /gsd unpark <id> or create a new milestone.",
        action: "stop",
        guardId: "no-active-milestone",
      };
    }
  }

  if (active && activeSession && shouldAdoptActiveMilestone(state, activeSession, activeDispatchBasePath)) {
    activeSession.currentMilestoneId = active.id;
    activeSession.milestoneLeaseToken = null;
  }
  const dispatchMid = active?.id ?? "PROJECT";
  const dispatchMidTitle = active?.title ?? "Project setup";

  // Derive session-derived dispatch inputs the same way phases.ts:runDispatch does
  // (#5789). Prefer caller-supplied values when present so test harnesses and
  // alternative wirings can inject deterministic snapshots; otherwise pull from
  // the captured pi/ctx references.
  const sessionProvider = input.sessionProvider ?? ctx.model?.provider;
  const sessionContextWindow = input.sessionContextWindow ?? ctx.model?.contextWindow;
  const modelRegistry = input.modelRegistry ?? (ctx.modelRegistry as MinimalModelRegistry | undefined);
  const authMode =
    sessionProvider && typeof ctx.modelRegistry?.getProviderAuthMode === "function"
      ? ctx.modelRegistry.getProviderAuthMode(sessionProvider)
      : undefined;
  // Use baseline snapshot — same reason as phases.ts:runDispatch: the live
  // active set may be narrowed by the prior unit before selectAndApplyModel
  // restores it, causing false transport-preflight failures (#477 follow-up).
  const activeTools = getToolBaselineSnapshot(pi);
  const registeredTools = getRegisteredToolSnapshot(pi);
  // Mirrors runDispatch: deep-planning keeps approval gates in plain chat
  // because structured questions can be cancelled outside the chat turn on
  // some transports.
  const structuredQuestionsAvailable =
    input.structuredQuestionsAvailable ??
    (prefs?.planning_depth === "deep"
      ? "false"
      : supportsStructuredQuestions(activeTools, {
          authMode,
          baseUrl: ctx.model?.baseUrl,
        })
        ? "true"
        : "false");

  // Only replay a milestone-scoped verification retry when a milestone is
  // active. Pre-PR (#712 fix), `!active` returned null before reaching this
  // block, so the retry was preserved for a future tick. The new
  // pre-planning + deep-pending fall-through must keep that contract:
  // otherwise a stale execute-task / complete-slice / complete-milestone
  // retry whose target milestone has since been parked would preempt
  // project-level deep rules like `discuss-project`.
  const pendingRetry = session?.pendingVerificationRetryDispatch;
  if (session && pendingRetry && active) {
    const authorityBlocker = getDispatchAuthorityBlocker(pendingRetry.unitType, pendingRetry.unitId);
    if (authorityBlocker) {
      return { kind: "blocked", reason: authorityBlocker, action: "stop", guardId: "dispatch-authority" };
    }
    const alreadyClosedReason = getDispatchAlreadyClosedReason(
      pendingRetry.unitType,
      pendingRetry.unitId,
    );
    if (
      alreadyClosedReason &&
      !shouldBypassAlreadyClosedForVerificationRetry(
        pendingRetry.unitType,
        pendingRetry.unitId,
        session.pendingVerificationRetry,
      )
    ) {
      session.pendingOrchestrationDispatch = null;
      session.pendingVerificationRetry = null;
      return { kind: "skipped", reason: alreadyClosedReason, code: "already-closed" };
    }
    session.pendingVerificationRetryDispatch = null;
    session.pendingOrchestrationDispatch = pendingRetry;
    return {
      unitType: pendingRetry.unitType,
      unitId: pendingRetry.unitId,
      reason: "verification-retry",
      preconditions: [],
    };
  }

  const action = await resolveDispatch({
    basePath: activeDispatchBasePath,
    mid: dispatchMid,
    midTitle: dispatchMidTitle,
    state,
    prefs,
    session: activeSession,
    structuredQuestionsAvailable,
    sessionContextWindow,
    sessionProvider,
    modelRegistry,
    activeTools,
    registeredTools,
    sessionAuthMode: authMode,
    sessionBaseUrl: ctx.model?.baseUrl,
  });

  if (action.action === "stop") {
    if (session) session.pendingOrchestrationDispatch = null;
    return {
      kind: "blocked",
      reason: action.reason,
      action: action.level === "warning" ? "pause" : "stop",
      guardId: "dispatch-rule-stop",
    };
  }
  if (action.action !== "dispatch") {
    if (session) session.pendingOrchestrationDispatch = null;
    return {
      kind: "skipped",
      reason: action.matchedRule ?? "dispatch-skip",
      code: "no-dispatch",
    };
  }
  const alreadyClosedReason = getDispatchAlreadyClosedReason(action.unitType, action.unitId);
  if (
    alreadyClosedReason &&
    !shouldBypassAlreadyClosedForVerificationRetry(
      action.unitType,
      action.unitId,
      session?.pendingVerificationRetry,
    )
  ) {
    if (session) {
      session.pendingOrchestrationDispatch = null;
      session.pendingVerificationRetry = null;
    }
    return { kind: "skipped", reason: alreadyClosedReason, code: "already-closed" };
  }
  if (session) {
    const pending: PendingOrchestrationDispatch = {
      unitType: action.unitType,
      unitId: action.unitId,
      prompt: action.prompt,
      pauseAfterUatDispatch: action.pauseAfterDispatch ?? false,
      state,
      mid: dispatchMid,
      midTitle: dispatchMidTitle,
    };
    session.pendingOrchestrationDispatch = pending;
  }
  return {
    unitType: action.unitType,
    unitId: action.unitId,
    reason: action.matchedRule ?? "dispatch",
    preconditions: [],
  };
}

export function classifyAutoAdvanceFailure(input: {
  error: unknown;
  unitType?: string;
  unitId?: string;
}): AutoAdvanceFailureResult {
  const recovery = classifyFailure(input);
  if (recovery.action === "retry") {
    return {
      kind: "paused",
      reason: recovery.reason,
      failureKind: recovery.failureKind,
      backoffMs: recovery.backoffMs,
    };
  }
  if (recovery.action === "escalate") return { kind: "error", reason: recovery.reason };
  return { kind: "stopped", reason: recovery.reason };
}

export class AutoOrchestrator implements AutoOrchestrationModule {
  private status: AutoStatus = {
    phase: "idle",
    transitionCount: 0,
  };
  private readonly ctx: ExtensionContext;
  private readonly pi: ExtensionAPI;
  private readonly dispatchBasePath: string;
  private readonly runtimeBasePath: string;
  private readonly s: AutoSession;
  private readonly flowId: string;
  private seq = 0;
  private lastFinalizedUnitKey: string | null = null;
  // ADR-047 liveness backstop: target-row hash captured at dispatch so
  // completeActiveUnit can detect completed-no-advance outcomes, and the last
  // decided unit so non-advancing outcomes carry their target identity.
  private pendingTargetSnapshot: { unitType: string; unitId: string; hash: string } | null = null;
  private lastDecisionUnit: { unitType: string; unitId: string } | null = null;
  private pendingLivenessInput: {
    guardId: string;
    inputPayload: string;
    sanctionedExit?: string;
  } | null = null;
  private pendingBackstopFailure: string | null = null;
  // ADR-030 Phase Transition Invariant: the prior advance's reconciled Phase,
  // the "from" endpoint of the edge check. In-memory; reset on start/resume/stop
  // so the first advance of a session has no edge to assert.
  private lastDerivedPhase: Phase | null = null;

  public constructor(context: OrchestratorContext) {
    this.ctx = context.ctx;
    this.pi = context.pi;
    this.dispatchBasePath = context.dispatchBasePath;
    this.runtimeBasePath = context.runtimeBasePath;
    this.s = context.session;
    this.flowId = `auto-orchestrator-${Date.now()}`;
  }

  /**
   * Stable project scope for the liveness backstop — the same realpath scope
   * the dispatch ledger uses, so signatures survive worktree adoption and
   * process restarts.
   */
  private backstopScopeId(): string | null {
    return normalizeRealPath(
      this.s.scope?.workspace.projectRoot ??
        (this.s.originalBasePath || this.s.basePath || this.runtimeBasePath),
    ) || null;
  }

  // ── Live base-path resolution (was the wiring factory's getLiveDispatchBasePath) ──

  private getLiveDispatchBasePath(): string {
    return resolveLiveOrchestratorBasePath({
      capturedBasePath: this.dispatchBasePath,
      runtimeBasePath: this.runtimeBasePath,
      sessionBasePath: this.s.basePath,
      originalBasePath: this.s.originalBasePath,
    });
  }

  // ── RuntimePersistenceAdapter (folded) ───────────────────────────────────

  private ensureLockOwnership(): void {
    const status = getSessionLockStatus(this.runtimeBasePath);
    if (!status.valid || status.failureReason === "pid-mismatch") {
      throw new Error("session lock held by another process");
    }
  }

  /**
   * Map an orchestrator lifecycle event name to its journal eventType and emit
   * it. The name→eventType ternary is preserved byte-for-byte from the legacy
   * wired RuntimePersistenceAdapter.journalTransition.
   */
  private journalTransition(event: {
    name: string;
    reason?: string;
    unitType?: string;
    unitId?: string;
  }): void {
    const eventType = event.name === "start"
      ? "orchestrator-iteration-start"
      : event.name === "resume"
        ? "orchestrator-iteration-start"
        : event.name === "advance"
          ? "orchestrator-dispatch-match"
          : event.name === "advance-blocked"
            ? "orchestrator-guard-block"
            : event.name === "advance-stopped"
              ? "orchestrator-dispatch-stop"
              : event.name === "advance-error"
                ? "orchestrator-iteration-end"
                : event.name === "advance-paused" || event.name === "advance-retry"
                  ? "orchestrator-guard-block"
                  : event.name === "stop"
                  ? "orchestrator-terminal"
                  : "orchestrator-iteration-end";

    _emitJournalEvent(this.runtimeBasePath, {
      ts: new Date().toISOString(),
      flowId: this.flowId,
      seq: ++this.seq,
      eventType,
      data: {
        source: "auto-orchestrator",
        name: event.name,
        reason: event.reason,
        unitType: event.unitType,
        unitId: event.unitId,
      },
    });
  }

  // ── NotificationAdapter (folded) ─────────────────────────────────────────

  private notifyLifecycle(event: { name: string; detail?: string }): void {
    if (event.name === "error") {
      this.ctx.ui.notify(event.detail ?? "auto orchestration error", "error");
    }
  }

  // ── HealthAdapter (folded) ───────────────────────────────────────────────

  private checkResourcesStale(): string | null {
    return checkResourcesStale(this.s.resourceVersionOnStart);
  }

  private async preAdvanceGate(): Promise<
    | { kind: "pass"; fixesApplied?: readonly string[] }
    | { kind: "fail"; reason: string; action?: "pause" | "stop" }
    | { kind: "threw"; error: unknown }
  > {
    try {
      const gate = await preDispatchHealthGate(this.getLiveDispatchBasePath());
      if (gate.proceed) {
        return {
          kind: "pass",
          fixesApplied: gate.fixesApplied,
        };
      }
      return {
        kind: "fail",
        reason: gate.reason ?? "Pre-dispatch health check failed — run /gsd doctor for details.",
        action: gate.severity ?? "pause",
      };
    } catch (error) {
      return { kind: "threw", error };
    }
  }

  private postAdvanceRecord(result: AutoAdvanceResult): void {
    if (result.kind === "error") {
      recordHealthSnapshot(1, 0, 0, [{
        code: "orchestration-error",
        message: result.reason ?? "orchestration error",
        severity: "error",
        unitId: "orchestration",
      }], [], "orchestration");
    } else if (result.kind === "blocked") {
      recordHealthSnapshot(0, 1, 0, [{
        code: "orchestration-blocked",
        message: result.reason ?? "orchestration blocked",
        severity: "warning",
        unitId: "orchestration",
      }], [], "orchestration");
    }
  }

  // ── UokGateAdapter (folded) ──────────────────────────────────────────────

  private resolveUokGateContext(): { activeBasePath: string; uokFlags: UokFlags } {
    const activeBasePath = this.getLiveDispatchBasePath();
    const prefs = loadEffectiveGSDPreferencesWithRegistry(
      this.ctx.modelRegistry,
      activeBasePath,
      resolveProfileAnchorProvider(this.ctx.model?.provider, this.s.autoModeStartModel?.provider),
      this.s.autoModeStartModel
        ? `${this.s.autoModeStartModel.provider}/${this.s.autoModeStartModel.id}`
        : undefined,
    )?.preferences;
    return { activeBasePath, uokFlags: resolveUokFlags(prefs) };
  }

  private async emitUokGate(input: {
    gateId: string;
    gateType: "policy" | "execution";
    outcome: "pass" | "fail" | "manual-attention";
    failureClass: "none" | "policy" | "manual-attention";
    rationale: string;
    findings?: string;
    milestoneId?: string;
    activeBasePath: string;
    uokFlags: UokFlags;
  }): Promise<void> {
    if (!input.uokFlags.gates) return;
    const activeBasePath = input.activeBasePath;
    const milestoneId = input.milestoneId ?? this.s.currentMilestoneId ?? undefined;
    try {
      const { UokGateRunner } = await import("../uok/gate-runner.js");
      const runner = new UokGateRunner();
      runner.register({
        id: input.gateId,
        type: input.gateType,
        execute: async () => ({
          outcome: input.outcome,
          failureClass: input.failureClass,
          rationale: input.rationale,
          findings: input.findings ?? "",
        }),
      });
      await runner.run(input.gateId, {
        basePath: activeBasePath,
        traceId: `pre-dispatch:${this.flowId}`,
        turnId: `orch-${this.seq}`,
        milestoneId,
        unitType: "pre-dispatch",
        unitId: `orch-${this.seq}`,
      });
    } catch (err) {
      logWarning("engine", `uok gate emit failed: ${getErrorMessage(err)}`, {
        file: "orchestrator.ts",
        gateId: input.gateId,
        gateType: input.gateType,
        ...(milestoneId ? { milestoneId } : {}),
      });
    }
  }

  // ── StateReconciliationAdapter (folded) ──────────────────────────────────

  private async reconcileBeforeDispatch(): Promise<
    { ok: true; reason: string; stateSnapshot?: GSDState }
    | {
      ok: false;
      reason: string;
      stateSnapshot?: GSDState;
      blockerDetails: readonly ReconciliationBlockerDetail[];
    }
  > {
    const activeBasePath = this.getLiveDispatchBasePath();
    try {
      await (_preserveProjectionChangesFn ?? preserveProjectionChanges)(activeBasePath);
    } catch (error) {
      // Keep transient Windows projection-lock failures on the typed recovery
      // path so autoLoop receives their classification and bounded backoff.
      throwIfTransientProjectionLockError(error);
      const reason = `Projection observation failed: ${getErrorMessage(error)}`;
      logWarning("reconcile", reason);
      return {
        ok: false,
        reason,
        blockerDetails: [{ message: reason }],
      };
    }
    const result = await reconcileBeforeDispatch(activeBasePath);
    if (result.blockers.length > 0) {
      return {
        ok: false,
        reason: result.blockers.join("\n"),
        stateSnapshot: result.stateSnapshot,
        blockerDetails: result.blockerDetails,
      };
    }
    const repairedKinds = result.repaired.map((d) => d.kind);
    return {
      ok: true,
      reason:
        repairedKinds.length > 0
          ? `repaired: ${repairedKinds.join(", ")}`
          : "clean",
      stateSnapshot: result.stateSnapshot,
    };
  }

  // ── DispatchAdapter (folded) ─────────────────────────────────────────────

  private decideNextUnit(input: DispatchDecisionInput): Promise<DispatchDecision> {
    return decideOrchestratorDispatch(this.ctx, this.pi, this.dispatchBasePath, this.s, input);
  }

  private evaluateNoRemainingUnitsSettlement(stateSnapshot: GSDState): BlockedAdvanceResult | null {
    const settlement = evaluateAllCompleteSettlement({
      milestoneId: this.s.currentMilestoneId ?? stateSnapshot.activeMilestone?.id,
      statePhase: stateSnapshot.phase,
      basePath: this.s.basePath || this.getLiveDispatchBasePath(),
      originalBasePath: this.s.originalBasePath || this.runtimeBasePath,
      milestoneMerged: this.s.milestoneMergedInPhases,
    });
    this.s.milestoneSettlement = settlement;
    if (settlement.ok) return null;
    return {
      kind: "blocked",
      reason: settlement.message,
      action: settlement.action,
      stateSnapshot,
      terminalOutcome: {
        code: "settlement-blocked",
        displayReason: settlement.message,
        nextAction: settlement.nextAction,
        milestoneId: settlement.milestoneId,
        allMilestonesComplete: false,
      },
    };
  }

  private async mergePendingCompleteMilestone(milestoneId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = this.buildLifecycle().exitMilestone(
      milestoneId,
      { merge: true },
      this.ctx.ui,
    );
    if (!result.ok) {
      const detail = result.cause instanceof Error
        ? result.cause.message
        : result.reason;
      return {
        ok: false,
        reason: `Milestone ${milestoneId} is complete, but the system-owned merge failed: ${detail}`,
      };
    }

    this.s.milestoneMergedInPhases = true;
    this.s.milestoneSettlement = { ok: true, reason: "settled" };
    try {
      const projectRoot = this.s.originalBasePath || this.s.canonicalProjectRoot || this.runtimeBasePath;
      // Test seam: when _projectionRebuildFn is injected, route the rebuild
      // through it so the best-effort failure path (:637) is deterministically
      // reachable. Production leaves it null → real rebuildMarkdownProjectionsFromDb.
      if (_projectionRebuildFn) {
        await _projectionRebuildFn(projectRoot);
      } else {
        const { rebuildMarkdownProjectionsFromDb } = await import("../commands-maintenance.js");
        await rebuildMarkdownProjectionsFromDb(projectRoot);
      }
    } catch (err) {
      logWarning(
        "engine",
        `markdown projection rebuild after settlement merge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { ok: true };
  }

  private clearPendingDispatch(): void {
    this.s.pendingOrchestrationDispatch = null;
  }

  private findPriorSliceCompletionBlocker(unitType: string, unitId: string): string | null {
    const guardBasePath = resolveWorktreeProjectRoot(
      this.getLiveDispatchBasePath(),
      this.s.originalBasePath,
    );
    let mainBranch = "main";
    try {
      mainBranch = getMainBranch(guardBasePath);
    } catch (err) {
      // Preserve legacy dispatch behavior: fall back to main when branch
      // discovery fails, then let the guard make the progression decision.
      logWarning(
        "engine",
        `branch discovery failed, falling back to main: ${getErrorMessage(err)}`,
        { file: "orchestrator.ts" },
      );
    }
    return getPriorSliceCompletionBlocker(guardBasePath, mainBranch, unitType, unitId);
  }

  // ── ToolContractAdapter (folded) ─────────────────────────────────────────

  private compileUnitToolContract(unitType: string): { ok: true; reason: string } | { ok: false; reason: string } {
    const result = compileUnitToolContract(unitType);
    if (!result.ok) return { ok: false, reason: result.detail };
    return { ok: true, reason: result.contract.validationRules.join(", ") };
  }

  // ── WorktreeAdapter (folded) ─────────────────────────────────────────────

  private getEffectiveUnitIsolationMode(basePath: string): ReturnType<typeof getIsolationMode> {
    return resolveEffectiveUnitIsolationMode(
      getIsolationMode(basePath),
      this.s.isolationDegraded,
      this.s.strandedRecoveryIsolationMode,
    );
  }

  private buildLifecycle(): WorktreeLifecycle {
    return new WorktreeLifecycle(this.s, {
      gitServiceFactory: (basePath: string) => {
        const gitConfig = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
        return new GitServiceImpl(basePath, gitConfig);
      },
      worktreeProjection: new WorktreeStateProjection(),
      mergeMilestone: createDefaultMilestoneMergeTransaction(),
    });
  }

  private rebuildScope(rawPath: string, milestoneId: string | null): void {
    if (!milestoneId) {
      this.s.scope = null;
      return;
    }
    try {
      const workspace = createWorkspace(rawPath);
      this.s.scope = scopeMilestone(workspace, milestoneId);
    } catch {
      // Non-fatal — scope is additive. Existing readers still use basePath.
      this.s.scope = null;
    }
  }

  private async prepareWorktreeForUnit(
    unitType: string,
    unitId: string,
  ): Promise<{ ok: true; reason: string } | { ok: false; reason: string }> {
    const isolationMode = this.getEffectiveUnitIsolationMode(this.runtimeBasePath);
    const manifest = resolveManifest(unitType);
    if (!manifest) {
      return {
        ok: false,
        reason: `No Unit manifest is registered for ${unitType}`,
      };
    }
    const writeScope =
      manifest.tools.mode === "all" || manifest.tools.mode === "docs"
        ? "source-writing"
        : "planning-only";
    const safety = createWorktreeSafetyModule();
    const activeBasePath = this.getLiveDispatchBasePath();
    const snapshot = await deriveState(activeBasePath);
    const milestoneId = snapshot.activeMilestone?.id ?? null;
    const buildExpectedBranch = (mode: ReturnType<typeof getIsolationMode>) =>
      mode !== "none" && milestoneId ? autoWorktreeBranch(milestoneId) : null;
    // The milestone lease coordinates concurrent workers on an isolated
    // milestone worktree/branch. `none` mode has no per-milestone isolation
    // and does not reliably claim a lease, so requiring one there would
    // falsely fail dispatch; enforce it only in isolated modes.
    const buildLease = (mode: ReturnType<typeof getIsolationMode>) =>
      milestoneId && this.s.workerId
        ? {
            required: writeScope === "source-writing" && mode !== "none",
            held: hasHeldMilestoneLease(this.s, milestoneId),
            owner: this.s.workerId,
          }
        : undefined;
    if (writeScope === "source-writing") {
      reclaimMissingMilestoneLease(this.s, milestoneId, isolationMode, "orchestrator");
    }
    let result = safety.validateUnitRoot({
      unitType,
      unitId,
      writeScope,
      projectRoot: this.runtimeBasePath,
      unitRoot: activeBasePath,
      milestoneId,
      isolationMode,
      expectedBranch: buildExpectedBranch(isolationMode),
      lease: buildLease(isolationMode),
    });
    if (!result.ok) {
      const repaired = await repairAutoWorktreeSafetyFailure({
        safetyResult: result,
        projectRoot: this.runtimeBasePath,
        activeRoot: activeBasePath,
        milestoneId,
        enterMilestone: async (id) => {
          this.buildLifecycle().adoptSessionRoot(this.runtimeBasePath, this.s.originalBasePath || this.runtimeBasePath);
          const enterResult = this.buildLifecycle().enterMilestone(id, {
            notify: this.ctx.ui.notify.bind(this.ctx.ui),
          });
          if (!enterResult.ok) return { ok: false, reason: enterResult.reason };
          this.rebuildScope(this.s.basePath, this.s.currentMilestoneId);
          return { ok: true };
        },
        revalidate: () => {
          const revalidatedMode = this.getEffectiveUnitIsolationMode(this.runtimeBasePath);
          return safety.validateUnitRoot({
            unitType,
            unitId,
            writeScope,
            projectRoot: this.runtimeBasePath,
            unitRoot: this.getLiveDispatchBasePath(),
            milestoneId,
            isolationMode: revalidatedMode,
            expectedBranch: buildExpectedBranch(revalidatedMode),
            lease: buildLease(revalidatedMode),
          });
        },
      });
      result = repaired.result;
      if (result.ok) {
        return { ok: true, reason: repaired.repaired ? `repaired-${result.kind}` : result.kind };
      }
      const repairDetail = repaired.repairReason
        ? ` (repair skipped: ${repaired.repairReason})`
        : "";
      return { ok: false, reason: `${result.kind}: ${result.reason}${repairDetail}` };
    }
    return { ok: true, reason: result.kind };
  }

  /**
   * ADR-030 Phase Transition Invariant (advisory mode). The matrix is an
   * assertion, not a decision-maker — deriveState already chose the phase; we
   * only observe illegal *derived* edges that survived reconciliation. The
   * matrix is still a sparse hardening spec, so this is telemetry-only (no
   * block) until it is expanded into a validated legal-edge graph. To enforce:
   * `throw violation;` instead of logging — recovery-classification maps
   * IllegalPhaseTransitionError to kind "illegal-transition" (escalate).
   */
  private observePhaseTransition(from: Phase, to: Phase): void {
    if (isLegalEdge(from, to)) return;
    const violation = new IllegalPhaseTransitionError(from, to);
    debugLog("phase-transition-advisory", { from, to, message: violation.message });
  }

  // ── Lifecycle verbs ──────────────────────────────────────────────────────

  public async start(_sessionContext: AutoSessionContext): Promise<AutoAdvanceResult> {
    this.lastFinalizedUnitKey = null;
    // ADR-047: cross-session liveness state lives in the DB-persisted
    // block-signature ledger, not in-process — a restart resets nothing.
    this.pendingTargetSnapshot = null;
    this.pendingBackstopFailure = null;
    this.lastDerivedPhase = null;
    this.status.phase = "running";
    this.bumpTransition();
    this.journalTransition({ name: "start" });
    this.notifyLifecycle({ name: "start" });
    return { kind: "started" };
  }

  /**
   * ADR-047 liveness backstop wrapper. Re-entry is refused while an
   * unacknowledged wedge record exists; every non-advancing advance outcome
   * feeds the DB-persisted block-signature ledger, and a tripped signature
   * converts the outcome into a surfaced, resumable hard stop.
   */
  public async advance(): Promise<AutoAdvanceResult> {
    if (this.pendingBackstopFailure) {
      return this.backstopFailure(this.pendingBackstopFailure);
    }
    const scopeId = this.backstopScopeId();
    if (!scopeId) return this.backstopFailure('project scope unavailable');
    const openWedgeResult = getOpenWedge(scopeId);
    if (!openWedgeResult.ok) return this.backstopFailure(openWedgeResult.error);
    const openWedge = openWedgeResult.wedge;
    if (openWedge) {
      const blocked: AutoAdvanceResult = {
        kind: "blocked",
        reason: formatWedgeRefusalNotice(openWedge),
        action: "stop",
      };
      this.journalTransition({
        name: "advance-blocked",
        reason: blocked.reason,
        unitType: openWedge.unitType,
        unitId: openWedge.unitId,
      });
      this.postAdvanceRecord(blocked);
      return blocked;
    }
    return this.adjudicateLiveness(await this.advanceInner());
  }

  public async recheckWedge(wedge: WedgeRecheckTarget): Promise<WedgeRecheckResult> {
    if (wedge.guardId === COMPLETED_NO_ADVANCE_GUARD_ID) {
      const current = snapshotUnitTargetRows(wedge.unitType, wedge.unitId);
      if (!current.ok) return { blocking: true, reason: current.error };
      const blocking = current.hash !== null && hashBackstopInput(current.hash) === wedge.inputHash;
      return {
        blocking,
        ...(blocking ? { reason: `state did not advance for ${wedge.unitType} ${wedge.unitId}` } : {}),
      };
    }

    if (wedge.guardId === "orphaned-active-unit") {
      const current = this.readOrphanedActiveUnitBlocker(wedge.unitType, wedge.unitId);
      return {
        blocking: current !== null,
        ...(current ? { reason: current.reason } : {}),
      };
    }

    if (
      wedge.guardId === "dispatch-rule-stop" ||
      wedge.guardId === "dispatch-authority" ||
      wedge.guardId === "no-active-milestone"
    ) {
      try {
        const stateSnapshot = await deriveState(this.getLiveDispatchBasePath());
        // Dispatch selection can update session bookkeeping. Re-evaluate with a
        // shadow so acknowledging a wedge remains a read-only operation.
        const shadowSession = {
          ...this.s,
          missingTaskPlanRetryCount: new Map(this.s.missingTaskPlanRetryCount),
        } as AutoSession;
        const decision = await decideOrchestratorDispatch(
          this.ctx,
          this.pi,
          this.dispatchBasePath,
          shadowSession,
          { stateSnapshot },
        );
        const currentGuard = decision && "kind" in decision && decision.kind === "blocked"
          ? decision
          : null;
        const blocking = currentGuard?.guardId === wedge.guardId;
        return {
          blocking,
          ...(blocking ? { reason: currentGuard.reason } : {}),
        };
      } catch (error) {
        return {
          blocking: true,
          reason: `could not recheck ${wedge.guardId}: ${getErrorMessage(error)}`,
        };
      }
    }

    // Some wedges represent one-shot runtime failures whose originating probe
    // cannot be repeated without running the unit again. Preserve their
    // existing explicit-ack behavior; state-derived guards above must prove
    // that their blocker has cleared before acknowledgment.
    return { blocking: false };
  }

  private readOrphanedActiveUnitBlocker(
    unitType: string,
    unitId: string,
  ): OrphanedActiveUnitBlocker | null {
    const parsed = parseUnitId(unitId);
    const latestTaskAttempt = unitType === "execute-task" && parsed.milestone && parsed.slice && parsed.task
      ? readLatestTaskAttempt({
          milestoneId: parsed.milestone,
          sliceId: parsed.slice,
          taskId: parsed.task,
        })
      : null;
    const recovery = latestTaskAttempt
      ? readTaskRecoveryRoute(latestTaskAttempt.attemptId)
      : null;
    const activeDispatch = getRecentDispatchesForUnit(unitId)
      .find((dispatch) => dispatch.status === "claimed" || dispatch.status === "running");
    const attemptDispatch = latestTaskAttempt
      ? getDispatchById(latestTaskAttempt.coordinationDispatchId)
      : null;
    // A settled Attempt with an abort route is not an orphan: the task
    // execution cutover either pauses with the resumable abort or claims the
    // authorized retry (#1941). Only a still-running Attempt is orphaned.
    const orphanCandidate = activeDispatch
      ?? (latestTaskAttempt?.state === "running"
        ? attemptDispatch
        : null);
    if (!orphanCandidate) return null;

    const activeTaskAttempt = latestTaskAttempt?.coordinationDispatchId === orphanCandidate.id
      ? latestTaskAttempt
      : null;
    const executorWorkerId = activeTaskAttempt?.workerId ?? orphanCandidate.worker_id;
    if (isAutoWorkerLive(executorWorkerId)) return null;

    const recoveryInstruction = recovery?.action === "abort" && recovery.resumeEligibility?.eligible === true
      ? ` Resume with /gsd recover ${recovery.recoveryActionId}.`
      : activeTaskAttempt?.state === "running"
        ? ` Settle the orphaned Attempt with gsd_task_settle using attemptId ${activeTaskAttempt.attemptId}.`
        : " Inspect /gsd status for the active UnitRun's recovery eligibility.";
    const executionDetail = activeTaskAttempt
      ? `Attempt ${activeTaskAttempt.attemptId} is ${activeTaskAttempt.state}`
      : `UnitRun ${orphanCandidate.id} is ${orphanCandidate.status}`;
    const reason =
      `stale-active ${unitType} ${unitId}: ${executionDetail}, ` +
      `but executor worker ${executorWorkerId} is not live.${recoveryInstruction}`;
    return {
      reason,
      inputPayload: JSON.stringify({
        unitType,
        unitId,
        dispatchId: orphanCandidate.id,
        attemptId: activeTaskAttempt?.attemptId ?? null,
        attemptState: activeTaskAttempt?.state ?? null,
        executorWorkerId,
        recoveryActionId: recovery?.recoveryActionId ?? null,
      }),
    };
  }

  private withLivenessInput<T extends AutoAdvanceResult>(
    result: T,
    input: { guardId: string; inputPayload?: string; sanctionedExit?: string },
  ): T {
    this.pendingLivenessInput = {
      guardId: input.guardId,
      inputPayload: input.inputPayload ?? ("reason" in result ? result.reason : input.guardId),
      ...(input.sanctionedExit ? { sanctionedExit: input.sanctionedExit } : {}),
    };
    return result;
  }

  /**
   * Feed the liveness ledger from the single seam where advance outcomes are
   * adjudicated. Guard blocks and gate failures (kind "blocked"/"error")
   * record a signature built from the guard's own reason payload; a dispatch
   * (kind "advanced") snapshots the target rows so completeActiveUnit can
   * detect completed-no-advance. Transient retry pauses (kind "paused") are
   * not recorded here — the loop counts them against its existing
   * consecutive-error budget and, on exhaustion, stops through the blocked
   * path and records that exhaustion into this same ledger (ADR-047 gap fix).
   */
  private adjudicateLiveness(result: AutoAdvanceResult): AutoAdvanceResult {
    if (this.pendingBackstopFailure) return this.backstopFailure(this.pendingBackstopFailure);
    const scopeId = this.backstopScopeId();
    if (!scopeId) return result;

    if (result.kind === "advanced") {
      const { unitType, unitId } = result.unit;
      const snapshot = snapshotUnitTargetRows(unitType, unitId);
      if (!snapshot.ok) return this.backstopFailure(snapshot.error);
      this.pendingTargetSnapshot = snapshot.hash ? { unitType, unitId, hash: snapshot.hash } : null;
      return result;
    }
    if (result.kind !== "blocked" && result.kind !== "error" && result.kind !== "skipped") return result;

    const livenessInput = this.pendingLivenessInput;
    this.pendingLivenessInput = null;
    if (!livenessInput) {
      return result.kind === "skipped"
        ? result
        : this.backstopFailure("semantic guard did not provide a stable identity");
    }
    const unit = this.lastDecisionUnit ?? {
      unitType: "orchestration",
      unitId: this.s.currentMilestoneId ?? "workflow",
    };
    const outcome = recordNonAdvancingOutcome({
      scopeId,
      guardId: livenessInput.guardId,
      unitType: unit.unitType,
      unitId: unit.unitId,
      inputPayload: livenessInput.inputPayload,
    }, livenessInput.sanctionedExit
      ? { sanctionedExit: livenessInput.sanctionedExit }
      : undefined);
    if ('error' in outcome) return this.backstopFailure(outcome.error);
    if (!outcome.tripped) return result;

    const wedged: AutoAdvanceResult = {
      kind: "blocked",
      reason: formatWedgeTripNotice(outcome.wedge),
      action: "stop",
      ...(result.kind === "blocked" && result.stateSnapshot
        ? { stateSnapshot: result.stateSnapshot }
        : {}),
    };
    this.journalTransition({
      name: "advance-blocked",
      reason: wedged.reason,
      unitType: unit.unitType,
      unitId: unit.unitId,
    });
    this.postAdvanceRecord(wedged);
    return wedged;
  }

  private backstopFailure(detail: string): AutoAdvanceResult {
    const blocked: AutoAdvanceResult = {
      kind: "blocked",
      reason: `liveness backstop unavailable: ${detail}. Repair the workflow database with \`/gsd doctor --fix\` before resuming auto-mode.`,
      action: "stop",
    };
    this.journalTransition({ name: "advance-blocked", reason: blocked.reason });
    this.postAdvanceRecord(blocked);
    return blocked;
  }

  private async advanceInner(): Promise<AutoAdvanceResult> {
    debugCount("dispatches");
    const stopAdvanceTimer = debugTime("orchestrator-advance");
    this.lastDecisionUnit = null;
    this.pendingLivenessInput = null;
    try {
      this.ensureLockOwnership();
      const uokGateContext = this.resolveUokGateContext();

      const staleMsg = this.checkResourcesStale();
      if (staleMsg) {
        await this.emitUokGate({
          ...uokGateContext,
          gateId: "resource-version-guard",
          gateType: "policy",
          outcome: "fail",
          failureClass: "policy",
          rationale: "resource version guard blocked dispatch",
          findings: staleMsg,
        });
        const blocked: AutoAdvanceResult = { kind: "blocked", reason: staleMsg, action: "pause" };
        this.journalTransition({ name: "advance-blocked", reason: blocked.reason });
        this.postAdvanceRecord(blocked);
        return this.withLivenessInput(blocked, { guardId: "resource-version-guard" });
      }
      await this.emitUokGate({
        ...uokGateContext,
        gateId: "resource-version-guard",
        gateType: "policy",
        outcome: "pass",
        failureClass: "none",
        rationale: "resource version guard passed",
      });

      const gate = await this.preAdvanceGate();
      if (gate.kind === "fail") {
        await this.emitUokGate({
          ...uokGateContext,
          gateId: "pre-dispatch-health-gate",
          gateType: "execution",
          outcome: "manual-attention",
          failureClass: "manual-attention",
          rationale: "pre-dispatch health gate blocked dispatch",
          findings: gate.reason,
        });
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: gate.reason,
          action: gate.action ?? "pause",
        };
        this.journalTransition({ name: "advance-blocked", reason: blocked.reason });
        this.postAdvanceRecord(blocked);
        return this.withLivenessInput(blocked, { guardId: "pre-dispatch-health-gate" });
      }
      if (gate.kind === "threw") {
        await this.emitUokGate({
          ...uokGateContext,
          gateId: "pre-dispatch-health-gate",
          gateType: "execution",
          outcome: "manual-attention",
          failureClass: "manual-attention",
          rationale: "pre-dispatch health gate threw unexpectedly",
          findings: String(gate.error),
        });
        // intentional fall-through: matches runPreDispatch behaviour
      } else {
        await this.emitUokGate({
          ...uokGateContext,
          gateId: "pre-dispatch-health-gate",
          gateType: "execution",
          outcome: "pass",
          failureClass: "none",
          rationale: "pre-dispatch health gate passed",
          findings: gate.fixesApplied?.join(", ") ?? "",
        });
      }

      const reconciliation = await this.reconcileBeforeDispatch();
      if (!reconciliation.ok || !reconciliation.stateSnapshot) {
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: reconciliation.reason ?? "state reconciliation produced no snapshot",
          action: "pause",
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.journalTransition({ name: "advance-blocked", reason: blocked.reason });
        this.postAdvanceRecord(blocked);
        const blockerDetails = "blockerDetails" in reconciliation
          ? reconciliation.blockerDetails
          : [{ message: blocked.reason }];
        const blockerKinds = blockerDetails.map((detail) =>
          detail.drift?.kind ?? detail.detectorKind ?? "state"
        ).sort();
        return this.withLivenessInput(blocked, {
          guardId: `state-reconciliation:${[...new Set(blockerKinds)].join("+")}`,
          inputPayload: serializeNonAdvancingEvidence(blockerDetails),
        });
      }

      const reconciledPhase = reconciliation.stateSnapshot.phase;
      if (this.lastDerivedPhase !== null) {
        this.observePhaseTransition(this.lastDerivedPhase, reconciledPhase);
      }
      this.lastDerivedPhase = reconciledPhase;

      const decision = await this.decideNextUnit({ stateSnapshot: reconciliation.stateSnapshot });
      if (!decision) {
        const settlementBlock = this.evaluateNoRemainingUnitsSettlement(reconciliation.stateSnapshot);
        if (settlementBlock) {
          const settlement = this.s.milestoneSettlement;
          if (settlement && !settlement.ok && settlement.reason === "merge-pending") {
            const merged = await this.mergePendingCompleteMilestone(settlement.milestoneId);
            if (merged.ok) {
              const terminalOutcome = noRemainingUnitsOutcome(reconciliation.stateSnapshot);
              const stopped: AutoAdvanceResult = {
                kind: "stopped",
                reason: terminalOutcome.displayReason,
                stateSnapshot: reconciliation.stateSnapshot,
                terminalOutcome,
              };
              this.status.phase = "stopped";
              this.status.activeUnit = undefined;
              this.discardActiveUnitRun(stopped.reason);
              this.bumpTransition();
              this.journalTransition({ name: "advance-stopped", reason: stopped.reason });
              this.postAdvanceRecord(stopped);
              return stopped;
            }
            settlementBlock.reason = merged.reason;
            settlementBlock.terminalOutcome = {
              code: "settlement-blocked",
              displayReason: merged.reason,
              nextAction: `Fix the merge failure, then retry \`/gsd dispatch complete-milestone ${settlement.milestoneId}\`.`,
              milestoneId: settlement.milestoneId,
              allMilestonesComplete: false,
            };
          }
          this.status.phase = "paused";
          this.status.activeUnit = undefined;
          this.bumpTransition();
          this.journalTransition({ name: "advance-blocked", reason: settlementBlock.reason });
          this.postAdvanceRecord(settlementBlock);
          return this.withLivenessInput(settlementBlock, { guardId: "milestone-settlement" });
        }
        const terminalOutcome = noRemainingUnitsOutcome(reconciliation.stateSnapshot);
        const stopped: AutoAdvanceResult = {
          kind: "stopped",
          reason: terminalOutcome.displayReason,
          stateSnapshot: reconciliation.stateSnapshot,
          terminalOutcome,
        };
        this.status.phase = "stopped";
        this.status.activeUnit = undefined;
        this.discardActiveUnitRun(stopped.reason);
        this.bumpTransition();
        this.journalTransition({ name: "advance-stopped", reason: stopped.reason });
        this.postAdvanceRecord(stopped);
        return stopped;
      }
      if ("kind" in decision && decision.kind === "skipped") {
        this.discardActiveUnitRun(decision.reason);
        const skipped: AutoAdvanceResult = {
          kind: "skipped",
          code: decision.code,
          reason: decision.reason,
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.status.phase = "running";
        this.status.activeUnit = undefined;
        this.bumpTransition();
        this.journalTransition({ name: "advance-skipped", reason: skipped.reason });
        this.postAdvanceRecord(skipped);
        return skipped;
      }
      if (!("unitType" in decision)) {
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: decision.reason,
          action: decision.action,
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.journalTransition({ name: "advance-blocked", reason: blocked.reason });
        this.postAdvanceRecord(blocked);
        return this.withLivenessInput(blocked, { guardId: decision.guardId });
      }

      const priorSliceBlocker = this.findPriorSliceCompletionBlocker(decision.unitType, decision.unitId);
      if (priorSliceBlocker) {
        this.clearPendingDispatch();
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: priorSliceBlocker,
          action: "stop",
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.journalTransition({
          name: "advance-blocked",
          reason: blocked.reason,
          unitType: decision.unitType,
          unitId: decision.unitId,
        });
        this.postAdvanceRecord(blocked);
        return this.withLivenessInput(blocked, { guardId: "prior-slice-completion" });
      }

      // ADR-047: remember the decided unit so any guard block below carries
      // its target identity into the liveness ledger.
      this.lastDecisionUnit = { unitType: decision.unitType, unitId: decision.unitId };
      const nextKey = buildDispatchKey(decision.unitType, decision.unitId);

      if (this.lastFinalizedUnitKey === nextKey) {
        this.clearPendingDispatch();
        const current = snapshotUnitTargetRows(decision.unitType, decision.unitId);
        if (!current.ok || !current.hash) {
          this.pendingBackstopFailure = current.ok
            ? `target snapshot unavailable for finalized ${decision.unitType} ${decision.unitId}`
            : current.error;
        }
        const skipped: AutoAdvanceResult = {
          kind: "skipped",
          code: "completed-no-advance",
          reason: `state did not advance after finalized ${decision.unitType} ${decision.unitId}`,
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.journalTransition({
          name: "advance-skipped",
          reason: skipped.reason,
          unitType: decision.unitType,
          unitId: decision.unitId,
        });
        this.postAdvanceRecord(skipped);
        return this.withLivenessInput(skipped, {
          guardId: COMPLETED_NO_ADVANCE_GUARD_ID,
          inputPayload: current.ok && current.hash ? current.hash : skipped.reason,
          sanctionedExit:
            `${decision.unitType} ${decision.unitId} completed without changing any of its target rows; ` +
            `inspect the unit's summary and reconcile state (\`/gsd status\`, \`/gsd doctor\`) before re-running.`,
        });
      }

      const orphanedActiveUnit = this.readOrphanedActiveUnitBlocker(decision.unitType, decision.unitId);
      if (orphanedActiveUnit) {
        this.clearPendingDispatch();
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: orphanedActiveUnit.reason,
          action: "stop",
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.journalTransition({
          name: "advance-blocked",
          reason: blocked.reason,
          unitType: decision.unitType,
          unitId: decision.unitId,
        });
        this.postAdvanceRecord(blocked);
        return this.withLivenessInput(blocked, {
          guardId: "orphaned-active-unit",
          inputPayload: orphanedActiveUnit.inputPayload,
          sanctionedExit: blocked.reason,
        });
      }

      const existingRun = resolveExistingUnitRun({
        workerId: this.s.workerId,
        unitType: decision.unitType,
        unitId: decision.unitId,
        unitExecutionInFlight: this.s.unitExecutionInFlight,
      });
      if (existingRun.kind === "skip-in-flight") {
        this.clearPendingDispatch();
        const skipped: AutoAdvanceResult = {
          kind: "skipped",
          code: UNIT_ALREADY_ACTIVE_SKIP_CODE,
          reason: UNIT_ALREADY_ACTIVE_SKIP_REASON,
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.journalTransition({
          name: "advance-skipped",
          reason: skipped.reason,
          unitType: decision.unitType,
          unitId: decision.unitId,
        });
        this.postAdvanceRecord(skipped);
        return skipped;
      }

      // ADR-047: the legacy detect-stuck rule set ("Rule 1" over the dispatch
      // window) was deleted, not paralleled. Non-advancing outcomes now feed
      // the DB-persisted block-signature ledger in adjudicateLiveness(), which
      // trips at 2 identical-input occurrences, interleaving-blind — covering
      // the repeat, oscillation, and zero-work re-dispatch shapes the window
      // rules missed or double-reported.

      const contract = this.compileUnitToolContract(decision.unitType);
      if (!contract.ok) {
        this.clearPendingDispatch();
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: contract.reason,
          action: "pause",
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.journalTransition({
          name: "advance-blocked",
          reason: blocked.reason,
          unitType: decision.unitType,
          unitId: decision.unitId,
        });
        this.postAdvanceRecord(blocked);
        return this.withLivenessInput(blocked, { guardId: "unit-tool-contract" });
      }

      const worktree = await this.prepareWorktreeForUnit(decision.unitType, decision.unitId);
      if (!worktree.ok) {
        this.clearPendingDispatch();
        const blocked: AutoAdvanceResult = {
          kind: "blocked",
          reason: worktree.reason,
          action: "pause",
          stateSnapshot: reconciliation.stateSnapshot,
        };
        this.journalTransition({
          name: "advance-blocked",
          reason: blocked.reason,
          unitType: decision.unitType,
          unitId: decision.unitId,
        });
        this.postAdvanceRecord(blocked);
        return this.withLivenessInput(blocked, { guardId: "unit-worktree-preparation" });
      }

      const dispatchId = existingRun.kind === "resume"
        ? existingRun.dispatchId
        : this.openUnitRun(decision.unitType, decision.unitId, reconciliation.stateSnapshot);
      if (typeof dispatchId !== "number") {
        this.clearPendingDispatch();
        // ADR-047 (#2097): a rejected unit-run claim (lease held/blocked,
        // degraded, or skip) is a non-advancing guard block just like every
        // other blocked path above. It MUST register a stable liveness identity
        // so adjudicateLiveness can record/trip the signature ledger. Without
        // this, the blocked result reaches adjudicateLiveness with no
        // pendingLivenessInput and degrades into the "semantic guard did not
        // provide a stable identity" backstop-unavailable hard-stop — which
        // /gsd doctor --fix cannot repair because nothing is corrupt.
        if (dispatchId.kind === "blocked") {
          this.journalTransition({
            name: "advance-blocked",
            reason: dispatchId.reason,
            unitType: decision.unitType,
            unitId: decision.unitId,
          });
        }
        this.postAdvanceRecord(dispatchId);
        // Use a stable signature payload: lease-held reasons embed a volatile
        // `until <expiresAt>` timestamp that advances on every holder
        // heartbeat, which would defeat the ADR-047 occurrence-2 wedge trip.
        const claimInputPayload = dispatchId.kind === "blocked"
          ? stableClaimSignature(dispatchId.reason)
          : buildDispatchKey(decision.unitType, decision.unitId);
        return this.withLivenessInput(dispatchId, {
          guardId: "unit-run-claim",
          inputPayload: claimInputPayload,
          // ADR-047 §5: a tripped wedge MUST carry a reachable recovery
          // instruction. Without an explicit sanctionedExit the ledger falls
          // back to the raw claim reason (e.g. `missing-worker`), which tells
          // the operator nothing about how to clear the claim blocker.
          sanctionedExit:
            `Auto-mode could not claim a unit-run for ${decision.unitType} ${decision.unitId} ` +
            `(${claimInputPayload}). Another live worker may hold the milestone lease, or the ` +
            `owning worker is shutting down mid-retry. Inspect \`/gsd status\` for the active ` +
            `UnitRun and lease holder, then re-run once the lease is released (or run ` +
            `\`/gsd doctor\` if no worker is live).`,
        });
      }

      this.status.phase = "running";
      this.bumpTransition();

      this.journalTransition({
        name: "advance",
        reason: decision.reason,
        unitType: decision.unitType,
        unitId: decision.unitId,
      });

      const advanced: AutoAdvanceResult = {
        kind: "advanced",
        unit: { unitType: decision.unitType, unitId: decision.unitId },
        stateSnapshot: reconciliation.stateSnapshot,
        dispatchId,
      };
      this.postAdvanceRecord(advanced);
      return advanced;
    } catch (error) {
      let result: AutoAdvanceResult = classifyAutoAdvanceFailure({
        error,
        unitType: activeUnitFromWorker(this.s.workerId)?.unitType,
        unitId: activeUnitFromWorker(this.s.workerId)?.unitId,
      });
      if (result.kind === "error") {
        result = this.withLivenessInput(
          result,
          { guardId: "advance-exception" },
        );
      }

      if (result.kind === "paused") {
        this.status.phase = "paused";
      } else if (result.kind === "stopped") {
        this.status.phase = "stopped";
      } else {
        this.status.phase = "error";
      }

      if (result.kind === "stopped") {
        this.lastFinalizedUnitKey = null;
        this.status.activeUnit = undefined;
      }
      this.bumpTransition();

      const journalName = result.kind === "paused"
        ? "advance-paused"
        : result.kind === "stopped"
          ? "advance-stopped"
          : "advance-error";
      this.journalTransition({ name: journalName, reason: result.reason });

      if (result.kind === "paused") {
        this.notifyLifecycle({ name: "pause", detail: result.reason });
      } else if (result.kind === "stopped") {
        this.notifyLifecycle({ name: "stopped", detail: result.reason });
      } else if (result.kind === "error") {
        this.notifyLifecycle({ name: "error", detail: result.reason });
      }
      this.postAdvanceRecord(result);
      return result;
    } finally {
      stopAdvanceTimer();
    }
  }

  public async resume(): Promise<AutoAdvanceResult> {
    this.lastFinalizedUnitKey = null;
    this.pendingBackstopFailure = null;
    // ADR-047: the DB-persisted signature ledger already spans pause/resume
    // cycles and process restarts — no in-process window to rehydrate.
    // ADR-030: drop the prior "from" — the first advance after resume has no
    // edge to assert (avoids a false illegal-edge across the pause boundary).
    this.lastDerivedPhase = null;
    this.status.phase = "running";
    this.bumpTransition();
    this.journalTransition({ name: "resume" });
    this.notifyLifecycle({ name: "resume" });
    return { kind: "resumed" };
  }

  public async stop(reason: string): Promise<AutoAdvanceResult> {
    if (this.status.phase === "stopped") {
      return { kind: "stopped", reason };
    }
    this.discardActiveUnitRun(reason);
    this.status.phase = "stopped";
    this.status.activeUnit = undefined;
    this.lastFinalizedUnitKey = null;
    this.lastDerivedPhase = null;
    this.pendingTargetSnapshot = null;
    this.bumpTransition();
    this.journalTransition({ name: "stop", reason });
    this.notifyLifecycle({ name: "stop", detail: reason });
    return { kind: "stopped", reason };
  }

  public getStatus(): AutoStatus {
    const activeUnit = activeUnitFromWorker(this.s.workerId);
    return { ...this.status, activeUnit: activeUnit ? { ...activeUnit } : undefined };
  }

  public async settle(
    dispatchId: number,
    outcome: IterationRunOutcome,
    reason: string,
  ): Promise<void> {
    const unit = unitRefForDispatch(dispatchId) ?? activeUnitFromWorker(this.s.workerId);
    if (!unit) return;
    switch (outcome) {
      case "completed":
        markDispatchCompleted(dispatchId);
        await this.recordCompletedCloseout(unit);
        break;
      case "retry":
        markDispatchFailed(dispatchId, { errorSummary: reason });
        await this.recordRetryCloseout(unit);
        break;
      case "failed":
        markDispatchFailed(dispatchId, { errorSummary: reason });
        await this.recordAbandonCloseout(unit, reason);
        break;
      case "canceled":
        markDispatchCanceled(dispatchId, reason);
        await this.recordAbandonCloseout(unit, reason);
        break;
      default: {
        const exhaustive: never = outcome;
        throw new Error(`Unhandled settle outcome: ${String(exhaustive)}`);
      }
    }
  }

  public async completeActiveUnit(unit: { unitType: string; unitId: string }): Promise<void> {
    const row = this.matchingActiveDispatch(unit);
    if (row) {
      await this.settle(row.id, "completed", "completeActiveUnit");
      return;
    }
    await this.recordCompletedCloseout(unit);
  }

  public async retryActiveUnit(unit: { unitType: string; unitId: string }): Promise<void> {
    const row = this.matchingActiveDispatch(unit);
    if (row) {
      await this.settle(row.id, "retry", "finalize-retry");
      return;
    }
    await this.recordRetryCloseout(unit);
  }

  public async abandonActiveUnit(
    unit: UnitRef,
    reason: string,
  ): Promise<void> {
    const row = this.matchingActiveDispatch(unit);
    if (row) {
      await this.settle(row.id, "failed", reason);
      return;
    }
    await this.recordAbandonCloseout(unit, reason);
  }

  private matchingActiveDispatch(unit: UnitRef) {
    if (!this.s.workerId) return null;
    const row = getActiveForWorker(this.s.workerId);
    if (!row) return null;
    if (row.unit_type !== unit.unitType || row.unit_id !== unit.unitId) return null;
    return row;
  }

  private discardActiveUnitRun(reason: string): void {
    if (!this.s.workerId) return;
    const row = getActiveForWorker(this.s.workerId);
    if (row) markDispatchCanceled(row.id, reason);
  }

  private openUnitRun(
    unitType: string,
    unitId: string,
    stateSnapshot: GSDState,
  ): number | AutoAdvanceResult {
    const claimed = claimUnitRun({
      session: this.s,
      flowId: this.s.currentTraceId ?? this.flowId,
      turnId: this.s.currentTurnId ?? randomUUID(),
      iterData: iterationDataForClaim(unitType, unitId, stateSnapshot, this.s),
      leaseDeps: {
        claimMilestoneLease,
        logLeaseRecovered: UNIT_RUN_LEASE_LOG,
        logLeaseRecoveryFailed: UNIT_RUN_LEASE_FAIL_LOG,
      },
      claimDeps: {
        getRecentDispatchesForUnit,
        recordDispatchClaim,
        markDispatchRunning,
        logClaimRejected: UNIT_RUN_CLAIM_REJECT_LOG,
        logClaimFailed: UNIT_RUN_CLAIM_FAIL_LOG,
      },
    });
    if (claimed.kind === "opened") return claimed.dispatchId;
    if (claimed.kind === "blocked" || claimed.kind === "degraded") {
      return {
        kind: "blocked",
        reason: claimed.reason,
        action: "stop",
        stateSnapshot,
      };
    }
    return {
      kind: "blocked",
      reason: `dispatch claim skipped: ${claimed.reason}`,
      action: "stop",
      stateSnapshot,
    };
  }

  private async recordCompletedCloseout(unit: UnitRef): Promise<void> {
    const unitKey = buildDispatchKey(unit.unitType, unit.unitId);
    const scopeId = this.backstopScopeId();
    const snapshot = this.pendingTargetSnapshot;
    this.pendingTargetSnapshot = null;
    if (
      scopeId &&
      snapshot &&
      buildDispatchKey(snapshot.unitType, snapshot.unitId) === unitKey
    ) {
      const current = snapshotUnitTargetRows(unit.unitType, unit.unitId);
      if (!current.ok) {
        this.pendingBackstopFailure = current.error;
      } else if (current.hash && current.hash === snapshot.hash) {
        const outcome = recordNonAdvancingOutcome({
          scopeId,
          guardId: COMPLETED_NO_ADVANCE_GUARD_ID,
          unitType: unit.unitType,
          unitId: unit.unitId,
          inputPayload: current.hash,
        }, {
          sanctionedExit:
            `${unit.unitType} ${unit.unitId} completed without changing any of its target rows; ` +
            `inspect the unit's summary and reconcile state (\`/gsd status\`, \`/gsd doctor\`) before re-running.`,
        });
        if ('error' in outcome) {
          this.pendingBackstopFailure = outcome.error;
        } else if (outcome.tripped) {
          this.ctx.ui.notify(formatWedgeTripNotice(outcome.wedge), "error");
        }
      }
    }

    this.status.activeUnit = undefined;
    this.lastFinalizedUnitKey = unitKey;
    this.bumpTransition();
    this.journalTransition({
      name: "unit-finalized",
      unitType: unit.unitType,
      unitId: unit.unitId,
    });
  }

  private async recordRetryCloseout(unit: UnitRef): Promise<void> {
    const scopeId = this.backstopScopeId();
    if (scopeId) {
      const ledgerError = lookupLatestLedgerError(unit.unitType, unit.unitId);
      // #2198: the finalize-retry recurrence is already known to be
      // non-progressing, so the trip pauses with the concrete finalize-failure
      // cause instead of minting a wedge — the acknowledge gate would only
      // repeat what the pause says, and the guard's own sanctioned exit resumes
      // with plain `/gsd auto`. The signature ledger still re-trips an
      // unchanged re-entry (recordNonAdvancingRecurrence).
      const outcome = recordNonAdvancingRecurrence({
        scopeId,
        guardId: "finalize-retry",
        unitType: unit.unitType,
        unitId: unit.unitId,
        inputPayload: ledgerError ?? "finalize-retry",
      });
      if ('error' in outcome) {
        this.pendingBackstopFailure = outcome.error;
      } else if (outcome.recurred) {
        const detail = ledgerError && ledgerError !== "finalize-retry" ? `: ${ledgerError}` : "";
        const reason =
          `${unit.unitType} ${unit.unitId} failed finalize twice with identical inputs${detail}. ` +
          `Retrying unchanged inputs cannot resolve this failure — fix the finalize failure ` +
          `(new verification evidence, changed source revision, or a recovery action), ` +
          `then re-run /gsd auto; pausing auto-mode.`;
        this.status.phase = "stopped";
        this.ctx.ui.notify(reason, "error");
        this.notifyLifecycle({ name: "stopped", detail: reason });
      }
    }

    this.status.activeUnit = undefined;
    this.lastFinalizedUnitKey = null;
    this.bumpTransition();
    this.journalTransition({
      name: "unit-retry",
      reason: "finalize-retry",
      unitType: unit.unitType,
      unitId: unit.unitId,
    });
  }

  private async recordAbandonCloseout(unit: UnitRef, reason: string): Promise<void> {
    // #2212: the abandoned turn may still be parked in a pending
    // ask_user_questions elicitation. Aborting the turn trips the tool's
    // abort signal, so showInterviewRound finishes and the TUI dialog
    // unmounts; the normal tool_execution_end → markToolEnd path retires
    // the in-flight entry. clearInFlightTools covers the case where that
    // end event never arrives, so a leaked interactive entry cannot exempt
    // later units from the idle watchdog and hard timeout.
    abortActiveUnitTurn(this.ctx);
    clearInFlightTools();
    this.status.activeUnit = undefined;
    this.pendingTargetSnapshot = null;
    this.bumpTransition();
    this.journalTransition({
      name: "unit-abandon",
      reason,
      unitType: unit.unitType,
      unitId: unit.unitId,
    });
  }

  private bumpTransition(): void {
    this.status.transitionCount += 1;
    this.status.lastTransitionAt = now();
  }
}

function isUsableLiveOrchestratorBasePath(basePath: string): boolean {
  if (!basePath || !existsSync(basePath)) return false;
  if (!detectWorktreeName(basePath)) return true;

  try {
    return readFileSync(join(basePath, ".git"), "utf8").trim().startsWith("gitdir: ");
  } catch {
    return false;
  }
}

/**
 * Resolve the base path the live orchestrator should dispatch from, falling
 * back to the project root when the captured worktree path has been removed
 * (e.g. after milestone-merge cleanup). Exported for the closeout-regression
 * tests and reused by the orchestrator's getLiveDispatchBasePath.
 */
export function resolveLiveOrchestratorBasePath(input: {
  capturedBasePath: string;
  runtimeBasePath: string;
  sessionBasePath?: string | null;
  originalBasePath?: string | null;
}): string {
  const primary = input.sessionBasePath || input.capturedBasePath;
  if (isUsableLiveOrchestratorBasePath(primary)) return primary;

  const fallbacks = [
    input.originalBasePath,
    input.runtimeBasePath,
    resolveProjectRoot(input.capturedBasePath),
  ];

  for (const candidate of fallbacks) {
    if (candidate && isUsableLiveOrchestratorBasePath(candidate)) {
      return candidate;
    }
  }

  return input.runtimeBasePath || input.capturedBasePath;
}

export function createAutoOrchestrator(context: OrchestratorContext): AutoOrchestrationModule {
  return new AutoOrchestrator(context);
}

/**
 * Inject an override for the post-settlement markdown projection rebuild,
 * returning a function that restores the default (real rebuild) behavior. Used
 * by tests to deterministically exercise the best-effort rebuild-failure path
 * (orchestrator.ts:637) — otherwise only reachable by driving advance() through
 * a full merge-pending milestone settlement and then contriving a projection
 * fault. No production caller.
 * @internal
 */
export function _setProjectionRebuildFnForTests(
  fn: ((projectRoot: string) => Promise<void>) | null,
): () => void {
  _projectionRebuildFn = fn;
  return () => { _projectionRebuildFn = null; };
}

/** @internal Test-only override for projection observation failures. */
export function _setPreserveProjectionChangesFnForTests(
  fn: typeof preserveProjectionChanges | null,
): () => void {
  _preserveProjectionChangesFn = fn;
  return () => { _preserveProjectionChangesFn = null; };
}
