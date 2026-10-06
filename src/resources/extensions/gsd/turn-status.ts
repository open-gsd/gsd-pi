// Project/App: gsd-pi
// File Purpose: Persistent turn-state status indicator (#2374).
//
// The working spinner covers "busy". This module surfaces the other two
// states of the same machine on the extension status channel:
//   - "⏸ waiting on you" while the turn is parked on an interactive
//     elicitation / interactive tool (question) or a pending write gate
//     (gate), and
//   - "✅ turn done" briefly after the turn ends.
//
// Statuses are written under the "gsd-turn" key via ctx.ui.setStatus, which
// the interactive footer already renders as a secondary status — no
// TUI-package changes. Predicates are injected so the state machine is
// testable against fakes.
//
// Lifecycle notes:
//   - Start/end are the AGENT boundaries (before_agent_start / agent_end),
//     not the per-assistant-round turn_start/turn_end events, which fire
//     between tool rounds inside a single user turn.
//   - A retryable agent_end (event.willRetry) is NOT a completion — the
//     status stays "working" through provider backoff.
//   - An agent_end that leaves control with the user (elicitation in flight,
//     interactive tool in flight, pending gate) keeps the waiting status and
//     the poller alive; when the predicate clears, the "✅ turn done" flash
//     runs then. This covers approval gates armed after the loop ends.

import { logWarning } from "./workflow-logger.js";

/** Footer status key carrying the turn state (secondary status slot). */
export const TURN_STATUS_KEY = "gsd-turn";

/** Poll cadence while a turn is active. */
export const TURN_STATUS_POLL_MS = 500;

/** How long the "turn done" flash stays before the status is cleared. */
export const TURN_STATUS_DONE_FLASH_MS = 2000;

export type TurnStatusUi = {
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
};

export type TurnState = "idle" | "working" | "waiting-question" | "waiting-gate" | "done";

export const TURN_STATUS_TEXT: Readonly<Record<Exclude<TurnState, "idle">, string>> = {
  "working": "working",
  "waiting-question": "⏸ waiting on you · question",
  "waiting-gate": "⏸ waiting on you · gate",
  "done": "✅ turn done",
};

export interface TurnStatusDeps {
  /** Extension UI channel; when null (headless) the tracker stays inert. */
  ui: TurnStatusUi | null;
  /** True while an interactive elicitation (ask-user-questions) is in flight. */
  isQuestionPending: () => boolean;
  /** Pending write-gate id, or null. */
  getPendingGateId: () => string | null;
  pollIntervalMs?: number;
  doneFlashMs?: number;
}

export interface TurnEndOptions {
  /** Core will retry the failed turn — not a completion; stay "working". */
  willRetry?: boolean;
  /** A user boundary is active right now (fresh predicate read at end time). */
  waitingNow?: boolean;
}

type ActiveState = Exclude<TurnState, "idle">;

/**
 * Turn-status state machine. Lifecycle: turnStarted() → "working" (poller
 * every 500ms flips to a waiting state while the turn is parked on the user,
 * and back to working when the predicate clears) → turnEnded() → "✅ turn
 * done" flash, cleared after ~2s. Retryable ends and ends that hand control
 * to the user keep the poller alive instead of flashing done; a new turn
 * cancels a pending done-clear.
 */
export class TurnStatusTracker {
  private deps: TurnStatusDeps;
  private state: TurnState = "idle";
  private turnActive = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWaitingKind: "question" | "gate" | null = null;

  constructor(deps: TurnStatusDeps) {
    this.deps = deps;
  }

  getState(): TurnState {
    return this.state;
  }

  /** Re-bind the UI channel (per-event ctx may hand us a fresh object). */
  rebindUi(ui: TurnStatusUi | null): void {
    this.deps.ui = ui;
  }

  /** Agent start → "working" and start the waiting-state poller. */
  turnStarted(): void {
    if (!this.deps.ui) return;
    this.turnActive = true;
    this.cancelDoneClear();
    this.lastWaitingKind = null;
    this.setState("working");
    this.ensurePoller();
  }

  /**
   * Agent end → stop, unless the end is not a completion: a retryable error
   * stays "working"; handing control to the user keeps the waiting status
   * (and poller) until the predicate clears, then flashes done.
   */
  turnEnded(opts: TurnEndOptions = {}): void {
    this.turnActive = false;
    if (!this.deps.ui) {
      // Still release timers — the UI channel may have been rebound away.
      this.stopPoller();
      this.cancelDoneClear();
      return;
    }
    if (opts.willRetry) {
      this.lastWaitingKind = null;
      this.setState("working");
      this.ensurePoller();
      return;
    }
    if (opts.waitingNow || this.state === "waiting-question" || this.state === "waiting-gate") {
      this.ensurePoller();
      return;
    }
    this.flashDone();
  }

  /** Poll tick — recompute the desired state from the injected predicates. */
  tick(): void {
    if (!this.deps.ui) {
      this.stopPoller();
      return;
    }
    if (this.state !== "working" && this.state !== "waiting-question" && this.state !== "waiting-gate") return;

    let questionPending = false;
    let gatePending = false;
    try {
      questionPending = this.deps.isQuestionPending();
      gatePending = !questionPending && this.deps.getPendingGateId() !== null;
    } catch (err) {
      logWarning("dashboard", `turn-status poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const desired: ActiveState = questionPending
      ? "waiting-question"
      : gatePending
        ? "waiting-gate"
        : "working";

    // Post-turn waiting resolved: the user answered after the loop ended —
    // run the completion flash instead of returning to "working".
    if (!this.turnActive && desired === "working") {
      this.flashDone();
      return;
    }
    if (desired === this.state) return;

    if (desired === "waiting-question" || desired === "waiting-gate") {
      const kind = desired === "waiting-question" ? "question" : "gate";
      // One notify per entry into a waiting state (re-entry after returning
      // to working notifies again; flipping question↔gate notifies too).
      if (this.lastWaitingKind !== kind) {
        this.safeUi("notify", (ui) =>
          ui.notify(
            kind === "question"
              ? "GSD is waiting on you — answer the question in the terminal"
              : "GSD is waiting on you — approve the pending write gate",
            "info",
          ));
      }
      this.lastWaitingKind = kind;
    } else {
      this.lastWaitingKind = null;
    }

    this.setState(desired);
  }

  /** Stop timers without touching the rendered status (process teardown). */
  dispose(): void {
    this.turnActive = false;
    this.stopPoller();
    this.cancelDoneClear();
  }

  private ensurePoller(): void {
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.tick(), this.deps.pollIntervalMs ?? TURN_STATUS_POLL_MS);
    }
  }

  private flashDone(): void {
    this.stopPoller();
    this.lastWaitingKind = null;
    this.setState("done");
    this.cancelDoneClear();
    this.clearTimer = setTimeout(() => {
      this.clearTimer = null;
      if (this.state === "done") {
        this.safeUi("setStatus", (ui) => ui.setStatus(TURN_STATUS_KEY, undefined));
        this.state = "idle";
      }
    }, this.deps.doneFlashMs ?? TURN_STATUS_DONE_FLASH_MS);
    if (typeof this.clearTimer.unref === "function") this.clearTimer.unref();
  }

  private setState(state: ActiveState | "done"): void {
    this.state = state;
    this.safeUi("setStatus", (ui) => ui.setStatus(TURN_STATUS_KEY, TURN_STATUS_TEXT[state]));
  }

  /**
   * Run a UI-channel call without letting a sync throw escape into the
   * shared poll/done timers (#2515): tick() runs on a 500ms interval inside
   * the TUI process, and an escaping throw surfaces as an uncaughtException
   * that tears the whole session down. A failed status write or notify
   * degrades to a warning instead.
   */
  private safeUi(op: string, fn: (ui: TurnStatusUi) => void): void {
    const ui = this.deps.ui;
    if (!ui) return;
    try {
      fn(ui);
    } catch (err) {
      logWarning("dashboard", `turn-status ${op} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private stopPoller(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private cancelDoneClear(): void {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
  }
}
