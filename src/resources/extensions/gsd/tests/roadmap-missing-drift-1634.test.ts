// Project/App: gsd-pi
// File Purpose: Regression tests for #1634 (map #1651): a milestone persisted
// to the DB whose ROADMAP.md render failed (or was deleted) must never stay a
// permanent orphan — the roadmap-missing drift handler re-renders the
// projection from the DB and reconciliation converges, doctor agrees the issue
// is fixable, and the reconciliation cap error names its repair command.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeDatabase,
  getMilestone,
  getMilestoneSlices,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { persistMilestonePlan } from "../milestone-planning-persistence.ts";
import { internalPlanningInvocation } from "../planning-invocation.ts";
import { targetMilestoneFile } from "../paths.ts";
import {
  reconcileBeforeDispatch,
  ReconciliationFailedError,
} from "../state-reconciliation.ts";
import { detectRoadmapMissingDrift } from "../state-reconciliation/drift/roadmap.ts";
import { checkGsdStateHealth } from "../doctor-state-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import type { GSDState } from "../types.ts";

function makeState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Milestone" },
    activeSlice: null,
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "Plan milestone",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } },
    ...overrides,
  };
}

afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
});

function makeBase(prefix: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  // openDatabase requires the .gsd dir; the phase dir is deliberately NOT
  // created — the missing-roadmap repair must create it itself.
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedPlannedMilestone(): void {
  insertMilestone({
    id: "M001",
    title: "Test",
    status: "active",
    planning: { vision: "Verify roadmap-missing drift heals orphans." },
  });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Foundation",
    status: "pending",
    risk: "medium",
    depends: [],
    demo: "S01 demo.",
    sequence: 1,
  });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Plan S01", status: "pending" });
}

function planParams() {
  return {
    milestoneId: "M001",
    title: "Test",
    vision: "Verify render failure does not orphan the milestone.",
    slices: [
      {
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
      },
    ],
  };
}

test("#1634 (b): missing ROADMAP.md with DB planning rows emits roadmap-missing drift, repair re-renders and converges", async (t) => {
  const base = makeBase("gsd-1634-missing-");
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  seedPlannedMilestone();

  // No ROADMAP.md anywhere on disk — the milestone dir does not even exist.
  const records = detectRoadmapMissingDrift(makeState(), { basePath: base, state: makeState() });
  assert.equal(records.length, 1, "missing roadmap must emit exactly one drift record");
  assert.deepEqual(records[0], { kind: "roadmap-missing", milestoneId: "M001" });

  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });
  assert.equal(result.ok, true);
  assert.ok(
    result.repaired.some((d) => d.kind === "roadmap-missing"),
    "repaired list should include the roadmap-missing drift",
  );
  const roadmapPath = targetMilestoneFile(base, "M001", "ROADMAP", "Test");
  assert.ok(existsSync(roadmapPath), "repair must re-render ROADMAP.md from the DB");
  assert.match(readFileSync(roadmapPath, "utf-8"), /# M001: Test/);

  // Convergence proof: a second pass detects nothing and repairs nothing.
  const second = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });
  assert.equal(second.ok, true);
  assert.equal(
    second.repaired.filter((d) => d.kind === "roadmap-missing" || d.kind === "roadmap-divergence").length,
    0,
    "second pass must be clean — repair converged",
  );
});

test("#1634/#2063: unplanned bare milestone rows and closed milestones do not emit roadmap-missing drift", async (t) => {
  const base = makeBase("gsd-1634-unplanned-");
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  // Bare row from gsd_milestone_generate_id: zero slices, empty vision — the
  // renderer refuses to write a stub for it (#852), so flagging it would make
  // the drift persist to the cap.
  insertMilestone({ id: "M002", title: "", status: "queued" });
  // Completed milestone: /gsd cleanup archives its phase dir; re-rendering
  // would fight the archival.
  insertMilestone({
    id: "M003",
    title: "Done",
    status: "complete",
    planning: { vision: "Already shipped." },
  });
  // Cancelled milestone: imported/externally-written terminal rows must stay
  // out of reconciliation even when vision would otherwise make them renderable.
  insertMilestone({
    id: "M004",
    title: "Cancelled",
    status: "cancelled",
    planning: { vision: "No longer planned." },
  });
  insertMilestone({ id: "M005", title: "Cancelled placeholder", status: "cancelled" });

  const records = detectRoadmapMissingDrift(makeState(), { basePath: base, state: makeState() });
  assert.equal(records.length, 0, "neither bare nor closed milestones may be flagged");
});

test("#1634 (a): persistMilestonePlan with a failing render keeps the DB plan and heals on the next drift pass", async (t) => {
  const base = makeBase("gsd-1634-persist-");
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));

  // Block the render target: creating the ROADMAP path as a directory makes
  // the projection write fail (EISDIR) after the DB commit.
  const roadmapPath = targetMilestoneFile(base, "M001", "ROADMAP", "Test");
  mkdirSync(roadmapPath, { recursive: true });

  const result = await persistMilestonePlan(planParams(), base, internalPlanningInvocation());
  assert.ok("error" in result, "render failure must surface as an error");
  assert.match(result.error, /render failed:/);
  assert.match(
    result.error,
    /drift reconciliation|\/gsd sync/,
    "the error must name the self-heal route instead of a dead end",
  );

  // The DB plan is committed — DB is the authority, not the projection.
  assert.ok(getMilestone("M001"), "milestone row must survive the render failure");
  assert.equal(getMilestoneSlices("M001").length, 1, "slice rows must survive the render failure");

  // Unblock the path; the next reconciliation pass heals the orphan.
  rmSync(roadmapPath, { recursive: true, force: true });
  const reconciled = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {},
    deriveState: async () => makeState(),
  });
  assert.equal(reconciled.ok, true);
  assert.ok(
    reconciled.repaired.some((d) => d.kind === "roadmap-missing" && d.milestoneId === "M001"),
    "the orphaned milestone must be repaired by the roadmap-missing handler",
  );
  assert.ok(existsSync(roadmapPath), "ROADMAP.md must exist after the drift pass");
  assert.match(readFileSync(roadmapPath, "utf-8"), /# M001: Test/);
});

test("#1634 (c): the reconciliation cap error names its repair command", () => {
  const err = new ReconciliationFailedError({
    persistentDrift: [{ kind: "roadmap-divergence", milestoneId: "M001" }],
  });
  assert.match(err.message, /Reconciliation drift persisted after cap=2 passes: roadmap-divergence/);
  assert.match(err.message, /\/gsd sync/, "the cap error must name a sanctioned repair exit");
});

test("#1634: doctor re-renders a missing ROADMAP from the DB when fixing, and reports it fixable otherwise", async (t) => {
  const base = makeBase("gsd-1634-doctor-");
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  seedPlannedMilestone();
  // Worktree teardown removed the projection directory as well as ROADMAP.md.

  // Report-only run: the issue is now fixable and names the repair.
  const issues: DoctorIssue[] = [];
  await checkGsdStateHealth(base, issues, [], { fix: false, shouldFix: () => false });
  const reported = issues.find((i) => i.code === "missing_roadmap");
  assert.ok(reported, "doctor must still report the missing roadmap");
  assert.equal(reported.fixable, true, "a DB-backed roadmap is projection drift and therefore fixable");
  assert.match(reported.message, /\/gsd sync|doctor --fix/);

  // Fix run: doctor applies the same repair as the drift handler.
  const fixIssues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  await checkGsdStateHealth(base, fixIssues, fixesApplied, { fix: true, shouldFix: () => true });
  assert.equal(
    fixIssues.filter((i) => i.code === "missing_roadmap").length,
    0,
    "the issue must not be reported once fixed",
  );
  assert.ok(
    fixesApplied.some((f) => f.includes("re-rendered missing ROADMAP.md for M001")),
    "the fix must be recorded",
  );
  assert.ok(
    existsSync(targetMilestoneFile(base, "M001", "ROADMAP", "Test")),
    "doctor --fix must have rendered the ROADMAP from the DB",
  );
});
