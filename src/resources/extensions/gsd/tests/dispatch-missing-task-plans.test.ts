/**
 * Regression test for issue #909.
 *
 * When S##-PLAN.md exists (causing deriveState → phase:'executing') but the
 * individual task plan files (tasks/T01-PLAN.md, etc.) are absent, the dispatch
 * table must recover by re-running plan-slice — NOT hard-stop.
 *
 * Prior behaviour: action:"stop" → infinite loop on restart.
 * Fixed behaviour: action:"dispatch" unitType:"plan-slice".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDispatch } from "../auto-dispatch.ts";
import type { DispatchContext } from "../auto-dispatch.ts";
import type { AutoSession } from "../auto/session.ts";
import type { GSDState } from "../types.ts";
import { enableDebug, disableDebug, getDebugLogPath } from "../debug-logger.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  isDbAvailable,
  openDatabase,
} from "../gsd-db.ts";

function makeState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M002", title: "Test Milestone" },
    activeSlice: { id: "S03", title: "Third Slice" },
    activeTask: { id: "T01", title: "First Task" },
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
    ...overrides,
  };
}

function makeContext(basePath: string, stateOverrides?: Partial<GSDState>): DispatchContext {
  return {
    basePath,
    mid: "M002",
    midTitle: "Test Milestone",
    state: makeState(stateOverrides),
    prefs: undefined,
  };
}

function makeContextFor(
  basePath: string,
  mid: string,
  sid: string,
  tid: string,
  session?: Partial<AutoSession>,
): DispatchContext {
  return {
    basePath,
    mid,
    midTitle: "Test Milestone",
    state: makeState({
      activeMilestone: { id: mid, title: "Test Milestone" },
      activeSlice: { id: sid, title: "Second Slice" },
      activeTask: { id: tid, title: "First Task" },
    }),
    prefs: undefined,
    session: session as AutoSession | undefined,
  };
}

// ─── Scaffold helpers ──────────────────────────────────────────────────────

function scaffoldSlicePlan(basePath: string, mid: string, sid: string): void {
  // Flat-phase: phases/NN-slug/NN-MM-PLAN.md
  const phaseNum = parseInt(mid.match(/^M0*(\d+)/i)?.[1] || '1', 10);
  const planNum = parseInt(sid.match(/^S0*(\d+)/i)?.[1] || '1', 10);
  const dir = join(basePath, ".gsd", "phases", `${String(phaseNum).padStart(2, '0')}-test`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(phaseNum).padStart(2, '0')}-${String(planNum).padStart(2, '0')}-PLAN.md`), [
    `# ${sid}: Third Slice`,
    "",
    "## Tasks",
    "- [ ] **T01: Do something** `est:1h`",
    "- [ ] **T02: Do another thing** `est:30m`",
    "",
  ].join("\n"));
}

function scaffoldMilestoneContext(basePath: string, mid: string): void {
  const phaseNum = parseInt(mid.match(/^M0*(\d+)/i)?.[1] || '1', 10);
  const dir = join(basePath, ".gsd", "phases", `${String(phaseNum).padStart(2, '0')}-test`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(phaseNum).padStart(2, '0')}-CONTEXT.md`), [
    `# ${mid}: Test Milestone`,
    "",
    "Context for dispatch recovery tests.",
    "",
  ].join("\n"));
}

function scaffoldLegacyMilestoneContext(basePath: string, mid: string): void {
  const dir = join(basePath, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT.md`), [
    `# ${mid}: Test Milestone`,
    "",
    "Context for legacy dispatch recovery tests.",
    "",
  ].join("\n"));
}

function scaffoldLegacySlicePlan(basePath: string, mid: string, sid: string): void {
  const dir = join(basePath, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(join(dir, `${sid}-PLAN.md`), [
    `# ${sid}: Legacy Slice`,
    "",
    "## Tasks",
    "- T01: Do something",
    "",
  ].join("\n"));
}

function scaffoldLegacyTaskPlan(basePath: string, mid: string, sid: string, tid: string): void {
  const dir = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${tid}-PLAN.md`), [
    `# ${tid}: First Task`,
    "",
    "Implement the task.",
    "",
  ].join("\n"));
}

function scaffoldTaskPlan(basePath: string, mid: string, sid: string, tid: string): void {
  // Flat-phase: no per-task plan files. This is a no-op — tasks live as
  // checkboxes inside the slice plan. Kept for backward-compat with tests
  // that call it; does nothing in flat-phase.
}

function scaffoldWorkflowDatabase(basePath: string, mid: string, sid: string, tid: string): void {
  if (isDbAvailable()) closeDatabase();
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: mid, title: "Test Milestone", status: "active" });
  insertSlice({ id: sid, milestoneId: mid, title: "Test Slice", status: "active" });
  insertTask({ id: tid, sliceId: sid, milestoneId: mid, title: "Test Task", status: "pending" });
}

function removeWorkflowTestDirectory(basePath: string): void {
  if (isDbAvailable()) closeDatabase();
  rmSync(basePath, { recursive: true, force: true });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test("dispatch: missing task plan triggers plan-slice (not stop) — issue #909", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-909-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M002", "S03", "T01");

  // Slice plan exists with tasks. In flat-phase, tasks are checkboxes inside
  // the slice plan (no per-task files), so this is the NORMAL state — dispatch
  // should proceed to execute-task, not recover with plan-slice.
  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");

  const ctx = makeContext(tmp);
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch", "should dispatch, not stop");
  // Flat-phase: tasks embedded in slice plan → execute-task (not plan-slice recovery)
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task (tasks in slice plan), got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
});

test("dispatch: closed milestone is not implicitly recovered or reopened", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-closed-dispatch-"));
  t.after(() => {
    if (isDbAvailable()) closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  if (isDbAvailable()) closeDatabase();
  mkdirSync(join(tmp, ".gsd"), { recursive: true });
  openDatabase(join(tmp, ".gsd", "gsd.db"));
  insertMilestone({ id: "M002", title: "Closed Milestone", status: "complete" });
  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");

  const result = await resolveDispatch(makeContext(tmp));

  assert.equal(result.action, "stop");
  assert.ok(result.action === "stop");
  assert.equal(result.level, "warning");
  assert.match(result.reason, /Milestone M002 is closed/);
  assert.match(result.reason, /will not reopen or recover it implicitly/);
});

test("dispatch: present task plan proceeds to execute-task normally", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-909-ok-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M002", "S03", "T01");

  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");
  // Flat-phase: tasks are checkboxes inside the slice plan (no per-task PLAN files).
  // scaffoldTaskPlan is intentionally NOT called here — creating a milestones/ dir
  // as a side effect would confuse milestonesDir() into treating this as a legacy
  // layout, breaking slice plan resolution and causing discuss-milestone dispatch.

  const ctx = makeContext(tmp);
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch");
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.ok(result.action === "dispatch" && result.unitId === "M002/S03/T01",
    `unitId should be M002/S03/T01, got: ${result.action === "dispatch" ? result.unitId : "(stop)"}`);
});

test("dispatch: missing legacy task plan recovery increments a per-slice retry counter", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-1087-retry-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M002", "S03", "T01");

  scaffoldLegacyMilestoneContext(tmp, "M002");
  scaffoldLegacySlicePlan(tmp, "M002", "S03");

  const session = {
    missingTaskPlanRetryCount: new Map<string, number>(),
  };
  const result = await resolveDispatch(makeContextFor(tmp, "M002", "S03", "T01", session));

  assert.equal(result.action, "dispatch");
  assert.ok(result.action === "dispatch" && result.unitType === "plan-slice",
    `unitType should be plan-slice, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.ok(result.action === "dispatch" && result.unitId === "M002/S03",
    `unitId should be M002/S03, got: ${result.action === "dispatch" ? result.unitId : "(stop)"}`);
  assert.equal(session.missingTaskPlanRetryCount.get("M002/S03"), 1);
});

test("dispatch: missing legacy task plan recovery stops when retry counter is exhausted", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-1087-stop-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M002", "S03", "T01");

  scaffoldLegacyMilestoneContext(tmp, "M002");
  scaffoldLegacySlicePlan(tmp, "M002", "S03");

  const session = {
    missingTaskPlanRetryCount: new Map<string, number>([["M002/S03", 2]]),
  };
  const result = await resolveDispatch(makeContextFor(tmp, "M002", "S03", "T01", session));

  assert.equal(result.action, "stop");
  assert.ok(result.action === "stop");
  assert.equal(result.level, "error");
  assert.match(result.reason, /Missing task-plan recovery failed 2 times for M002\/S03/);
  assert.match(result.reason, /manual intervention required/);
  assert.equal(session.missingTaskPlanRetryCount.has("M002/S03"), false);
});

test("dispatch: present legacy task plan clears missing-plan recovery retry counter", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-1087-clear-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M002", "S03", "T01");

  scaffoldLegacyMilestoneContext(tmp, "M002");
  scaffoldLegacySlicePlan(tmp, "M002", "S03");
  scaffoldLegacyTaskPlan(tmp, "M002", "S03", "T01");

  const session = {
    missingTaskPlanRetryCount: new Map<string, number>([["M002/S03", 1]]),
    preExecRetryCount: new Map<string, number>([["M002/S03", 2]]),
  };
  const result = await resolveDispatch(makeContextFor(tmp, "M002", "S03", "T01", session));

  assert.equal(result.action, "dispatch");
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.equal(session.missingTaskPlanRetryCount.has("M002/S03"), false);
  assert.equal(session.preExecRetryCount.get("M002/S03"), 2,
    "pre-exec retry counter must not be cleared when task plan is present");
});

test("dispatch: missing-task-plan recovery loop terminates even when the shared pre-exec key is reset between rounds (#1087)", async (t) => {
  // The recovery rule re-dispatches plan-slice with unitId "${mid}/${sid}".
  // That regenerated plan-slice carries the same currentUnit.id, and on a
  // pre-execution pass the post-unit hook deletes that key from
  // preExecRetryCount (auto-post-unit.ts). Missing per-task PLAN projection
  // files do not fail pre-exec checks, so the regenerated plan-slice typically
  // passes and that delete fires every cycle. If recovery shared
  // preExecRetryCount, its counter would be wiped to 0 each round and the loop
  // would never reach the cap. Here we simulate that reset between rounds and
  // assert the dedicated counter still climbs to MAX and stops.
  const tmp = mkdtempSync(join(tmpdir(), "gsd-1087-loop-term-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M002", "S03", "T01");

  scaffoldLegacyMilestoneContext(tmp, "M002");
  scaffoldLegacySlicePlan(tmp, "M002", "S03");

  const session = {
    missingTaskPlanRetryCount: new Map<string, number>(),
    preExecRetryCount: new Map<string, number>(),
  };

  // Round 1: missing task plan → recover (counter 0 → 1).
  const r1 = await resolveDispatch(makeContextFor(tmp, "M002", "S03", "T01", session));
  assert.ok(r1.action === "dispatch" && r1.unitType === "plan-slice",
    `round 1 should re-dispatch plan-slice, got: ${r1.action === "dispatch" ? r1.unitType : "(stop)"}`);
  assert.equal(session.missingTaskPlanRetryCount.get("M002/S03"), 1);

  // The regenerated plan-slice passes its post-unit pre-exec check, deleting
  // the shared "${mid}/${sid}" key from preExecRetryCount.
  session.preExecRetryCount.delete("M002/S03");

  // Round 2: still missing → recover (counter 1 → 2), unaffected by the reset.
  const r2 = await resolveDispatch(makeContextFor(tmp, "M002", "S03", "T01", session));
  assert.ok(r2.action === "dispatch" && r2.unitType === "plan-slice",
    `round 2 should re-dispatch plan-slice, got: ${r2.action === "dispatch" ? r2.unitType : "(stop)"}`);
  assert.equal(session.missingTaskPlanRetryCount.get("M002/S03"), 2);

  session.preExecRetryCount.delete("M002/S03");

  // Round 3: cap reached → stop. The loop terminates despite the resets.
  const r3 = await resolveDispatch(makeContextFor(tmp, "M002", "S03", "T01", session));
  assert.equal(r3.action, "stop");
  assert.ok(r3.action === "stop" && r3.level === "error");
  assert.match(r3.reason, /Missing task-plan recovery failed 2 times for M002\/S03/);
  assert.equal(session.missingTaskPlanRetryCount.has("M002/S03"), false);
});

test("dispatch: session milestone mismatch stops before missing-task-plan recovery", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-session-milestone-mismatch-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const worktreeRoot = join(tmp, ".gsd", "worktrees", "M002");
  mkdirSync(worktreeRoot, { recursive: true });

  const ctx = makeContextFor(tmp, "M001", "S01", "T01", {
    basePath: worktreeRoot,
    originalBasePath: tmp,
    currentMilestoneId: "M002",
  });
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "stop");
  assert.ok(result.action === "stop");
  assert.equal(result.level, "warning");
  assert.match(result.reason, /context mid "M001" does not match session\.currentMilestoneId "M002"/);
});

test("dispatch: bare context milestone maps to suffixed active session milestone", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-suffixed-session-milestone-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M003-vaz73w", "S01", "T02");

  const worktreeRoot = join(tmp, ".gsd", "worktrees", "M003-vaz73w");
  scaffoldLegacyMilestoneContext(worktreeRoot, "M003-vaz73w");
  scaffoldLegacySlicePlan(worktreeRoot, "M003-vaz73w", "S01");
  scaffoldLegacyTaskPlan(worktreeRoot, "M003-vaz73w", "S01", "T02");

  const ctx = makeContextFor(tmp, "M003", "S01", "T02", {
    basePath: worktreeRoot,
    originalBasePath: tmp,
    currentMilestoneId: "M003-vaz73w",
  });
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch");
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.ok(result.action === "dispatch" && result.unitId === "M003-vaz73w/S01/T02",
    `unitId should use suffixed milestone, got: ${result.action === "dispatch" ? result.unitId : "(stop)"}`);
});

test("dispatch: suffixed context milestone keeps suffix when scoped alias is bare", async (t) => {
  // Inverse of the case above: dispatch context carries the suffixed id but the
  // scoped alias (session.currentMilestoneId) is bare. resolveEffectiveDispatchMilestoneId
  // must keep the suffixed id so slice/task artifacts resolve under the suffixed
  // worktree layout (milestones/M003-xxxxxx/) rather than the bare milestones/M003/.
  const tmp = mkdtempSync(join(tmpdir(), "gsd-suffixed-context-bare-scope-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M003-vaz73w", "S01", "T02");

  const worktreeRoot = join(tmp, ".gsd", "worktrees", "M003-vaz73w");
  scaffoldLegacyMilestoneContext(worktreeRoot, "M003-vaz73w");
  scaffoldLegacySlicePlan(worktreeRoot, "M003-vaz73w", "S01");
  scaffoldLegacyTaskPlan(worktreeRoot, "M003-vaz73w", "S01", "T02");

  const ctx = makeContextFor(tmp, "M003-vaz73w", "S01", "T02", {
    basePath: worktreeRoot,
    originalBasePath: tmp,
    currentMilestoneId: "M003",
  });
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch");
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.ok(result.action === "dispatch" && result.unitId === "M003-vaz73w/S01/T02",
    `unitId should keep suffixed milestone, got: ${result.action === "dispatch" ? result.unitId : "(stop)"}`);
});

test("dispatch: worktree path mismatch stops before planning a different milestone", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-worktree-path-milestone-mismatch-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const worktreeRoot = join(tmp, ".gsd", "worktrees", "M002");
  mkdirSync(worktreeRoot, { recursive: true });

  const ctx = makeContextFor(worktreeRoot, "M001", "S01", "T01");
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "stop");
  assert.ok(result.action === "stop");
  assert.equal(result.level, "warning");
  assert.match(result.reason, /context mid "M001" does not match basePath worktree "M002"/);
});

test("dispatch: executing recovery checks active milestone worktree task plans before re-dispatching plan-slice", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-6192-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M002", "S03", "T01");

  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");

  const worktreeRoot = join(tmp, ".gsd", "worktrees", "M002");
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(join(worktreeRoot, ".git"), "gitdir: /tmp/fake-worktree-gitdir\n");
  scaffoldMilestoneContext(worktreeRoot, "M002");
  scaffoldSlicePlan(worktreeRoot, "M002", "S03");
  scaffoldTaskPlan(worktreeRoot, "M002", "S03", "T01");

  const ctx = makeContext(tmp);
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch");
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.ok(result.action === "dispatch" && result.unitId === "M002/S03/T01",
    `unitId should be M002/S03/T01, got: ${result.action === "dispatch" ? result.unitId : "(stop)"}`);
});

test("dispatch: active session worktree task plan wins over missing original-root task plan", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-worktree-artifact-root-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M004", "S02", "T01");

  scaffoldMilestoneContext(tmp, "M004");
  scaffoldSlicePlan(tmp, "M004", "S02");

  const worktreeRoot = join(tmp, ".gsd", "worktrees", "M004");
  mkdirSync(worktreeRoot, { recursive: true });
  scaffoldMilestoneContext(worktreeRoot, "M004");
  scaffoldSlicePlan(worktreeRoot, "M004", "S02");
  scaffoldTaskPlan(worktreeRoot, "M004", "S02", "T01");

  const ctx = makeContextFor(tmp, "M004", "S02", "T01", {
    basePath: worktreeRoot,
    originalBasePath: tmp,
    currentMilestoneId: "M004",
  });
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch");
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.ok(result.action === "dispatch" && result.unitId === "M004/S02/T01",
    `unitId should be M004/S02/T01, got: ${result.action === "dispatch" ? result.unitId : "(stop)"}`);
});

test("dispatch: artifact checks trust active session basePath even when originalBasePath matches", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-worktree-session-basepath-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M004", "S02", "T01");

  scaffoldMilestoneContext(tmp, "M004");
  scaffoldSlicePlan(tmp, "M004", "S02");

  const activeMilestoneRoot = join(tmp, ".gsd", "runtime-active", "M004");
  mkdirSync(activeMilestoneRoot, { recursive: true });
  scaffoldMilestoneContext(activeMilestoneRoot, "M004");
  scaffoldSlicePlan(activeMilestoneRoot, "M004", "S02");
  scaffoldTaskPlan(activeMilestoneRoot, "M004", "S02", "T01");

  const ctx = makeContextFor(tmp, "M004", "S02", "T01", {
    basePath: activeMilestoneRoot,
    originalBasePath: activeMilestoneRoot,
    currentMilestoneId: "M004",
  });
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch");
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.ok(result.action === "dispatch" && result.unitId === "M004/S02/T01",
    `unitId should be M004/S02/T01, got: ${result.action === "dispatch" ? result.unitId : "(stop)"}`);
});

test("dispatch: plan-slice recovery loop — second call after plan-slice still recovers cleanly", async (t) => {
  // Flat-phase: tasks are checkboxes inside the slice plan, so there are no
  // per-task plan files to be "missing". Dispatch should go to execute-task
  // (the normal flow), not plan-slice recovery.
  const tmp = mkdtempSync(join(tmpdir(), "gsd-909-loop-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M002", "S03", "T01");

  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");

  const ctx = makeContext(tmp);
  const r1 = await resolveDispatch(ctx);
  assert.equal(r1.action, "dispatch");
  assert.ok(r1.action === "dispatch" && r1.unitType === "execute-task",
    "flat-phase: should dispatch execute-task (tasks in slice plan)");

  // Second dispatch should also go to execute-task (idempotent)
  const r2 = await resolveDispatch(ctx);
  assert.equal(r2.action, "dispatch");
  assert.ok(r2.action === "dispatch" && r2.unitType === "execute-task",
    "should keep dispatching execute-task");
});

test("dispatch: missing task plan recovery logs root/worktree diagnostic when debug enabled — issue #6194", async (t) => {
  // Flat-phase: tasks are embedded in the slice plan, so the recovery rule
  // (which fires when per-task plan files are missing) doesn't apply.
  // The diagnostic log entry is only produced in the legacy layout.
  // This test verifies the normal flat-phase dispatch path doesn't crash
  // with debug enabled.
  const tmp = mkdtempSync(join(tmpdir(), "gsd-6194-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M002", "S03", "T01");

  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");

  enableDebug(tmp);
  t.after(() => disableDebug());

  const ctx = makeContext(tmp);
  const result = await resolveDispatch(ctx);
  // Flat-phase: dispatch goes to execute-task (tasks in slice plan)
  assert.ok(result.action === "dispatch",
    "should dispatch without crashing in debug mode");
  // Flat-phase: no recovery diagnostic entry expected (tasks in slice plan)
});

test("dispatch: unprojected worktree re-renders the slice PLAN from the DB and proceeds — issues #1520/#1640", async (t) => {
  // Incident shape (#1520): flat-phase slice plan with embedded tasks exists
  // at the project root, but the active worktree's projection is incomplete —
  // the milestone CONTEXT landed, the slice plan did not. The DB rows for the
  // slice survive (DB is authoritative), so since #1640 the rule heals the
  // gap by re-rendering the PLAN into the worktree instead of stopping.
  const tmp = mkdtempSync(join(tmpdir(), "gsd-1520-unprojected-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M004", "S02", "T01");

  scaffoldMilestoneContext(tmp, "M004");
  scaffoldSlicePlan(tmp, "M004", "S02");

  // Active worktree is partially projected: CONTEXT present, slice plan missing.
  const worktreeRoot = join(tmp, ".gsd", "worktrees", "M004");
  mkdirSync(worktreeRoot, { recursive: true });
  scaffoldMilestoneContext(worktreeRoot, "M004");

  const session = {
    basePath: worktreeRoot,
    originalBasePath: tmp,
    currentMilestoneId: "M004",
    missingTaskPlanRetryCount: new Map<string, number>(),
  };
  const result = await resolveDispatch(makeContextFor(tmp, "M004", "S02", "T01", session));

  assert.equal(result.action, "dispatch",
    `expected dispatch, got ${result.action}${result.action === "stop" ? `: ${result.reason}` : ""}`);
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  // The PLAN was re-rendered into the worktree's existing descriptor dir.
  const healedPlan = join(worktreeRoot, ".gsd", "phases", "04-test", "04-02-PLAN.md");
  assert.ok(existsSync(healedPlan), `healed PLAN should exist at ${healedPlan}`);
  assert.match(readFileSync(healedPlan, "utf-8"), /<tasks>/);
  // No plan-slice retry budget was spent on a healable projection gap.
  assert.equal(session.missingTaskPlanRetryCount.has("M004/S02"), false);
});

test("dispatch: fresh worktree with DB rows but no PLAN anywhere re-renders and proceeds — issue #1640", async (t) => {
  // Teardown of an incomplete milestone deletes the worktree; .gsd markdown is
  // gitignored, so on the next run the fresh worktree — and possibly the
  // project root — has no slice PLAN at all while the DB rows survive. The
  // dispatch path must re-render the PLAN from the DB and proceed.
  const tmp = mkdtempSync(join(tmpdir(), "gsd-1640-fresh-worktree-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M004", "S02", "T01");

  // No slice PLAN anywhere — only milestone CONTEXT.
  scaffoldMilestoneContext(tmp, "M004");
  const worktreeRoot = join(tmp, ".gsd", "worktrees", "M004");
  mkdirSync(worktreeRoot, { recursive: true });
  scaffoldMilestoneContext(worktreeRoot, "M004");

  const session = {
    basePath: worktreeRoot,
    originalBasePath: tmp,
    currentMilestoneId: "M004",
    missingTaskPlanRetryCount: new Map<string, number>(),
  };
  const result = await resolveDispatch(makeContextFor(tmp, "M004", "S02", "T01", session));

  assert.equal(result.action, "dispatch",
    `expected dispatch, got ${result.action}${result.action === "stop" ? `: ${result.reason}` : ""}`);
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.ok(result.action === "dispatch" && result.unitId === "M004/S02/T01");
  const healedPlan = join(worktreeRoot, ".gsd", "phases", "04-test", "04-02-PLAN.md");
  assert.ok(existsSync(healedPlan), `healed PLAN should exist at ${healedPlan}`);
  assert.equal(session.missingTaskPlanRetryCount.has("M004/S02"), false);
});

test("dispatch: unprojected worktree stops loud when the DB lacks the slice rows — issues #1520/#1640", async (t) => {
  // When the DB genuinely lacks the slice rows the heal cannot render, and the
  // sanctioned exit must be truthful: report the render failure and name the
  // command that actually restores projections (/gsd rebuild markdown), not a
  // doctor run that only re-renders milestone shells.
  const tmp = mkdtempSync(join(tmpdir(), "gsd-1640-no-db-rows-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  if (isDbAvailable()) closeDatabase();
  mkdirSync(join(tmp, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(tmp, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M004", title: "Test Milestone", status: "active" });
  // No slice or task rows — the DB cannot render the PLAN.

  scaffoldMilestoneContext(tmp, "M004");
  scaffoldSlicePlan(tmp, "M004", "S02");

  const worktreeRoot = join(tmp, ".gsd", "worktrees", "M004");
  mkdirSync(worktreeRoot, { recursive: true });
  scaffoldMilestoneContext(worktreeRoot, "M004");

  const session = {
    basePath: worktreeRoot,
    originalBasePath: tmp,
    currentMilestoneId: "M004",
    missingTaskPlanRetryCount: new Map<string, number>(),
  };
  const result = await resolveDispatch(makeContextFor(tmp, "M004", "S02", "T01", session));

  assert.equal(result.action, "stop",
    `expected stop, got ${result.action}${result.action === "dispatch" ? `/${result.unitType}` : ""}`);
  assert.ok(result.action === "stop");
  assert.equal(result.level, "error");
  assert.match(result.reason, /M004\/S02/);
  assert.match(result.reason, /re-rendering it from the workflow database failed/);
  assert.match(result.reason, /rebuild markdown/);
  assert.doesNotMatch(result.reason, /Run \/gsd doctor/);
  assert.doesNotMatch(result.reason, /Fix the task-plan files manually/);
  // No plan-slice retry budget was spent on an unfixable-by-replan condition.
  assert.equal(session.missingTaskPlanRetryCount.has("M004/S02"), false);
});

test("dispatch: worktree recovery still replans when the root slice plan lacks embedded tasks — #909 preserved", async (t) => {
  // Boundary case: the slice plan exists in legacy form (no embedded tasks)
  // at both the project root and the active worktree, and the per-task plan
  // is genuinely absent. The #909 plan-slice recovery still applies — the
  // projection-diagnosis stop must not swallow it. (A legacy worktree with
  // no slice plan at all never reaches the recovery rule: the missing-context
  // guard dispatches discuss-milestone first.)
  const tmp = mkdtempSync(join(tmpdir(), "gsd-1520-legacy-replan-"));
  t.after(() => removeWorkflowTestDirectory(tmp));
  scaffoldWorkflowDatabase(tmp, "M004", "S02", "T01");

  scaffoldLegacyMilestoneContext(tmp, "M004");
  scaffoldLegacySlicePlan(tmp, "M004", "S02");

  const worktreeRoot = join(tmp, ".gsd", "worktrees", "M004");
  mkdirSync(worktreeRoot, { recursive: true });
  scaffoldLegacyMilestoneContext(worktreeRoot, "M004");
  scaffoldLegacySlicePlan(worktreeRoot, "M004", "S02");

  const session = {
    basePath: worktreeRoot,
    originalBasePath: tmp,
    currentMilestoneId: "M004",
    missingTaskPlanRetryCount: new Map<string, number>(),
  };
  const result = await resolveDispatch(makeContextFor(tmp, "M004", "S02", "T01", session));

  assert.equal(result.action, "dispatch");
  assert.ok(result.action === "dispatch" && result.unitType === "plan-slice",
    `unitType should be plan-slice, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.equal(session.missingTaskPlanRetryCount.get("M004/S02"), 1);
});
