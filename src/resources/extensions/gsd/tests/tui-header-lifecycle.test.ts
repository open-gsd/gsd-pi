// Project/App: gsd-pi
// File Purpose: Regression tests for the TUI header lifecycle fixes —
// header is suppressed (zero lines) when auto-mode activates, the wizard
// step status badge is cleared, the NEXT-mode footer hint renders when
// step mode is active, and the health widget appends guidance for active
// projects.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _resetWidgetModeForTests,
  setCompletionProgressWidget,
  setWidgetMode,
  updateProgressWidget,
} from "../auto-dashboard.ts";
import {
  createProgressStripUiMock,
  renderProgressStrip,
  renderProgressStripLines,
  assertLinesFit,
} from "./progress-strip-test-helpers.ts";
import type { GSDState } from "../types.ts";

interface CapturedSetHeader {
  factory: ((tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void }) | undefined;
}

function makeTempDir(prefix: string): string {
  return join(
    tmpdir(),
    `gsd-tui-lifecycle-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

const baseState: GSDState = {
  phase: "executing",
  activeMilestone: { id: "M001", title: "Milestone" },
  activeSlice: { id: "S01", title: "Slice" },
  activeTask: { id: "T01", title: "Task" },
} as unknown as GSDState;

const baseAccessors = {
  getAutoStartTime: () => 0,
  isStepMode: () => false,
  getCmdCtx: () => null,
  getBasePath: () => "/tmp",
  isVerbose: () => false,
  isSessionSwitching: () => false,
  getCurrentDispatchedModelId: () => null,
};

// ── Header lifecycle ────────────────────────────────────────────────────

test("updateProgressWidget installs an EMPTY-rendering header (not undefined) — addresses codex P1 finding that setHeader(undefined) restores the built-in logo+instructions header", (t) => {
  const dir = makeTempDir("empty-header");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));

  const captured: CapturedSetHeader = { factory: undefined };
  let setHeaderCallCount = 0;

  updateProgressWidget(
    {
      hasUI: true,
      ui: {
        setWidget() {},
        setHeader(factory: any) {
          setHeaderCallCount++;
          captured.factory = factory;
        },
        setStatus() {},
      },
    } as any,
    "execute-task",
    "M001/S01/T01",
    baseState,
    { ...baseAccessors, getBasePath: () => dir },
  );

  assert.equal(setHeaderCallCount, 1, "setHeader must be called exactly once when widget installs");
  assert.notEqual(captured.factory, undefined, "factory must NOT be undefined — undefined restores the built-in logo+instructions header (codex P1)");
  assert.equal(typeof captured.factory, "function", "factory must be a component-creating function");

  const component = captured.factory!(null, null);
  const rendered = component.render(80);
  assert.deepEqual(rendered, [], "empty header component must render zero lines so auto-mode actually suppresses the welcome banner");
});

test("updateProgressWidget clears the gsd-step wizard badge when auto-mode activates", (t) => {
  const dir = makeTempDir("step-badge");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));

  const statusCalls: Array<[string, string | undefined]> = [];

  updateProgressWidget(
    {
      hasUI: true,
      ui: {
        setWidget() {},
        setHeader() {},
        setStatus(key: string, value: string | undefined) { statusCalls.push([key, value]); },
      },
    } as any,
    "execute-task",
    "M001/S01/T01",
    baseState,
    { ...baseAccessors, getBasePath: () => dir },
  );

  assert.ok(
    statusCalls.some(([key, value]) => key === "gsd-step" && value === undefined),
    `expected setStatus("gsd-step", undefined) to be called; got ${JSON.stringify(statusCalls)}`,
  );
});

test("updateProgressWidget gracefully no-ops when ctx.ui lacks setHeader/setStatus (RPC mode)", (t) => {
  const dir = makeTempDir("rpc-mode");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));

  // ctx.ui without setHeader / setStatus — must not throw.
  assert.doesNotThrow(() => {
    updateProgressWidget(
      {
        hasUI: true,
        ui: { setWidget() {} },
      } as any,
      "execute-task",
      "M001/S01/T01",
      baseState,
      { ...baseAccessors, getBasePath: () => dir },
    );
  });
});

// ── NEXT-mode footer guidance ───────────────────────────────────────────

test("progress strip uses NEXT mode tag when step mode is active", (t) => {
  const dir = makeTempDir("step-hint");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  const projectPrefsPath = join(dir, ".gsd", "preferences.md");
  const globalPrefsPath = join(dir, ".gsd", "global-preferences.md");
  writeFileSync(projectPrefsPath, "---\nversion: 1\n---\n", "utf-8");
  _resetWidgetModeForTests();
  setWidgetMode("full", projectPrefsPath, globalPrefsPath);
  const mock = createProgressStripUiMock();
  t.after(() => {
    mock.disposeProgress();
    _resetWidgetModeForTests();
    cleanup(dir);
  });

  updateProgressWidget(
    {
      hasUI: true,
      ui: mock.ui,
    } as any,
    "execute-task",
    "M001/S01/T01",
    baseState,
    { ...baseAccessors, getBasePath: () => dir, isStepMode: () => true },
  );

  const progress = mock.getProgressState();
  assert.ok(progress, "progress strip state should be published");
  assert.equal(progress!.modeTag, "NEXT");
  const rendered = renderProgressStrip(progress!, 120, { cwd: dir });
  assert.match(rendered, /NEXT/);
});

test("progress strip uses AUTO mode tag when step mode is inactive", (t) => {
  const dir = makeTempDir("no-step-hint");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  const projectPrefsPath = join(dir, ".gsd", "preferences.md");
  const globalPrefsPath = join(dir, ".gsd", "global-preferences.md");
  writeFileSync(projectPrefsPath, "---\nversion: 1\n---\n", "utf-8");
  _resetWidgetModeForTests();
  setWidgetMode("full", projectPrefsPath, globalPrefsPath);
  const mock = createProgressStripUiMock();
  t.after(() => {
    mock.disposeProgress();
    _resetWidgetModeForTests();
    cleanup(dir);
  });

  updateProgressWidget(
    {
      hasUI: true,
      ui: mock.ui,
    } as any,
    "execute-task",
    "M001/S01/T01",
    baseState,
    { ...baseAccessors, getBasePath: () => dir, isStepMode: () => false },
  );

  const progress = mock.getProgressState();
  assert.ok(progress, "progress strip state should be published");
  assert.equal(progress!.modeTag, "AUTO");
  const rendered = renderProgressStrip(progress!, 120, { cwd: dir });
  assert.match(rendered, /AUTO/);
  assert.doesNotMatch(rendered, /NEXT/);
});

test("progress strip render output fits common terminal widths", (t) => {
  const dir = makeTempDir("width-safe");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  const mock = createProgressStripUiMock();
  t.after(() => {
    mock.disposeProgress();
    cleanup(dir);
  });

  updateProgressWidget(
    {
      hasUI: true,
      ui: mock.ui,
    } as any,
    "execute-task",
    "M001/S01/T01",
    baseState,
    { ...baseAccessors, getBasePath: () => dir },
  );

  const progress = mock.getProgressState();
  assert.ok(progress, "progress strip state should be published");

  for (const width of [40, 80, 120]) {
    assertLinesFit(renderProgressStripLines(progress!, width, { cwd: dir }), width);
  }
});

test("completion dashboard keeps final milestone roll-up in the progress widget", (t) => {
  const dir = makeTempDir("completion-widget");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));

  let widgetFactory: ((tui: unknown, theme: unknown) => any) | undefined;

  setCompletionProgressWidget(
    {
      hasUI: true,
      ui: {
        setWidget(_key: string, factory: any) { widgetFactory = factory; },
        setHeader() {},
        setStatus() {},
      },
    } as any,
    {
      milestoneId: "M003",
      milestoneTitle: "Budget tracking",
      oneLiner: "Added milestone budget warning output and provider roll-up details.",
      successCriteriaResults: "Budget warnings appear at the end of milestone completion.",
      requirementOutcomes: "Users can see what shipped without opening a fresh session.",
      keyFiles: ["src/resources/extensions/gsd/auto-dashboard.ts", "src/resources/extensions/gsd/auto.ts"],
      keyDecisions: ["Keep completion closeout in the same TUI surface."],
      followUps: "None.",
      reason: "Milestone M003 complete",
      startedAt: Date.now() - 90_000,
      totalCost: 21.29,
      totalTokens: 1_000_000,
      unitCount: 8,
      cacheHitRate: 100,
      contextPercent: 0.9,
      contextWindow: 1_000_000,
      completedSlices: 3,
      totalSlices: 3,
      basePath: dir,
    },
  );

  assert.ok(widgetFactory, "completion widget factory must be installed");

  const fakeTui = { requestRender() {} };
  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const component = widgetFactory!(fakeTui, fakeTheme);
  const output = component.render(140).join("\n");

  assert.match(output, /Milestone M003 roll-up/);
  assert.match(output, /Budget tracking/);
  assert.match(output, /Outcome/);
  assert.match(output, /Added milestone budget warning output/);
  assert.match(output, /What changed/);
  assert.match(output, /Budget warnings appear/);
  assert.match(output, /Users can see what shipped/);
  assert.match(output, /Keep completion closeout/);
  assert.match(output, /Verification/);
  assert.match(output, /Files:/);
  assert.match(output, /auto-dashboard\.ts/);
  assert.doesNotMatch(output, /Run totals/);
  assert.doesNotMatch(output, /\$21\.29/);
  assert.doesNotMatch(output, /1\.0M tokens/);
  assert.doesNotMatch(output, /COMPLETE-MILESTONE/);

  if (component.dispose) component.dispose();
});
