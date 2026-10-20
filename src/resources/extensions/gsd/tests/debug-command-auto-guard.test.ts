// Regression tests around #2810 and the #2813 active-auto guard: the
// dispatching /gsd debug forms refuse while an auto unit is active (the
// ownership guard lives in source-context-command-ownership.test.ts), while
// read-only subcommands pass through untouched and plain dispatch outside
// auto-mode stays unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { handleDebug } from "../commands-debug.ts";
import { createDebugSession } from "../debug-session-store.ts";
import { autoSession, isAutoActive } from "../auto-runtime-state.ts";
import { makeTempRepo } from "./test-utils.ts";

const UNIT_ID = "M027/S08/T10";

/** Bind the runtime state and protected source observations exactly like an in-flight execute-task unit. */
function createStreamingAutoUnit(base: string): void {
  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = {
    type: "execute-task",
    id: UNIT_ID,
    startedAt: 1_000,
    workspaceRoot: base,
  };
  const observed = join(base, "task-source.md");
  writeFileSync(observed, "task source\n", "utf-8");
  autoSession.sourceObservations.beginUnit({
    unitType: "execute-task",
    unitId: UNIT_ID,
    startedAt: 1_000,
    basePath: base,
  });
  autoSession.sourceObservations.observeRead({ path: observed });
}

function createMockCtx(notifications: Array<{ message: string; level: string }>) {
  return {
    notifications,
    hasUI: true,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {},
      setStatus() {},
      setWidget() {},
    },
    cwd: process.cwd(),
    sessionManager: { getEntries: () => [], getSessionFile: () => null },
  };
}

function createMockPi(calls: Array<{ payload: any; options: any }>) {
  return {
    sendMessage(payload: any, options: any) {
      calls.push({ payload, options });
    },
  };
}

test("/gsd debug read-only subcommand passes through an active auto unit untouched", async (t) => {
  const savedCwd = process.cwd();
  const base = makeTempRepo("gsd-debug-guard-readonly-");
  t.after(() => {
    autoSession.reset();
    process.chdir(savedCwd);
  });
  process.chdir(base);

  const notifications: Array<{ message: string; level: string }> = [];
  const calls: Array<{ payload: any; options: any }> = [];
  const ctx = createMockCtx(notifications);
  const pi = createMockPi(calls);

  createStreamingAutoUnit(base);
  createDebugSession(base, { issue: "cache misses on cold start" });

  await handleDebug("status cache-misses-on-cold-start", ctx as any, pi as any);

  assert.equal(isAutoActive(), true, "status is read-only and must not touch the active auto unit");
  assert.equal(autoSession.currentUnit?.id, UNIT_ID);
  assert.equal(calls.length, 0, "status must not dispatch");
});

test("/gsd debug dispatch without auto-mode stays unchanged", async (t) => {
  const savedCwd = process.cwd();
  const base = makeTempRepo("gsd-debug-guard-noauto-");
  t.after(() => {
    autoSession.reset();
    process.chdir(savedCwd);
  });
  process.chdir(base);

  const notifications: Array<{ message: string; level: string }> = [];
  const calls: Array<{ payload: any; options: any }> = [];
  const ctx = createMockCtx(notifications);
  const pi = createMockPi(calls);

  autoSession.reset();

  await handleDebug("login fails after deploy", ctx as any, pi as any);

  assert.equal(isAutoActive(), false);
  assert.equal(autoSession.paused, false);
  assert.equal(calls.length, 1, "the debug start must dispatch exactly one prompt");
  assert.equal(calls[0].payload.customType, "gsd-debug-start");
  assert.equal(calls[0].options.triggerTurn, true);
  assert.equal(
    notifications.some((n) => /auto-mode is active/i.test(n.message)),
    false,
    "no active-auto refusal when auto is not running",
  );
});
