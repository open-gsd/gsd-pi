// Regression tests for #2810: "/gsd debug" issued while an auto execute-task
// unit turn is streaming must pause auto and wait for idleness before
// dispatching.
//
// The host's default sendMessage delivery is "steer": without the pause, the
// debug prompt is injected into the still-running unit's agent run, the unit
// never reaches agent_end, the sanctioned pause path never fires, and every
// debug read/edit is attributed to the old unit and advertised as protected
// Source Context Block entries for that unit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { handleDebug } from "../commands-debug.ts";
import { createDebugSession, loadDebugSession } from "../debug-session-store.ts";
import { autoSession, isAutoActive } from "../auto-runtime-state.ts";
import { _resetPendingResolve, _setCurrentResolve } from "../auto/resolve.ts";
import { makeTempRepo } from "./test-utils.ts";

interface DispatchCall {
  payload: any;
  options: any;
}

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

function createMockCtx(events: string[]) {
  const notifications: Array<{ message: string; level: string }> = [];
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
    // The unit turn is streaming: pauseAuto's abortActiveTurn must abort it,
    // and the helper must wait for the host to settle before dispatching.
    isIdle: () => false,
    abort() {
      events.push("abort");
    },
    waitForIdle: async () => {
      events.push("wait-idle");
    },
    shutdown: async () => {},
  };
}

function createMockPi(events: string[], calls: DispatchCall[]) {
  return {
    sendMessage(payload: any, options: any) {
      events.push(`send:${payload?.customType ?? "unknown"}`);
      calls.push({ payload, options });
    },
  };
}

async function makeDebugFixture(prefix: string, issue: string): Promise<{ base: string; slug: string }> {
  const base = makeTempRepo(prefix);
  createDebugSession(base, { issue });
  const slug = loadDebugSession(base, issue.toLowerCase().replace(/[^a-z0-9]+/g, "-"))?.session.slug;
  assert.ok(slug, "debug session fixture must exist");
  return { base, slug };
}

test("/gsd debug continue during a streaming execute-task unit pauses auto and releases the unit source context (#2810)", async (t) => {
  const savedCwd = process.cwd();
  const { base, slug } = await makeDebugFixture("gsd-debug-pause-auto-", "recurring read/edit recovery diagnostics");
  t.after(() => {
    autoSession.reset();
    process.chdir(savedCwd);
  });
  process.chdir(base);

  const events: string[] = [];
  const calls: DispatchCall[] = [];
  const ctx = createMockCtx(events);
  const pi = createMockPi(events, calls);

  createStreamingAutoUnit(base);
  _setCurrentResolve(() => {});

  await handleDebug(`continue ${slug}`, ctx as any, pi as any);

  assert.equal(isAutoActive(), false, "auto must be paused before the debug dispatch");
  assert.equal(autoSession.paused, true);
  assert.equal(autoSession.currentUnit, null, "the interrupted unit must be unbound");
  assert.equal(
    autoSession.sourceObservations.renderActiveBlock(),
    null,
    "the paused unit's protected source context must not be advertised on debug turns",
  );
  assert.equal(events[0], "abort", "the streaming unit turn must be aborted first");
  assert.ok(
    events.indexOf("wait-idle") < events.indexOf("send:gsd-debug-continue"),
    `the host must settle before the debug prompt dispatches, got: ${events.join(" -> ")}`,
  );
  // pauseAuto emits its own workflow_outcome custom message through pi, so
  // filter to the debug dispatch instead of asserting the total send count.
  const debugDispatches = calls.filter((call) => call.payload.customType === "gsd-debug-continue");
  assert.equal(debugDispatches.length, 1, "the debug continue must dispatch exactly one prompt");
  assert.equal(debugDispatches[0].options.triggerTurn, true);
  assert.ok(
    ctx.notifications.some((n) => /paused/i.test(n.message)),
    "the operator must be told auto was paused for the debug session",
  );
});

test("/gsd debug issue-start and --diagnose dispatches pause a streaming unit before dispatch (#2810)", async (t) => {
  const savedCwd = process.cwd();
  t.after(() => {
    autoSession.reset();
    process.chdir(savedCwd);
  });

  const start = await makeDebugFixture("gsd-debug-pause-start-", "login fails after deploy");
  process.chdir(start.base);
  const startEvents: string[] = [];
  const startCalls: DispatchCall[] = [];
  createStreamingAutoUnit(start.base);
  _setCurrentResolve(() => {});
  await handleDebug("login fails after deploy", createMockCtx(startEvents) as any, createMockPi(startEvents, startCalls) as any);

  assert.equal(isAutoActive(), false, "issue-start must pause the streaming unit first");
  assert.equal(autoSession.currentUnit, null);
  const startDispatches = startCalls.filter((call) => call.payload.customType === "gsd-debug-start");
  assert.equal(startDispatches.length, 1, "issue-start must still dispatch exactly one prompt");
  assert.equal(startEvents[0], "abort", "issue-start must abort the streaming turn first");
  assert.ok(
    startEvents.indexOf("wait-idle") < startEvents.indexOf("send:gsd-debug-start"),
    "issue-start must wait for host idleness before dispatching",
  );

  autoSession.reset();
  const diagnose = await makeDebugFixture("gsd-debug-pause-diagnose-", "cache misses on cold start");
  process.chdir(diagnose.base);
  const diagnoseEvents: string[] = [];
  const diagnoseCalls: DispatchCall[] = [];
  createStreamingAutoUnit(diagnose.base);
  _setCurrentResolve(() => {});
  await handleDebug("--diagnose cache misses on cold start", createMockCtx(diagnoseEvents) as any, createMockPi(diagnoseEvents, diagnoseCalls) as any);

  assert.equal(isAutoActive(), false, "--diagnose <issue> must pause the streaming unit first");
  assert.equal(autoSession.currentUnit, null);
  const diagnoseDispatches = diagnoseCalls.filter((call) => call.payload.customType === "gsd-debug-diagnose");
  assert.equal(diagnoseDispatches.length, 1, "--diagnose must still dispatch exactly one prompt");
});

test("/gsd debug read-only subcommand does not pause an active auto unit", async (t) => {
  const savedCwd = process.cwd();
  const base = makeTempRepo("gsd-debug-pause-readonly-");
  t.after(() => {
    autoSession.reset();
    process.chdir(savedCwd);
  });
  process.chdir(base);

  const events: string[] = [];
  const calls: DispatchCall[] = [];
  const ctx = createMockCtx(events);
  const pi = createMockPi(events, calls);

  createStreamingAutoUnit(base);
  createDebugSession(base, { issue: "cache misses on cold start" });

  await handleDebug("status cache-misses-on-cold-start", ctx as any, pi as any);

  assert.equal(isAutoActive(), true, "status is read-only and must not pause auto");
  assert.equal(autoSession.currentUnit?.id, UNIT_ID);
  assert.equal(calls.length, 0, "status must not dispatch");
});

test("/gsd debug dispatch without auto-mode stays unchanged (no pause, no pause notification)", async (t) => {
  const savedCwd = process.cwd();
  const base = makeTempRepo("gsd-debug-pause-noauto-");
  t.after(() => {
    autoSession.reset();
    process.chdir(savedCwd);
  });
  process.chdir(base);

  const events: string[] = [];
  const calls: DispatchCall[] = [];
  const ctx = createMockCtx(events);
  const pi = createMockPi(events, calls);

  autoSession.reset();

  await handleDebug("login fails after deploy", ctx as any, pi as any);

  assert.equal(isAutoActive(), false);
  assert.equal(autoSession.paused, false);
  assert.equal(calls.length, 1, "the debug start must dispatch exactly one prompt");
  assert.equal(calls[0].payload.customType, "gsd-debug-start");
  assert.equal(calls[0].options.triggerTurn, true);
  assert.equal(
    events.includes("abort"),
    false,
    "no unit turn is streaming, so nothing may be aborted",
  );
  assert.equal(
    ctx.notifications.some((n) => /paused/i.test(n.message)),
    false,
    "no pause notification when auto is not active",
  );
});
