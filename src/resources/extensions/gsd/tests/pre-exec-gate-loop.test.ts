/**
 * pre-exec-gate-loop.test.ts — Regression tests for #4551.
 *
 * Verifies that when a pre-execution gate fails on a plan-slice unit:
 *   1. The blocking findings and a verdict excerpt are stored on the dispatch
 *      row of the plan (ADR-048), so they survive a kill.
 *   2. The `planning → plan-slice` dispatch rule reads them from the database
 *      and injects a "Fix these specific issues" section into the prompt.
 *   3. The next dispatch of the slice has no findings of its own, so stale
 *      context does not bleed into a later plan-slice run.
 *   4. When the failure belongs to a *different* unit ID, the dispatch rule
 *      does NOT inject the stale context into the prompt.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AutoSession } from "../auto/session.ts";
import { spendUnitBudget } from "../db/unit-dispatch-budgets.ts";
import { readPreExecFailure, recordPreExecFailure } from "../db/unit-dispatch-pre-exec-failure.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { markCanceled, recordDispatchClaim } from "../db/unit-dispatches.ts";
import { resolveDispatch } from "../auto-dispatch.ts";
import type { DispatchContext } from "../auto-dispatch.ts";
import { buildPlanSlicePrompt } from "../auto-prompts.ts";
import { formatPreExecutionRetryContext } from "../auto-post-unit.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
} from "../gsd-db.ts";
import { deriveStateFromDb } from "../state.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { invalidateAllCaches } from "../cache.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-4551-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function seedPlanningState(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Core Slice",
    status: "pending",
    risk: "medium",
    depends: [],
    demo: "demo",
    sequence: 1,
    isSketch: false,
  });
  // Write minimal ROADMAP so state derivation doesn't error
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# Roadmap\n",
  );
}

interface TestWorker {
  workerId: string;
  leaseToken: number;
}

function registerWorker(base: string): TestWorker {
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  if (!lease.ok) throw new Error("expected test lease");
  return { workerId, leaseToken: lease.token };
}

/** Claim a plan-slice dispatch of the slice, so its findings have a real dispatch row. */
function claimPlanSlice(worker: TestWorker, sliceId: string): number {
  const claim = recordDispatchClaim({
    traceId: `trace-${sliceId}`,
    workerId: worker.workerId,
    milestoneLeaseToken: worker.leaseToken,
    milestoneId: "M001",
    sliceId,
    unitType: "plan-slice",
    unitId: `M001/${sliceId}`,
  });
  if (!claim.ok) throw new Error(`expected test claim: ${claim.error}`);
  return claim.dispatchId;
}

function cleanup(base: string, originalCwd: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { process.chdir(originalCwd); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("pre-exec retry context leads with the real findings and only adds Verify guidance for unsafe Verify commands", () => {
  const artifactCheck = {
    category: "file" as const,
    target: ".gsd/phases/01-answer-fixture/01-03-ASSESSMENT.md",
    passed: false,
    message: "Task T03 lists '.gsd/phases/01-answer-fixture/01-03-ASSESSMENT.md' in expectedOutput — GSD planning artifacts are written by workflow tools (e.g. gsd_summary_save), never by tasks; remove it",
    blocking: true,
  };
  const base = {
    unitType: "plan-slice",
    unitId: "M001/S04",
    verdictExcerpt: "status=fail; 1 blocking issue detected",
    evidencePath: ".gsd/phases/01-answer-fixture/S04-PRE-EXEC-VERIFY.json",
  };

  const artifactContext = formatPreExecutionRetryContext({ ...base, checks: [artifactCheck] });
  // The liveness backstop excerpts the first 300 chars of this text as the
  // wedge's sanctioned exit, so the real blocker must come first.
  assert.ok(artifactContext.slice(0, 300).includes("01-03-ASSESSMENT.md' in expectedOutput"));
  assert.ok(!artifactContext.includes("Verify commands must not use shell pipes"));
  assert.ok(!artifactContext.includes("known runnable command"));
  assert.ok(!artifactContext.includes("reads as prose"));

  const verifyContext = formatPreExecutionRetryContext({
    ...base,
    checks: [{
      category: "tool",
      target: "T01 Verify",
      passed: false,
      message: "Unsafe or non-runnable Verify command: cat a | grep b (pipes are not allowed)",
      blocking: true,
    }],
  });
  assert.ok(verifyContext.includes("Unsafe or non-runnable Verify command"));
  assert.ok(verifyContext.includes("Verify commands must not use shell pipes"));
});

test("pre-exec retry guidance for non-runnable rejections states the known-prefix and prose-marker rules", () => {
  // Mirrors the real message format from pre-execution-checks.ts:
  // `Unsafe or non-runnable Verify command: ${command} (${validation.reason})`.
  // A prose-pattern statement is rejected with the "does not look like a
  // runnable command" reason (#2290) — the guidance must state the two rules
  // behind that reason so the repaired plan stops repeating the pattern.
  const context = formatPreExecutionRetryContext({
    unitType: "plan-slice",
    unitId: "M001/S04",
    verdictExcerpt: "status=fail; 1 blocking issue detected",
    evidencePath: ".gsd/phases/01-answer-fixture/S04-PRE-EXEC-VERIFY.json",
    checks: [{
      category: "tool",
      target: "T01 Verify",
      passed: false,
      blocking: true,
      message: "Unsafe or non-runnable Verify command: Verify the scaffold output contains the summary (does not look like a runnable command)",
    }],
  });

  const reason = "does not look like a runnable command";
  assert.ok(context.includes(reason), "finding must be echoed");
  // The finding line already contains the reason once; the guidance must
  // restate it so the planner can connect message → rule.
  assert.ok(
    context.split(reason).length >= 3,
    "guidance must restate the rejection reason, not just echo the finding",
  );
  // Known-command-prefix rule, with the illustrative-list, path-prefix, and
  // short-statement fallback qualifications.
  assert.ok(
    context.includes("known runnable command such as"),
    "guidance must state the known-command-prefix rule",
  );
  assert.ok(context.includes("illustrative, not exhaustive"));
  assert.ok(
    context.includes("same prose checks as a known command"),
    "path prefix must not be presented as a prose-check escape",
  );
  assert.ok(context.includes("may pass without a known prefix"));
  // Prose-marker rule: marker matching runs on unquoted text only (#2290),
  // quoted words still count toward the word minimum; the plain-word tail
  // rule ignores trailing punctuation but any shell-like token breaks it.
  assert.ok(
    context.includes("reads as prose"),
    "guidance must state the prose-marker rule",
  );
  assert.ok(
    context.includes("unquoted word"),
    "guidance must state that marker words only count when unquoted",
  );
  assert.ok(context.includes("never match markers"));
  assert.ok(context.includes("count toward the word minimum"));
  assert.ok(context.includes("trailing punctuation ignored"));
  assert.ok(context.includes("breaks the run"));
});

test("#4551: buildPlanSlicePrompt injects fix section when priorPreExecFailure provided", async (t) => {
  const originalCwd = process.cwd();
  const base = makeTempBase();
  t.after(() => cleanup(base, originalCwd));

  seedPlanningState(base);
  process.chdir(base);
  _clearGsdRootCache();
  invalidateAllCaches();

  const prompt = await buildPlanSlicePrompt(
    "M001", "Test Milestone", "S01", "Core Slice", base,
    undefined,
    {
      priorPreExecFailure: {
        blockingFindings: [
          "[file] src/utils/helper.ts: file not found",
          "[package] nonexistent-pkg: package not found on npm",
        ],
        verdictExcerpt: "status=fail; 2 blocking issues detected",
      },
    },
  );

  assert.ok(prompt.includes("## Context Mode"), "plan-slice should include standalone Context Mode guidance");
  assert.ok(prompt.includes("planning lane"), "plan-slice should render the planning lane");

  assert.ok(
    prompt.includes("Fix these specific issues from the prior pre-exec check"),
    "prompt must contain the fix section heading",
  );
  assert.ok(
    prompt.includes("src/utils/helper.ts: file not found"),
    "prompt must include the specific file finding",
  );
  assert.ok(
    prompt.includes("nonexistent-pkg: package not found on npm"),
    "prompt must include the specific package finding",
  );
  assert.ok(
    prompt.includes("status=fail; 2 blocking issues detected"),
    "prompt must include the verdict excerpt",
  );
});

test("#4551: buildPlanSlicePrompt with no priorPreExecFailure does NOT include fix section", async (t) => {
  const originalCwd = process.cwd();
  const base = makeTempBase();
  t.after(() => cleanup(base, originalCwd));

  seedPlanningState(base);
  process.chdir(base);
  _clearGsdRootCache();
  invalidateAllCaches();

  const prompt = await buildPlanSlicePrompt(
    "M001", "Test Milestone", "S01", "Core Slice", base,
    undefined,
    { /* no priorPreExecFailure */ },
  );

  assert.ok(
    !prompt.includes("Fix these specific issues from the prior pre-exec check"),
    "prompt must NOT include the fix section when no failure context is given",
  );
});

test("#4551: after a kill, the dispatch rule gives the planner the stored findings for one re-plan", async (t) => {
  const originalCwd = process.cwd();
  const base = makeTempBase();
  t.after(() => cleanup(base, originalCwd));

  seedPlanningState(base);
  // Write a RESEARCH file so the dispatch rule skips research-slice and reaches
  // plan-slice (which is the phase we're testing).
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-RESEARCH.md"),
    "# Research\n",
  );
  process.chdir(base);
  _clearGsdRootCache();
  invalidateAllCaches();

  const state = await deriveStateFromDb(base);
  assert.equal(state.phase, "planning", "state must be in planning phase");

  // The plan of the first dispatch failed the check at the retry cap. The used
  // budget must not keep the findings from the planner.
  const worker = registerWorker(base);
  const failedDispatchId = claimPlanSlice(worker, "S01");
  const preExecBudget = { unitType: "plan-slice", unitId: "M001/S01", kind: "pre-exec" } as const;
  spendUnitBudget(new Map(), preExecBudget);
  spendUnitBudget(new Map(), preExecBudget);
  assert.equal(
    recordPreExecFailure("M001/S01", {
      blockingFindings: ["[file] src/missing.ts: file not found"],
      verdictExcerpt: "status=fail; 1 blocking issue detected",
    }),
    true,
  );

  // The cap pause stops orchestration, which cancels the active dispatch row.
  markCanceled(failedDispatchId, "pause");

  // Kill: the session is gone and the database file is opened again.
  closeDatabase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  const session = new AutoSession();
  session.basePath = base;
  session.active = true;

  const ctx: DispatchContext = {
    basePath: base,
    mid: "M001",
    midTitle: "Test Milestone",
    state,
    prefs: { phases: { reassess_after_slice: false, skip_research: true } } as any,
    session,
  };

  // The rule only reads. A second evaluation before the claim (a recheck, a
  // preview) must give the same prompt.
  for (const evaluation of ["first", "second"]) {
    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "dispatch", "must dispatch a unit");
    if (result.action !== "dispatch") throw new Error("unreachable");
    assert.equal(result.unitType, "plan-slice", "must be a plan-slice unit");
    assert.ok(
      result.prompt.includes("Fix these specific issues from the prior pre-exec check"),
      `${evaluation} evaluation: dispatched prompt must include the fix section`,
    );
    assert.ok(
      result.prompt.includes("src/missing.ts: file not found"),
      `${evaluation} evaluation: dispatched prompt must include the specific blocking finding`,
    );
  }

  // The re-plan is dispatched. Its findings are its own: the old ones must not
  // reach a later plan of the slice.
  claimPlanSlice(worker, "S01");
  const afterReplan = await resolveDispatch(ctx);
  assert.equal(afterReplan.action, "dispatch");
  if (afterReplan.action !== "dispatch") throw new Error("unreachable");
  assert.ok(
    !afterReplan.prompt.includes("Fix these specific issues from the prior pre-exec check"),
    "the findings must reach one re-plan only",
  );
});

test("#4551: dispatch rule does NOT inject stale failure for a different slice", async (t) => {
  const originalCwd = process.cwd();
  const base = makeTempBase();
  t.after(() => cleanup(base, originalCwd));

  seedPlanningState(base);
  // Write a RESEARCH file so dispatch reaches plan-slice, making the assertion
  // about the prompt meaningful (we can check it's a plan-slice prompt without
  // the fix section rather than a research-slice prompt without it).
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-RESEARCH.md"),
    "# Research\n",
  );
  process.chdir(base);
  _clearGsdRootCache();
  invalidateAllCaches();

  const state = await deriveStateFromDb(base);

  const session = new AutoSession();
  session.basePath = base;
  session.active = true;
  // Failure belongs to a different slice (S02), not the active one (S01)
  claimPlanSlice(registerWorker(base), "S02");
  const otherSliceFailure = {
    blockingFindings: ["[file] src/other.ts: file not found"],
    verdictExcerpt: "status=fail; 1 blocking issue detected",
  };
  assert.equal(recordPreExecFailure("M001/S02", otherSliceFailure), true);

  const ctx: DispatchContext = {
    basePath: base,
    mid: "M001",
    midTitle: "Test Milestone",
    state,
    prefs: { phases: { reassess_after_slice: false, skip_research: true } } as any,
    session,
  };

  const result = await resolveDispatch(ctx);
  assert.equal(result.action, "dispatch");
  if (result.action !== "dispatch") throw new Error("unreachable");

  // The stale fix section must NOT appear
  assert.ok(
    !result.prompt.includes("Fix these specific issues from the prior pre-exec check"),
    "prompt must NOT include fix section for a mismatched unit ID",
  );
  assert.ok(
    !result.prompt.includes("src/other.ts"),
    "prompt must NOT include findings from a different slice",
  );

  // The findings stay with their own slice.
  assert.deepEqual(readPreExecFailure("M001/S02"), otherSliceFailure);
});

test("pre-exec findings of a slice with no dispatch row have no place to go", (t) => {
  const originalCwd = process.cwd();
  const base = makeTempBase();
  t.after(() => cleanup(base, originalCwd));
  seedPlanningState(base);

  assert.equal(
    recordPreExecFailure("M001/S01", { blockingFindings: ["[file] a.ts"], verdictExcerpt: "status=fail" }),
    false,
    "the caller must learn that nothing was stored",
  );
  assert.equal(readPreExecFailure("M001/S01"), null);
});
