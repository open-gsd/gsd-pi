// Project/App: gsd-pi
// File Purpose: Session-level idle watchdog core (#2373) — pure state machine
// plus timer ownership, dependency-free so AutoSession can re-arm it directly
// from setCurrentUnit without import-weight or cycles.
//
// Every other observer in auto-mode is scoped to a unit or an iteration; this
// watchdog is the one observer for "auto-mode is active and nothing is being
// dispatched" (#1805 shape). Notification only — no retry, no repair, no state
// mutation (the Hermes #2210/#2287 precedent).
//
// Semantics: idle time is measured from the moment absence was first observed
// (or the loop started), never from the last busy tick, so a unit that just
// finished is never counted as idle. Unit starts re-arm the watchdog exactly
// via noteGlobalIdleWatchdogUnitStarted (wired from AutoSession.setCurrentUnit),
// so even a unit that starts and ends between two ticks begins a fresh idle
// period. End-of-unit detection is tick-sampled, so firing can lag the true
// threshold by at most one tick — it never fires early.

/** Structural session surface the global idle watchdog reads. */
export interface GlobalIdleWatchdogSession {
  active: boolean;
  currentUnit: { type: string; id: string } | null;
  currentMilestoneId?: string | null;
}

export interface GlobalIdleWatchdogState {
  /** When absence (no unit in flight) was first observed; null while a unit is in flight. */
  absentSinceAt: number | null;
  idleNotified: boolean;
}

export const GLOBAL_IDLE_WATCHDOG_TICK_MS = 60_000;

export type GlobalIdleWatchdogNotify = (message: string, level: "info" | "warning" | "error" | "success") => void;

/**
 * One tick of the session-level idle watchdog (#2373). While a unit is in
 * flight the idle clock resets; with no unit in flight past the threshold,
 * exactly one notification per idle period is emitted.
 */
export function tickGlobalIdleWatchdog(
  state: GlobalIdleWatchdogState,
  session: GlobalIdleWatchdogSession,
  notify: GlobalIdleWatchdogNotify,
  now: number,
  thresholdMs: number,
): void {
  if (!session.active) return;
  if (session.currentUnit) {
    state.absentSinceAt = null;
    state.idleNotified = false;
    return;
  }
  if (state.absentSinceAt === null) state.absentSinceAt = now;
  if (state.idleNotified) return;
  if (now - state.absentSinceAt < thresholdMs) return;
  state.idleNotified = true;
  const idleMinutes = Math.round((now - state.absentSinceAt) / 60_000);
  const milestoneSuffix = session.currentMilestoneId ? ` for milestone ${session.currentMilestoneId}` : "";
  notify(
    `Auto-mode has had no unit in flight for ${idleMinutes}min${milestoneSuffix} ` +
    `(auto_supervisor.global_idle_timeout_minutes reached). No action was taken automatically — the session stays active.`,
    "warning",
  );
}

// Watchdog state keyed by session object: lets AutoSession.setCurrentUnit
// re-arm the watchdog exactly without carrying watchdog bookkeeping itself.
const globalIdleWatchdogStates = new WeakMap<object, GlobalIdleWatchdogState>();

/**
 * Exact re-arm hook (#2373): marks a unit as started for the session's global
 * idle watchdog, so a unit that starts (and even ends) between two ticks still
 * begins a fresh idle period. No-op when the watchdog is not running for the
 * session. Wired from AutoSession.setCurrentUnit.
 */
export function noteGlobalIdleWatchdogUnitStarted(session: object, now: number = Date.now()): void {
  const state = globalIdleWatchdogStates.get(session);
  if (!state) return;
  state.absentSinceAt = null;
  state.idleNotified = false;
}

/**
 * Starts the session-level idle watchdog interval (#2373) and registers its
 * state under the session for the exact re-arm hook. Returns the stop function,
 * which clears the interval and unregisters the state.
 */
export function startGlobalIdleWatchdog(
  session: object,
  notify: GlobalIdleWatchdogNotify,
  thresholdMinutes: number,
  tickMs: number = GLOBAL_IDLE_WATCHDOG_TICK_MS,
  logFailure?: (message: string) => void,
): () => void {
  const state: GlobalIdleWatchdogState = { absentSinceAt: Date.now(), idleNotified: false };
  globalIdleWatchdogStates.set(session, state);
  const handle = setInterval(() => {
    try {
      tickGlobalIdleWatchdog(
        state,
        session as GlobalIdleWatchdogSession,
        notify,
        Date.now(),
        thresholdMinutes * 60_000,
      );
    } catch (err) {
      logFailure?.(`[global-idle-watchdog] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, tickMs);
  handle.unref?.();
  return () => {
    clearInterval(handle);
    globalIdleWatchdogStates.delete(session);
  };
}

/** @internal Exported for tests: register a driveable state for a session. */
export function _registerGlobalIdleWatchdogStateForTest(session: object, state: GlobalIdleWatchdogState): void {
  globalIdleWatchdogStates.set(session, state);
}

/** @internal Exported for tests: drop a session's registered state. */
export function _unregisterGlobalIdleWatchdogStateForTest(session: object): void {
  globalIdleWatchdogStates.delete(session);
}
