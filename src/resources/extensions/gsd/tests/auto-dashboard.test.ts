import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { visibleWidth } from "@gsd/pi-tui";

import {
  unitVerb,
  unitPhaseLabel,
  describeNextUnit,
  formatAutoElapsed,
  formatWidgetTokens,
  estimateTimeRemaining,
  extractUatSliceId,
  buildPhaseHandoffOutcome,
  updateProgressWidget,
  setAutoOutcomeWidget,
  setAutoActiveStatus,
  setCompletionProgressWidget,
  getRoadmapSlicesSync,
  clearSliceProgressCache,
  updateSliceProgressCache,
  getWidgetMode,
  cycleWidgetMode,
  setWidgetMode,
  _resetWidgetModeForTests,
  _resetLastCommitCacheForTests,
  _refreshLastCommitForTests,
  _getLastCommitForTests,
  _getLastCommitFetchedAtForTests,
  formatToolSurfaceSnapshot,
  formatRuntimeHealthSignal,
  shouldRenderRoadmapProgress,
} from "../auto-dashboard.ts";
import { getAutoDashboardData } from "../auto.ts";
import {
  autoSession,
  clearAutoToolSurfaceSnapshot,
  recordAutoToolSurfaceSnapshot,
} from "../auto-runtime-state.ts";
import { formatRtkSavingsLabel } from "../../shared/rtk-session-stats.ts";
import {
  createProgressStripUiMock,
  renderProgressStrip,
  renderProgressStripLines,
  assertLinesFit,
} from "./progress-strip-test-helpers.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
} from "../gsd-db.ts";
import { initMetrics, resetMetrics, type UnitMetrics } from "../metrics.ts";

function makeTempDir(prefix: string): string {
  return join(
    tmpdir(),
    `gsd-auto-dashboard-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function makeMetricUnit(id: string, startedAt: number, finishedAt: number): UnitMetrics {
  return {
    type: id.split("/").length >= 3 ? "execute-task" : "complete-slice",
    id,
    model: "test-model",
    startedAt,
    finishedAt,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    toolCalls: 0,
    assistantMessages: 0,
    userMessages: 0,
  };
}

type RenderableWidget = { render(width: number): string[]; invalidate(): void; dispose?: () => void };

// ─── unitVerb ─────────────────────────────────────────────────────────────

test("unitVerb maps known unit types to verbs", () => {
  assert.equal(unitVerb("research-milestone"), "researching");
  assert.equal(unitVerb("research-slice"), "researching");
  assert.equal(unitVerb("plan-milestone"), "planning");
  assert.equal(unitVerb("plan-slice"), "planning");
  assert.equal(unitVerb("execute-task"), "executing");
  assert.equal(unitVerb("complete-slice"), "completing");
  assert.equal(unitVerb("replan-slice"), "replanning");
  assert.equal(unitVerb("reassess-roadmap"), "reassessing");
  assert.equal(unitVerb("run-uat"), "running UAT");
});

test("unitVerb returns raw type for unknown types", () => {
  assert.equal(unitVerb("custom-thing"), "custom-thing");
});

test("unitVerb handles hook types", () => {
  assert.equal(unitVerb("hook/verify-code"), "hook: verify-code");
  assert.equal(unitVerb("hook/"), "hook: ");
});

test("setAutoActiveStatus clears stale outcome surfaces", () => {
  const statusCalls: Array<[string, string]> = [];
  const widgetCalls: Array<[string, unknown]> = [];

  setAutoActiveStatus({
    hasUI: true,
    ui: {
      setStatus: (key: string, value: string) => {
        statusCalls.push([key, value]);
      },
      setWidget: (key: string, value: unknown) => {
        widgetCalls.push([key, value]);
      },
    },
  } as any, "next");

  assert.deepEqual(statusCalls, [["gsd-auto", "next"]]);
  assert.deepEqual(widgetCalls, [["gsd-outcome", undefined]]);
});

// ─── unitPhaseLabel ───────────────────────────────────────────────────────

test("unitPhaseLabel maps known types to labels", () => {
  assert.equal(unitPhaseLabel("research-milestone"), "RESEARCH");
  assert.equal(unitPhaseLabel("research-slice"), "RESEARCH");
  assert.equal(unitPhaseLabel("plan-milestone"), "PLAN");
  assert.equal(unitPhaseLabel("plan-slice"), "PLAN");
  assert.equal(unitPhaseLabel("execute-task"), "EXECUTE");
  assert.equal(unitPhaseLabel("complete-slice"), "COMPLETE");
  assert.equal(unitPhaseLabel("replan-slice"), "REPLAN");
  assert.equal(unitPhaseLabel("reassess-roadmap"), "REASSESS");
  assert.equal(unitPhaseLabel("run-uat"), "UAT");
});

test("unitPhaseLabel uppercases unknown types", () => {
  assert.equal(unitPhaseLabel("custom-thing"), "CUSTOM-THING");
});

test("unitPhaseLabel returns HOOK for hook types", () => {
  assert.equal(unitPhaseLabel("hook/verify"), "HOOK");
});

// ─── describeNextUnit ─────────────────────────────────────────────────────

test("describeNextUnit handles pre-planning phase", () => {
  const result = describeNextUnit({
    phase: "pre-planning",
    activeMilestone: { id: "M001", title: "Test" },
  } as any);
  assert.equal(result.label, "Research & plan milestone");
});

test("describeNextUnit handles executing phase", () => {
  const result = describeNextUnit({
    phase: "executing",
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: { id: "S01", title: "Slice" },
    activeTask: { id: "T01", title: "Task One" },
  } as any);
  assert.ok(result.label.includes("T01"));
  assert.ok(result.label.includes("Task One"));
});

test("describeNextUnit handles summarizing phase", () => {
  const result = describeNextUnit({
    phase: "summarizing",
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: { id: "S01", title: "First Slice" },
  } as any);
  assert.ok(result.label.includes("S01"));
});

test("describeNextUnit handles needs-discussion phase", () => {
  const result = describeNextUnit({
    phase: "needs-discussion",
    activeMilestone: { id: "M001", title: "Test" },
  } as any);
  assert.ok(
    result.label.toLowerCase().includes("discuss") || result.label.toLowerCase().includes("draft"),
  );
});

test("describeNextUnit handles completing-milestone phase", () => {
  const result = describeNextUnit({
    phase: "completing-milestone",
    activeMilestone: { id: "M001", title: "Test" },
  } as any);
  assert.ok(result.label.toLowerCase().includes("milestone"));
});

test("describeNextUnit returns fallback for unknown phase", () => {
  const result = describeNextUnit({
    phase: "some-future-phase" as any,
    activeMilestone: { id: "M001", title: "Test" },
  } as any);
  assert.equal(result.label, "Continue");
});

// ─── formatAutoElapsed ────────────────────────────────────────────────────

test("formatAutoElapsed returns empty for zero startTime", () => {
  assert.equal(formatAutoElapsed(0), "");
});

test("formatAutoElapsed formats seconds", () => {
  const result = formatAutoElapsed(Date.now() - 30_000);
  assert.match(result, /^\d+s$/);
});

test("formatAutoElapsed formats minutes", () => {
  const result = formatAutoElapsed(Date.now() - 180_000); // 3 min
  assert.match(result, /^3m/);
});

test("formatAutoElapsed formats hours", () => {
  const result = formatAutoElapsed(Date.now() - 3_700_000); // ~1h
  assert.match(result, /^1h/);
});

// ─── formatWidgetTokens ──────────────────────────────────────────────────

test("formatWidgetTokens formats small numbers directly", () => {
  assert.equal(formatWidgetTokens(0), "0");
  assert.equal(formatWidgetTokens(500), "500");
  assert.equal(formatWidgetTokens(999), "999");
});

test("formatWidgetTokens formats thousands with k", () => {
  assert.equal(formatWidgetTokens(1000), "1.0k");
  assert.equal(formatWidgetTokens(5500), "5.5k");
  assert.equal(formatWidgetTokens(10000), "10k");
  assert.equal(formatWidgetTokens(99999), "100k");
});

test("formatWidgetTokens formats millions with M", () => {
  assert.equal(formatWidgetTokens(1_000_000), "1.0M");
  assert.equal(formatWidgetTokens(10_000_000), "10M");
  assert.equal(formatWidgetTokens(25_000_000), "25M");
});

test("formatRuntimeHealthSignal surfaces idle recovery instead of generic progress", () => {
  const signal = formatRuntimeHealthSignal({
    version: 1,
    unitType: "research-milestone",
    unitId: "M001",
    startedAt: 1_000,
    updatedAt: 600_000,
    phase: "recovered",
    wrapupWarningSent: false,
    continueHereFired: false,
    timeoutAt: null,
    lastProgressAt: 1_000,
    progressCount: 1,
    lastProgressKind: "idle-recovery-retry",
    recoveryAttempts: 1,
    lastRecoveryReason: "idle",
  }, 600_000);

  assert.deepEqual(signal, {
    level: "yellow",
    state: "recovering",
    summary: "Recovering",
    detail: "retry 1 after idle stall",
  });
});

test("formatRuntimeHealthSignal describes provider idle without repeating waiting text", () => {
  const signal = formatRuntimeHealthSignal({
    version: 1,
    unitType: "run-uat",
    unitId: "M007/S01",
    startedAt: 1_000,
    updatedAt: 120_000,
    phase: "dispatched",
    wrapupWarningSent: false,
    continueHereFired: false,
    timeoutAt: null,
    lastProgressAt: 1_000,
    progressCount: 0,
    lastProgressKind: "start",
    recoveryAttempts: 0,
  }, 121_000);

  assert.deepEqual(signal, {
    level: "yellow",
    state: "waiting",
    summary: "provider idle 2m",
    detail: "last output 2m ago",
  });
});

test("setAutoOutcomeWidget renders a durable next-action handoff", () => {
  let widgetFactory: any;
  setAutoOutcomeWidget(
    {
      hasUI: true,
      ui: {
        setWidget(key: string, factory: any) {
          if (key === "gsd-outcome") widgetFactory = factory;
        },
      },
    } as any,
    {
      status: "paused",
      title: "Auto-mode paused",
      detail: "Paused by user request.",
      unitLabel: "researching M005/S01",
      nextAction: "Type to steer, or run /gsd auto to resume.",
      commands: ["/gsd auto", "/gsd status for overview"],
      startedAt: Date.now() - 2_000,
    },
  );

  assert.equal(typeof widgetFactory, "function");
  const component = widgetFactory(
    { requestRender() {} },
    { fg: (_color: string, text: string) => text, bold: (text: string) => text },
  );
  const output = component.render(100).join("\n");
  assert.match(output, /^GSD · /m);
  assert.match(output, /Auto-mode paused/);
  assert.match(output, /Paused by user request/);
  assert.match(output, /researching M005\/S01/);
  assert.match(output, /\/gsd auto/);
  assert.doesNotMatch(output, /^───/m);
});

test("setCompletionProgressWidget keeps terminal all-complete handoff in outcome slot", () => {
  const calls: Array<[string, unknown]> = [];
  setCompletionProgressWidget(
    {
      hasUI: true,
      ui: {
        setWidget(key: string, factory: unknown) {
          calls.push([key, factory]);
        },
        setHeader() {},
        setStatus() {},
      },
    } as any,
    {
      milestoneId: "M007",
      milestoneTitle: "Live Text Search",
      oneLiner: "Completed the milestone.",
      reason: "All milestones complete. 8 active requirements in REQUIREMENTS.md have not been mapped to a milestone.",
      startedAt: Date.now() - 2_000,
      totalCost: 31.06,
      totalTokens: 3_600_000,
      unitCount: 78,
      completedSlices: 1,
      totalSlices: 1,
      allMilestonesComplete: true,
      unmappedActiveRequirements: 8,
      requirementsBacklogPreview: [
        "  • R001: Example requirement",
        "  • …and 7 more",
      ],
      basePath: "/project/root",
    },
  );

  assert.ok(
    calls.some(([key, value]) => key === "gsd-progress" && value === undefined),
    "terminal completion should clear the legacy progress widget slot",
  );
  const outcome = calls.filter(([key]) => key === "gsd-outcome").at(-1);
  assert.equal(typeof outcome?.[1], "function", "terminal completion must install the final handoff in the outcome slot");

  const component = (outcome?.[1] as any)(
    { requestRender() {} },
    { fg: (_color: string, text: string) => text, bold: (text: string) => text },
  );
  const output = component.render(120).join("\n");
  assert.match(output, /All milestones complete/);
  assert.match(output, /Review 8 unmapped active requirements/);
  assert.match(output, /Requirements backlog/);
  assert.match(output, /\/gsd to review requirements backlog/);
  assert.doesNotMatch(output, /\/gsd auto to resume/);
});

test("buildPhaseHandoffOutcome summarizes the last phase result", () => {
  const snapshot = buildPhaseHandoffOutcome({
    unitType: "plan-slice",
    unitId: "M005/S01",
    agentEndMessages: [
      { message: { role: "assistant", content: "Planned S01 with category-aware filtering and validation steps." } },
    ],
  });

  assert.equal(snapshot.status, "complete");
  assert.equal(snapshot.title, "PLAN complete");
  assert.match(snapshot.detail ?? "", /category-aware filtering/);
  assert.equal(snapshot.unitLabel, "planning M005/S01");
  assert.match(snapshot.nextAction, /next phase/);
});

test("buildPhaseHandoffOutcome ignores non-assistant trailing messages", () => {
  const snapshot = buildPhaseHandoffOutcome({
    unitType: "plan-slice",
    unitId: "M005/S01",
    agentEndMessages: [
      { message: { role: "assistant", content: "Assistant summary to hand off." } },
      { role: "tool", content: "Tool output should not be shown." },
      { role: "user", content: "User follow-up should not be shown." },
    ],
  });

  assert.match(snapshot.detail ?? "", /Assistant summary/);
  assert.doesNotMatch(snapshot.detail ?? "", /Tool output/);
  assert.doesNotMatch(snapshot.detail ?? "", /User follow-up/);
});

test("updateProgressWidget preserves the phase handoff during session switching", () => {
  const mock = createProgressStripUiMock();
  updateProgressWidget(
    {
      hasUI: true,
      ui: mock.ui,
    } as any,
    "execute-task",
    "M005/S01/T01",
    {
      phase: "executing",
      activeSlice: { id: "S01", title: "Filter chip bar" },
      activeTask: { id: "T01", title: "Add category filter" },
    } as any,
    {
      getAutoStartTime: () => Date.now(),
      isStepMode: () => false,
      getCmdCtx: () => null,
      getBasePath: () => "",
      isVerbose: () => false,
      isSessionSwitching: () => true,
      getCurrentDispatchedModelId: () => null,
    },
  );

  assert.equal(
    mock.getProgressState(),
    undefined,
    "progress strip should not publish while session switching is active",
  );
  assert.ok(
    mock.widgetCalls.some(([key, value]) => key === "gsd-progress" && value === undefined),
    "stale gsd-progress widget slot should still be cleared",
  );
  assert.ok(
    !mock.widgetCalls.some(([key, value]) => key === "gsd-outcome" && value === undefined),
    "handoff widget should stay visible until the next progress frame renders",
  );
  mock.disposeProgress();
});

test("updateProgressWidget clears the phase handoff once active progress resumes", () => {
  const mock = createProgressStripUiMock();
  updateProgressWidget(
    {
      hasUI: true,
      ui: mock.ui,
    } as any,
    "execute-task",
    "M005/S01/T01",
    {
      phase: "executing",
      activeSlice: { id: "S01", title: "Filter chip bar" },
      activeTask: { id: "T01", title: "Add category filter" },
    } as any,
    {
      getAutoStartTime: () => Date.now(),
      isStepMode: () => false,
      getCmdCtx: () => null,
      getBasePath: () => "",
      isVerbose: () => false,
      isSessionSwitching: () => false,
      getCurrentDispatchedModelId: () => null,
    },
  );

  assert.ok(mock.getProgressState(), "progress strip state should publish once session switching ends");
  assert.ok(
    mock.widgetCalls.some(([key, value]) => key === "gsd-outcome" && value === undefined),
    "handoff widget should clear once the active dashboard can render",
  );
  mock.disposeProgress();
});

test("shouldRenderRoadmapProgress hides pre-roadmap zero-slice progress", () => {
  assert.equal(shouldRenderRoadmapProgress(null), false);
  assert.equal(shouldRenderRoadmapProgress({ done: 0, total: 0, activeSliceTasks: null } as any), false);
  assert.equal(shouldRenderRoadmapProgress({ done: 0, total: 1, activeSliceTasks: null } as any), true);
});

// ─── estimateTimeRemaining ──────────────────────────────────────────────

test("estimateTimeRemaining returns null when no ledger data", () => {
  // With no active auto-mode session, ledger is empty
  const result = estimateTimeRemaining();
  assert.equal(result, null);
});

test("estimateTimeRemaining is exported and callable", () => {
  assert.equal(typeof estimateTimeRemaining, "function");
});

test("estimateTimeRemaining scopes completed units to the active milestone", (t) => {
  const dir = makeTempDir("eta-scope");
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  t.after(() => {
    resetMetrics();
    closeDatabase();
    clearSliceProgressCache();
    cleanup(dir);
  });

  openDatabase(join(dir, ".gsd", "gsd.db"));
  insertMilestone({ id: "M002", title: "Active", status: "active" });
  insertSlice({ milestoneId: "M002", id: "S01", title: "Done", status: "complete", sequence: 1 });
  insertSlice({ milestoneId: "M002", id: "S02", title: "Remaining", status: "pending", sequence: 2 });

  const units = [
    makeMetricUnit("M001/S01/T01", 1_000, 61_000),
    makeMetricUnit("M001/S01/T02", 61_000, 121_000),
    makeMetricUnit("M001/S02/T01", 121_000, 181_000),
    makeMetricUnit("M001/S02/T02", 181_000, 241_000),
    makeMetricUnit("M002/S01/T01", 241_000, 301_000),
    makeMetricUnit("M002/S01/T02", 301_000, 361_000),
  ];
  writeFileSync(
    join(dir, ".gsd", "metrics.json"),
    JSON.stringify({ version: 1, projectStartedAt: 1_000, units }),
  );

  initMetrics(dir);
  clearSliceProgressCache();
  updateSliceProgressCache(dir, "M002");

  assert.equal(estimateTimeRemaining(), "~2m remaining");
});

// ─── getAutoDashboardData elapsed guard ──────────────────────────────────────
// These tests verify the elapsed time calculation in getAutoDashboardData()
// doesn't produce absurd values when autoStartTime is 0 (uninitialized).
// The actual function is in auto.ts and tested structurally here by verifying
// that formatAutoElapsed properly handles the zero case.

test("formatAutoElapsed returns empty string for negative autoStartTime", () => {
  // A negative value should be treated as invalid — the guard in
  // getAutoDashboardData prevents this, but formatAutoElapsed should also
  // handle it gracefully via its falsy check.
  assert.equal(formatAutoElapsed(-1), "");
  assert.equal(formatAutoElapsed(NaN), "");
});

test("getAutoDashboardData returns RTK savings in the dashboard payload", () => {
  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = makeTempDir("rtk-dashboard");
  autoSession.cmdCtx = {
    sessionManager: { getSessionId: () => "session-1" },
  } as any;
  try {
    const data = getAutoDashboardData();
    assert.equal(Object.hasOwn(data, "rtkSavings"), true);
    assert.equal(
      data.rtkSavings === null || typeof data.rtkSavings === "object",
      true,
    );
  } finally {
    cleanup(autoSession.basePath);
    autoSession.reset();
  }
});

test("getAutoDashboardData exposes typed tool-surface snapshots", () => {
  autoSession.reset();
  clearAutoToolSurfaceSnapshot();
  autoSession.active = true;
  recordAutoToolSurfaceSnapshot({
    source: "provider-adjustment",
    unitType: "run-uat",
    modelFacingToolNames: ["read"],
    registeredToolNames: ["read", "browser_navigate"],
    scopedToolNames: ["read", "browser_navigate"],
    presentedToolNames: ["browser_navigate"],
    capturedAt: 456,
  });

  const data = getAutoDashboardData();

  assert.equal(data.toolSurface?.source, "provider-adjustment");
  assert.equal(formatToolSurfaceSnapshot(data.toolSurface), "run-uat: model 1 / registered 2 / scoped 2 / presented 1");

  autoSession.reset();
  clearAutoToolSurfaceSnapshot();
});

test("RTK savings label formats the dashboard footer text", () => {
  assert.equal(formatRtkSavingsLabel(null), null);
  assert.equal(
    formatRtkSavingsLabel({
      commands: 2,
      inputTokens: 10_000,
      outputTokens: 1_000,
      savedTokens: 2_500,
      savingsPct: 25,
      totalTimeMs: 100,
      avgTimeMs: 50,
      updatedAt: new Date(0).toISOString(),
    }),
    "rtk: 2.5k saved (25%)",
  );
});

test("updateProgressWidget refreshes slice progress cache immediately", (t) => {
  const dir = makeTempDir("progress-cache");
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  t.after(() => {
    closeDatabase();
    clearSliceProgressCache();
    cleanup(dir);
  });

  openDatabase(join(dir, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Done", status: "complete", sequence: 1 });
  insertSlice({ milestoneId: "M001", id: "S02", title: "Active", status: "pending", sequence: 2 });
  insertSlice({ milestoneId: "M001", id: "S03", title: "Pending", status: "pending", sequence: 3 });
  insertTask({ milestoneId: "M001", sliceId: "S02", id: "T01", title: "Task", status: "complete" });

  clearSliceProgressCache();
  updateProgressWidget(
    {
      hasUI: true,
      ui: { setWidget() {} },
    } as any,
    "complete-slice",
    "M001/S02",
    {
      phase: "summarizing",
      activeMilestone: { id: "M001", title: "Milestone" },
      activeSlice: { id: "S02", title: "Active" },
      activeTask: null,
    } as any,
    {
      getAutoStartTime: () => 0,
      isStepMode: () => false,
      getCmdCtx: () => null,
      getBasePath: () => dir,
      isVerbose: () => false,
      isSessionSwitching: () => false,
      getCurrentDispatchedModelId: () => null,
    },
  );

  const progress = getRoadmapSlicesSync();
  assert.ok(progress, "progress cache should be populated immediately after updateProgressWidget");
  assert.deepEqual({
    done: progress.done,
    total: progress.total,
    activeSliceTasks: progress.activeSliceTasks,
  }, {
    done: 1,
    total: 3,
    activeSliceTasks: { done: 1, total: 1 },
  });
});

test("updateProgressWidget full mode keeps footer-owned signals out of auto deck", (t) => {
  const dir = makeTempDir("command-deck");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  const projectPrefsPath = join(dir, ".gsd", "preferences.md");
  const globalPrefsPath = join(dir, ".gsd", "global-preferences.md");
  writeFileSync(projectPrefsPath, "---\nversion: 1\n---\n", "utf-8");
  const mock = createProgressStripUiMock();

  t.after(() => {
    mock.disposeProgress();
    _resetWidgetModeForTests();
    clearSliceProgressCache();
    cleanup(dir);
  });

  _resetWidgetModeForTests();
  setWidgetMode("full", projectPrefsPath, globalPrefsPath);

  updateProgressWidget(
    {
      hasUI: true,
      ui: mock.ui,
      sessionManager: { getSessionId: () => "session-1" },
    } as any,
    "execute-task",
    "M004/S01/T01",
    {
      phase: "executing",
      activeMilestone: { id: "M004", title: "Budget Tracking" },
      activeSlice: { id: "S01", title: "Schema migration + expense add --repeat" },
      activeTask: { id: "T01", title: "Add repeat column via idempotent ALTER TABLE" },
    } as any,
    {
      getAutoStartTime: () => Date.now() - 18_000,
      isStepMode: () => false,
      getCmdCtx: () => ({
        model: { id: "claude-sonnet-4-6", provider: "claude-code", contextWindow: 1_000_000 },
        getContextUsage: () => ({ percent: 0.2, contextWindow: 1_000_000 }),
        sessionManager: { getEntries: () => [] },
      } as any),
      getBasePath: () => dir,
      isVerbose: () => false,
      isSessionSwitching: () => false,
      getCurrentDispatchedModelId: () => "claude-code/claude-sonnet-4-6",
    },
  );

  const progress = mock.getProgressState();
  assert.ok(progress, "progress strip state should be published");
  const rendered = renderProgressStrip(progress!, 120);

  assert.match(rendered, /GSD AUTO/);
  assert.match(rendered, /T01: Add repeat column via idempotent ALTER TABLE/);
  assert.match(rendered, /tools/);
  assert.match(rendered, /claude-sonnet-4-6/, "strip shows the dispatched model (#2207)");
  assert.doesNotMatch(rendered, /0\.2%|ctx|1\.0M/, "footer owns raw context meter display");
  assert.doesNotMatch(rendered, /\$/, "footer owns session cost display");
});

test("updateProgressWidget small mode renders the dense horizontal grid", (t) => {
  const dir = makeTempDir("small-dense-grid");
  const homeDir = makeTempDir("small-dense-grid-home");
  const projectPrefsPath = join(dir, ".gsd", "preferences.md");
  const globalPrefsPath = join(homeDir, ".gsd", "preferences.md");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  mkdirSync(join(homeDir, ".gsd"), { recursive: true });
  writeFileSync(projectPrefsPath, "---\nversion: 1\nwidget_mode: full\n---\n", "utf-8");
  writeFileSync(globalPrefsPath, "---\nversion: 1\nwidget_mode: full\n---\n", "utf-8");

  const mock = createProgressStripUiMock();

  t.after(() => {
    mock.disposeProgress();
    closeDatabase();
    clearSliceProgressCache();
    _resetWidgetModeForTests();
    cleanup(dir);
    cleanup(homeDir);
  });

  openDatabase(join(dir, ".gsd", "gsd.db"));
  insertMilestone({ id: "M004", title: "Budget Tracking", status: "active" });
  insertSlice({ milestoneId: "M004", id: "S01", title: "Schema migration", status: "complete", sequence: 1 });
  insertSlice({ milestoneId: "M004", id: "S02", title: "Expense add", status: "pending", sequence: 2 });
  insertTask({ milestoneId: "M004", sliceId: "S01", id: "T01", title: "Add repeat column via idempotent ALTER TABLE", status: "complete" });
  insertTask({ milestoneId: "M004", sliceId: "S01", id: "T02", title: "Backfill repeat metadata", status: "pending" });

  _resetWidgetModeForTests();
  setWidgetMode("small", projectPrefsPath, globalPrefsPath);

  updateProgressWidget(
    {
      hasUI: true,
      ui: mock.ui,
    } as any,
    "execute-task",
    "M004/S01/T02",
    {
      phase: "executing",
      activeMilestone: { id: "M004", title: "Budget Tracking" },
      activeSlice: { id: "S01", title: "Schema migration" },
      activeTask: { id: "T02", title: "Backfill repeat metadata" },
    } as any,
    {
      getAutoStartTime: () => Date.now() - 18_000,
      isStepMode: () => false,
      getCmdCtx: () => null,
      getBasePath: () => dir,
      isVerbose: () => false,
      isSessionSwitching: () => false,
      getCurrentDispatchedModelId: () => null,
    },
  );

  const progress = mock.getProgressState();
  assert.ok(progress, "progress strip state should be published");
  assert.equal(progress!.widgetMode, "small");
  const rendered = renderProgressStrip(progress!, 120);

  assert.match(rendered, /GSD AUTO/);
  assert.match(rendered, /T02: Backfill repeat metadata/);
  assert.match(rendered, /tasks/);
  assert.doesNotMatch(rendered, /\/gsd next|\/gsd status|esc pause/);

  for (const width of [40, 80, 120]) {
    assertLinesFit(renderProgressStripLines(progress!, width, { cwd: dir }), width);
  }
});

test("updateProgressWidget carries the dispatched model into the strip", (t) => {
  const dir = makeTempDir("dispatched-model");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  const mocks: ReturnType<typeof createProgressStripUiMock>[] = [];

  t.after(() => {
    for (const mock of mocks) mock.disposeProgress();
    _resetWidgetModeForTests();
    clearSliceProgressCache();
    cleanup(dir);
  });

  function capture(modelId: string | null) {
    const mock = createProgressStripUiMock();
    mocks.push(mock);
    updateProgressWidget(
      {
        hasUI: true,
        ui: mock.ui,
      } as any,
      "execute-task",
      "M004/S01/T01",
      {
        phase: "executing",
        activeSlice: { id: "S01", title: "Filter chip bar" },
        activeTask: { id: "T01", title: "Add category filter" },
      } as any,
      {
        getAutoStartTime: () => Date.now() - 12_000,
        isStepMode: () => false,
        getCmdCtx: () => null,
        getBasePath: () => dir,
        isVerbose: () => false,
        isSessionSwitching: () => false,
        getCurrentDispatchedModelId: () => modelId,
      },
    );
    const progress = mock.getProgressState();
    assert.ok(progress, "progress strip state should be published");
    return progress;
  }

  const withModel = capture("openai/gpt-5.3-codex");
  assert.equal(withModel.model, "openai/gpt-5.3-codex");

  const withoutModel = capture(null);
  assert.equal(withoutModel.model, undefined);

  const rendered = renderProgressStrip(withModel, 120, { cwd: dir });
  assert.match(rendered, /openai\/gpt-5\.3-codex/, "strip should show the dispatched model");
  for (const width of [40, 80, 120]) {
    assertLinesFit(renderProgressStripLines(withModel, width, { cwd: dir }), width);
  }
});

test("updateProgressWidget shows provider-waiting state consistently for auto and next modes", (t) => {
  const dir = makeTempDir("auto-next-dashboard");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  const mocks: ReturnType<typeof createProgressStripUiMock>[] = [];

  t.after(() => {
    for (const mock of mocks) mock.disposeProgress();
    _resetWidgetModeForTests();
    clearSliceProgressCache();
    cleanup(dir);
  });

  function captureDashboard(stepMode: boolean): string {
    const mock = createProgressStripUiMock();
    mocks.push(mock);
    updateProgressWidget(
      {
        hasUI: true,
        ui: mock.ui,
      } as any,
      "complete-slice",
      "M003/S01",
      {
        phase: "summarizing",
        activeMilestone: { id: "M003", title: "Inline editing" },
        activeSlice: { id: "S01", title: "Inline Edit" },
        activeTask: null,
      } as any,
      {
        getAutoStartTime: () => Date.now() - 12_000,
        isStepMode: () => stepMode,
        getCmdCtx: () => null,
        getBasePath: () => dir,
        isVerbose: () => false,
        isSessionSwitching: () => false,
        getCurrentDispatchedModelId: () => null,
      },
    );

    const progress = mock.getProgressState();
    assert.ok(progress, "progress strip state should be published");
    return renderProgressStrip(progress!, 120, { cwd: dir });
  }

  const autoRendered = captureDashboard(false);
  const nextRendered = captureDashboard(true);

  assert.match(autoRendered, /AUTO/);
  assert.match(nextRendered, /NEXT/);
  assert.match(autoRendered, /Completing|complete-slice/i);
  assert.match(nextRendered, /Completing|complete-slice/i);
  assert.doesNotMatch(autoRendered, /waiting on provider.*Waiting on provider/i);
  assert.doesNotMatch(nextRendered, /waiting on provider.*Waiting on provider/i);
  assert.doesNotMatch(autoRendered, /Working/);
  assert.doesNotMatch(nextRendered, /Working/);
});

test("last commit refresh backs off cleanly when base path is not a git repo", (t) => {
  const dir = makeTempDir("non-git");
  mkdirSync(dir, { recursive: true });

  t.after(() => {
    cleanup(dir);
    _resetLastCommitCacheForTests();
  });

  _resetLastCommitCacheForTests();
  _refreshLastCommitForTests(dir);

  assert.equal(_getLastCommitForTests(dir), null);
  assert.ok(
    _getLastCommitFetchedAtForTests() > 0,
    "non-git refresh should still advance fetchedAt to avoid render-loop retries",
  );
});

test("last commit refresh backs off cleanly when git repo has no commits", (t) => {
  const dir = makeTempDir("empty-git");
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });

  t.after(() => {
    cleanup(dir);
    _resetLastCommitCacheForTests();
  });

  _resetLastCommitCacheForTests();
  _refreshLastCommitForTests(dir);

  assert.equal(_getLastCommitForTests(dir), null);
  assert.ok(
    _getLastCommitFetchedAtForTests() > 0,
    "empty git refresh should still advance fetchedAt to avoid render-loop retries",
  );
});

test("last commit refresh still returns commit info for a valid git repo", (t) => {
  const dir = makeTempDir("git");
  mkdirSync(dir, { recursive: true });

  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "GSD Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "gsd@example.com"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "hello\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "test: seed dashboard repo"], { cwd: dir, stdio: "pipe" });

  t.after(() => {
    cleanup(dir);
    _resetLastCommitCacheForTests();
  });

  _resetLastCommitCacheForTests();
  _refreshLastCommitForTests(dir);

  const lastCommit = _getLastCommitForTests(dir);
  assert.ok(lastCommit, "git repo should produce last commit metadata");
  assert.match(lastCommit!.message, /test: seed dashboard repo/);
  assert.ok(lastCommit!.timeAgo.length > 0, "relative time should be populated");
});

// ─── extractUatSliceId ───────────────────────────────────────────────────

test("extractUatSliceId extracts slice ID from M001/S01 format", () => {
  assert.equal(extractUatSliceId("M001/S01"), "S01");
  assert.equal(extractUatSliceId("M002/S03"), "S03");
  assert.equal(extractUatSliceId("M001/S12"), "S12");
});

test("extractUatSliceId returns null for invalid formats", () => {
  assert.equal(extractUatSliceId("M001"), null);
  assert.equal(extractUatSliceId(""), null);
  assert.equal(extractUatSliceId("M001/T01"), null);
});

test("widget mode respects project preference precedence and persists there", (t) => {
  const homeDir = makeTempDir("home");
  const projectDir = makeTempDir("project");
  const globalPrefsPath = join(homeDir, ".gsd", "preferences.md");
  const projectPrefsPath = join(projectDir, ".gsd", "preferences.md");

  mkdirSync(join(homeDir, ".gsd"), { recursive: true });
  mkdirSync(join(projectDir, ".gsd"), { recursive: true });
  writeFileSync(globalPrefsPath, "---\nversion: 1\nwidget_mode: off\n---\n", "utf-8");
  writeFileSync(projectPrefsPath, "---\nversion: 1\nwidget_mode: small\n---\n", "utf-8");

  t.after(() => {
    cleanup(homeDir);
    cleanup(projectDir);
    _resetWidgetModeForTests();
  });

  _resetWidgetModeForTests();

  assert.equal(getWidgetMode(projectPrefsPath, globalPrefsPath), "small", "project widget_mode overrides global");
  assert.equal(
    cycleWidgetMode(projectPrefsPath, globalPrefsPath),
    "min",
    "cycling advances from the project-owned mode",
  );

  const projectPrefs = readFileSync(projectPrefsPath, "utf-8");
  const globalPrefs = readFileSync(globalPrefsPath, "utf-8");
  assert.match(projectPrefs, /widget_mode:\s*min/);
  assert.match(globalPrefs, /widget_mode:\s*off/);
});

test("widget mode defaults to small when preferences do not set it", (t) => {
  const homeDir = makeTempDir("home-no-widget-pref");
  const projectDir = makeTempDir("project-no-widget-pref");
  const globalPrefsPath = join(homeDir, ".gsd", "preferences.md");
  const projectPrefsPath = join(projectDir, ".gsd", "preferences.md");

  mkdirSync(join(homeDir, ".gsd"), { recursive: true });
  mkdirSync(join(projectDir, ".gsd"), { recursive: true });
  writeFileSync(globalPrefsPath, "---\nversion: 1\n---\n", "utf-8");
  writeFileSync(projectPrefsPath, "---\nversion: 1\n---\n", "utf-8");

  t.after(() => {
    cleanup(homeDir);
    cleanup(projectDir);
    _resetWidgetModeForTests();
  });

  _resetWidgetModeForTests();

  assert.equal(getWidgetMode(projectPrefsPath, globalPrefsPath), "small");
});
