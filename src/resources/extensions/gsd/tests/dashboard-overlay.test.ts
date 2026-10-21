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
