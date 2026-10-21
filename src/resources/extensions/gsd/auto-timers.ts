/**
 * Unit supervision timers — soft timeout warning, idle watchdog,
 * hard timeout, and context-pressure monitor.
 *
 * Originally extracted from dispatchNextUnit() in auto.ts (now deleted — replaced by autoLoop).
 * via startUnitSupervision() and torn down by the caller via clearUnitTimeout().
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { readUnitRuntimeRecord, writeUnitRuntimeRecord } from "./unit-runtime.js";
import { isDbAvailable, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { resolveAutoSupervisorConfig } from "./preferences.js";
import type { AutoSupervisorConfig, GSDPreferences } from "./preferences.js";
import { computeBudgets, resolveExecutorContextWindow } from "./context-budget.js";
import {
  getInFlightToolCount,
  clearInFlightTools,
  hasInteractiveToolInFlight,
  getOldestStallDetectableToolStart,
} from "./auto-tool-tracking.js";
import { detectWorkingTreeActivity } from "./auto-supervisor.js";
import { applySupervisorModelIfConfigured } from "./auto-model-selection.js";
import { closeoutUnit, type CloseoutOptions } from "./auto-unit-closeout.js";
import { saveActivityLog } from "./activity-log.js";
import { recoverTimedOutUnit, type RecoveryContext } from "./auto-timeout-recovery.js";
import { resolveAgentEndCancelled } from "./auto/resolve.js";
import type { PauseAutoOptions } from "./auto/loop-deps.js";
import type { AutoSession } from "./auto/session.js";
import { logWarning, logError } from "./workflow-logger.js";

export interface SupervisionContext {
  s: AutoSession;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  unitType: string;
  unitId: string;
  prefs: GSDPreferences | undefined;
  buildSnapshotOpts: () => CloseoutOptions & Record<string, unknown>;
  buildRecoveryContext: () => RecoveryContext;
  pauseAuto: (ctx?: ExtensionContext, pi?: ExtensionAPI, errorContext?: undefined, options?: PauseAutoOptions) => Promise<void>;
  /** Optional task estimate string (e.g. "30m", "2h") for timeout scaling (#2243). */
  taskEstimate?: string;
}

export const PROJECT_RESEARCH_SOFT_TIMEOUT_MINUTES = 3;
export const PROJECT_RESEARCH_HARD_TIMEOUT_MINUTES = 5;

export function resolveUnitSupervisionTimeouts(
  unitType: string,
  supervisor: AutoSupervisorConfig,
  timeoutScale: number,
): { softTimeoutMs: number; idleTimeoutMs: number; hardTimeoutMs: number } {
  const softMinutes = supervisor.soft_timeout_minutes ?? 0;
  const idleMinutes = supervisor.idle_timeout_minutes ?? 0;
  const hardMinutes = supervisor.hard_timeout_minutes ?? 0;

  if (unitType === "research-project") {
    return {
      softTimeoutMs: Math.min(softMinutes, PROJECT_RESEARCH_SOFT_TIMEOUT_MINUTES) * 60 * 1000,
      idleTimeoutMs: idleMinutes * 60 * 1000,
      hardTimeoutMs: Math.min(hardMinutes, PROJECT_RESEARCH_HARD_TIMEOUT_MINUTES) * 60 * 1000,
    };
  }

  return {
    softTimeoutMs: softMinutes * 60 * 1000 * timeoutScale,
    idleTimeoutMs: idleMinutes * 60 * 1000,
    hardTimeoutMs: hardMinutes * 60 * 1000 * timeoutScale,
  };
}

/**
 * Set up all four supervision timers for the current unit:
 * 1. Soft timeout warning (wrapup)
 * 2. Idle watchdog (progress polling, stuck tool detection)
 * 3. Hard timeout (pause + recovery)
 * 4. Context-pressure monitor (continue-here)
 */

/**
 * Parse a task estimate string (e.g. "30m", "2h", "1h30m") into minutes.
 * Returns null if the string cannot be parsed.
 */
export function parseEstimateMinutes(estimate: string): number | null {
  if (!estimate || typeof estimate !== "string") return null;
  const trimmed = estimate.trim();
  if (!trimmed) return null;

  let totalMinutes = 0;
  let matched = false;

  // Match hours component
  const hoursMatch = trimmed.match(/(\d+)\s*h/i);
  if (hoursMatch) {
    totalMinutes += Number(hoursMatch[1]) * 60;
    matched = true;
  }

  // Match minutes component
  const minutesMatch = trimmed.match(/(\d+)\s*m/i);
  if (minutesMatch) {
    totalMinutes += Number(minutesMatch[1]);
    matched = true;
  }

  return matched ? totalMinutes : null;
}

export function startUnitSupervision(sctx: SupervisionContext): void {
  const { s, ctx, pi, unitType, unitId, prefs, buildSnapshotOpts, buildRecoveryContext, pauseAuto } = sctx;

  const supervisor = resolveAutoSupervisorConfig();

  // Scale timeouts based on task estimate annotations (#2243).
  // If the task has an est: annotation, use it to extend the hard and soft timeouts
  // so longer tasks don't get prematurely timed out.
  let taskEstimate = sctx.taskEstimate;
  if (!taskEstimate && unitType === "execute-task" && isDbAvailable()) {
    // Look up the task estimate from the DB (#2243).
    try {
      if (s.currentMilestoneId) {
        const slices = getMilestoneSlices(s.currentMilestoneId);
        for (const slice of slices) {
          const tasks = getSliceTasks(s.currentMilestoneId, slice.id);
          const task = tasks.find(t => t.id === unitId);
          if (task?.estimate) {
            taskEstimate = task.estimate;
            break;
          }
        }
      }
    } catch (err) {
      // Non-fatal — fall through with no estimate
      logWarning("timer", `operation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const estimateMinutes = taskEstimate ? parseEstimateMinutes(taskEstimate) : null;
  const MAX_TIMEOUT_SCALE = 6; // Cap at 6x (60min task). Prevents 2h+ tasks from creating 120min+ timeout windows.
  const timeoutScale = estimateMinutes && estimateMinutes > 0
    ? Math.min(MAX_TIMEOUT_SCALE, Math.max(1, estimateMinutes / 10))
    : 1;

  const supervisionTimeouts = resolveUnitSupervisionTimeouts(
    unitType,
    supervisor,
    timeoutScale,
  );
  const softTimeoutMs = supervisionTimeouts.softTimeoutMs;
  const idleTimeoutMs = supervisionTimeouts.idleTimeoutMs;
  const hardTimeoutMs = supervisionTimeouts.hardTimeoutMs;
  // A single hung tool gets its own short budget, NOT the general idle window:
  // a long-but-progressing session is not idle, but a tool stuck for minutes
  // is. Falls back to the idle window only if misconfigured to zero. The
  // hung-tool budget is intentionally not scaled by task estimate — a stuck
  // tool call is stuck regardless of how long the overall task should take.
  const stalledToolTimeoutMs =
    (supervisor.stalled_tool_timeout_minutes ?? 0) > 0
      ? supervisor.stalled_tool_timeout_minutes! * 60 * 1000
      : idleTimeoutMs;

  // ── 1. Soft timeout warning ──
  s.wrapupWarningHandle = setTimeout(async () => {
    s.wrapupWarningHandle = null;
    if (!s.active || !s.currentUnit) return;
    writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
      phase: "wrapup-warning-sent",
      wrapupWarningSent: true,
    });
    // Only trigger a new turn if no tools are currently in flight.
    // Triggering during active tool calls causes tool results to be skipped
    // with "Skipped due to queued user message", leading to provider errors (#3512).
    const softTrigger = getInFlightToolCount() === 0;
    if (softTrigger) {
      await applySupervisorModelIfConfigured(ctx, pi, s.basePath);
    }
    pi.sendMessage(
      {
        customType: "gsd-auto-wrapup",
        display: s.verbose,
        content: [
          "**TIME BUDGET WARNING — keep going only if progress is real.**",
          "This unit crossed the soft time budget.",
          "If you are making progress, continue. If not, switch to wrap-up mode now:",
          "1. rerun the minimal required verification",
          "2. write or update the required durable artifacts",
          "3. mark task or slice state on disk correctly",
          "4. leave precise resume notes if anything remains unfinished",
        ].join("\n"),
      },
      { triggerTurn: softTrigger },
    );
  }, softTimeoutMs);

  // ── 2. Idle watchdog ──
  s.idleWatchdogHandle = setInterval(async () => {
    try {
      if (!s.active || !s.currentUnit) return;
      const expectedCurrentUnit = {
        type: s.currentUnit.type,
        id: s.currentUnit.id,
        startedAt: s.currentUnit.startedAt,
      };
      const runtime = readUnitRuntimeRecord(s.basePath, unitType, unitId);
      if (!runtime) return;

      // In-flight tool handling runs on its own dedicated hung-tool budget,
      // independent of the general idle gate below, so a genuinely stuck tool
      // is caught in minutes instead of waiting out the (typically much longer)
      // idle window (#2527, follow-up). A tool actively executing within budget
      // is real progress, so refreshing lastProgressAt here also keeps the idle
      // gate from firing during legitimate long-running tool calls.
      let stalledToolDetected = false;
      if (getInFlightToolCount() > 0) {
        // User-interactive tools (ask_user_questions, secure_env_collect) block
        // waiting for human input by design — never treat them as stalled (#2676).
        if (hasInteractiveToolInFlight()) {
          writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
            lastProgressAt: Date.now(),
            lastProgressKind: "interactive-tool-waiting",
          });
          return;
        }
        // Subagent coordinators and bounded execution tools (gsd_exec,
        // gsd_uat_exec, async_bash, await_job, bg_shell) can legitimately run
        // for many minutes while their work completes — each is bounded by the
        // exec sandbox clamp or its own job/timeout contract. Leave genuinely
        // hung work to the unit-level hard timeout instead of aborting on
        // wall-clock age.
        const oldestStart = getOldestStallDetectableToolStart();
        if (oldestStart === undefined) {
          writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
            lastProgressAt: Date.now(),
            lastProgressKind: "coordination-tool-in-flight",
          });
          return;
        }
        const toolAgeMs = Date.now() - oldestStart;
        if (toolAgeMs < stalledToolTimeoutMs) {
          writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
            lastProgressAt: Date.now(),
            lastProgressKind: "tool-in-flight",
          });
          return;
        }
        // Tool has been in-flight longer than the hung-tool budget — treat as
        // hung. Clear the stale entries so subsequent ticks don't re-detect
        // them, and set the flag so the idle gate and filesystem-activity check
        // below do not override the stall verdict (#2527).
        stalledToolDetected = true;
        clearInFlightTools();
        ctx.ui.notify(
          `Stalled tool detected: a tool has been in-flight for ${Math.round(toolAgeMs / 60000)}min (budget ${Math.round(stalledToolTimeoutMs / 60000)}min). Treating as hung — attempting idle recovery.`,
          "warning",
        );
      }

      // No hung tool — apply the general idle gate. A unit that has made
      // meaningful progress within the idle window is not idle yet.
      if (!stalledToolDetected && Date.now() - runtime.lastProgressAt < idleTimeoutMs) return;

      // Check if the agent is producing work on disk.
      // Skip this when a stalled tool was just detected — filesystem changes
      // from earlier in the task should not override the stall verdict (#2527).
      if (!stalledToolDetected && detectWorkingTreeActivity(s.basePath)) {
        writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
          lastProgressAt: Date.now(),
          lastProgressKind: "filesystem-activity",
        });
        return;
      }

      if (s.currentUnit) {
        await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts());
      } else {
        saveActivityLog(ctx, s.basePath, unitType, unitId);
      }

      const recovery = await recoverTimedOutUnit(ctx, pi, unitType, unitId, "idle", buildRecoveryContext());
      if (recovery === "recovered") return;

      // Guard: recoverTimedOutUnit is async — pauseAuto/stopAuto may have
      // set s.currentUnit = null during the await (#2527).
      if (!s.currentUnit) return;

      writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
        phase: "paused",
      });
      ctx.ui.notify(
        `Unit ${unitType} ${unitId} made no meaningful progress for ${supervisor.idle_timeout_minutes}min. Pausing auto-mode.`,
        "warning",
      );
      await pauseAuto(ctx, pi, undefined, { expectedCurrentUnit });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("timer", `[idle-watchdog] Unhandled error: ${message}`);
      // Unblock any pending unit promise so the auto-loop is not orphaned.
      resolveAgentEndCancelled({ message: `Idle watchdog error: ${message}`, category: "idle", isTransient: true });
      try {
        ctx.ui.notify(`Idle watchdog error: ${message}`, "warning");
      } catch (err) { /* best effort */
        logWarning("timer", `notification failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, 15000);

  // ── 3. Hard timeout ──
  const hardTimeoutBody = async () => {
    try {
      s.unitTimeoutHandle = null;
      if (!s.active) return;
      // User-interactive tools (ask_user_questions, secure_env_collect) block
      // waiting for human input by design. Unlike the idle watchdog (above),
      // the hard timeout had no interactive exemption, so a long human
      // deliberation crossing the hard cap would still closeout + recover
      // (triggerTurn) and abort the turn hosting the elicitation, reintroducing
      // the self-cancel loop on slow answers (#2676). Re-arm instead of firing
      // while a human is being asked, mirroring the idle watchdog's
      // refresh-and-return. Conditional on hasInteractiveToolInFlight(), so a
      // genuinely hung non-interactive unit still hits the hard cap.
      if (getInFlightToolCount() > 0 && hasInteractiveToolInFlight()) {
        s.unitTimeoutHandle = setTimeout(hardTimeoutBody, hardTimeoutMs);
        return;
      }
      const expectedCurrentUnit = s.currentUnit
        ? { type: s.currentUnit.type, id: s.currentUnit.id, startedAt: s.currentUnit.startedAt }
        : null;
      if (s.currentUnit) {
        writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit.startedAt, {
          phase: "timeout",
          timeoutAt: Date.now(),
        });
        await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts());
      } else {
        saveActivityLog(ctx, s.basePath, unitType, unitId);
      }

      const recovery = await recoverTimedOutUnit(ctx, pi, unitType, unitId, "hard", buildRecoveryContext());
      if (recovery === "recovered") return;

      ctx.ui.notify(
        `Unit ${unitType} ${unitId} exceeded ${supervisor.hard_timeout_minutes}min hard timeout. Pausing auto-mode.`,
        "warning",
      );
      await pauseAuto(ctx, pi, undefined, { expectedCurrentUnit });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("timer", `[hard-timeout] Unhandled error: ${message}`);
      // Unblock any pending unit promise so the auto-loop is not orphaned.
      resolveAgentEndCancelled({ message: `Hard timeout error: ${message}`, category: "timeout", isTransient: true });
      try {
        ctx.ui.notify(`Hard timeout error: ${message}`, "warning");
      } catch (err) { /* best effort */
        logWarning("timer", `notification failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  s.unitTimeoutHandle = setTimeout(hardTimeoutBody, hardTimeoutMs);

  // ── 4. Context-pressure continue-here monitor ──
  if (s.continueHereHandle) {
    clearInterval(s.continueHereHandle);
    s.continueHereHandle = null;
  }
  const executorContextWindow = resolveExecutorContextWindow(
    ctx.modelRegistry as Parameters<typeof resolveExecutorContextWindow>[0],
    prefs as Parameters<typeof resolveExecutorContextWindow>[1],
    ctx.model?.contextWindow,
    ctx.model?.provider,
  );
  const continueHereThreshold = computeBudgets(executorContextWindow).continueThresholdPercent;
  s.continueHereHandle = setInterval(async () => {
    if (!s.active || !s.currentUnit || !s.cmdCtx) return;
    const runtime = readUnitRuntimeRecord(s.basePath, unitType, unitId);
    if (runtime?.continueHereFired) return;

    const contextUsage = s.cmdCtx.getContextUsage();
    if (!contextUsage || contextUsage.percent == null) return;
    const rawPercent = contextUsage.percent;
    if (rawPercent > 150) {
      logWarning(
        "timer",
        `[continue-here] critical context over-limit: ${rawPercent.toFixed(1)}% — forcing wrap-up`,
      );
    }
    const shouldWrapUp = rawPercent >= continueHereThreshold || rawPercent > 100;
    if (!shouldWrapUp) return;

    writeUnitRuntimeRecord(s.basePath, unitType, unitId, s.currentUnit!.startedAt, {
      continueHereFired: true,
    });

    const displayPercent = rawPercent.toFixed(1);
    if (s.verbose) {
      ctx.ui.notify(
        `Context at ${displayPercent}% (threshold: ${continueHereThreshold}%) — sending wrap-up signal.`,
        "info",
      );
    }

    // Only trigger a new turn if no tools are currently in flight (#3512).
    const contextTrigger = getInFlightToolCount() === 0;
    if (contextTrigger) {
      await applySupervisorModelIfConfigured(ctx, pi, s.basePath);
    }
    pi.sendMessage(
      {
        customType: "gsd-auto-wrapup",
        display: s.verbose,
        content: [
          "**CONTEXT BUDGET WARNING — wrap up this unit now.**",
          `Context window is at ${displayPercent}% (threshold: ${continueHereThreshold}%).`,
          "The next unit needs a fresh context to work effectively. Wrap up now:",
          "1. Finish any in-progress file writes",
          "2. Write or update the required durable artifacts (summary, checkboxes)",
          "3. Mark task state on disk correctly",
          "4. Leave precise resume notes if anything remains unfinished",
          "Do NOT start new sub-tasks or investigations.",
        ].join("\n"),
      },
      { triggerTurn: contextTrigger },
    );

    if (s.continueHereHandle) {
      clearInterval(s.continueHereHandle);
      s.continueHereHandle = null;
    }
  }, 15_000);
}
