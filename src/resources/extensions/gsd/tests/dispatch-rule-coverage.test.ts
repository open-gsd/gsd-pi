// gsd-pi / dispatch rule coverage canary test
//
// Iterates DISPATCH_RULES in order against representative GSDState stubs and
// asserts that the first matching rule has the expected name and unitType
// (mirroring auto-dispatch's first-match-wins semantics). The goal is a
// canary: if a future PR adds a new rule in the wrong position and steals
// a match from an existing one, this test fails.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DISPATCH_RULES } from "../auto-dispatch.ts";
import type { DispatchContext, DispatchAction } from "../auto-dispatch.ts";
import type { GSDState } from "../types.ts";
import { createWorkspace, scopeMilestone } from "../workspace.ts";
import { closeDatabase, insertArtifact, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.ts";
import { storeUnitRetry } from "../db/unit-dispatch-retries.ts";
import { claimTestDispatch } from "./helpers/unit-dispatch.ts";

// ─── State helpers ────────────────────────────────────────────────────────

function makeState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Test Milestone" },
    activeSlice: null,
    activeTask: null,
    phase: "pre-planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
    ...overrides,
  };
}

function makeCtx(basePath: string, state: GSDState, mid = "M001"): DispatchContext {
  return {
    basePath,
    mid,
    midTitle: "Test Milestone",
    state,
    prefs: undefined,
  };
}

// ─── Database scaffold helpers ────────────────────────────────────────────

/**
 * Open an in-memory DB with milestone `mid` and the given saved artifact rows.
 * Dispatch reads these rows; a CONTEXT or RESEARCH file decides nothing.
 */
function seedMilestoneArtifacts(
  t: { after: (fn: () => void) => void },
  mid: string,
  artifactTypes: string[],
): void {
  openDatabase(":memory:");
  t.after(() => closeDatabase());
  insertMilestone({ id: mid, title: "Test Milestone", status: "active" });
  for (const type of artifactTypes) {
    insertArtifact({
      path: `milestones/${mid}/${mid}-${type}.md`,
      artifact_type: type,
      milestone_id: mid,
      slice_id: null,
      task_id: null,
      full_content: `# ${type}\n`,
    });
  }
}

// ─── Disk scaffold helpers ────────────────────────────────────────────────

function writeMilestoneFile(basePath: string, mid: string, suffix: string, content = "stub\n"): void {
  const dir = join(basePath, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-${suffix}.md`), content);
}

function writeSliceFile(
  basePath: string,
  mid: string,
  sid: string,
  suffix: string,
  content = "stub\n",
): void {
  const dir = join(basePath, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-${suffix}.md`), content);
}

function writeTaskPlan(basePath: string, mid: string, sid: string, tid: string): void {
  const dir = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${tid}-PLAN.md`), `# ${tid}\n\n## Steps\n- [ ] Step\n`);
}

// ─── Rule evaluation ──────────────────────────────────────────────────────

interface MatchEntry {
  ruleName: string;
  result: DispatchAction;
}

// First-match-wins semantics: walks DISPATCH_RULES in order and stops at the
// first non-null result. This mirrors the production resolver and is the
// canary against rule reordering or shadowing.
async function findFirstMatch(ctx: DispatchContext): Promise<MatchEntry | null> {
  for (const rule of DISPATCH_RULES) {
    const result = await rule.match(ctx);
    if (result) return { ruleName: rule.name, result };
  }
  return null;
}

function assertMatch(
  match: MatchEntry | null,
  expected: { ruleName: string; action: DispatchAction["action"]; unitType?: string },
  scenario: string,
): void {
  assert.ok(match, `${scenario}: no rule matched`);
  assert.equal(match.ruleName, expected.ruleName, `${scenario}: matched rule mismatch`);
  assert.equal(match.result.action, expected.action, `${scenario}: action mismatch`);
  if (expected.action === "dispatch" && expected.unitType) {
    assert.ok(
      match.result.action === "dispatch" && match.result.unitType === expected.unitType,
      `${scenario}: unitType mismatch (got ${
        match.result.action === "dispatch" ? match.result.unitType : match.result.action
      })`,
    );
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

test("dispatch-rule-coverage: escalating-task → stop (info)", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-esc-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ctx = makeCtx(
    tmp,
    makeState({
      phase: "escalating-task",
      activeSlice: { id: "S01", title: "Slice" },
      nextAction: "Resolve escalation X",
    }),
  );
  const match = await findFirstMatch(ctx);
  assertMatch(
    match,
    { ruleName: "escalating-task → pause-for-escalation", action: "stop" },
    "escalating-task",
  );
});

test("dispatch-rule-coverage: pre-planning, no CONTEXT → discuss-milestone", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-disc-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // Bare milestone dir, no CONTEXT/RESEARCH/ROADMAP files.
  mkdirSync(join(tmp, ".gsd", "milestones", "M001"), { recursive: true });

  const ctx = makeCtx(tmp, makeState({ phase: "pre-planning" }));
  const match = await findFirstMatch(ctx);
  assertMatch(
    match,
    {
      ruleName: "pre-planning (no context) → discuss-milestone",
      action: "dispatch",
      unitType: "discuss-milestone",
    },
    "pre-planning no context",
  );
});

test("dispatch-rule-coverage: pre-planning from a worktree base sees the saved CONTEXT row", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-wt-context-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  seedMilestoneArtifacts(t, "M001", ["CONTEXT"]);

  // The worktree has no CONTEXT file at all: the saved row is the discussion.
  const worktree = join(tmp, ".gsd", "worktrees", "M001");
  mkdirSync(join(worktree, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(
    join(worktree, ".gsd", "milestones", "M001", "M001-META.json"),
    '{"branch":"milestone/M001"}',
  );

  const rule = DISPATCH_RULES.find(
    (candidate) => candidate.name === "pre-planning (no context) → discuss-milestone",
  );
  assert.ok(rule, "pre-planning missing-context rule should exist");

  const result = await rule.match(makeCtx(worktree, makeState({ phase: "pre-planning" })));
  assert.equal(result, null, "the saved CONTEXT row must prevent a second discuss-milestone dispatch");
});

test("dispatch-rule-coverage: pre-planning with only a CONTEXT file dispatches discuss-milestone", async (t) => {
  // A CONTEXT file with no saved row (in the worktree or at the project root)
  // is not a finished discussion.
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-wt-only-context-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  seedMilestoneArtifacts(t, "M001", []);
  writeMilestoneFile(tmp, "M001", "CONTEXT", "# Context\n");

  const rule = DISPATCH_RULES.find(
    (candidate) => candidate.name === "pre-planning (no context) → discuss-milestone",
  );
  assert.ok(rule, "pre-planning missing-context rule should exist");

  const result = await rule.match(makeCtx(tmp, makeState({ phase: "pre-planning" })));
  assert.equal(result?.action === "dispatch" ? result.unitType : null, "discuss-milestone");
});

test("dispatch-rule-coverage: pre-planning, has CONTEXT, no RESEARCH → research-milestone", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-res-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  seedMilestoneArtifacts(t, "M001", ["CONTEXT"]);

  const ctx = makeCtx(tmp, makeState({ phase: "pre-planning" }));
  const match = await findFirstMatch(ctx);
  assertMatch(
    match,
    {
      ruleName: "pre-planning (no research) → research-milestone",
      action: "dispatch",
      unitType: "research-milestone",
    },
    "pre-planning no research",
  );
});

test("dispatch-rule-coverage: pre-planning, has CONTEXT + RESEARCH → plan-milestone", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-plan-m-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  seedMilestoneArtifacts(t, "M001", ["CONTEXT", "RESEARCH"]);

  const ctx = makeCtx(tmp, makeState({ phase: "pre-planning" }));
  const match = await findFirstMatch(ctx);
  assertMatch(
    match,
    {
      ruleName: "pre-planning (has research) → plan-milestone",
      action: "dispatch",
      unitType: "plan-milestone",
    },
    "pre-planning has research",
  );
});

test("dispatch-rule-coverage: plan-milestone refreshes stale session scope", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-plan-scope-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeMilestoneFile(tmp, "M001", "CONTEXT", "# Prior Milestone Context\n");
  writeMilestoneFile(tmp, "M002", "CONTEXT", "# Current Milestone Context\n");
  writeMilestoneFile(tmp, "M002", "RESEARCH", "# Current Milestone Research\n");

  const rule = DISPATCH_RULES.find(
    (candidate) => candidate.name === "pre-planning (has research) → plan-milestone",
  );
  assert.ok(rule, "plan-milestone rule should exist");

  const ctx = makeCtx(
    tmp,
    makeState({
      phase: "pre-planning",
      activeMilestone: { id: "M002", title: "Current Milestone" },
    }),
    "M002",
  );
  ctx.session = {
    scope: scopeMilestone(createWorkspace(tmp), "M001"),
  } as DispatchContext["session"];

  const result = await rule.match(ctx);
  assert.ok(result?.action === "dispatch");
  assert.match(result.prompt, /Current Milestone Context/);
  assert.doesNotMatch(result.prompt, /Prior Milestone Context/);
  assert.match(result.prompt, /\.gsd\/milestones\/M002\/M002-CONTEXT\.md/);
  assert.doesNotMatch(result.prompt, /\.gsd\/milestones\/M001\/M001-CONTEXT\.md/);
});

test("dispatch-rule-coverage: planning with active slice and skip_research → plan-slice", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-plan-s-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeMilestoneFile(tmp, "M001", "CONTEXT", "# Context\n");
  writeMilestoneFile(tmp, "M001", "ROADMAP", "# Roadmap\n");

  const state = makeState({
    phase: "planning",
    activeSlice: { id: "S01", title: "First Slice" },
  });
  const ctx: DispatchContext = {
    basePath: tmp,
    mid: "M001",
    midTitle: "Test Milestone",
    state,
    // Skip slice research so the parallel/single research rules fall through.
    prefs: { phases: { skip_slice_research: true } } as DispatchContext["prefs"],
  };
  const match = await findFirstMatch(ctx);
  assertMatch(
    match,
    {
      ruleName: "planning → plan-slice",
      action: "dispatch",
      unitType: "plan-slice",
    },
    "planning → plan-slice",
  );
});

test("dispatch-rule-coverage: planning boundary without planner handoff → research-slice", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-planning-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeMilestoneFile(tmp, "M001", "CONTEXT", "# Context\n");
  writeMilestoneFile(tmp, "M001", "ROADMAP", "# Roadmap\n");

  const state = makeState({
    phase: "planning",
    activeSlice: { id: "S01", title: "First Slice" },
    nextAction: "Plan slice S01 (First Slice).",
  });
  const match = await findFirstMatch(makeCtx(tmp, state));
  assertMatch(
    match,
    {
      ruleName: "planning (no research) → research-slice",
      action: "dispatch",
      unitType: "research-slice",
    },
    "planning boundary without planner handoff",
  );
});

test("dispatch-rule-coverage: S01 still researches when only milestone research exists", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-s01-research-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeMilestoneFile(tmp, "M001", "CONTEXT", "# Context\n");
  writeMilestoneFile(tmp, "M001", "ROADMAP", "# Roadmap\n");
  writeMilestoneFile(tmp, "M001", "RESEARCH", "# Milestone Research\n");

  const state = makeState({
    phase: "planning",
    activeSlice: { id: "S01", title: "First Slice" },
    nextAction: "Plan slice S01 (First Slice).",
  });
  const match = await findFirstMatch(makeCtx(tmp, state));
  assertMatch(
    match,
    {
      ruleName: "planning (no research) → research-slice",
      action: "dispatch",
      unitType: "research-slice",
    },
    "S01 missing slice research despite milestone research",
  );
});

test("dispatch-rule-coverage: executing with task plan present → execute-task", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-exec-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeMilestoneFile(tmp, "M001", "CONTEXT", "# Context\n");
  writeSliceFile(tmp, "M001", "S01", "PLAN", "# Plan\n");
  writeTaskPlan(tmp, "M001", "S01", "T01");

  const state = makeState({
    phase: "executing",
    activeSlice: { id: "S01", title: "First Slice" },
    activeTask: { id: "T01", title: "First Task" },
  });
  // Disable reactive dispatch so the parallel batching rule falls through.
  const ctx: DispatchContext = {
    basePath: tmp,
    mid: "M001",
    midTitle: "Test Milestone",
    state,
    prefs: { reactive_execution: { enabled: false } } as DispatchContext["prefs"],
  };
  const match = await findFirstMatch(ctx);
  assertMatch(
    match,
    {
      ruleName: "executing → execute-task",
      action: "dispatch",
      unitType: "execute-task",
    },
    "executing → execute-task",
  );
});

/**
 * A database with a claimed dispatch row for the unit, as a unit that ran in
 * auto-mode has. No AutoSession holds anything about it: the dispatch rules see
 * what a restarted process sees.
 */
function openProjectWithDispatch(
  t: { after(cb: () => void): void },
  basePath: string,
  unitType: string,
  unitId: string,
): void {
  openDatabase(":memory:");
  t.after(() => closeDatabase());
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "First Slice" });
  claimTestDispatch(basePath, { milestoneId: "M001", sliceId: "S01", unitType, unitId });
}

const COMMIT_REPAIR_RETRY = {
  unitId: "M001/S01/T01",
  failureContext: "Git commit failed after task verification. The hook refused the changes.",
  signature: "git-commit:1:the hook refused the changes",
  attempt: 1,
};

for (const { phase, activeTask } of [
  { phase: "executing", activeTask: { id: "T02", title: "Second Task" } },
  { phase: "summarizing", activeTask: null },
] as const) {
  test(`dispatch-rule-coverage: ${phase} with a stored commit repair retry → the closed execute-task`, async (t) => {
    const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-commit-repair-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    writeMilestoneFile(tmp, "M001", "CONTEXT", "# Context\n");
    writeSliceFile(tmp, "M001", "S01", "PLAN", "# Plan\n");
    writeTaskPlan(tmp, "M001", "S01", "T01");
    writeTaskPlan(tmp, "M001", "S01", "T02");
    openProjectWithDispatch(t, tmp, "execute-task", "M001/S01/T01");
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "complete" });
    storeUnitRetry("execute-task", COMMIT_REPAIR_RETRY);

    const match = await findFirstMatch({
      ...makeCtx(tmp, makeState({ phase, activeSlice: { id: "S01", title: "First Slice" }, activeTask })),
      prefs: { reactive_execution: { enabled: false } } as DispatchContext["prefs"],
    });
    assertMatch(
      match,
      { ruleName: "stored retry → execute-task (commit repair)", action: "dispatch", unitType: "execute-task" },
      `${phase} with a stored commit repair retry`,
    );
    assert.equal(
      match?.result.action === "dispatch" ? match.result.unitId : null,
      "M001/S01/T01",
      "state derivation does not select a closed task, so the stored retry must",
    );
  });
}

test("dispatch-rule-coverage: a stored verification retry of the active task does not change the selection", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-task-retry-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeMilestoneFile(tmp, "M001", "CONTEXT", "# Context\n");
  writeSliceFile(tmp, "M001", "S01", "PLAN", "# Plan\n");
  writeTaskPlan(tmp, "M001", "S01", "T01");
  openProjectWithDispatch(t, tmp, "execute-task", "M001/S01/T01");
  storeUnitRetry("execute-task", { unitId: "M001/S01/T01", failureContext: "npm test failed", attempt: 1 });

  const match = await findFirstMatch({
    ...makeCtx(tmp, makeState({
      phase: "executing",
      activeSlice: { id: "S01", title: "First Slice" },
      activeTask: { id: "T01", title: "First Task" },
    })),
    prefs: { reactive_execution: { enabled: false } } as DispatchContext["prefs"],
  });
  assertMatch(
    match,
    { ruleName: "executing → execute-task", action: "dispatch", unitType: "execute-task" },
    "executing with a stored verification retry of the active task",
  );
});

for (const { phase, unitType } of [
  { phase: "executing", unitType: "plan-slice" },
  { phase: "evaluating-gates", unitType: "refine-slice" },
] as const) {
  test(`dispatch-rule-coverage: ${phase} with a stored ${unitType} pre-execution retry → ${unitType}`, async (t) => {
    const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-stored-retry-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    openProjectWithDispatch(t, tmp, unitType, "M001/S01");
    storeUnitRetry(unitType, {
      unitId: "M001/S01",
      failureContext: "the plan failed its check",
      signature: "pre-execution:1",
      attempt: 1,
    });

    const match = await findFirstMatch(makeCtx(
      tmp,
      makeState({
        phase,
        activeSlice: { id: "S01", title: "First Slice" },
        activeTask: { id: "T01", title: "First Task" },
      }),
    ));
    assertMatch(
      match,
      { ruleName: "stored retry → plan-slice / refine-slice", action: "dispatch", unitType },
      `${phase} with a stored ${unitType} retry`,
    );
  });
}

test("dispatch-rule-coverage: a stored artifact retry of the planner does not send an executing slice back", async (t) => {
  // Only a plan that the pre-execution check refused goes back to the planner.
  // An artifact retry is for a planner that saved no plan; a slice in the
  // executing phase has a plan.
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-artifact-retry-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeMilestoneFile(tmp, "M001", "CONTEXT", "# Context\n");
  writeSliceFile(tmp, "M001", "S01", "PLAN", "# Plan\n");
  writeTaskPlan(tmp, "M001", "S01", "T01");
  openProjectWithDispatch(t, tmp, "plan-slice", "M001/S01");
  storeUnitRetry("plan-slice", { unitId: "M001/S01", failureContext: "the plan artifact is missing", attempt: 1 });

  const match = await findFirstMatch({
    ...makeCtx(tmp, makeState({
      phase: "executing",
      activeSlice: { id: "S01", title: "First Slice" },
      activeTask: { id: "T01", title: "First Task" },
    })),
    prefs: { reactive_execution: { enabled: false } } as DispatchContext["prefs"],
  });
  assertMatch(
    match,
    { ruleName: "executing → execute-task", action: "dispatch", unitType: "execute-task" },
    "executing with a stored artifact retry of the planner",
  );
});

test("dispatch-rule-coverage: summarizing → complete-slice", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-sum-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ctx = makeCtx(
    tmp,
    makeState({
      phase: "summarizing",
      activeSlice: { id: "S01", title: "First Slice" },
    }),
  );
  const match = await findFirstMatch(ctx);
  assertMatch(
    match,
    {
      ruleName: "summarizing → complete-slice",
      action: "dispatch",
      unitType: "complete-slice",
    },
    "summarizing → complete-slice",
  );
});

test("dispatch-rule-coverage: complete phase → stop", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-disp-cov-done-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ctx = makeCtx(
    tmp,
    makeState({
      phase: "complete",
      activeMilestone: null,
      lastCompletedMilestone: { id: "M001", title: "Test Milestone" },
    }),
  );
  const match = await findFirstMatch(ctx);
  assertMatch(
    match,
    { ruleName: "complete → stop", action: "stop" },
    "complete → stop",
  );
});

// ─── Ordering canary: every scenario above resolves to exactly one rule ────

test("dispatch-rule-coverage: rule registry has the expected size", () => {
  // Sanity check that complements the per-state assertions: if someone adds a
  // new rule, this number changes — prompting them to add a state stub above.
  // Exact count is a brittle but useful canary; update when adding rules
  // intentionally.
  assert.equal(
    DISPATCH_RULES.length,
    29,
    `DISPATCH_RULES length changed (got ${DISPATCH_RULES.length}). ` +
      "If you added a rule, add a state stub to dispatch-rule-coverage.test.ts " +
      "and update this expected count.",
  );
});

test("dispatch-rule-coverage: Task replan recovery runs before every execution rule", () => {
  const names = DISPATCH_RULES.map((rule) => rule.name);
  const recovery = names.indexOf("executing → replan-task recovery");
  assert.ok(recovery >= 0);
  assert.ok(recovery < names.indexOf("executing → reactive-execute (parallel dispatch)"));
  assert.ok(recovery < names.indexOf("executing → execute-task"));
});

test("dispatch-rule-coverage: no planner handoff rule is registered", () => {
  assert.equal(
    DISPATCH_RULES.some((rule) => /planner/i.test(rule.name)),
    false,
    "planner handoff rule should stay removed from DISPATCH_RULES",
  );
});
