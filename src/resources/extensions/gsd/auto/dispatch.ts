// Project/App: gsd-pi
// File Purpose: Auto-loop dispatch phase.

import type { DispatchAction } from "../auto-dispatch.js";
import { getConsecutiveDispatchBlocker } from "../dispatch-guard.js";
import { debugLog } from "../debug-logger.js";
import {
  getToolBaselineSnapshot,
  getRegisteredToolSnapshot,
} from "../auto-model-selection.js";
import { supportsStructuredQuestions } from "../workflow-mcp.js";
import type { MinimalModelRegistry } from "../context-budget.js";
import { isDbAvailable, getTask, getSlice } from "../gsd-db.js";
import { refreshWorkflowDatabaseFromDisk } from "../db-workspace.js";
import { isClosedStatus } from "../status-guards.js";
import { parseUnitId } from "../unit-id.js";
import { validateSourceWriteWorktreeSafety } from "./worktree-safety-phase.js";
import { closeoutAndStop } from "./closeout.js";
import {
  _resolveDispatchGuardBasePath,
  rememberRetryDispatch,
  applyVerificationRetryPolicy,
} from "./phase-helpers.js";
import type { PendingVerificationRetry } from "./session.js";
import type { IterationContext, IterationData, LoopState, PhaseResult, PreDispatchData } from "./types.js";

export function getAlreadyClosedDispatchReason(unitType: string, unitId: string): string | null {
  if (!isDbAvailable()) return null;
  refreshWorkflowDatabaseFromDisk();
  const { milestone, slice, task } = parseUnitId(unitId);
  if (unitType === "execute-task" && milestone && slice && task) {
    const row = getTask(milestone, slice, task);
    return row && isClosedStatus(row.status)
      ? `execute-task ${unitId} is already ${row.status}`
      : null;
  }
  if (unitType === "complete-slice" && milestone && slice) {
    const row = getSlice(milestone, slice);
    return row && isClosedStatus(row.status)
      ? `complete-slice ${unitId} is already ${row.status}`
      : null;
  }
  return null;
}

export function shouldBypassAlreadyClosedForVerificationRetry(
  unitType: string,
  unitId: string,
  retryInfo: PendingVerificationRetry | null | undefined,
): boolean {
  return (
    unitType === "execute-task" &&
    retryInfo?.unitId === unitId &&
    retryInfo.signature?.startsWith("git-commit:") === true
  );
}

function isUnhandledPhaseWarning(dispatchResult: DispatchAction): dispatchResult is Extract<DispatchAction, { action: "stop" }> {
  return dispatchResult.action === "stop" &&
    dispatchResult.level === "warning" &&
    dispatchResult.matchedRule === "<no-match>" &&
    /^Unhandled phase "/.test(dispatchResult.reason);
}

export { isUnhandledPhaseWarning };

/**
 * Phase 3: Dispatch resolution — resolve the next unit, then run local guards
 * and pre-dispatch hooks. Non-advancing outcomes are adjudicated centrally by
 * the DB-persisted liveness backstop.
 * Returns break/continue to control the loop, or next with IterationData on success.
 */
export async function runDispatch(
  ic: IterationContext,
  preData: PreDispatchData,
  loopState: LoopState,
): Promise<PhaseResult<IterationData>> {
  const { ctx, pi, s, deps, prefs } = ic;
  const { state, mid, midTitle } = preData;
  const provider = ctx.model?.provider;
  const authMode = provider && typeof ctx.modelRegistry?.getProviderAuthMode === "function"
    ? ctx.modelRegistry.getProviderAuthMode(provider)
    : undefined;
  // Use the baseline snapshot rather than the live active-tool set: a prior
  // unit's per-provider narrowing (hook overrides, Groq 128-tool cap, etc.)
  // can strip required MCP tools from the live set even though
  // selectAndApplyModel will restore them before the unit is dispatched.
  // Checking a stale-narrowed set causes false transport-preflight warnings
  // that repeat on every /gsd auto resume (#477 follow-up).
  const activeTools = getToolBaselineSnapshot(pi);
  const registeredTools = getRegisteredToolSnapshot(pi);
  // Deep planning intentionally keeps human checkpoints in plain chat. In
  // Claude Code/local MCP transports, structured question requests can be
  // cancelled outside the normal chat flow, which made approval gates easy to
  // skip or bury under tool output.
  const structuredQuestionsAvailable = prefs?.planning_depth === "deep"
    ? "false"
    : supportsStructuredQuestions(activeTools, {
        authMode,
        baseUrl: ctx.model?.baseUrl,
      }) ? "true" : "false";

  debugLog("autoLoop", { phase: "dispatch-resolve", iteration: ic.iteration });
  let dispatchResult = await deps.resolveDispatch({
    basePath: s.basePath,
    mid,
    midTitle,
    state,
    prefs,
    session: s,
    structuredQuestionsAvailable,
    sessionContextWindow: ctx.model?.contextWindow,
    sessionProvider: ctx.model?.provider,
    modelRegistry: ctx.modelRegistry as MinimalModelRegistry | undefined,
    activeTools,
    registeredTools,
    sessionBaseUrl: ctx.model?.baseUrl,
    sessionAuthMode: authMode,
  });
  if (isUnhandledPhaseWarning(dispatchResult)) {
    deps.invalidateAllCaches();
    const freshState = await deps.deriveState(s.canonicalProjectRoot);
    const freshMid = freshState.activeMilestone?.id ?? mid;
    const freshMidTitle = freshState.activeMilestone?.title ?? freshMid ?? midTitle;
    debugLog("autoLoop", {
      phase: "dispatch-unhandled-phase-retry",
      iteration: ic.iteration,
      stalePhase: state.phase,
      freshPhase: freshState.phase,
    });
    dispatchResult = await deps.resolveDispatch({
      basePath: s.basePath,
      mid: freshMid,
      midTitle: freshMidTitle,
      state: freshState,
      prefs,
      session: s,
      structuredQuestionsAvailable,
      sessionContextWindow: ctx.model?.contextWindow,
      sessionProvider: ctx.model?.provider,
      modelRegistry: ctx.modelRegistry as MinimalModelRegistry | undefined,
      activeTools,
      registeredTools,
      sessionBaseUrl: ctx.model?.baseUrl,
      sessionAuthMode: authMode,
    });
  }

  if (dispatchResult.action === "stop") {
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "dispatch-stop", rule: dispatchResult.matchedRule, data: { reason: dispatchResult.reason } });
    // Warning-level stops are recoverable human checkpoints (e.g. UAT verdict
    // gate) — pause instead of hard-stopping so the session is resumable with
    // `/gsd auto`. Error/info-level stops remain hard stops for infrastructure
    // failures and terminal conditions respectively.
    // See: https://github.com/open-gsd/gsd-pi/issues/2474
    if (dispatchResult.level === "warning") {
      ctx.ui.notify(dispatchResult.reason, "warning");
      await deps.pauseAuto(ctx, pi, {
        message: dispatchResult.reason,
        category: "unknown",
      });
    } else {
      await closeoutAndStop(ctx, pi, s, deps, dispatchResult.reason);
    }
    debugLog("autoLoop", { phase: "exit", reason: "dispatch-stop" });
    return { action: "break", reason: "dispatch-stop" };
  }

  if (dispatchResult.action !== "dispatch") {
    // Non-dispatch action (e.g. "skip") — re-derive state
    await new Promise((r) => setImmediate(r));
    return { action: "continue" };
  }

  let unitType = dispatchResult.unitType;
  let unitId = dispatchResult.unitId;
  let prompt = dispatchResult.prompt;
  let pauseAfterUatDispatch = dispatchResult.pauseAfterDispatch ?? false;
  let dispatchState = state;
  let dispatchMid = mid;
  let dispatchMidTitle = midTitle;
  const pendingRetryDispatch = s.pendingVerificationRetryDispatch;
  if (pendingRetryDispatch) {
    unitType = pendingRetryDispatch.unitType;
    unitId = pendingRetryDispatch.unitId;
    prompt = pendingRetryDispatch.prompt;
    pauseAfterUatDispatch = pendingRetryDispatch.pauseAfterUatDispatch;
    dispatchState = pendingRetryDispatch.state;
    dispatchMid = pendingRetryDispatch.mid ?? mid;
    dispatchMidTitle = pendingRetryDispatch.midTitle ?? midTitle;
    s.pendingVerificationRetryDispatch = null;
    debugLog("autoLoop", {
      phase: "dispatch-pending-verification-retry",
      unitType,
      unitId,
    });
  }

  const alreadyClosedReason = getAlreadyClosedDispatchReason(unitType, unitId);
  if (
    alreadyClosedReason &&
    !shouldBypassAlreadyClosedForVerificationRetry(unitType, unitId, s.pendingVerificationRetry)
  ) {
    s.pendingVerificationRetry = null;
    deps.invalidateAllCaches();
    debugLog("autoLoop", {
      phase: "dispatch-skip-already-closed",
      unitType,
      unitId,
      reason: alreadyClosedReason,
    });
    deps.emitJournalEvent({
      ts: new Date().toISOString(),
      flowId: ic.flowId,
      seq: ic.nextSeq(),
      eventType: "guard-block",
      data: { unitType, unitId, reason: alreadyClosedReason },
    });
    ctx.ui.notify(`Skipping ${unitType} ${unitId}: ${alreadyClosedReason}.`, "info");
    await new Promise((r) => setImmediate(r));
    return { action: "continue" };
  }

  deps.emitJournalEvent({
    ts: new Date().toISOString(),
    flowId: ic.flowId,
    seq: ic.nextSeq(),
    eventType: "dispatch-match",
    rule: pendingRetryDispatch ? "verification-retry" : dispatchResult.matchedRule,
    data: { unitType, unitId },
  });

  // Resolve hooks and prior-slice gating before health/stuck accounting so
  // those checks run against the final dispatch unit.
  const preDispatchResult = deps.runPreDispatchHooks(
    unitType,
    unitId,
    prompt,
    s.basePath,
  );
  if (preDispatchResult.firedHooks.length > 0) {
    ctx.ui.notify(
      `Pre-dispatch hook${preDispatchResult.firedHooks.length > 1 ? "s" : ""}: ${preDispatchResult.firedHooks.join(", ")}`,
      "info",
    );
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "pre-dispatch-hook", data: { firedHooks: preDispatchResult.firedHooks, action: preDispatchResult.action } });
  }
  if (preDispatchResult.action === "skip") {
    ctx.ui.notify(
      `Skipping ${unitType} ${unitId} (pre-dispatch hook).`,
      "info",
    );
    await new Promise((r) => setImmediate(r));
    return { action: "continue" };
  }
  if (preDispatchResult.action === "replace") {
    prompt = preDispatchResult.prompt ?? prompt;
    if (preDispatchResult.unitType) unitType = preDispatchResult.unitType;
  } else if (preDispatchResult.prompt) {
    prompt = preDispatchResult.prompt;
  }

  const guardBasePath = _resolveDispatchGuardBasePath(s);
  let mainBranch = "main";
  try {
    mainBranch = deps.getMainBranch(guardBasePath);
  } catch (err) {
    debugLog("autoLoop", { phase: "getMainBranch-failed", error: String(err) });
  }
  const priorSliceBlocker = deps.getPriorSliceCompletionBlocker(
    guardBasePath,
    mainBranch,
    unitType,
    unitId,
  );
  if (priorSliceBlocker) {
    await deps.stopAuto(ctx, pi, priorSliceBlocker);
    debugLog("autoLoop", { phase: "exit", reason: "prior-slice-blocker" });
    return { action: "break", reason: "prior-slice-blocker" };
  }

  const consecutiveDispatchBlocker = getConsecutiveDispatchBlocker(
    loopState,
    state.phase,
    unitType,
    unitId,
  );
  if (consecutiveDispatchBlocker) {
    await deps.stopAuto(ctx, pi, consecutiveDispatchBlocker);
    debugLog("autoLoop", { phase: "exit", reason: "consecutive-dispatch-blocker" });
    return { action: "break", reason: "consecutive-dispatch-blocker" };
  }

  const worktreeSafetyBlock = await validateSourceWriteWorktreeSafety(
    ic,
    unitType,
    unitId,
    mid,
    "pre-dispatch",
  );
  if (worktreeSafetyBlock) return worktreeSafetyBlock;


  return {
    action: "next",
    data: {
      unitType, unitId, prompt, finalPrompt: prompt,
      pauseAfterUatDispatch,
      state: dispatchState, mid: dispatchMid, midTitle: dispatchMidTitle,
      isRetry: Boolean(pendingRetryDispatch), previousTier: undefined,
      hookModelOverride: preDispatchResult.model,
    },
  };
}
