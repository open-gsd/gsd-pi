/**
 * Idle/hard timeout recovery honors the in-flight-tool guard (#1229 follow-up).
 *
 * `recoverTimedOutUnit` steers a still-running unit with `deliverAs: "steer"`
 * and, before that, may swap the session model via
 * `applySupervisorModelIfConfigured`. Swapping the model and triggering a turn
 * while non-interactive tool calls are still open skips tool results and trips
 * provider errors (#3512) — the same failure the soft wrap-up and continue-here
 * timers guard against. This test pins that the idle and hard steering branches
 * gate both the model swap and `triggerTurn` on `getInFlightToolCount() === 0`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { recoverTimedOutUnit, type RecoveryContext } from "../auto-timeout-recovery.ts";
import { clearGSDPreferencesCache } from "../preferences.ts";
import {
  markToolStart,
  markToolEnd,
  clearInFlightTools,
} from "../auto-tool-tracking.ts";

const SUPERVISOR_PREFS = [
  "auto_supervisor:",
  "  soft_timeout_minutes: 1",
  "  idle_timeout_minutes: 100",
  "  hard_timeout_minutes: 100",
  "  model:",
  "    model: supervisor-primary",
  "    fallbacks: [supervisor-fb]",
];

interface Harness {
  home: string;
  base: string;
  ctx: any;
  pi: any;
  rctx: RecoveryContext;
  setModelCalls: unknown[][];
  sendMessageCalls: unknown[][];
}

function makeHarness(): Harness {
  const home = mkdtempSync(join(tmpdir(), "gsd-recovery-guard-home-"));
  const base = mkdtempSync(join(tmpdir(), "gsd-recovery-guard-base-"));
  process.env.GSD_HOME = home;
  writeFileSync(join(home, "preferences.md"), ["---", ...SUPERVISOR_PREFS, "---", ""].join("\n"));
  clearGSDPreferencesCache();

  const setModelCalls: unknown[][] = [];
  const sendMessageCalls: unknown[][] = [];

  const ctx = {
    ui: { notify: () => {} },
    model: { provider: "anthropic" },
    modelRegistry: {
      getAvailable: () => [
        { id: "supervisor-primary", provider: "anthropic" },
        { id: "supervisor-fb", provider: "anthropic" },
      ],
    },
  } as any;

  const pi = {
    sendMessage: (...args: unknown[]) => {
      sendMessageCalls.push(args);
    },
    setModel: async (...args: unknown[]) => {
      setModelCalls.push(args);
      return true;
    },
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
  } as any;

  const rctx: RecoveryContext = {
    basePath: base,
    verbose: false,
    currentUnitStartedAt: 1234,
    unitRecoveryCount: new Map(),
  };

  return { home, base, ctx, pi, rctx, setModelCalls, sendMessageCalls };
}

function cleanup(h: Harness): void {
  clearInFlightTools();
  clearGSDPreferencesCache();
  delete process.env.GSD_HOME;
  rmSync(h.home, { recursive: true, force: true });
  rmSync(h.base, { recursive: true, force: true });
}

// "discuss-project" resolves to a PROJECT.md that never exists in the temp base,
// so recovery skips the "already on disk" shortcut and reaches the steering
// branch with recoveryAttempts (0) < maxRecoveryAttempts.
for (const reason of ["idle", "hard"] as const) {
  test(`${reason} recovery skips the supervisor model swap while a tool is in flight`, async () => {
    const h = makeHarness();
    try {
      markToolStart("call-1", true, "some_tool");

      const outcome = await recoverTimedOutUnit(
        h.ctx,
        h.pi,
        "discuss-project",
        "P01",
        reason,
        h.rctx,
      );

      assert.equal(outcome, "recovered");
      assert.equal(
        h.setModelCalls.length,
        0,
        "model must NOT swap while a tool is in flight",
      );
      assert.equal(h.sendMessageCalls.length, 1, "steer message still sent (queued)");
      const opts = h.sendMessageCalls[0][1] as { triggerTurn?: boolean; deliverAs?: string };
      assert.equal(opts.triggerTurn, false, "turn is not triggered mid-tool-call");
      assert.equal(opts.deliverAs, "steer");

      markToolEnd("call-1");
    } finally {
      cleanup(h);
    }
  });

  test(`${reason} recovery applies the supervisor model swap when no tools are in flight`, async () => {
    const h = makeHarness();
    try {
      const outcome = await recoverTimedOutUnit(
        h.ctx,
        h.pi,
        "discuss-project",
        "P01",
        reason,
        h.rctx,
      );

      assert.equal(outcome, "recovered");
      assert.equal(h.setModelCalls.length, 1, "model swaps to the supervisor model");
      assert.deepEqual(
        h.setModelCalls[0][0],
        { id: "supervisor-primary", provider: "anthropic" },
        "swaps to the configured supervisor primary",
      );
      assert.equal(h.sendMessageCalls.length, 1);
      const opts = h.sendMessageCalls[0][1] as { triggerTurn?: boolean };
      assert.equal(opts.triggerTurn, true, "turn is triggered when no tools are open");
    } finally {
      cleanup(h);
    }
  });
}
