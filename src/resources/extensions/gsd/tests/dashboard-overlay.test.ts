/**
 * GSD dashboard overlay dialog chrome tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import { GSDDashboardOverlay } from "../dashboard-overlay.ts";
import type { UnitMetrics } from "../metrics.ts";
import { assertFullOuterBorder } from "./tui-border-assertions.ts";
import { autoSession, getAutoRuntimeSnapshot } from "../auto-runtime-state.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import { clearParseCache } from "../files.ts";
import {
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { completeMilestone } from "../milestone-lifecycle-domain-operation.ts";
import { clearPathCache } from "../paths.ts";
import { handleValidateMilestone } from "../tools/validate-milestone.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";
import {
  getActiveWorkers,
  registerWorker,
  resetWorkerRegistry,
  updateWorker,
} from "../../subagent/worker-registry.ts";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("GSDDashboardOverlay renders inside the shared full border", (t) => {
  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => overlay.dispose());

  const lines = overlay.render(100);
  assertFullOuterBorder(lines, 100);
  assert.match(lines[0] ?? "", /^╭─ GSD Dashboard /);
  assert.ok(lines.some((line) => line.startsWith("│")), "body rows should have side borders");
  assert.match(lines.at(-1) ?? "", /^╰─+╯$/);
});

test("GSDDashboardOverlay reuses metrics aggregations until the unit count changes", (t) => {
  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => overlay.dispose());

  const firstUnits = [makeUnit("M001/S001/T001", 0.25)];
  const firstMetrics = (overlay as any).ensureMetricsCache(firstUnits);

  overlay.invalidate();

  const sameCountUnits = [makeUnit("M001/S001/T002", 0.5)];
  const sameCountMetrics = (overlay as any).ensureMetricsCache(sameCountUnits);
  assert.equal(sameCountMetrics, firstMetrics, "same unit count should reuse cached metrics");
  assert.equal(sameCountMetrics.totals.cost, 0.25);

  const increasedCountMetrics = (overlay as any).ensureMetricsCache([
    ...sameCountUnits,
    makeUnit("M001/S001/T003", 0.75),
  ]);
  assert.notEqual(increasedCountMetrics, firstMetrics, "changed unit count should recompute metrics");
  assert.equal(increasedCountMetrics.totals.units, 2);
  assert.equal(increasedCountMetrics.totals.cost, 1.25);
});

test("GSDDashboardOverlay non-identity refresh avoids reparsing preferences", async (t) => {
  const basePath = join(
    tmpdir(),
    `gsd-dashboard-overlay-refresh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = basePath;
  autoSession.autoStartTime = Date.now() - 1000;
  autoSession.setCurrentUnit({
    type: "execute-task",
    id: "M001/S001/T001",
    startedAt: Date.now() - 500,
  });

  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => {
    overlay.dispose();
    autoSession.reset();
    rmSync(basePath, { recursive: true, force: true });
  });

  (overlay as any).loadedDashboardIdentity = (overlay as any).computeDashboardIdentity(getAutoRuntimeSnapshot());
  mkdirSync(join(basePath, ".gsd", "PREFERENCES.md"));

  await assert.doesNotReject(
    () => (overlay as any).refreshDashboard(false),
    "unchanged overlay identity should not call getAutoDashboardData or read preferences",
  );
});

test("GSDDashboardOverlay reloads milestone progress after a DB-backed completion with unchanged runtime identity", async (t) => {
  const basePath = join(
    tmpdir(),
    `gsd-dashboard-overlay-db-revision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  mkdirSync(join(milestoneDir, "slices", "S01", "tasks"), { recursive: true });
  writeFileSync(join(milestoneDir, "M001-CONTEXT.md"), "# M001\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'dashboard';\n");
  execFileSync("git", ["init"], { cwd: basePath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: basePath });
  execFileSync("git", ["add", "source.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: basePath, stdio: "ignore" });
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  assert.ok(source.ok, "source snapshot should succeed");

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Dashboard refresh", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice One", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task One", status: "complete" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.dashboard.adopt",
    idempotencyKey: "fixture/dashboard/adopt",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready" });
    adoptOrTransitionLifecycle(context, { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed" });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "completed",
    });
    return {
      events: [{
        eventType: "test.dashboard.adopt", entityType: "milestone", entityId: "M001", payload: {}, destinations: ["test"],
      }],
      projections: [{ projectionKey: "test/dashboard/adopt", projectionKind: "test", rendererVersion: "1" }],
    };
  });

  autoSession.reset();
  autoSession.basePath = basePath;

  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => {
    overlay.dispose();
    autoSession.reset();
    closeDatabase();
    clearParseCache();
    clearPathCache();
    rmSync(basePath, { recursive: true, force: true });
  });

  await (overlay as any).refreshInFlight;
  assert.deepEqual((overlay as any).milestoneData?.progress.milestones, { total: 1, done: 0 });
  assert.ok((overlay as any).milestoneData.slices.some((slice: { id: string }) => slice.id === "S01"));
  const identityBefore = (overlay as any).loadedDashboardIdentity;
  const runtimeBefore = JSON.stringify(getAutoRuntimeSnapshot());

  const invocation = (idempotencyKey: string) => ({
    idempotencyKey,
    sourceTransport: "pi-tool" as const,
    actorType: "agent" as const,
    actorId: "dashboard-overlay-test",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  });
  const validated = await handleValidateMilestone({
    milestoneId: "M001",
    verdict: "pass",
    remediationRound: 0,
    successCriteriaChecklist: "- [x] Complete",
    sliceDeliveryAudit: "| S01 | delivered |",
    crossSliceIntegration: "Passed",
    requirementCoverage: "Covered",
    verificationClasses: "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| Contract | focused test | PASS |",
    verdictRationale: "All current database evidence passes.",
  }, basePath, { invocation: invocation("fixture/dashboard/validate"), skipBrowserEvidenceGate: true });
  assert.ok(!("error" in validated), `validation failed: ${"error" in validated ? validated.error : ""}`);
  completeMilestone({
    invocation: invocation("fixture/dashboard/complete"),
    milestoneId: "M001",
    sourceRevision: source.ok ? source.snapshot.aggregateRevision : "",
    closeout: {
      title: "Dashboard refresh",
      oneLiner: "Completed while the dashboard stayed open.",
      narrative: "The DB-backed completion must reach the open dashboard.",
      successCriteriaResults: "Passed.",
      definitionOfDoneResults: "Passed.",
      requirementOutcomes: "Covered.",
      keyDecisions: [],
      keyFiles: [],
      lessonsLearned: [],
      followUps: "None.",
      deviations: "None.",
    },
  });
  assert.equal(JSON.stringify(getAutoRuntimeSnapshot()), runtimeBefore, "completion must not change the auto-runtime identity");

  await (overlay as any).refreshDashboard(false);

  assert.notEqual((overlay as any).loadedDashboardIdentity, identityBefore, "DB revision change should invalidate the dashboard identity");
  assert.equal((overlay as any).milestoneData, null, "completed milestone must not be presented as the active milestone");
  const rendered = overlay.render(100).join("\n");
  assert.ok(!rendered.includes("S01"), "stale active slice must not be presented as current");
});

test("GSDDashboardOverlay render and scroll do not run environment doctor subprocesses", (t) => {
  const basePath = join(
    tmpdir(),
    `gsd-dashboard-overlay-env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const shimDir = join(
    tmpdir(),
    `gsd-dashboard-overlay-shim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(basePath, { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(basePath, "package.json"), JSON.stringify({ engines: { node: ">=22.0.0" } }));

  const posixNodeShim = join(shimDir, "node");
  writeFileSync(posixNodeShim, "#!/bin/sh\nsleep 1\nexit 1\n");
  chmodSync(posixNodeShim, 0o755);
  writeFileSync(join(shimDir, "node.cmd"), "@echo off\r\nping -n 2 127.0.0.1 > nul\r\nexit /b 1\r\n");

  const originalPath = process.env.PATH;
  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  overlay.dispose();

  t.after(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    rmSync(basePath, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  });

  (overlay as any).loading = false;
  (overlay as any).milestoneData = null;
  (overlay as any).dashData = {
    ...(overlay as any).dashData,
    basePath,
  };

  process.env.PATH = `${shimDir}${delimiter}${originalPath ?? ""}`;
  const start = performance.now();
  overlay.render(100);
  overlay.handleInput("j");
  overlay.render(100);
  const elapsed = performance.now() - start;

  assert.ok(
    elapsed < 500,
    `rendering and scrolling should not wait for environment subprocesses, took ${Math.round(elapsed)}ms`,
  );
});

function makeUnit(id: string, cost: number): UnitMetrics {
  return {
    type: "execute-task",
    id,
    model: "claude-sonnet-4.5",
    startedAt: 1000,
    finishedAt: 2000,
    tokens: {
      input: 100,
      output: 50,
      cacheRead: 25,
      cacheWrite: 10,
      total: 185,
    },
    cost,
    toolCalls: 1,
    assistantMessages: 1,
    userMessages: 1,
  };
}

// ─── Parallel worker identity rows (#2396) ────────────────────────────────────

const ansiRegex = /\x1b\[[0-9;]*m/g;

test("parallel worker rows show each child's requested model and thinking (#2396)", (t) => {
  resetWorkerRegistry();
  t.after(() => resetWorkerRegistry());

  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => overlay.dispose());

  registerWorker("scout", "Explore the codebase", 0, 2, "batch-a", { model: "gpt-5.6-sol", thinking: "high" });
  registerWorker("release-engineer", "Ship the release", 1, 2, "batch-a", { model: "gpt-5.6-luna", thinking: "medium" });

  const lines = overlay.render(120);
  const text = lines.join("\n");
  assert.match(text, /scout · gpt-5.6-sol · high/, "first child shows its own model/thinking");
  assert.match(text, /release-engineer · gpt-5.6-luna · medium/, "second child shows its own model/thinking");
  assert.match(text, /running /, "running elapsed still shown");
});

test("completed and failed worker rows keep attribution with deterministic elapsed (#2396)", async (t) => {
  resetWorkerRegistry();
  t.after(() => resetWorkerRegistry());

  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => overlay.dispose());

  // Mixed batch: the workers section renders only while some worker runs.
  const id1 = registerWorker("scout", "Done task", 0, 3, "batch-b", { model: "gpt-5.6-sol", thinking: "high" });
  const id2 = registerWorker("release-engineer", "Failed task", 1, 3, "batch-b", { model: "gpt-5.6-luna", thinking: "medium" });
  registerWorker("worker", "Still running", 2, 3, "batch-b");
  updateWorker(id1, "completed");
  updateWorker(id2, "failed");

  // Pin timestamps: elapsed must come from startedAt/completedAt, not the wall clock.
  const w1 = getActiveWorkers().find(w => w.id === id1)!;
  const w2 = getActiveWorkers().find(w => w.id === id2)!;
  w1.startedAt = 1000;
  w1.completedAt = 101000; // 100s
  w2.startedAt = 2000;
  w2.completedAt = 20000; // 18s

  const lines = overlay.render(120);
  const text = lines.join("\n");
  assert.match(text, /1m 40s/, "completed child shows completedAt-based elapsed");
  assert.match(text, /failed after 18s/, "failed child shows failed-after elapsed");
  // Deterministic: rebuilding (cache invalidated, wall clock advanced) shows the
  // same durations because elapsed comes from startedAt/completedAt, not Date.now().
  await new Promise((resolve) => setTimeout(resolve, 20));
  overlay.invalidate();
  const again = overlay.render(120).join("\n");
  assert.match(again, /1m 40s/, "completed elapsed does not drift after render");
  assert.match(again, /failed after 18s/, "failed elapsed does not drift after render");
});

test("parallel worker rows render legacy workers without identity fields (#2396)", (t) => {
  resetWorkerRegistry();
  t.after(() => resetWorkerRegistry());

  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => overlay.dispose());

  registerWorker("scout", "Legacy task", 0, 1, "batch-c");

  const lines = overlay.render(120);
  const text = lines.join("\n");
  assert.match(text, /scout/, "agent row still renders");
  assert.match(text, /running /, "elapsed still renders without model/thinking");
  assert.doesNotMatch(text, /· ·/, "no dangling separators");
});

test("parallel worker rows stay within terminal width with identity (#2396)", (t) => {
  resetWorkerRegistry();
  t.after(() => resetWorkerRegistry());

  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => overlay.dispose());

  registerWorker(
    "scout",
    "very long task description ".repeat(12),
    0,
    1,
    "batch-d",
    { model: "openrouter/auto · anthropic/claude-opus-4.7-with-a-very-long-name", thinking: "xhigh" },
  );

  const width = 60;
  const lines = overlay.render(width);
  assert.ok(lines.length > 0, "overlay rendered");
  const text = lines.join("\n");
  // Elapsed outranks the task preview: it must survive truncation.
  assert.match(text, /running \d/, "elapsed stays visible at narrow width");
  for (const line of lines) {
    const visible = line.replace(ansiRegex, "");
    assert.ok(
      visible.length <= width,
      `line exceeds width ${width}: ${JSON.stringify(visible)}`,
    );
  }

  // Wide (CJK) agent names measured by display width, plus the preview separator,
  // must not push elapsed out of the row.
  registerWorker("調査担当調査担当", "very long task description ".repeat(8), 1, 2, "batch-d", {
    model: "gpt-5.6-sol",
    thinking: "high",
  });
  overlay.invalidate();
  for (const w of [width, 80, 120]) {
    const wideLines = overlay.render(w);
    const wideText = wideLines.join("\n");
    assert.match(wideText, /running \d/, `elapsed visible at width ${w} with CJK agent`);
    for (const line of wideLines) {
      const visible = line.replace(ansiRegex, "");
      assert.ok(visible.length <= w, `line exceeds width ${w}: ${JSON.stringify(visible)}`);
    }
  }
});
