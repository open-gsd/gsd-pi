// Project/App: gsd-pi
// File Purpose: Direct confirmed /gsd discard routing contract.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handleWorkflowCommand } from "../commands/handlers/workflow.ts";
import { withCommandCwd } from "../commands/context.ts";
import { closeDatabase, getMilestone, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.ts";
import { detectStaleRenders } from "../markdown-renderer.ts";
import { repairStaleRenders } from "../state-reconciliation/drift/stale-render.ts";
import { renderTopLevelQueueFromDb, renderTopLevelRoadmapFromDb } from "../workflow-projections.ts";
import { discardMilestone } from "../milestone-actions.ts";
import { persistMilestonePlan } from "../milestone-planning-persistence.ts";
import { internalPlanningInvocation } from "../planning-invocation.ts";
import { deriveStateFromDb, invalidateStateCache } from "../state.ts";

test("/gsd discard confirms and calls the primitive directly", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-discard-command-"));
  const notifications: string[] = [];
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "README.md"), "# Test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: base, stdio: "ignore" });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", status: "queued" });

  const ctx = {
    cwd: base,
    hasUI: true,
    ui: {
      custom: async () => true,
      notify: (message: string) => notifications.push(message),
    },
  };
  const handled = await withCommandCwd(base, () => handleWorkflowCommand("discard M001", ctx as any, {} as any));

  assert.equal(handled, true);
  assert.equal(getMilestone("M001")?.status, "skipped", "row kept as a tombstone");
  assert.ok(notifications.includes("Discarded M001."));
});

test("/gsd discard leaves the milestone when confirmation is declined", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-discard-command-cancel-"));
  const notifications: string[] = [];
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", status: "queued" });

  const ctx = {
    cwd: base,
    hasUI: true,
    ui: {
      custom: async () => false,
      notify: (message: string) => notifications.push(message),
    },
  };
  const handled = await withCommandCwd(base, () => handleWorkflowCommand("discard M001", ctx as any, {} as any));

  assert.equal(handled, true);
  assert.notEqual(getMilestone("M001"), null);
  assert.ok(notifications.includes("Discard of M001 cancelled."));
});

test("a discarded milestone is not complete and does not satisfy a dependency", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-discard-dependency-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "First", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending", risk: "low", depends: [] });
  insertMilestone({ id: "M002", title: "Second", status: "queued", depends_on: ["M001"] });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Slice", status: "pending", risk: "low", depends: [] });
  invalidateStateCache();
  assert.equal((await deriveStateFromDb(base)).activeMilestone?.id, "M001");

  assert.equal(await discardMilestone(base, "M001"), true);

  invalidateStateCache();
  const state = await deriveStateFromDb(base);
  assert.notEqual(state.activeMilestone?.id, "M002");
  assert.deepEqual(state.registry, [{ id: "M002", title: "Second", status: "pending", dependsOn: ["M001"] }]);
  assert.deepEqual(state.progress?.milestones, { done: 0, total: 1 });
});

test("QUEUE.md and ROADMAP.md renders omit a discarded milestone", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-discard-renders-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "First", status: "active" });
  insertMilestone({ id: "M002", title: "Second", status: "queued" });
  const render = () => {
    renderTopLevelQueueFromDb(base);
    renderTopLevelRoadmapFromDb(base);
    return ["QUEUE.md", "ROADMAP.md"].map((name) => readFileSync(join(base, ".gsd", name), "utf8"));
  };
  for (const content of render()) assert.ok(content.includes("**M002: Second**"));

  assert.equal(await discardMilestone(base, "M002"), true);

  for (const content of render()) {
    assert.ok(content.includes("**M001: First**"));
    assert.equal(content.includes("M002"), false, content);
  }
});

test("stale-render repair does not restore files of a discarded milestone", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-discard-stale-render-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), "# M001: First\n", "utf8");
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "First", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active", risk: "low", depends: [] });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Done", status: "complete", fullSummaryMd: "# T01 summary\n" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Open", status: "pending" });
  assert.equal(detectStaleRenders(base).length, 1, "the completed task summary is missing before discard");

  assert.equal(await discardMilestone(base, "M001"), true);

  assert.deepEqual(detectStaleRenders(base), []);
  assert.equal(existsSync(milestoneDir), false, "discard removed the milestone files");
  assert.equal(await repairStaleRenders(base), 0);
  assert.equal(existsSync(milestoneDir), false);
});

test("planning refuses a discarded milestone as a dependency", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-discard-plan-dependency-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "First", status: "active" });
  assert.equal(await discardMilestone(base, "M001"), true);

  const result = await persistMilestonePlan({
    milestoneId: "M003",
    title: "Third",
    vision: "Depends on discarded work.",
    dependsOn: ["M001"],
    slices: [{
      sliceId: "S01",
      title: "Foundation",
      risk: "medium",
      depends: [],
      demo: "S01 demo.",
      goal: "Lay the foundation.",
      successCriteria: "It exists.",
      proofLevel: "demo",
      integrationClosure: "none",
      observabilityImpact: "none",
    }],
  }, base, internalPlanningInvocation());

  assert.ok("error" in result);
  assert.match(result.error, /M001 was discarded/);
  assert.equal(getMilestone("M003"), null);
});
