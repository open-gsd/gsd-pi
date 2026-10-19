// Project/App: gsd-pi
// File Purpose: Behavior tests that the budget ceiling guard reads unit spend from the database, not from .gsd/metrics.json.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { selectAndApplyModel } from "../auto-model-selection.ts";
import { runGuards } from "../auto/phases.ts";
import type { IterationContext } from "../auto/types.ts";
import {
  getBudgetAlertLevel,
  getBudgetEnforcementAction,
  getNewBudgetAlertLevel,
} from "../auto-budget.ts";
import { listUnitMetrics, readUnitSpend } from "../db/unit-metrics.ts";
import { recordUnitMetricsRows } from "../db/writers/unit-metrics.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  formatCost,
  getLedger,
  initMetrics,
  resetMetrics,
  snapshotUnitMetrics,
  type UnitMetrics,
} from "../metrics.ts";

/** A temp project with an open database and no metrics ledger in memory. */
function makeProject(t: { after: (fn: () => void) => void }): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-budget-db-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  resetMetrics();
  assert.equal(openDatabase(":memory:"), true);
  t.after(() => {
    resetMetrics();
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

/** A session whose one assistant message cost `cost` USD. */
function sessionWithCost(cost: number): Parameters<typeof snapshotUnitMetrics>[0] {
  const entries = [{
    type: "message",
    id: "entry-0",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { total: cost } },
    },
  }];
  return { sessionManager: { getEntries: () => entries } } as unknown as Parameters<typeof snapshotUnitMetrics>[0];
}

function unit(overrides: Partial<UnitMetrics>): UnitMetrics {
  return {
    type: "execute-task",
    id: "M001/S01/T01",
    model: "test-model",
    startedAt: 1000,
    finishedAt: 2000,
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
    cost: 1,
    toolCalls: 1,
    assistantMessages: 1,
    userMessages: 0,
    ...overrides,
  };
}

/** The guard with the production budget functions and a $5 halt ceiling. */
function guardContext(basePath: string, autoStartTime = 0, budgetCeiling = 5): { ic: IterationContext; stops: string[]; notices: string[] } {
  const stops: string[] = [];
  const notices: string[] = [];
  const ic = {
    ctx: { ui: { notify: (message: string, level: string) => { notices.push(`${level}: ${message}`); } } },
    pi: {},
    s: { basePath, originalBasePath: basePath, autoStartTime, lastBudgetAlertLevel: 0 },
    deps: {
      getLedger,
      getBudgetSpend: readUnitSpend,
      getBudgetAlertLevel,
      getNewBudgetAlertLevel,
      getBudgetEnforcementAction,
      formatCost,
      stopAuto: async (_ctx: unknown, _pi: unknown, reason: string) => { stops.push(reason); },
      pauseAuto: async () => {},
      sendDesktopNotification: () => {},
      logCmuxEvent: () => {},
      getManifestStatus: async () => null,
    },
    prefs: { budget_ceiling: budgetCeiling, budget_enforcement: "halt" },
  } as unknown as IterationContext;
  return { ic, stops, notices };
}

test("budget ceiling stops the run with metrics.json deleted", async (t) => {
  const base = makeProject(t);
  initMetrics(base);
  assert.ok(snapshotUnitMetrics(sessionWithCost(6), "execute-task", "M001/S01/T01", Date.now() - 5000, "test-model"));

  // A new process: no ledger in memory and no ledger file.
  resetMetrics();
  rmSync(join(base, ".gsd", "metrics.json"));
  const { ic, stops } = guardContext(base);

  const result = await runGuards(ic, "M001");

  assert.deepEqual([result.action, result.action === "break" && result.reason], ["break", "budget-halt"]);
  assert.deepEqual(stops, ["Budget ceiling reached"]);
});

test("a second snapshot of the same unit run replaces its row and is counted once", (t) => {
  const base = makeProject(t);
  initMetrics(base);
  const startedAt = Date.now() - 5000;
  snapshotUnitMetrics(sessionWithCost(2), "execute-task", "M001/S01/T01", startedAt, "test-model");
  snapshotUnitMetrics(sessionWithCost(3), "execute-task", "M001/S01/T01", startedAt, "test-model");

  assert.equal(readUnitSpend(), 3);
  assert.equal(listUnitMetrics().length, 1);
});

test("metrics.json spend that the database does not hold is reported one time and does not stop the run until doctor imports it", async (t) => {
  const base = makeProject(t);
  writeFileSync(
    join(base, ".gsd", "metrics.json"),
    `${JSON.stringify({ version: 1, projectStartedAt: 1, units: [unit({ cost: 10 })] })}\n`,
  );
  initMetrics(base);
  assert.equal(getLedger()!.units[0]!.cost, 10, "the ledger in memory holds the file spend");

  const before = guardContext(base);
  assert.equal((await runGuards(before.ic, "M001")).action, "next", "the file does not decide the budget");
  assert.deepEqual(before.stops, []);
  assert.deepEqual(before.notices, [
    "warning: Budget ceiling $5.00 does not count $10.00 of earlier spend: 1 unit run(s) are only in .gsd/metrics.json. Run /gsd doctor --fix to import them.",
  ]);
  await runGuards(before.ic, "M001");
  assert.equal(before.notices.length, 1, "one auto session reports the uncounted spend one time");

  const ledgerIssues = async (options: { repair?: boolean; importFileOverrides?: boolean }, fixes: string[] = []) => {
    const issues: DoctorIssue[] = [];
    await checkEngineHealth(base, issues, fixes, options);
    return issues.filter((issue) => issue.code === "metrics_ledger_units_unimported");
  };
  const issues = await ledgerIssues({ repair: true });
  assert.deepEqual(issues.map((issue) => [issue.severity, issue.fixable]), [["warning", true]]);
  assert.match(issues[0]!.message, /metrics\.json ledger of 1 unit run\(s\) \(\$10\.00\) is not in the database and is not counted by the budget ceiling/);
  assert.equal(readUnitSpend(), 0, "a repair the operator did not ask for imports nothing");

  const fixes: string[] = [];
  assert.deepEqual(await ledgerIssues({ repair: true, importFileOverrides: true }, fixes), []);
  assert.match(fixes.join("\n"), /imported 1 row\(s\) from metrics\.json: 1 unit run\(s\)/);
  assert.equal(readUnitSpend(), 10);

  const after = guardContext(base);
  const result = await runGuards(after.ic, "M001");
  assert.deepEqual([result.action, result.action === "break" && result.reason], ["break", "budget-halt"]);
  assert.deepEqual(after.notices, [], "imported spend is counted, so there is no uncounted-spend warning");
});

test("a parallel worker counts only the spend of its own auto session", async (t) => {
  const base = makeProject(t);
  const previous = process.env.GSD_PARALLEL_WORKER;
  process.env.GSD_PARALLEL_WORKER = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.GSD_PARALLEL_WORKER;
    else process.env.GSD_PARALLEL_WORKER = previous;
  });
  const sessionStart = 50_000;
  recordUnitMetricsRows([unit({ id: "M001/S01/T01", startedAt: sessionStart - 1, cost: 10 })]);
  writeFileSync(
    join(base, ".gsd", "metrics.json"),
    `${JSON.stringify({ version: 1, projectStartedAt: 1, units: [unit({ id: "M001/S01/T00", startedAt: 1, cost: 10 })] })}\n`,
  );

  const earlier = guardContext(base, sessionStart);
  assert.equal((await runGuards(earlier.ic, "M001")).action, "next", "spend from before the session is not counted");
  assert.deepEqual(earlier.notices, [], "a worker does not count earlier spend, so the ledger gap changes nothing for it");

  recordUnitMetricsRows([unit({ id: "M001/S01/T02", startedAt: sessionStart, cost: 6 })]);
  const inSession = guardContext(base, sessionStart);
  const result = await runGuards(inSession.ic, "M001");
  assert.deepEqual([result.action, result.action === "break" && result.reason], ["break", "budget-halt"]);
});

/** Run `fn` as the parallel worker that holds the given Milestone (and Slice) lock. */
async function asWorker<T>(milestoneId: string, sliceId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const keys = ["GSD_PARALLEL_WORKER", "GSD_MILESTONE_LOCK", "GSD_SLICE_LOCK"] as const;
  const previous = keys.map((key) => process.env[key]);
  process.env.GSD_PARALLEL_WORKER = "1";
  process.env.GSD_MILESTONE_LOCK = milestoneId;
  if (sliceId === undefined) delete process.env.GSD_SLICE_LOCK;
  else process.env.GSD_SLICE_LOCK = sliceId;
  try {
    return await fn();
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}

test("parallel workers on different milestones do not count the spend of each other", async (t) => {
  const base = makeProject(t);
  const sessionStart = 50_000;
  const milestones = ["M001", "M002", "M003", "M004"];
  recordUnitMetricsRows(milestones.map((mid) => unit({ id: `${mid}/S01/T01`, startedAt: sessionStart, cost: 13 })));
  assert.equal(readUnitSpend(sessionStart), 52, "the project spend since the start is over the ceiling");

  for (const mid of milestones) {
    const worker = guardContext(base, sessionStart, 50);
    const result = await asWorker(mid, undefined, () => runGuards(worker.ic, mid));
    assert.equal(result.action, "next", `${mid} worker spent 13 of 50`);
    assert.deepEqual(worker.stops, []);
  }

  recordUnitMetricsRows([unit({ id: "M002/S02/T01", startedAt: sessionStart + 1, cost: 38 })]);
  const heavy = guardContext(base, sessionStart, 50);
  const result = await asWorker("M002", undefined, () => runGuards(heavy.ic, "M002"));
  assert.deepEqual([result.action, result.action === "break" && result.reason], ["break", "budget-halt"]);
  assert.deepEqual(heavy.stops, ["Budget ceiling reached"]);

  const sibling = guardContext(base, sessionStart, 50);
  assert.equal((await asWorker("M001", undefined, () => runGuards(sibling.ic, "M001"))).action, "next");
});

test("a slice worker counts only the spend of its own slice", async (t) => {
  const base = makeProject(t);
  const sessionStart = 50_000;
  recordUnitMetricsRows([
    unit({ id: "M001/S01/T01", startedAt: sessionStart, cost: 4 }),
    unit({ id: "M001/S02/T01", startedAt: sessionStart, cost: 4 }),
    unit({ id: "M001/S010/T01", startedAt: sessionStart, cost: 4 }),
  ]);

  const worker = guardContext(base, sessionStart);
  assert.equal((await asWorker("M001", "S01", () => runGuards(worker.ic, "M001"))).action, "next");

  const milestoneWorker = guardContext(base, sessionStart);
  const result = await asWorker("M001", undefined, () => runGuards(milestoneWorker.ic, "M001"));
  assert.deepEqual([result.action, result.action === "break" && result.reason], ["break", "budget-halt"]);
});

/** The tier classification that dynamic routing gives a plan-slice unit under a $10 budget ceiling. */
async function routedClassification(t: { after: (fn: () => void) => void }, base: string): Promise<{ tier: string; reason: string }> {
  const home = mkdtempSync(join(tmpdir(), "gsd-budget-home-"));
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  process.env.GSD_HOME = home;
  process.chdir(base);
  t.after(() => {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(home, { recursive: true, force: true });
  });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "token_profile: burn-max",
      "dynamic_routing:",
      "  enabled: true",
      "  tier_models:",
      "    light: anthropic/claude-haiku-4-5",
      "    standard: anthropic/claude-sonnet-4-6",
      "    heavy: anthropic/claude-opus-4-6",
      "---",
    ].join("\n"),
  );
  const models = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]
    .map((id) => ({ id, provider: "anthropic", api: "anthropic-messages" }));
  const ctx = {
    modelRegistry: {
      getAvailable: () => models,
      getAll: () => models,
      isProviderRequestReady: () => true,
      getProviderAuthMode: () => "apiKey",
    },
    sessionManager: { getSessionId: () => "test-session" },
    ui: { notify: () => {} },
    model: models[2],
  };
  let classification: { tier: string; reason: string } | undefined;
  const pi = {
    setModel: async () => true,
    emitBeforeModelSelect: async (input: { classification: { tier: string; reason: string } }) => {
      classification = input.classification;
      return undefined;
    },
    getActiveTools: () => [],
    emitAdjustToolSet: async () => undefined,
    setActiveTools: () => {},
    setThinkingLevel: () => {},
  };

  await selectAndApplyModel(
    ctx as unknown as Parameters<typeof selectAndApplyModel>[0],
    pi as unknown as Parameters<typeof selectAndApplyModel>[1],
    "plan-slice",
    "M001/S01",
    base,
    { budget_ceiling: 10 },
    false,
    { provider: "anthropic", id: "claude-opus-4-6" },
  );
  assert.ok(classification, "dynamic routing classified the unit");
  return classification;
}

test("model routing takes its budget pressure from database spend with metrics.json deleted", async (t) => {
  const base = makeProject(t);
  recordUnitMetricsRows([unit({ cost: 9.5 })]);

  const classification = await routedClassification(t, base);

  assert.match(classification.reason, /budget pressure: 95%/);
});

test("model routing takes no budget pressure from a metrics.json ledger the database does not hold", async (t) => {
  const base = makeProject(t);
  writeFileSync(
    join(base, ".gsd", "metrics.json"),
    `${JSON.stringify({ version: 1, projectStartedAt: 1, units: [unit({ cost: 9.5 })] })}\n`,
  );
  initMetrics(base);

  const classification = await routedClassification(t, base);

  assert.doesNotMatch(classification.reason, /budget pressure/);
});
