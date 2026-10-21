// Project/App: gsd-pi
// File Purpose: Auto-loop pipeline phases — compatibility shim.
/**
 * auto/phases.ts — Pipeline phases for the auto-loop.
 *
 * This file is now a thin compatibility shim. The implementation lives in
 * focused modules (pre-dispatch, dispatch, unit-phase, finalize, closeout)
 * and in the shared helpers (phase-helpers, worktree-safety-phase).
 */

import { basename } from "node:path";
import { debugLog } from "../debug-logger.js";
import { logWarning } from "../workflow-logger.js";
import { getContextPauseAction } from "../auto-budget.js";
import { BUDGET_THRESHOLDS, type IterationContext, type PhaseResult } from "./types.js";
import type { AutoSession } from "./session.js";

// Re-export phase implementations.
export { runPreDispatch } from "./pre-dispatch.js";
export { runDispatch, getAlreadyClosedDispatchReason, isUnhandledPhaseWarning } from "./dispatch.js";
export {
  runUnitPhase,
  resetSessionTimeoutState,
  _classifyZeroToolProviderMessageForTest,
  resolveDispatchRecoveryAttempts,
  _shouldProceedWithInvalidRepoClassificationForTest,
} from "./unit-phase.js";
export { runFinalize, failClosedOnFinalizeTimeout } from "./finalize.js";
export {
  closeoutAndStop,
  generateMilestoneReport,
  _runMilestoneMergeWithStashRestore,
  _runMilestoneMergeOnceWithStashRestore,
  stopOnPostflightRecoveryNeeded,
  restorePreflightStashOrStop,
  shouldSkipTerminalMilestoneCloseout,
} from "./closeout.js";

// Re-export shared helpers.
export {
  isSamePathLocal,
  isIsolatedWorktreeSession,
  _resolveReportBasePath,
  _resolveDispatchGuardBasePath,
  shouldRunPlanV2Gate,
  _resolveCurrentUnitStartedAtForTest,
  applyVerificationRetryPolicy,
  rememberRetryDispatch,
  emitCancelledUnitEnd,
  _buildCancelledUnitStopReason,
  _isPauseOriginCancelledResult,
} from "./phase-helpers.js";

export {
  validateSourceWriteWorktreeSafety,
  formatWorktreeSafetyFailure,
  formatWorktreeSafetyStopReason,
  resolveEmptyWorktreeWithProjectContent,
  shouldDegradeEmptyWorktreeToProjectRoot,
  unitWritesSource,
} from "./worktree-safety-phase.js";

/**
 * Phase 2: Guards — stop directives, budget ceiling, context window, secrets re-check.
 * Returns break to exit the loop, or next to proceed to dispatch.
 */
export async function runGuards(
  ic: IterationContext,
  mid: string,
): Promise<PhaseResult> {
  const { ctx, pi, s, deps, prefs } = ic;

  // ── Stop/Backtrack directive guard (#3487) ──
  // Check for unexecuted stop or backtrack captures BEFORE dispatching any unit.
  // This ensures user "halt" directives are honored immediately.
  // IMPORTANT: Fail-closed — any exception during stop handling still breaks the loop
  // to ensure user halt intent is never silently dropped.
  try {
    const { loadStopCaptures, markCaptureExecuted } = await import("../captures.js");
    const stopCaptures = loadStopCaptures(s.basePath);
    if (stopCaptures.length > 0) {
      const first = stopCaptures[0];
      const isBacktrack = first.classification === "backtrack";
      const label = isBacktrack
        ? `Backtrack directive: ${first.text}`
        : `Stop directive: ${first.text}`;

      ctx.ui.notify(label, "warning");
      deps.sendDesktopNotification(
        "GSD", label, "warning", "stop-directive",
        basename(s.originalBasePath || s.basePath),
      );

      // Pause first — Ensures auto-mode stops even if later steps fail
      await deps.pauseAuto(ctx, pi);

      // For backtrack captures, write the backtrack trigger after pausing
      if (isBacktrack) {
        try {
          const { executeBacktrack } = await import("../triage-resolution.js");
          executeBacktrack(s.basePath, mid, first);
        } catch (e) {
          debugLog("guards", { phase: "backtrack-execution-error", error: String(e) });
        }
      }

      // Mark captures as executed only after successful pause/transition
      for (const cap of stopCaptures) {
        markCaptureExecuted(s.basePath, cap.id);
      }

      debugLog("autoLoop", { phase: "exit", reason: isBacktrack ? "user-backtrack" : "user-stop" });
      return {
        action: "break",
        reason: isBacktrack ? "user-backtrack" : "user-stop",
        inputPayload: JSON.stringify(stopCaptures.map((capture) => ({
          id: capture.id,
          text: capture.text,
          classification: capture.classification,
        }))),
      };
    }
  } catch (e) {
    // Fail-closed: if anything in the stop guard throws, break the loop
    // rather than silently continuing and dropping user halt intent
    debugLog("guards", { phase: "stop-guard-error", error: String(e) });
    return { action: "break", reason: "stop-guard-error", inputPayload: String(e) };
  }

  // Budget ceiling guard
  const budgetCeiling = prefs?.budget_ceiling;
  if (budgetCeiling !== undefined && budgetCeiling > 0) {
    const currentLedger = deps.getLedger() as { units: unknown } | null;
    // In parallel worker mode, only count cost from the current auto-mode session
    // to avoid hitting the ceiling due to historical project-wide spend (#2184).
    let costUnits = currentLedger?.units;
    if (process.env.GSD_PARALLEL_WORKER && s.autoStartTime && Array.isArray(costUnits)) {
      const sessionStartISO = new Date(s.autoStartTime).toISOString();
      costUnits = costUnits.filter(
        (u: { startedAt?: string }) => u.startedAt != null && u.startedAt >= sessionStartISO,
      );
    }
    const totalCost = costUnits
      ? deps.getProjectTotals(costUnits).cost
      : 0;
    const budgetPct = totalCost / budgetCeiling;
    const budgetAlertLevel = deps.getBudgetAlertLevel(budgetPct);
    const newBudgetAlertLevel = deps.getNewBudgetAlertLevel(
      s.lastBudgetAlertLevel,
      budgetPct,
    );
    const enforcement = prefs?.budget_enforcement ?? "pause";
    const budgetEnforcementAction = deps.getBudgetEnforcementAction(
      enforcement,
      budgetPct,
    );

    // Data-driven threshold check — loop descending, fire first match
    const threshold = BUDGET_THRESHOLDS.find(
      (t) => newBudgetAlertLevel >= t.pct,
    );
    if (threshold) {
      s.lastBudgetAlertLevel =
        newBudgetAlertLevel as AutoSession["lastBudgetAlertLevel"];

      // Emit Layer 2 budget_threshold event (post-plan hook recommendation).
      // Extensions / Layer 0 shell hooks may return an action override.
      let hookAction: "pause" | "downgrade" | "continue" | undefined;
      try {
        const { emitBudgetThreshold } = await import("../hook-emitter.js");
        const hookResult = await emitBudgetThreshold({
          fraction: budgetPct,
          spent: totalCost,
          limit: budgetCeiling,
        });
        if (hookResult?.action) hookAction = hookResult.action;
      } catch (hookErr) {
        logWarning("engine", `budget_threshold hook emission failed: ${(hookErr as Error).message}`);
      }

      // Apply hook override to enforcement action. "continue" → "none" (no enforcement),
      // "pause" and "downgrade" map to the matching enforcement path below.
      let effectiveAction = budgetEnforcementAction;
      if (hookAction === "continue") {
        effectiveAction = "none";
      } else if (hookAction === "pause") {
        effectiveAction = "pause";
      } else if (hookAction === "downgrade") {
        effectiveAction = "warn";
      }

      if (threshold.pct === 100 && effectiveAction !== "none") {
        const inputPayload = JSON.stringify({
          budgetCeiling,
          totalCost,
          budgetPct,
          enforcement,
          effectiveAction,
          hookAction: hookAction ?? null,
          newBudgetAlertLevel,
          thresholdPct: threshold.pct,
        });
        // 100% — special enforcement logic (halt/pause/warn)
        const msg = `Budget ceiling ${deps.formatCost(budgetCeiling)} reached (spent ${deps.formatCost(totalCost)}).`;
        if (effectiveAction === "halt") {
          deps.sendDesktopNotification("GSD", msg, "error", "budget", basename(s.originalBasePath || s.basePath));
          await deps.stopAuto(ctx, pi, "Budget ceiling reached");
          debugLog("autoLoop", { phase: "exit", reason: "budget-halt" });
          return { action: "break", reason: "budget-halt", inputPayload };
        }
        if (effectiveAction === "pause") {
          ctx.ui.notify(
            `${msg} Pausing auto-mode — /gsd auto to override and continue.`,
            "warning",
          );
          deps.sendDesktopNotification("GSD", msg, "warning", "budget", basename(s.originalBasePath || s.basePath));
          deps.logCmuxEvent(prefs, msg, "warning");
          await deps.pauseAuto(ctx, pi);
          debugLog("autoLoop", { phase: "exit", reason: "budget-pause" });
          return { action: "break", reason: "budget-pause", inputPayload };
        }
        ctx.ui.notify(`${msg} Continuing (enforcement: warn).`, "warning");
        deps.sendDesktopNotification("GSD", msg, "warning", "budget", basename(s.originalBasePath || s.basePath));
        deps.logCmuxEvent(prefs, msg, "warning");
      } else if (threshold.pct < 100) {
        // Sub-100% — simple notification
        const msg = `${threshold.label}: ${deps.formatCost(totalCost)} / ${deps.formatCost(budgetCeiling)}`;
        ctx.ui.notify(msg, threshold.notifyLevel);
        deps.sendDesktopNotification(
          "GSD",
          msg,
          threshold.notifyLevel,
          "budget",
          basename(s.originalBasePath || s.basePath),
        );
        deps.logCmuxEvent(prefs, msg, threshold.cmuxLevel);
      }
    } else if (budgetAlertLevel === 0) {
      s.lastBudgetAlertLevel = 0;
    }
  } else {
    s.lastBudgetAlertLevel = 0;
  }

  // Context window guard
  const contextThreshold = prefs?.context_pause_threshold ?? 0;
  if (contextThreshold > 0 && s.cmdCtx) {
    const contextUsage = s.cmdCtx.getContextUsage();
    if (getContextPauseAction(contextUsage?.percent, contextThreshold) === "pause") {
      const contextPercent = contextUsage!.percent as number;
      const msg = `Context window at ${contextPercent}% (threshold: ${contextThreshold}%). Pausing to prevent truncated output.`;
      ctx.ui.notify(
        `${msg} Run /gsd auto to continue (will start fresh session).`,
        "warning",
      );
      deps.sendDesktopNotification(
        "GSD",
        `Context ${contextPercent}% — paused`,
        "warning",
        "attention",
        basename(s.originalBasePath || s.basePath),
      );
      await deps.pauseAuto(ctx, pi);
      debugLog("autoLoop", { phase: "exit", reason: "context-window" });
      return {
        action: "break",
        reason: "context-window",
        inputPayload: JSON.stringify({ contextPercent, contextThreshold }),
      };
    }
  }

  // Secrets re-check gate
  try {
    const manifestStatus = await deps.getManifestStatus(s.basePath, mid, s.originalBasePath);
    if (manifestStatus && manifestStatus.pending.length > 0) {
      const result = await deps.collectSecretsFromManifest(
        s.basePath,
        mid,
        ctx,
      );
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

  return { action: "next", data: undefined as void };
}
