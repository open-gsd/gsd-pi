// Project/App: gsd-pi
// File Purpose: Tests for the persistent turn-state status indicator (#2374).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  TURN_STATUS_DONE_FLASH_MS,
  TURN_STATUS_KEY,
  TURN_STATUS_POLL_MS,
  TURN_STATUS_TEXT,
  TurnStatusTracker,
  type TurnStatusUi,
} from "../turn-status.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RecordedStatus {
  key: string;
  text: string | undefined;
}

function makeFakeUi(): { ui: TurnStatusUi; statuses: RecordedStatus[]; notifications: string[] } {
  const statuses: RecordedStatus[] = [];
  const notifications: string[] = [];
  return {
    statuses,
    notifications,
    ui: {
      setStatus: (key, text) => statuses.push({ key, text }),
      notify: (message) => notifications.push(message),
    },
  };
}

function makeTracker(
  t: { after: (fn: () => void) => void },
  ui: TurnStatusUi | null,
  predicates: { question?: boolean; gate?: string | null },
  overrides: { pollIntervalMs?: number; doneFlashMs?: number } = {},
): TurnStatusTracker {
  const tracker = new TurnStatusTracker({
    ui,
    isQuestionPending: () => predicates.question ?? false,
    getPendingGateId: () => predicates.gate ?? null,
    pollIntervalMs: overrides.pollIntervalMs,
    doneFlashMs: overrides.doneFlashMs,
  });
  // Dispose before assertions can fail so a referenced interval never hangs
  // the test process (CONTRIBUTING cleanup rule).
  t.after(() => tracker.dispose());
  return tracker;
}

describe("TurnStatusTracker", () => {
  test("turn start writes working under the gsd-turn key", (t) => {
    const { ui, statuses } = makeFakeUi();
    const tracker = makeTracker(t, ui, {});

    tracker.turnStarted();

    assert.strictEqual(tracker.getState(), "working");
    assert.deepStrictEqual(statuses, [{ key: TURN_STATUS_KEY, text: "working" }]);
  });

  test("poller flips to waiting-on-you · question while an elicitation is in flight", async (t) => {
    const { ui, statuses } = makeFakeUi();
    const predicates = { question: false, gate: null as string | null };
    const tracker = new TurnStatusTracker({
      ui,
      isQuestionPending: () => predicates.question,
      getPendingGateId: () => predicates.gate,
      pollIntervalMs: 5,
    });
    t.after(() => tracker.dispose());

    tracker.turnStarted();
    predicates.question = true;
    await sleep(30);

    assert.strictEqual(tracker.getState(), "waiting-question");
    assert.ok(statuses.some((s) => s.text === TURN_STATUS_TEXT["waiting-question"]));

    // No stale waiting after the question clears.
    predicates.question = false;
    await sleep(30);
    assert.strictEqual(tracker.getState(), "working");
  });

  test("poller flips to waiting-on-you · gate while a write gate is pending", async (t) => {
    const { ui, statuses } = makeFakeUi();
    const predicates = { question: false, gate: null as string | null };
    const tracker = new TurnStatusTracker({
      ui,
      isQuestionPending: () => predicates.question,
      getPendingGateId: () => predicates.gate,
      pollIntervalMs: 5,
    });
    t.after(() => tracker.dispose());

    tracker.turnStarted();
    predicates.gate = "gate-1";
    await sleep(30);

    assert.strictEqual(tracker.getState(), "waiting-gate");
    assert.ok(statuses.some((s) => s.text === TURN_STATUS_TEXT["waiting-gate"]));

    predicates.gate = null;
    await sleep(30);
    assert.strictEqual(tracker.getState(), "working");
  });

  test("manual tick: waiting→working transitions and no stale waiting after gate clears", (t) => {
    const { ui, statuses } = makeFakeUi();
    const predicates = { question: false, gate: "gate-1" as string | null };
    const tracker = makeTracker(t, ui, predicates);

    tracker.turnStarted();
    tracker.tick();
    assert.strictEqual(tracker.getState(), "waiting-gate");

    predicates.gate = null;
    tracker.tick();
    assert.strictEqual(tracker.getState(), "working");
    assert.strictEqual(statuses[statuses.length - 1].text, "working");
  });

  test("question takes precedence over gate", (t) => {
    const { ui } = makeFakeUi();
    const tracker = makeTracker(t, ui, { question: true, gate: "gate-1" });

    tracker.turnStarted();
    tracker.tick();
    assert.strictEqual(tracker.getState(), "waiting-question");
  });

  test("notifies once per entry into a waiting state, not on every poll", (t) => {
    const { ui, notifications } = makeFakeUi();
    const predicates = { question: true };
    const tracker = makeTracker(t, ui, predicates);

    tracker.turnStarted();
    tracker.tick();
    tracker.tick();
    tracker.tick();
    assert.strictEqual(notifications.length, 1);

    // Returning to working re-arms the notify-once guard.
    predicates.question = false;
    tracker.tick();
    assert.strictEqual(notifications.length, 1);

    // Re-entry notifies again.
    predicates.question = true;
    tracker.tick();
    assert.strictEqual(notifications.length, 2);
    assert.match(notifications[0], /waiting on you/);
  });

  test("a duplicate turnStarted resets the notify-once guard", (t) => {
    const { ui, notifications } = makeFakeUi();
    const predicates = { question: true };
    const tracker = makeTracker(t, ui, predicates);

    tracker.turnStarted();
    tracker.tick();
    assert.strictEqual(notifications.length, 1);

    tracker.turnStarted();
    tracker.tick();
    assert.strictEqual(notifications.length, 2);
  });

  test("flipping question→gate notifies again", (t) => {
    const { ui, notifications } = makeFakeUi();
    const predicates = { question: true, gate: "gate-1" as string | null };
    const tracker = makeTracker(t, ui, predicates);

    tracker.turnStarted();
    tracker.tick();
    assert.strictEqual(notifications.length, 1);

    predicates.question = false;
    tracker.tick();
    assert.strictEqual(tracker.getState(), "waiting-gate");
    assert.strictEqual(notifications.length, 2);
  });

  test("turn end flashes turn done then clears after the flash window", async (t) => {
    const { ui, statuses } = makeFakeUi();
    const tracker = makeTracker(t, ui, {}, { doneFlashMs: 20 });

    tracker.turnStarted();
    tracker.turnEnded();

    assert.strictEqual(tracker.getState(), "done");
    assert.ok(statuses.some((s) => s.text === TURN_STATUS_TEXT["done"]));

    await sleep(60);
    assert.strictEqual(tracker.getState(), "idle");
    assert.deepStrictEqual(statuses[statuses.length - 1], { key: TURN_STATUS_KEY, text: undefined });
  });

  test("a new turn during the done flash cancels the pending clear", async (t) => {
    const { ui, statuses } = makeFakeUi();
    const tracker = makeTracker(t, ui, {}, { doneFlashMs: 20 });

    tracker.turnStarted();
    tracker.turnEnded();
    tracker.turnStarted();
    await sleep(60);

    assert.strictEqual(tracker.getState(), "working");
    assert.strictEqual(statuses[statuses.length - 1].text, "working");
  });

  test("retryable agent end stays working instead of flashing done", (t) => {
    const { ui, statuses } = makeFakeUi();
    const tracker = makeTracker(t, ui, {}, { doneFlashMs: 5 });

    tracker.turnStarted();
    tracker.turnEnded({ willRetry: true });

    assert.strictEqual(tracker.getState(), "working");
    awaitPromiseThenRejectIfFlashed(statuses);
    assert.ok(!statuses.some((s) => s.text === TURN_STATUS_TEXT["done"]));
  });

  test("end that hands control to the user keeps the waiting status until it clears", async (t) => {
    const { ui, statuses } = makeFakeUi();
    const predicates = { question: false, gate: "gate-1" as string | null };
    const tracker = makeTracker(t, ui, predicates, { doneFlashMs: 20, pollIntervalMs: 5 });

    tracker.turnStarted();
    tracker.tick();
    assert.strictEqual(tracker.getState(), "waiting-gate");

    // Loop ends while the gate is still pending: no done flash, still waiting.
    tracker.turnEnded();
    assert.strictEqual(tracker.getState(), "waiting-gate");

    // User approves after the loop ended → completion flash runs then.
    predicates.gate = null;
    await sleep(30);
    assert.strictEqual(tracker.getState(), "idle");
    assert.ok(statuses.some((s) => s.text === TURN_STATUS_TEXT["done"]));
  });

  test("end with waitingNow keeps waiting even if the last poll missed it", async (t) => {
    const { ui, statuses } = makeFakeUi();
    const predicates = { question: false, gate: null as string | null };
    const tracker = makeTracker(t, ui, predicates, { doneFlashMs: 20, pollIntervalMs: 5 });

    tracker.turnStarted();
    await sleep(15);
    // Deferred approval gate armed between the last tick and agent_end, and
    // it stays pending until the user answers.
    predicates.gate = "gate-1";
    tracker.turnEnded({ waitingNow: true });
    assert.strictEqual(tracker.getState(), "working");

    await sleep(30);
    assert.strictEqual(tracker.getState(), "waiting-gate");
    assert.ok(!statuses.some((s) => s.text === TURN_STATUS_TEXT["done"]));

    // Approval arrives → completion flash runs then.
    predicates.gate = null;
    await sleep(30);
    assert.strictEqual(tracker.getState(), "idle");
    assert.ok(statuses.some((s) => s.text === TURN_STATUS_TEXT["done"]));
  });

  test("rebindUi(null) then turnEnded releases the poller (no timer leak)", async (t) => {
    const { ui } = makeFakeUi();
    const tracker = makeTracker(t, ui, {}, { doneFlashMs: 20 });

    tracker.turnStarted();
    tracker.rebindUi(null);
    tracker.turnEnded();

    // Wait past what would be the done-flash window; the test process hanging
    // on a referenced interval would fail the suite, and dispose() in t.after
    // is a no-op second cleanup.
    await sleep(40);
    assert.strictEqual(tracker.getState(), "working");
  });

  test("null ui (headless) is a no-op and never throws", (t) => {
    const tracker = makeTracker(t, null, { question: true, gate: "gate-1" });

    assert.doesNotThrow(() => {
      tracker.turnStarted();
      tracker.tick();
      tracker.turnEnded();
      tracker.dispose();
    });
    assert.strictEqual(tracker.getState(), "idle");
  });

  test("predicate throw on a poll tick is warned, not fatal", (t) => {
    const { ui } = makeFakeUi();
    const tracker = new TurnStatusTracker({
      ui,
      isQuestionPending: () => {
        throw new Error("disk read failed");
      },
      getPendingGateId: () => null,
    });
    t.after(() => tracker.dispose());

    tracker.turnStarted();
    assert.doesNotThrow(() => tracker.tick());
    // Falls back to working (default desired state when predicates fail).
    assert.strictEqual(tracker.getState(), "working");
  });

  test("defaults: 500ms poll and 2s done flash", () => {
    assert.strictEqual(TURN_STATUS_POLL_MS, 500);
    assert.strictEqual(TURN_STATUS_DONE_FLASH_MS, 2000);
  });
});

/** Guard against an accidental done flash racing the assertion. */
function awaitPromiseThenRejectIfFlashed(statuses: RecordedStatus[]): void {
  if (statuses.some((s) => s.text === TURN_STATUS_TEXT["done"])) {
    assert.fail("done flash emitted for a retryable end");
  }
}
