// Project/App: gsd-pi
// File Purpose: Regression tests for #2510: a queued milestone that was never
// planned (no slices, empty vision, no ROADMAP.md) is the normal pre-planning
// state — doctor must not report a blocking non-fixable missing_roadmap for it.
// The roadmap-missing drift handler skips exactly these milestones (renderable
// === false). A recorded plan-milestone-recovery gate (deterministic planning
// failure) must surface as a dedicated planning_blocked issue naming the
// recovery action — independent of ROADMAP presence, because the recovery
// blocker diagnostic itself occupies ROADMAP.md — and only for live milestones
// with zero slices (a persisted plan supersedes the gate).

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeDatabase,
  getPlanMilestoneRecoveryBlock,
  insertGateRun,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { writeBlockerPlaceholder } from "../auto-recovery.ts";
import { checkGsdStateHealth } from "../doctor-state-checks.ts";
import { postUnitPreVerification } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import type { DoctorIssue } from "../doctor-types.ts";

const GSD_EXEC_HARD_BLOCK =
  'HARD BLOCK: Tool Contract failure for unit "plan-milestone" — GSD lifecycle tool "gsd_exec" is not permitted; allowed GSD tools: gsd_milestone_status, gsd_plan_milestone, gsd_plan_slice, gsd_plan_task, gsd_decision_save, gsd_requirement_update.';

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

function seedUnplannedMilestone(id = "M001", status = "queued"): void {
  // Default insert status is "queued"; no planning vision, no slices, no
  // ROADMAP.md anywhere on disk — the never-planned state.
  insertMilestone({ id, title: "Unplanned", status });
}

function seedPlanningRecoveryGate(milestoneId: string): void {
  // Mirrors the gate row writeBlockerPlaceholder records for a deterministic
  // plan-milestone policy rejection.
  const recordedAt = new Date().toISOString();
  insertGateRun({
    traceId: `auto-recovery:${milestoneId}`,
    turnId: `plan-milestone:${milestoneId}:${recordedAt}`,
    gateId: "plan-milestone-recovery",
    gateType: "policy",
    unitType: "plan-milestone",
    unitId: `plan-milestone/${milestoneId}`,
    milestoneId,
    outcome: "manual-attention",
    failureClass: "manual-attention",
    rationale: `Deterministic policy rejection for plan-milestone "${milestoneId}": HARD BLOCK: Tool Contract failure — GSD lifecycle tool "gsd_exec" is not permitted.`,
    findings: "Diagnostic artifact: .gsd/milestones/M001/M001-ROADMAP.md",
    attempt: 1,
    maxAttempts: 1,
    retryable: false,
    evaluatedAt: recordedAt,
  });
}

test("#2510: a queued never-planned milestone without ROADMAP.md is not a doctor error", async (t) => {
  const base = makeBase("gsd-2510-unplanned-");
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  seedUnplannedMilestone();

  const issues: DoctorIssue[] = [];
  await checkGsdStateHealth(base, issues, [], { fix: false, shouldFix: () => false });
  assert.equal(
    issues.filter((i) => i.code === "missing_roadmap").length,
    0,
    "missing ROADMAP on a never-planned milestone must not be reported",
  );
  assert.equal(
    issues.filter((i) => i.code === "planning_blocked").length,
    0,
    "no planning blocker was recorded, so planning_blocked must not be reported",
  );

  // A fix run must not attempt a repair either — there is no DB plan to render.
  const fixIssues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  await checkGsdStateHealth(base, fixIssues, fixesApplied, { fix: true, shouldFix: () => true });
  assert.equal(fixesApplied.length, 0, "doctor --fix must not fabricate a roadmap for an unplanned milestone");
});

test("#2510: a recorded plan-milestone-recovery gate surfaces planning_blocked with the recovery action", async (t) => {
  const base = makeBase("gsd-2510-blocked-");
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  seedUnplannedMilestone();
  seedPlanningRecoveryGate("M001");

  const issues: DoctorIssue[] = [];
  await checkGsdStateHealth(base, issues, [], { fix: false, shouldFix: () => false });
  assert.equal(
    issues.filter((i) => i.code === "missing_roadmap").length,
    0,
    "the failure is planning_blocked, not missing_roadmap",
  );
  const blocked = issues.find((i) => i.code === "planning_blocked");
  assert.ok(blocked, "doctor must report planning_blocked for a recorded recovery gate");
  assert.equal(blocked.severity, "error");
  assert.equal(blocked.fixable, false, "no mechanical fix exists — replanning is the recovery");
  assert.match(blocked.message, /planning failed fail-closed/);
  assert.match(blocked.message, /gsd_exec/, "the gate rationale must carry the deterministic cause");
  assert.match(
    blocked.message,
    /\/gsd dispatch plan-milestone|gsd_plan_milestone/,
    "the message must name a recovery action that works from the blocked state",
  );
});

test("#2510: the real recovery path (blocker sidecar, no ROADMAP.md) surfaces planning_blocked", async (t) => {
  const base = makeBase("gsd-2510-writer-");
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  seedUnplannedMilestone();
  // Content-bearing legacy milestone dir so the blocker artifact path resolves.
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-CONTEXT.md"), "# Context\n", "utf-8");

  // The real deterministic-failure recovery write: the blocker diagnostic is
  // written to a sidecar beside ROADMAP.md and the gate row is recorded.
  const blockerPath = writeBlockerPlaceholder(
    "plan-milestone",
    "M001",
    base,
    "Deterministic policy rejection for plan-milestone M001: HARD BLOCK — gsd_exec is not permitted.",
  );
  assert.ok(blockerPath, "the placeholder write must succeed with a resolvable milestone dir");
  assert.match(blockerPath, /M001-ROADMAP-RECOVERY-BLOCKER\.md$/, "plan-milestone blockers are written to a sidecar");
  assert.equal(
    existsSync(join(milestoneDir, "M001-ROADMAP.md")),
    false,
    "the blocker must not occupy the ROADMAP projection",
  );

  // Doctor must report the planning gate, not a missing roadmap.
  const issues: DoctorIssue[] = [];
  await checkGsdStateHealth(base, issues, [], { fix: false, shouldFix: () => false });
  assert.equal(
    issues.filter((i) => i.code === "missing_roadmap").length,
    0,
    "planning is blocked, so missing_roadmap does not describe this state",
  );
  assert.ok(
    issues.some((i) => i.code === "planning_blocked"),
    "the recovery gate must surface from the gate row",
  );
});

test("#2510: a closed milestone with a stale recovery gate is not reported as planning_blocked", async (t) => {
  const base = makeBase("gsd-2510-closed-");
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  seedUnplannedMilestone("M001", "complete");
  seedPlanningRecoveryGate("M001");

  const issues: DoctorIssue[] = [];
  await checkGsdStateHealth(base, issues, [], { fix: false, shouldFix: () => false });
  assert.equal(
    issues.filter((i) => i.code === "planning_blocked").length,
    0,
    "historical gates must not reappear on closed milestones",
  );
});

test("#2510: a successful plan supersedes the recovery gate — doctor reports missing_roadmap as fixable again", async (t) => {
  const base = makeBase("gsd-2510-superseded-");
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  seedUnplannedMilestone();
  seedPlanningRecoveryGate("M001");
  // The manual replan persisted real slices — derive only consults the
  // recovery gate while the milestone has zero slices.
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Real first slice",
    status: "pending",
    risk: "medium",
    depends: [],
    demo: "S01 demo.",
    sequence: 1,
  });

  const issues: DoctorIssue[] = [];
  await checkGsdStateHealth(base, issues, [], { fix: false, shouldFix: () => false });
  assert.equal(
    issues.filter((i) => i.code === "planning_blocked").length,
    0,
    "a persisted plan supersedes the recovery gate",
  );
  const missing = issues.find((i) => i.code === "missing_roadmap");
  assert.ok(missing, "with a real plan the missing ROADMAP is projection drift again");
  assert.equal(missing.fixable, true, "the DB plan is renderable, so doctor can re-render it");
});

test("#2510: a filesystem-discovered milestone with no DB row keeps the legacy missing_roadmap diagnostic", async (t) => {
  const base = makeBase("gsd-2510-norow-");
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  // No DB row: the milestone is only known from a legacy dir on disk. The DB
  // authority cannot say whether a plan exists, so the legacy diagnostic (and
  // its fixable:false) must be preserved, not silently suppressed.
  const milestoneDir = join(base, ".gsd", "milestones", "M002");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M002-CONTEXT.md"), "# Context\n", "utf-8");

  const issues: DoctorIssue[] = [];
  await checkGsdStateHealth(base, issues, [], { fix: false, shouldFix: () => false });
  const missing = issues.find((i) => i.code === "missing_roadmap" && i.unitId === "M002");
  assert.ok(missing, "an unknown-plan milestone must keep the missing_roadmap diagnostic");
  assert.equal(missing.fixable, false, "nothing is renderable without the DB row");
});

test("#2510: a vision-only milestone with a recovery gate stays blocked — doctor --fix must not paper over it", async (t) => {
  const base = makeBase("gsd-2510-vision-");
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  // Vision-only: isRoadmapRenderable is true (nonempty vision), but planning
  // still failed and no slices exist. Rendering a roadmap cannot clear the
  // planning block, so --fix must leave the gate unresolved.
  insertMilestone({
    id: "M001",
    title: "Vision only",
    status: "queued",
    planning: { vision: "A milestone that never got past planning." },
  });
  seedPlanningRecoveryGate("M001");

  const fixIssues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  await checkGsdStateHealth(base, fixIssues, fixesApplied, { fix: true, shouldFix: () => true });
  assert.equal(fixesApplied.length, 0, "--fix must not render a roadmap over a live planning gate");
  assert.ok(
    fixIssues.some((i) => i.code === "planning_blocked"),
    "the planning gate must still be reported on the fix run",
  );
});

function planMilestoneSession(base: string): AutoSession {
  const s = new AutoSession();
  s.active = true;
  s.basePath = base;
  s.currentUnit = { type: "plan-milestone", id: "M001", startedAt: Date.now() };
  s.lastToolInvocationError = GSD_EXEC_HARD_BLOCK;
  return s;
}

test("#2510: post-unit reports honestly when the planning blocker cannot be persisted", async (t) => {
  const base = makeBase("gsd-2510-notify-null-");
  t.after(() => cleanup(base));

  // No milestone dir anywhere: resolveExpectedArtifactPath returns null, so
  // neither the blocker diagnostic sidecar nor the recovery gate row can
  // be written. The notification must not claim a blocker was recorded.
  const s = planMilestoneSession(base);
  const notifications: string[] = [];
  const result = await postUnitPreVerification({
    s,
    ctx: { ui: { notify: (message: string) => notifications.push(message) } } as any,
    pi: {} as any,
    buildSnapshotOpts: () => ({}) as any,
    lockBase: () => base,
    stopAuto: async () => {},
    pauseAuto: async () => {},
    updateProgressWidget: () => {},
  } as any);

  assert.equal(result, "dispatched", "the deterministic branch must pause auto-mode");
  assert.ok(
    notifications.some((m) => /could not be persisted/.test(m)),
    `expected the honest persistence-failure notification, got: ${JSON.stringify(notifications)}`,
  );
  assert.equal(
    notifications.some((m) => /recorded blocker/.test(m)),
    false,
    "must not claim a blocker was recorded when the write returned null",
  );
});

test("#2510: post-unit records the planning blocker when persistence succeeds", async (t) => {
  const base = makeBase("gsd-2510-notify-ok-");
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  seedUnplannedMilestone();
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-CONTEXT.md"), "# Context\n", "utf-8");

  const s = planMilestoneSession(base);
  const notifications: string[] = [];
  const result = await postUnitPreVerification({
    s,
    ctx: { ui: { notify: (message: string) => notifications.push(message) } } as any,
    pi: {} as any,
    buildSnapshotOpts: () => ({}) as any,
    lockBase: () => base,
    stopAuto: async () => {},
    pauseAuto: async () => {},
    updateProgressWidget: () => {},
  } as any);

  assert.equal(result, "dispatched", "the deterministic branch must pause auto-mode");
  assert.ok(
    notifications.some((m) => /recorded blocker and paused/.test(m)),
    `expected the blocker-recorded notification, got: ${JSON.stringify(notifications)}`,
  );
  // The gate row makes the block durable: derive gates re-dispatch on it.
  assert.ok(
    getPlanMilestoneRecoveryBlock("M001"),
    "the plan-milestone-recovery gate row must exist after the branch",
  );
  assert.equal(
    existsSync(join(milestoneDir, "M001-ROADMAP-RECOVERY-BLOCKER.md")),
    true,
    "the blocker diagnostic is written to a sidecar",
  );
  assert.equal(
    existsSync(join(milestoneDir, "M001-ROADMAP.md")),
    false,
    "the blocker diagnostic must not occupy the ROADMAP projection",
  );
  assert.equal(s.lastToolInvocationError, null, "the invocation error is consumed by the branch");
});
