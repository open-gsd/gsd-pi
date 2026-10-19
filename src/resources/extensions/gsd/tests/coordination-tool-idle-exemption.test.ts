/**
 * Regression coverage for #2052: long-running coordination tools must not be
 * aborted by the stalled-tool watchdog, while the hard timeout remains armed.
 * #2644: the hard timeout stays armed after its recovery steer, so a unit that
 * never answers the steer is still paused.
 */
import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startUnitSupervision, type SupervisionContext } from "../auto-timers.ts";
import {
  clearInFlightTools,
  getInFlightToolCount,
  getOldestStallDetectableToolStart,
  markToolStart,
} from "../auto-tool-tracking.ts";
import { clearGSDPreferencesCache } from "../preferences.ts";
import { closeDatabase, insertAssessment, insertMilestone, openDatabase } from "../gsd-db.ts";
import { readUnitRuntimeRecord, writeUnitRuntimeRecord } from "../unit-runtime.ts";

const SUPERVISOR_PREFS = [
  "auto_supervisor:",
  "  soft_timeout_minutes: 100",
  "  idle_timeout_minutes: 100",
  "  hard_timeout_minutes: 2",
  "  stalled_tool_timeout_minutes: 1",
];

interface Harness {
  home: string;
  base: string;
  notifications: string[];
  steers: any[];
  pauses: any[][];
  s: any;
  sctx: SupervisionContext;
  previousGsdHome: string | undefined;
}

function makeHarness(): Harness {
  const home = mkdtempSync(join(tmpdir(), "gsd-coordination-watchdog-home-"));
  const base = mkdtempSync(join(tmpdir(), "gsd-coordination-watchdog-base-"));
  const previousGsdHome = process.env.GSD_HOME;
  process.env.GSD_HOME = home;
  writeFileSync(join(home, "preferences.md"), ["---", ...SUPERVISOR_PREFS, "---", ""].join("\n"));
  clearGSDPreferencesCache();
  // The unit runtime record the watchdog reads is a database row.
  openDatabase(":memory:");

  const notifications: string[] = [];
  const ctx = {
    ui: { notify: (message: string) => notifications.push(message) },
    model: { provider: "anthropic" },
    modelRegistry: { getAvailable: () => [] },
  } as any;
  const steers: any[] = [];
  const pauses: any[][] = [];
  const pi = {
    sendMessage: (message: any) => {
      if (message.customType === "gsd-auto-timeout-recovery") steers.push(message);
    },
    setModel: async () => true,
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
  } as any;
  const s = {
    active: true,
    verbose: false,
    basePath: base,
    currentUnit: { type: "validate-milestone", id: "M002", startedAt: 0 },
    cmdCtx: undefined,
    wrapupWarningHandle: null,
    idleWatchdogHandle: null,
    unitTimeoutHandle: null,
    continueHereHandle: null,
  } as any;
  const sctx: SupervisionContext = {
    s,
    ctx,
    pi,
    unitType: "validate-milestone",
    unitId: "M002",
    prefs: undefined,
    buildSnapshotOpts: () => ({}),
    buildRecoveryContext: () => ({
      basePath: base,
      verbose: false,
      currentUnitStartedAt: 0,
      unclaimedUnitBudgets: new Map(),
    }),
    pauseAuto: async (...args: any[]) => {
      pauses.push(args);
    },
  };

  return { home, base, notifications, steers, pauses, s, sctx, previousGsdHome };
}

function cleanup(h: Harness): void {
  h.s.active = false;
  if (h.s.wrapupWarningHandle) clearTimeout(h.s.wrapupWarningHandle);
  if (h.s.idleWatchdogHandle) clearInterval(h.s.idleWatchdogHandle);
  if (h.s.unitTimeoutHandle) clearTimeout(h.s.unitTimeoutHandle);
  if (h.s.continueHereHandle) clearInterval(h.s.continueHereHandle);
  mock.timers.reset();
  clearInFlightTools();
  clearGSDPreferencesCache();
  closeDatabase();
  if (h.previousGsdHome === undefined) delete process.env.GSD_HOME;
  else process.env.GSD_HOME = h.previousGsdHome;
  rmSync(h.home, { recursive: true, force: true });
  rmSync(h.base, { recursive: true, force: true });
}

/** Let the awaits of a fired hard timeout (closeout, then recovery) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function startHarness(t: TestContext): Harness {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  const h = makeHarness();
  t.after(() => cleanup(h));
  writeUnitRuntimeRecord(h.base, "validate-milestone", "M002", 0);
  startUnitSupervision(h.sctx);
  return h;
}

test("subagent remains in flight after the stalled-tool budget", (t) => {
  const h = startHarness(t);
  markToolStart("call-1", true, "subagent");

  mock.timers.tick(75_000);

  assert.equal(getInFlightToolCount(), 1);
  assert.equal(readUnitRuntimeRecord(h.base, "validate-milestone", "M002")?.lastProgressKind, "coordination-tool-in-flight");
  assert.equal(h.notifications.some((message) => message.startsWith("Stalled tool detected:")), false);
});

test("Task and MCP-scoped subagent names are excluded from stall aging", (t) => {
  t.after(() => clearInFlightTools());
  markToolStart("call-1", true, "Task");
  markToolStart("call-2", true, "mcp__custom-workflow__subagent");
  assert.equal(getOldestStallDetectableToolStart(), undefined);
});

test("a stale ordinary tool is still detected alongside a subagent", (t) => {
  const h = startHarness(t);
  markToolStart("call-1", true, "bash");
  markToolStart("call-2", true, "subagent");

  mock.timers.tick(75_000);

  assert.equal(getInFlightToolCount(), 0);
  assert.equal(h.notifications.some((message) => message.startsWith("Stalled tool detected:")), true);
});

test("a bounded execution tool remains in flight after the stalled-tool budget (#2203)", (t) => {
  const h = startHarness(t);
  markToolStart("call-1", true, "gsd_exec");

  mock.timers.tick(75_000);

  assert.equal(getInFlightToolCount(), 1);
  assert.equal(readUnitRuntimeRecord(h.base, "validate-milestone", "M002")?.lastProgressKind, "coordination-tool-in-flight");
  assert.equal(h.notifications.some((message) => message.startsWith("Stalled tool detected:")), false);
});

test("a UAT execution tool remains in flight after the stalled-tool budget (#2203)", (t) => {
  const h = startHarness(t);
  markToolStart("call-1", true, "gsd_uat_exec");

  mock.timers.tick(75_000);

  assert.equal(getInFlightToolCount(), 1);
  assert.equal(readUnitRuntimeRecord(h.base, "validate-milestone", "M002")?.lastProgressKind, "coordination-tool-in-flight");
  assert.equal(h.notifications.some((message) => message.startsWith("Stalled tool detected:")), false);
});

test("bounded execution tools are excluded from stall aging (#2203)", (t) => {
  t.after(() => clearInFlightTools());
  markToolStart("call-1", true, "gsd_exec");
  markToolStart("call-2", true, "gsd_uat_exec");
  markToolStart("call-3", true, "async_bash");
  markToolStart("call-4", true, "await_job");
  markToolStart("call-5", true, "bg_shell");
  markToolStart("call-6", true, "mcp__gsd__gsd_exec");
  assert.equal(getOldestStallDetectableToolStart(), undefined);
});

test("a stale non-exempt tool is still detected alongside a bounded execution tool (#2203)", (t) => {
  const h = startHarness(t);
  markToolStart("call-1", true, "read_file");
  markToolStart("call-2", true, "gsd_exec");

  mock.timers.tick(75_000);

  assert.equal(getInFlightToolCount(), 0);
  assert.equal(h.notifications.some((message) => message.startsWith("Stalled tool detected:")), true);
});

test("subagent does not re-arm the unit hard timeout", (t) => {
  const h = startHarness(t);
  markToolStart("call-1", true, "subagent");

  mock.timers.tick(120_000);

  assert.equal(h.s.unitTimeoutHandle, null);
  assert.equal(readUnitRuntimeRecord(h.base, "validate-milestone", "M002")?.phase, "timeout");
});

test("bounded execution tools do not re-arm the unit hard timeout (#2203)", (t) => {
  for (const toolName of ["gsd_exec", "gsd_uat_exec", "async_bash", "await_job", "bg_shell"]) {
    const h = startHarness(t);
    markToolStart("call-1", true, toolName);

    mock.timers.tick(120_000);

    assert.equal(h.s.unitTimeoutHandle, null, toolName);
    assert.equal(readUnitRuntimeRecord(h.base, "validate-milestone", "M002")?.phase, "timeout", toolName);
    cleanup(h);
  }
});

test("a unit that never answers the hard-timeout steer is paused when the hard timeout expires again (#2644)", async (t) => {
  const h = startHarness(t);

  // The model stream stalls: no tool runs and the unit never ends.
  mock.timers.tick(120_000);
  await settle();
  assert.equal(h.steers.length, 1, "the first expiry steers the unit");
  assert.equal(h.pauses.length, 0, "the first expiry does not pause");

  // The unit keeps the full hard-timeout window to answer the steer.
  mock.timers.tick(119_000);
  await settle();
  assert.equal(h.pauses.length, 0, "no pause before the second window ends");

  mock.timers.tick(1_000);
  await settle();
  assert.equal(h.steers.length, 1, "a steer that got no answer is not sent again");
  assert.equal(h.pauses.length, 1, "the second expiry pauses auto-mode");
  assert.equal(h.pauses[0][2], "machine_fixable");
  assert.deepEqual(h.pauses[0][4], {
    expectedCurrentUnit: { type: "validate-milestone", id: "M002", startedAt: 0 },
  });
  assert.equal(
    h.notifications.some((message) => /validate-milestone M002 exceeded 2min hard timeout\. Pausing auto-mode\./.test(message)),
    true,
    "the pause names the unit and the hard timeout",
  );
  assert.equal(h.s.unitTimeoutHandle, null, "a paused unit has no armed hard timeout");
});

test("a unit that saves its result after the hard-timeout steer is advanced, not paused (#2644)", async (t) => {
  const h = startHarness(t);

  mock.timers.tick(120_000);
  await settle();
  assert.equal(h.steers.length, 1);

  // The unit answers the steer and saves its result, but its turn is still open.
  insertMilestone({ id: "M002", title: "Milestone", status: "active" });
  insertAssessment({
    path: ".gsd/milestones/M002/M002-VALIDATION.md",
    milestoneId: "M002",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "---\nverdict: pass\n---\n",
  });

  mock.timers.tick(120_000);
  await settle();
  assert.equal(h.pauses.length, 0, "a saved result is never paused");
  assert.equal(readUnitRuntimeRecord(h.base, "validate-milestone", "M002")?.phase, "finalized");
  assert.equal(h.s.unitTimeoutHandle, null, "an advanced unit has no armed hard timeout");
});

test("a unit that ends while the hard-timeout steer is sent gets no new hard timeout (#2644)", async (t) => {
  const h = startHarness(t);
  // The unit ends during recovery: the loop clears the supervision timers, as clearUnitTimeout() does.
  h.sctx.pi.sendMessage = async () => {
    for (const key of ["wrapupWarningHandle", "unitTimeoutHandle"]) {
      if (h.s[key]) clearTimeout(h.s[key]);
      h.s[key] = null;
    }
    for (const key of ["idleWatchdogHandle", "continueHereHandle"]) {
      if (h.s[key]) clearInterval(h.s[key]);
      h.s[key] = null;
    }
  };

  mock.timers.tick(120_000);
  await settle();
  assert.equal(h.s.unitTimeoutHandle, null, "ended supervision is not armed again");

  mock.timers.tick(120_000);
  await settle();
  assert.equal(h.pauses.length, 0, "the ended unit is not paused by a stale hard timeout");
});
