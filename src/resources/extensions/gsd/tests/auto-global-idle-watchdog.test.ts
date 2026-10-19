// Project/App: gsd-pi
// File Purpose: Unit tests for the opt-in session-level idle watchdog (#2373).

import assert from "node:assert/strict";
import test from "node:test";

import {
  tickGlobalIdleWatchdog,
  noteGlobalIdleWatchdogUnitStarted,
  startGlobalIdleWatchdog,
  _registerGlobalIdleWatchdogStateForTest,
  _unregisterGlobalIdleWatchdogStateForTest,
  type GlobalIdleWatchdogSession,
  type GlobalIdleWatchdogState,
} from "../auto/global-idle-watchdog.js";
import { withGlobalIdleWatchdog } from "../auto-timers.js";
import { AutoSession } from "../auto/session.js";
import { resolveAutoSupervisorConfig } from "../preferences-models.js";
import type { ExtensionContext } from "@gsd/pi-coding-agent";

const MINUTE = 60_000;
const THRESHOLD_MS = 30 * MINUTE;

function makeState(absentSinceAt: number): GlobalIdleWatchdogState {
  return { absentSinceAt, idleNotified: false };
}

function collector() {
  const calls: Array<{ message: string; level: string }> = [];
  return {
    calls,
    notify(message: string, level: "info" | "warning" | "error" | "success" = "warning"): void {
      calls.push({ message, level });
    },
  };
}

function idleSession(milestoneId: string | null = "M001"): GlobalIdleWatchdogSession {
  return { active: true, currentUnit: null, currentMilestoneId: milestoneId };
}

test("disabled by default: resolution defaults to 0 (off)", () => {
  assert.equal(resolveAutoSupervisorConfig().global_idle_timeout_minutes, 0);
});

test("disabled by default: the loop runs unchanged with no timers or notifications", async () => {
  const { calls, notify } = collector();
  const session = idleSession() as AutoSession;
  const ctx = { ui: { notify } } as unknown as ExtensionContext;

  const result = await withGlobalIdleWatchdog(ctx, session, async () => "ran");

  assert.equal(result, "ran");
  assert.equal(calls.length, 0);
});

test("enabled + idle: exactly one notification per idle period, naming the idle minutes and milestone", () => {
  const { calls, notify } = collector();
  // Session started idle at t=0.
  const state = makeState(0);
  const session = idleSession();

  tickGlobalIdleWatchdog(state, session, notify, 29 * MINUTE, THRESHOLD_MS);
  assert.equal(calls.length, 0, "below threshold must not notify");

  tickGlobalIdleWatchdog(state, session, notify, 30 * MINUTE, THRESHOLD_MS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].level, "warning");
  assert.match(calls[0].message, /no unit in flight for 30min/);
  assert.match(calls[0].message, /M001/);

  // Still idle: the notification must not repeat.
  tickGlobalIdleWatchdog(state, session, notify, 45 * MINUTE, THRESHOLD_MS);
  tickGlobalIdleWatchdog(state, session, notify, 61 * MINUTE, THRESHOLD_MS);
  assert.equal(calls.length, 1, "must fire once per idle period");
});

test("idle time is measured from observed absence onset, never from the last busy tick", () => {
  const { calls, notify } = collector();
  const state = makeState(0);
  const session = idleSession();

  // A unit is observed busy at t=29min and finishes at t=29min59s — between ticks.
  session.currentUnit = { type: "execute-task", id: "T001" };
  tickGlobalIdleWatchdog(state, session, notify, 29 * MINUTE, THRESHOLD_MS);
  session.currentUnit = null;

  // The t=30min tick sees absence for the first time: onset is NOW, so even a
  // 1-minute threshold must not fire here even though 30min passed since the
  // last busy tick.
  tickGlobalIdleWatchdog(state, session, notify, 30 * MINUTE, MINUTE);
  assert.equal(calls.length, 0, "busy time must never count as idle");

  // The threshold counts from the observed onset.
  tickGlobalIdleWatchdog(state, session, notify, 30 * MINUTE + MINUTE - 1, MINUTE);
  assert.equal(calls.length, 0);
  tickGlobalIdleWatchdog(state, session, notify, 31 * MINUTE, MINUTE);
  assert.equal(calls.length, 1);
});

test("a unit that appears between ticks re-arms exactly via the start hook", () => {
  const { calls, notify } = collector();
  const state = makeState(0);
  const session = idleSession();
  // Register the driveable state so the production start hook can re-arm it.
  _registerGlobalIdleWatchdogStateForTest(session, state);

  tickGlobalIdleWatchdog(state, session, notify, 30 * MINUTE, THRESHOLD_MS);
  assert.equal(calls.length, 1);

  // A short unit runs 70s–80s, entirely between the 60s and 120s ticks.
  noteGlobalIdleWatchdogUnitStarted(session, 70_000);
  assert.equal(state.absentSinceAt, null, "the start hook must reset absence");
  assert.equal(state.idleNotified, false, "the start hook must re-arm");

  // Ticks never see the unit in flight, but the idle period was reset.
  tickGlobalIdleWatchdog(state, session, notify, 120_000, THRESHOLD_MS);
  assert.equal(calls.length, 1, "fresh idle period below threshold must not notify");

  tickGlobalIdleWatchdog(state, session, notify, 120_000 + THRESHOLD_MS, THRESHOLD_MS);
  assert.equal(calls.length, 2, "a second idle period fires after the sub-tick unit");
  _unregisterGlobalIdleWatchdogStateForTest(session);
});

test("AutoSession.setCurrentUnit re-arms the watchdog (covers paths that skip startUnitSupervision, e.g. resumed host verification)", async () => {
  const { calls, notify } = collector();
  const s = new AutoSession();
  s.active = true;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // 0.001 minutes = 60ms threshold, 20ms tick.
  const stop = startGlobalIdleWatchdog(s, notify, 0.001, 20);
  try {
    await sleep(140);
    assert.ok(calls.length >= 1, "an idle session must notify");
    const afterFirst = calls.length;

    // The resumed-verification shape: currentUnit is set directly via
    // setCurrentUnit without startUnitSupervision, and cleared before the
    // next tick observes it.
    s.setCurrentUnit({ type: "execute-task", id: "T001", startedAt: Date.now(), workspaceRoot: "/tmp/gsd-idle-watchdog-test" });
    await sleep(20);
    s.clearCurrentUnit();

    await sleep(40);
    assert.equal(calls.length, afterFirst, "re-armed by setCurrentUnit: no immediate re-fire");

    await sleep(140);
    assert.equal(calls.length, afterFirst + 1, "the fresh idle period notifies once");
  } finally {
    stop();
  }
});

test("an in-flight unit observed on a tick resets absence; a long unit never trips the watchdog", () => {
  const { calls, notify } = collector();
  const state = makeState(0);
  const session = idleSession();
  session.currentUnit = { type: "execute-task", id: "T001" };

  for (let minute = 1; minute <= 120; minute++) {
    tickGlobalIdleWatchdog(state, session, notify, minute * MINUTE, THRESHOLD_MS);
  }
  assert.equal(calls.length, 0, "in-flight unit means the session is not idle");
  assert.equal(state.absentSinceAt, null);

  // After the unit ends, the threshold counts from the first null tick.
  session.currentUnit = null;
  tickGlobalIdleWatchdog(state, session, notify, 125 * MINUTE, THRESHOLD_MS);
  assert.equal(calls.length, 0);
  tickGlobalIdleWatchdog(state, session, notify, 155 * MINUTE, THRESHOLD_MS);
  assert.equal(calls.length, 1);
});

test("an inactive session never notifies", () => {
  const { calls, notify } = collector();
  const state = makeState(0);
  const session = { active: false, currentUnit: null, currentMilestoneId: "M001" };

  tickGlobalIdleWatchdog(state, session, notify, 1000 * MINUTE, THRESHOLD_MS);
  assert.equal(calls.length, 0);
});

test("enabled lifecycle: one interval, unref'd, cleared on completion and on rejection", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const created: { delayMs: number; unrefCalled: boolean; cleared: boolean }[] = [];
  (globalThis as { setInterval: unknown }).setInterval = ((_fn: unknown, delay: number) => {
    const entry = { delayMs: delay as number, unrefCalled: false, cleared: false };
    created.push(entry);
    return {
      unref: () => {
        entry.unrefCalled = true;
      },
      // clearInterval on a fake handle must be tolerated by the runtime.
    };
  }) as typeof setInterval;
  (globalThis as { clearInterval: unknown }).clearInterval = ((_handle: unknown) => {
    const entry = created.find((candidate) => !candidate.cleared);
    if (entry) entry.cleared = true;
  }) as typeof clearInterval;

  try {
    const session = idleSession() as AutoSession;
    const { calls, notify } = collector();
    const ctx = { ui: { notify } } as unknown as ExtensionContext;

    // Completion path: exactly one interval is created, unref'd, and cleared.
    const result = await withGlobalIdleWatchdog(
      ctx,
      session,
      async () => "ran",
      { thresholdMinutes: 1, tickMs: 60_000 },
    );
    assert.equal(result, "ran");
    assert.equal(created.length, 1, "exactly one interval for one loop run");
    assert.equal(created[0].delayMs, 60_000);
    assert.equal(created[0].unrefCalled, true, "the interval must be unref'd");
    assert.equal(created[0].cleared, true, "the interval must be cleared when the loop settles");
    assert.equal(calls.length, 0, "the stubbed interval never fires, so nothing notifies");

    // Rejection path: the interval is still cleared.
    await assert.rejects(
      withGlobalIdleWatchdog(ctx, session, async () => {
        throw new Error("loop failed");
      }, { thresholdMinutes: 1, tickMs: 60_000 }),
      /loop failed/,
    );
    const clearedCount = created.filter((entry) => entry.cleared).length;
    assert.equal(created.length, 2);
    assert.equal(clearedCount, 2, "rejection must clear the interval too");
  } finally {
    (globalThis as { setInterval: unknown }).setInterval = originalSetInterval;
    (globalThis as { clearInterval: unknown }).clearInterval = originalClearInterval;
  }
});

test("startGlobalIdleWatchdog: real interval fires once per idle period, re-arms via the start hook, stops cleanly", async () => {
  const { calls, notify } = collector();
  const session = idleSession();
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // 0.001 minutes = 60ms threshold, 20ms tick: fast enough for a unit test.
  const stop = startGlobalIdleWatchdog(session, notify, 0.001, 20);
  try {
    await sleep(140);
    assert.ok(calls.length >= 1, "an idle session must notify");
    const afterFirst = calls.length;

    await sleep(60);
    assert.equal(calls.length, afterFirst, "must fire exactly once per idle period");

    // A unit starts (the exact re-arm hook): a fresh idle period begins.
    noteGlobalIdleWatchdogUnitStarted(session);
    await sleep(40);
    assert.equal(calls.length, afterFirst, "just re-armed: no immediate re-fire");

    await sleep(140);
    assert.equal(calls.length, afterFirst + 1, "the second idle period notifies once");
  } finally {
    stop();
  }

  const afterStop = calls.length;
  await sleep(80);
  assert.equal(calls.length, afterStop, "stop() must clear the interval");
});
