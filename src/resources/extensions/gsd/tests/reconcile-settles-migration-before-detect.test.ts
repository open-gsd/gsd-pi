// Project/App: gsd-pi
// File Purpose: Regression tests for the NPM Publish @dev verify failure
// (actions run 31923706955) and #1774: reconcileBeforeDispatch ran while the
// startup flat-phase migration was still pending or in flight (headless fires
// session_start in two processes). Detectors saw the transient mid-move gap —
// ROADMAP in neither layout — as phantom roadmap-missing drift, and the repair
// write into the legacy tree died with ENOENT when the migration renamed the
// directory mid-write, permanently wedging auto-mode. Reconciliation must
// settle the migration (idempotent, cross-process locked) before detecting.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { needsFlatPhaseMigration } from "../flat-phase-migration.ts";
import {
  acquireSessionLock,
  releaseSessionLock,
  validateSessionLock,
} from "../session-lock.ts";
import { reconcileBeforeDispatch } from "../state-reconciliation.ts";
import type { GSDState } from "../types.ts";

function makeState(): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: null,
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "Execute task",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } },
  };
}

afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
});

function makeBase(prefix: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedDb(): void {
  insertMilestone({
    id: "M001",
    title: "Test",
    status: "active",
    planning: { vision: "Settle layout migration before drift detection." },
  });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Foundation",
    status: "pending",
    risk: "low",
    depends: [],
    demo: "S01 demo.",
    sequence: 1,
  });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Plan S01", status: "pending" });
}

/** Minimal recovered-project legacy tree (mirrors the acceptance bed fixture). */
function writeLegacyTree(gsdDir: string): void {
  const sliceDir = join(gsdDir, "milestones", "M001", "slices", "S01");
  mkdirSync(join(sliceDir, "tasks"), { recursive: true });
  writeFileSync(join(gsdDir, "milestones", "M001", "M001-CONTEXT.md"), "# M001: Test\n");
  writeFileSync(
    join(gsdDir, "milestones", "M001", "M001-ROADMAP.md"),
    "# M001: Test\n\n## Slices\n\n- [ ] **S01: Foundation** `risk:low` `depends:[]`\n  > S01 demo.\n",
  );
  writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01: Foundation\n");
  writeFileSync(join(sliceDir, "tasks", "T01-PLAN.md"), "# T01: Plan S01\n");
}

function flatRoadmapPath(base: string): string {
  return join(base, ".gsd", "phases", "01-test", "01-ROADMAP.md");
}

test("reconcile settles a pending flat-phase migration while the session lock is held", async (t) => {
  const base = makeBase("gsd-recon-mig-pending-");
  t.after(() => {
    releaseSessionLock(base);
    cleanup(base);
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  seedDb();
  writeLegacyTree(join(base, ".gsd"));
  assert.equal(needsFlatPhaseMigration(base), true, "fixture must need migration");
  const sessionLock = acquireSessionLock(base);
  assert.equal(sessionLock.acquired, true, "production session lock must be held");

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.repaired.filter((d) => d.kind === "roadmap-missing").length,
    0,
    "no phantom roadmap-missing repair may run against the pre-migration layout",
  );
  assert.ok(existsSync(flatRoadmapPath(base)), "migration must have rendered the flat-phase ROADMAP");
  assert.equal(existsSync(join(base, ".gsd", "milestones")), false, "legacy tree must be gone after settling");
  assert.equal(needsFlatPhaseMigration(base), false, "layout must be settled afterwards");
  assert.equal(validateSessionLock(base), true, "reconciliation must preserve the session lock");

  // Convergence proof: a second pass detects nothing.
  const second = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });
  assert.equal(second.ok, true);
  assert.equal(second.repaired.length, 0, "second pass must be clean");
});

test("reconcile waits out an in-flight migration instead of repairing the transient gap", async (t) => {
  const base = makeBase("gsd-recon-mig-inflight-");
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  seedDb();
  writeLegacyTree(join(base, ".gsd"));
  // Simulate a sibling process mid-migration: the legacy tree sits renamed
  // aside and .gsd/phases/ has not been rendered yet — projections exist in
  // neither layout. This is exactly the window that wedged the @dev verify bed.
  renameSync(join(base, ".gsd", "milestones"), join(base, ".gsd", "milestones.migrating"));
  assert.equal(needsFlatPhaseMigration(base), true, "interrupted migration must still need settling");

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.repaired.filter((d) => d.kind === "roadmap-missing").length,
    0,
    "the transient gap is not drift — the migration resume owns the render",
  );
  assert.ok(existsSync(flatRoadmapPath(base)), "resumed migration must render the flat-phase ROADMAP");
  assert.equal(
    existsSync(join(base, ".gsd", "milestones.migrating")),
    false,
    "the migrating tree must be cleaned up",
  );
});

test("dry-run reconcile stays read-only and never runs the migration", async (t) => {
  const base = makeBase("gsd-recon-mig-dryrun-");
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  seedDb();
  writeLegacyTree(join(base, ".gsd"));

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(
    existsSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md")),
    true,
    "dry-run must leave the legacy tree untouched",
  );
  assert.equal(existsSync(join(base, ".gsd", "phases")), false, "dry-run must not render phases/");
  assert.equal(needsFlatPhaseMigration(base), true, "migration must remain pending after a dry run");
});
