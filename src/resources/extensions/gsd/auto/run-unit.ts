// gsd-pi + src/resources/extensions/gsd/auto/run-unit.ts - Runs one GSD auto-mode unit from session creation through agent completion.

/**
 * auto/run-unit.ts — Single unit execution: session create → prompt → await agent_end.
 *
 * Imports from: auto/types, auto/resolve
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import type { AutoSession } from "./session.js";
import { NEW_SESSION_TIMEOUT_MS } from "./session.js";
import type { UnitResult } from "./types.js";
import {
  _clearCurrentResolve,
  _consumePendingSwitchCancellation,
  _markSessionSwitchAbortGraceWindow,
  _setCurrentResolve,
  _setSessionSwitchInFlight,
} from "./resolve.js";
import {
  getCurrentTurnGeneration,
  runWithTurnGeneration,
} from "./turn-epoch.js";
import { debugLog } from "../debug-logger.js";
import { logWarning, logError } from "../workflow-logger.js";
import { resolveAutoSupervisorConfig } from "../preferences.js";
import { readUnitRuntimeRecord, type AutoUnitRuntimeRecord } from "../unit-runtime.js";
import { clearAutoWakeup, consumeAutoWakeup } from "./schedule-wakeup.js";
import { applyUnitSkillVisibility } from "../skill-scope.js";

const UNIT_FAILSAFE_BUFFER_MS = 30_000;
const UNIT_FAILSAFE_RECHECK_MS = 30_000;
const WAKEUP_SLEEP_CHUNK_MS = 1_000;
const MAX_WAKEUPS_PER_UNIT = 100;

export function shouldDeferUnitFailsafeTimeout(
  runtime: AutoUnitRuntimeRecord | null,
  opts: {
    nowMs: number;
    currentUnitStartedAt?: number;
    freshProgressMs: number;
  },
): boolean {
  if (!runtime) return false;
  if (opts.currentUnitStartedAt === undefined) return false;
  if (runtime.startedAt !== opts.currentUnitStartedAt) return false;
  if (runtime.lastProgressAt <= 0) return false;
  const progressAgeMs = opts.nowMs - runtime.lastProgressAt;
  if (progressAgeMs < 0) return false;
  if (progressAgeMs > opts.freshProgressMs) return false;
  if (runtime.phase === "recovered") return true;
  if (runtime.lastProgressKind.includes("recovery")) return true;
  if (runtime.recoveryAttempts && runtime.recoveryAttempts > 0) return true;
  return progressAgeMs >= 0 && progressAgeMs <= opts.freshProgressMs;
}

async function sleepForScheduledWakeup(s: AutoSession, delayMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, delayMs);
  while (Date.now() < deadline) {
    if (!s.active || s.paused) return false;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(WAKEUP_SLEEP_CHUNK_MS, deadline - Date.now())),
    );
  }
  return s.active && !s.paused;
}

// Tracks the latest session-switch attempt so a late timeout settlement from an
// older runUnit() call cannot clear the guard for a newer one.
let sessionSwitchGeneration = 0;

/**
 * Execute a single unit: create a new session, send the prompt, and await
 * the agent_end promise. Returns a UnitResult describing what happened.
 *
 * The promise is one-shot: resolveAgentEnd() is the only way to resolve it.
 * On session creation failure or timeout, returns { status: 'cancelled' }
 * without awaiting the promise.
 */
export async function runUnit(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  unitType: string,
  unitId: string,
  prompt: string,
): Promise<UnitResult> {
  debugLog("runUnit", { phase: "start", unitType, unitId });

  // ── Session creation with timeout ──
  debugLog("runUnit", { phase: "session-create", unitType, unitId });

  const cmdCtx = s.cmdCtx;
  if (typeof cmdCtx?.newSession !== "function") {
    const msg = "command context is missing newSession";
    debugLog("runUnit", {
      phase: "session-error",
      unitType,
      unitId,
      error: msg,
    });
    return {
      status: "cancelled",
      errorContext: {
        message: `Session creation failed: ${msg}`,
        category: "session-failed",
        isTransient: false,
      },
    };
  }

  let sessionResult: { cancelled: boolean };
  let sessionTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const mySessionSwitchGeneration = ++sessionSwitchGeneration;
  // #3731: Cancellation controller for newSession(). When session creation
  // times out, abort before a late session switch can rebuild the tool runtime
  // against a stale workspace root.
  const sessionAbortController = new AbortController();
  _setSessionSwitchInFlight(true);
  try {
    const sessionPromise = cmdCtx.newSession({
      abortSignal: sessionAbortController.signal,
      workspaceRoot: s.basePath,
    }).finally(() => {
      if (sessionSwitchGeneration === mySessionSwitchGeneration) {
        _markSessionSwitchAbortGraceWindow();
        _setSessionSwitchInFlight(false);
      }
    });
    const timeoutPromise = new Promise<{ cancelled: true }>((resolve) => {
      sessionTimeoutHandle = setTimeout(
        () => {
          sessionAbortController.abort();
          resolve({ cancelled: true });
        },
        NEW_SESSION_TIMEOUT_MS,
      );
    });
    sessionResult = await Promise.race([sessionPromise, timeoutPromise]);
  } catch (sessionErr) {
    if (sessionTimeoutHandle) clearTimeout(sessionTimeoutHandle);
    _consumePendingSwitchCancellation();
    const msg =
      sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
    debugLog("runUnit", {
      phase: "session-error",
      unitType,
      unitId,
      error: msg,
    });
    const isStructural = sessionErr instanceof TypeError || /is not a function/i.test(msg);
    return { status: "cancelled", errorContext: { message: `Session creation failed: ${msg}`, category: "session-failed", isTransient: !isStructural } };
  }
  if (sessionTimeoutHandle) clearTimeout(sessionTimeoutHandle);

  if (sessionResult.cancelled) {
    _consumePendingSwitchCancellation();
    debugLog("runUnit-session-timeout", { unitType, unitId });
    return { status: "cancelled", errorContext: { message: "Session creation timed out", category: "timeout", isTransient: true } };
  }

  if (!s.active) {
    _consumePendingSwitchCancellation();
    return { status: "cancelled" };
  }

  if (s.currentUnitModel && typeof pi.setModel === "function") {
    const restored = await pi.setModel(s.currentUnitModel, { persist: false });
    if (!restored) {
      _consumePendingSwitchCancellation();
      const message =
        `Failed to restore configured model ${s.currentUnitModel.provider}/${s.currentUnitModel.id} after session creation`;
      ctx.ui.notify(
        `${message}. Cancelling unit before dispatch.`,
        "warning",
      );
      return {
        status: "cancelled",
        errorContext: {
          message,
          category: "session-failed",
          isTransient: false,
        },
      };
    }
  }

  const setVisibleSkills =
    typeof pi.setVisibleSkills === "function" ? pi.setVisibleSkills.bind(pi) : undefined;
  if (setVisibleSkills) {
    applyUnitSkillVisibility({ setVisibleSkills }, unitType);
  }

  // ── Create the agent_end promise (per-unit one-shot) ──
  // This happens after newSession completes so session-switch agent_end events
  // from the previous session cannot resolve the new unit.
  _markSessionSwitchAbortGraceWindow();
  _setSessionSwitchInFlight(false);
  const unitPromise = new Promise<UnitResult>((resolve) => {
    _setCurrentResolve(resolve);
  });
  const pendingSwitchCancellation = _consumePendingSwitchCancellation();
  if (pendingSwitchCancellation) {
    _clearCurrentResolve();
    setVisibleSkills?.(undefined);
    return {
      status: "cancelled",
      ...(pendingSwitchCancellation.errorContext ? { errorContext: pendingSwitchCancellation.errorContext } : {}),
    };
  }

  // ── Provider request-readiness pre-check (#4555) ──
  // Verify the provider can accept requests before dispatching. If the token
  // has expired since bootstrap, return cancelled immediately so the unit is
  // not wasted on a guaranteed 401.
  {
    const provider = s.currentUnitModel?.provider ?? ctx.model?.provider;
    const registry = (ctx as any).modelRegistry;

    if (provider && registry != null && typeof registry.isProviderRequestReady === "function") {
      let ready = false;
      try {
        ready = registry.isProviderRequestReady(provider);
      } catch {
        ready = false;
      }

      if (!ready) {
        _clearCurrentResolve();
        setVisibleSkills?.(undefined);
        return {
          status: "cancelled",
          errorContext: {
            message: `Provider ${provider} is not request-ready (login/token expired)`,
            category: "provider",
            isTransient: false,
          },
        };
      }
    }
  }

  // ── Capture turn generation for stale-write detection ──
  // Any write site reached via the sendMessage → tool-call → await chain
  // below sees this generation via AsyncLocalStorage. If a timeout recovery
  // or cancellation bumps the generation while this turn is in flight, those
  // writes see themselves as stale and self-drop.
  const capturedTurnGen = getCurrentTurnGeneration();

  // ── Send the prompt ──
  debugLog("runUnit", { phase: "send-message", unitType, unitId });

  const requestDispatchedAt = Date.now();
  ctx.ui.setWorkingMessage?.(null);

  // ── Await agent_end with absolute timeout (H4 fix) ──
  // If supervision fails to resolve unitPromise within 30s, treat as cancelled.
  // Without this, a crashed agent that never emits agent_end hangs the loop (#3161).
  const supervisor = resolveAutoSupervisorConfig();
  const UNIT_HARD_TIMEOUT_MS = Math.max(
    UNIT_FAILSAFE_BUFFER_MS,
    ((supervisor.hard_timeout_minutes ?? 30) * 60 * 1000) + UNIT_FAILSAFE_BUFFER_MS,
  );
  const freshProgressMs = Math.max(
    UNIT_FAILSAFE_BUFFER_MS,
    ((supervisor.idle_timeout_minutes ?? 10) * 60 * 1000) + UNIT_FAILSAFE_BUFFER_MS,
  );
  let unitTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let result: UnitResult = { status: "cancelled" };
  try {
    const awaitAgentEndWithTimeout = (agentEndPromise: Promise<UnitResult>): Promise<UnitResult> => {
      const timeoutResult = new Promise<UnitResult>((resolve) => {
        const settleOrDefer = () => {
          let runtime: AutoUnitRuntimeRecord | null;
          try {
            runtime = readUnitRuntimeRecord(s.basePath, unitType, unitId);
          } catch (error) {
            debugLog("runUnit", {
              phase: "unit-failsafe-runtime-read-failed",
              unitType,
              unitId,
              error: error instanceof Error ? error.message : String(error),
            });
            resolve({
              status: "cancelled",
              errorContext: {
                message: "Unit hard timeout — supervision may have failed; runtime progress could not be read",
                category: "timeout",
                isTransient: true,
              },
            });
            return;
          }
          if (shouldDeferUnitFailsafeTimeout(runtime, {
            nowMs: Date.now(),
            currentUnitStartedAt: s.currentUnit?.startedAt,
            freshProgressMs,
          })) {
            debugLog("runUnit", {
              phase: "unit-failsafe-deferred",
              unitType,
              unitId,
              runtimePhase: runtime?.phase,
              lastProgressKind: runtime?.lastProgressKind,
            });
            unitTimeoutHandle = setTimeout(settleOrDefer, UNIT_FAILSAFE_RECHECK_MS);
            return;
          }
          resolve({ status: "cancelled", errorContext: { message: "Unit hard timeout — supervision may have failed", category: "timeout", isTransient: true } });
        };
        unitTimeoutHandle = setTimeout(settleOrDefer, UNIT_HARD_TIMEOUT_MS);
      });
      return runWithTurnGeneration(capturedTurnGen, () =>
        Promise.race([agentEndPromise, timeoutResult]),
      );
    };

    pi.sendMessage(
      { customType: "gsd-auto", content: prompt, display: s.verbose },
      { triggerTurn: true },
    );

    debugLog("runUnit", { phase: "awaiting-agent-end", unitType, unitId });
    result = await awaitAgentEndWithTimeout(unitPromise);
    if (unitTimeoutHandle) {
      clearTimeout(unitTimeoutHandle);
      unitTimeoutHandle = undefined;
    }

    let wakeupCount = 0;
    while (result.status === "completed" && s.active && !s.paused) {
      const wakeup = consumeAutoWakeup(s.basePath, unitType, unitId);
      if (!wakeup) break;
      wakeupCount += 1;
      if (wakeupCount > MAX_WAKEUPS_PER_UNIT) {
        result = {
          status: "cancelled",
          errorContext: {
            message: `ScheduleWakeup limit exceeded for ${unitType} ${unitId}`,
            category: "timeout",
            isTransient: false,
          },
        };
        break;
      }
      debugLog("runUnit", {
        phase: "schedule-wakeup-wait",
        unitType,
        unitId,
        delayMs: wakeup.delayMs,
        reason: wakeup.reason,
      });
      const slept = await sleepForScheduledWakeup(s, wakeup.delayMs);
      if (!slept) {
        result = {
          status: "cancelled",
          errorContext: {
            message: `ScheduleWakeup interrupted for ${unitType} ${unitId}`,
            category: "aborted",
            isTransient: true,
          },
        };
        break;
      }
      const continuationPromise = new Promise<UnitResult>((resolve) => {
        _setCurrentResolve(resolve);
      });
      pi.sendMessage(
        { customType: "gsd-auto", content: wakeup.prompt, display: s.verbose },
        { triggerTurn: true },
      );
      debugLog("runUnit", { phase: "schedule-wakeup-awaiting-agent-end", unitType, unitId });
      result = await awaitAgentEndWithTimeout(continuationPromise);
      if (unitTimeoutHandle) {
        clearTimeout(unitTimeoutHandle);
        unitTimeoutHandle = undefined;
      }
    }
  } finally {
    if (unitTimeoutHandle) clearTimeout(unitTimeoutHandle);
    if (result.status !== "completed") {
      clearAutoWakeup(s.basePath, unitType, unitId);
    }
    ctx.ui.setWorkingMessage?.(undefined);
    setVisibleSkills?.(undefined);
  }
  debugLog("runUnit", {
    phase: "agent-end-received",
    unitType,
    unitId,
    status: result.status,
  });
  const finalResult: UnitResult = { ...result, requestDispatchedAt };

  // Discard trailing follow-up messages (e.g. async_job_result notifications)
  // from the completed unit. Without this, queued follow-ups trigger wasteful
  // LLM turns before the next session can start (#1642).
  // clearQueue() lives on AgentSession but isn't part of the typed
  // ExtensionCommandContext interface — call it via runtime check.
  try {
    const cmdCtxAny = s.cmdCtx as Record<string, unknown> | null;
    if (typeof cmdCtxAny?.clearQueue === "function") {
      (cmdCtxAny.clearQueue as () => unknown)();
    }
  } catch (e) {
    logWarning("engine", "clearQueue failed after unit completion", { error: String(e) });
  }

  return finalResult;
}
