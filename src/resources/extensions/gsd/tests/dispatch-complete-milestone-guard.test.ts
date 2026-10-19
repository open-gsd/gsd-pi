// Project/App: gsd-pi
// File Purpose: Regression tests for complete-milestone dispatch guards.

/**
 * dispatch-complete-milestone-guard.test.ts — #4324
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { DISPATCH_RULES, resolveDispatch, type DispatchContext } from "../auto-dispatch.ts";
import { AutoSession } from "../auto/session.ts";
import { releaseExhaustedUnits, spendUnitBudget } from "../db/unit-dispatch-budgets.ts";
import { claimTestDispatch } from "./helpers/unit-dispatch.ts";
import { seedLifecycles } from "./helpers/authority-cutover.ts";
import {
  closeDatabase,
  insertAssessment,
  insertGateRow,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { handleValidateMilestone } from "../tools/validate-milestone.ts";
import { handleCompleteMilestone } from "../tools/complete-milestone.ts";
import {
  evaluateCompleteMilestoneDispatch,
  evaluateGuardedCompleteMilestoneDispatch,
} from "../milestone-closeout.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-complete-dispatch-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  writeFileSync(join(base, ".gitignore"), ".gsd/\n");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "ROADMAP.md"), "# M001\n\n## Slices\n\n- [x] **S01**: Done\n");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "SUMMARY.md"), "# Summary\n");
  writeFileSync(join(base, "implementation.txt"), "done\n");
  return base;
}

function initGitRepo(base: string): void {
  execFileSync("git", ["init"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: base, stdio: "ignore" });
}

/**
 * Canonical complete-milestone dispatch fixture: adopted milestone with a
 * closed slice and a recorded passing canonical validation, in a git
 * repository so the closeout gate can match the tested source revision.
 */
function makeCanonicalBase(key: string): string {
  const base = makeBase();
  initGitRepo(base);
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Done", status: "complete" });
  seedLifecycles(key, [
    { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready" },
    { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed" },
  ]);
  return base;
}

async function recordPassingValidation(base: string, key: string): Promise<void> {
  const result = await handleValidateMilestone({
    milestoneId: "M001",
    verdict: "pass",
    remediationRound: 0,
    successCriteriaChecklist: "- [x] Complete",
    sliceDeliveryAudit: "Delivered",
    crossSliceIntegration: "Passed",
    requirementCoverage: "Covered",
    verdictRationale: "Everything passes.",
  }, base, {
    invocation: {
      idempotencyKey: key,
      sourceTransport: "internal",
      actorType: "agent",
    },
  });
  assert.ok(!("error" in result), `canonical passing validation should be recorded: ${JSON.stringify(result)}`);
}

async function recordFailingValidation(base: string, key: string): Promise<void> {
  const result = await handleValidateMilestone({
    milestoneId: "M001",
    verdict: "needs-attention",
    remediationRound: 0,
    successCriteriaChecklist: "- [ ] Complete",
    sliceDeliveryAudit: "S01 UAT failed",
    crossSliceIntegration: "Passed",
    requirementCoverage: "Covered",
    verdictRationale: "S01 UAT failed; remediation accepted.",
  }, base, {
    invocation: {
      idempotencyKey: key,
      sourceTransport: "internal",
      actorType: "agent",
    },
  });
  assert.ok(!("error" in result), `canonical failing validation should be recorded: ${JSON.stringify(result)}`);
}

function gitOutput(base: string, args: string[]): string {
  return execFileSync("git", args, { cwd: base, encoding: "utf-8" });
}

function buildDispatchCtx(basePath: string): DispatchContext {
  return {
    basePath,
    mid: "M001",
    midTitle: "Milestone One",
    state: {
      activeMilestone: { id: "M001", title: "Milestone One" },
      activeSlice: null,
      activeTask: null,
      phase: "completing-milestone",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [{ id: "M001", title: "Milestone One", status: "active" }],
      requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      progress: { milestones: { done: 0, total: 1 } },
    },
    prefs: undefined,
  };
}

describe("completing-milestone dispatch guard (#4324)", () => {
  let base = "";
  const rule = DISPATCH_RULES.find((candidate) => candidate.name === "completing-milestone → complete-milestone");
  assert.ok(rule, "complete-milestone dispatch rule should exist");

  afterEach(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    if (base) rmSync(base, { recursive: true, force: true });
    base = "";
  });

  test("skips complete-milestone dispatch when the DB milestone is already closed", async () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "complete" });

    const result = await rule.match(buildDispatchCtx(base));

    assert.equal(result?.action, "skip");
  });

  test("dispatches complete-milestone when the canonical closeout is ready", async () => {
    base = makeCanonicalBase("dispatch-guard/ready");
    await recordPassingValidation(base, "dispatch-guard/ready/validate");

    const result = await rule.match(buildDispatchCtx(base));

    assert.equal(result?.action, "dispatch");
    assert.equal(result?.unitType, "complete-milestone");
    assert.equal(result?.unitId, "M001");
  });

  test("resolveDispatch stops an exhausted complete-milestone after a restart, until a reopen releases it (#5662)", async () => {
    base = makeCanonicalBase("dispatch-guard/exhausted");
    await recordPassingValidation(base, "dispatch-guard/exhausted/validate");
    // The unit ran in auto-mode and used all its artifact verification
    // retries: its dispatch row holds the `exhausted` mark.
    claimTestDispatch(base, { milestoneId: "M001", unitType: "complete-milestone", unitId: "M001" });
    spendUnitBudget(new Map(), { unitType: "complete-milestone", unitId: "M001", kind: "exhausted" });

    // A new session holds nothing about the unit, as after a restart.
    const ctx = { ...buildDispatchCtx(base), session: new AutoSession() };
    const stopped = await resolveDispatch(ctx);

    assert.equal(stopped.action, "stop");
    assert.match(stopped.action === "stop" ? stopped.reason : "", /used all its verification retries/i);

    releaseExhaustedUnits("M001");
    const released = await resolveDispatch(ctx);

    assert.equal(released.action, "dispatch");
    assert.equal(released.action === "dispatch" ? released.unitType : null, "complete-milestone");
  });

  test("dispatches complete-milestone when only .gsd/ files exist in git history (#5097)", async () => {
    base = makeCanonicalBase("dispatch-guard/planning-only");
    rmSync(join(base, "implementation.txt"), { force: true });
    await recordPassingValidation(base, "dispatch-guard/planning-only/validate");

    const result = await rule.match(buildDispatchCtx(base));

    assert.equal(result?.action, "dispatch");
    assert.equal(result?.unitType, "complete-milestone");
    assert.equal(result?.unitId, "M001");
  });

  test("commits pending closeout changes before complete-milestone dispatch (#6132)", async () => {
    base = makeCanonicalBase("dispatch-guard/commit");
    // The dirty tracked file is part of the tree the validation proves; the
    // preflight commit then captures exactly that content.
    writeFileSync(join(base, "implementation.txt"), "dirty\n");
    await recordPassingValidation(base, "dispatch-guard/commit/validate");

    const result = await rule.match(buildDispatchCtx(base));

    assert.equal(result?.action, "dispatch");
    assert.equal(result?.unitType, "complete-milestone");
    assert.equal(gitOutput(base, ["status", "--porcelain"]), "");
    assert.match(gitOutput(base, ["log", "-1", "--pretty=%B"]), /auto-commit after complete-milestone-preflight/);
  });

  test("blocks complete-milestone dispatch when unresolved Git conflicts remain (#6132)", async () => {
    base = makeBase();
    initGitRepo(base);
    writeFileSync(join(base, "implementation.txt"), "stashed change\n");
    execFileSync("git", ["stash", "push", "-m", "conflicting closeout"], { cwd: base, stdio: "ignore" });
    writeFileSync(join(base, "implementation.txt"), "committed change\n");
    execFileSync("git", ["add", "implementation.txt"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "change implementation"], { cwd: base, stdio: "ignore" });
    try {
      execFileSync("git", ["stash", "apply", "stash@{0}"], { cwd: base, stdio: "ignore" });
    } catch {
      // Expected conflict state.
    }

    const result = await rule.match(buildDispatchCtx(base));

    assert.equal(result?.action, "stop");
    assert.equal(result?.level, "error");
    assert.match(result?.reason ?? "", /unresolved Git conflicts detected/i);
    assert.match(gitOutput(base, ["status", "--porcelain"]), /^UU implementation\.txt/m);
  });

  test("blocks complete-milestone dispatch when UAT verdict is non-PASS and uat_dispatch is enabled (#6132)", async () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "Done", status: "complete" });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-ASSESSMENT.md"),
      "---\nverdict: fail\n---\n\nUAT failed.\n",
    );

    const ctx = buildDispatchCtx(base);
    ctx.prefs = { uat_dispatch: true } as DispatchContext["prefs"];
    const result = await rule.match(ctx);

    assert.equal(result?.action, "stop");
    assert.match(result?.reason ?? "", /manual UAT sign-off \(PASS\) is required/i);
  });

  test("blocks complete-milestone dispatch when UAT verdict is missing and uat_dispatch is enabled (#6132)", async () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "Done", status: "complete" });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-ASSESSMENT.md"),
      "# UAT\n\nNo verdict yet.\n",
    );

    const ctx = buildDispatchCtx(base);
    ctx.prefs = { uat_dispatch: true } as DispatchContext["prefs"];
    const result = await rule.match(ctx);

    assert.equal(result?.action, "stop");
    assert.match(result?.reason ?? "", /manual UAT sign-off \(PASS\) is required/i);
  });

  // ── #2770: a historical UAT FAIL covered by the accepted validation ──

  const REMEDIATION_FAIL_RECORDED_AT = "2020-01-01T00:00:00.000Z";

  /** Record a run-uat verdict row, as gsd_uat_result_save does. */
  function recordRunUatVerdict(sliceId: string, status: string, createdAt: string): void {
    insertAssessment({
      path: `.gsd/milestones/M001/slices/${sliceId}/${sliceId}-ASSESSMENT.md`,
      milestoneId: "M001",
      sliceId,
      status,
      scope: "run-uat",
      fullContent: `verdict: ${status.toUpperCase()}`,
      createdAt,
    });
  }

  /**
   * Canonical closeout fixture for the #2770 remediation sequence: S01 and the
   * S02 remediation slice are both completed and closed. The tests record the
   * S01 UAT verdict and the validation receipt themselves, because their
   * ordering against each other is the behavior under test.
   */
  function makeRemediationBase(key: string): string {
    const base = makeCanonicalBase(key);
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "SUMMARY.md"), "# Summary\n");
    insertSlice({ milestoneId: "M001", id: "S02", title: "Remediation", status: "complete" });
    seedLifecycles(`${key}/s02`, [
      { itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "completed" },
    ]);
    recordRunUatVerdict("S02", "pass", REMEDIATION_FAIL_RECORDED_AT);
    return base;
  }

  test("proceeds to complete-milestone when a historical UAT FAIL predates the accepted validation receipt (#2770)", async () => {
    base = makeRemediationBase("dispatch-guard/remediation-covered");
    recordRunUatVerdict("S01", "fail", REMEDIATION_FAIL_RECORDED_AT);
    await recordPassingValidation(base, "dispatch-guard/remediation-covered/validate");

    const ctx = buildDispatchCtx(base);
    ctx.prefs = { uat_dispatch: true } as DispatchContext["prefs"];
    const result = await rule.match(ctx);

    assert.equal(result?.action, "dispatch");
    assert.equal(result?.unitType, "complete-milestone");
  });

  test("still blocks a UAT FAIL when no validation receipt exists (#2770)", async () => {
    base = makeRemediationBase("dispatch-guard/remediation-uncovered");
    recordRunUatVerdict("S01", "fail", REMEDIATION_FAIL_RECORDED_AT);

    const ctx = buildDispatchCtx(base);
    ctx.prefs = { uat_dispatch: true } as DispatchContext["prefs"];
    const result = await rule.match(ctx);

    assert.equal(result?.action, "stop");
    assert.match(
      result?.reason ?? "",
      /Cannot complete milestone M001: UAT verdict for S01 is "fail"\. Manual UAT sign-off \(PASS\) is required before milestone closure\./,
    );
  });

  test("still blocks a UAT FAIL recorded after the validation receipt (#2770)", async () => {
    base = makeRemediationBase("dispatch-guard/remediation-newer-fail");
    await recordPassingValidation(base, "dispatch-guard/remediation-newer-fail/validate");
    // A fresh FAIL after validation accepted the remediation is not covered
    // by that acceptance (+60s guards against receipt/verdict clock ties).
    recordRunUatVerdict("S01", "fail", new Date(Date.now() + 60_000).toISOString());

    const ctx = buildDispatchCtx(base);
    ctx.prefs = { uat_dispatch: true } as DispatchContext["prefs"];
    const result = await rule.match(ctx);

    assert.equal(result?.action, "stop");
    assert.match(
      result?.reason ?? "",
      /Cannot complete milestone M001: UAT verdict for S01 is "fail"\. Manual UAT sign-off \(PASS\) is required before milestone closure\./,
    );
  });

  test("still blocks a UAT FAIL with an unparseable verdict timestamp (#2770)", async () => {
    base = makeRemediationBase("dispatch-guard/remediation-unparseable");
    recordRunUatVerdict("S01", "fail", " ");
    await recordPassingValidation(base, "dispatch-guard/remediation-unparseable/validate");

    const ctx = buildDispatchCtx(base);
    ctx.prefs = { uat_dispatch: true } as DispatchContext["prefs"];
    const result = await rule.match(ctx);

    assert.equal(result?.action, "stop");
    assert.match(
      result?.reason ?? "",
      /Cannot complete milestone M001: UAT verdict for S01 is "fail"\. Manual UAT sign-off \(PASS\) is required before milestone closure\./,
    );
  });

  test("preview with an assumed waiver matches the real waive-and-proceed turn (#2770)", async () => {
    // skip_milestone_validation preview: the waiver write is suppressed, so the
    // UAT gate must treat the would-be waiver as recorded, exactly like the
    // closeout consistency gate does — otherwise preview stops where the real
    // turn dispatches.
    base = makeRemediationBase("dispatch-guard/remediation-preview-waiver");
    recordRunUatVerdict("S01", "fail", REMEDIATION_FAIL_RECORDED_AT);
    await recordFailingValidation(base, "dispatch-guard/remediation-preview-waiver/validate");

    const ctx = buildDispatchCtx(base);
    ctx.prefs = { uat_dispatch: true } as DispatchContext["prefs"];
    const preview = await evaluateGuardedCompleteMilestoneDispatch(
      ctx,
      { assumeValidationWaived: true },
    );
    assert.equal(preview.action, "dispatch");
    assert.equal(preview.action === "dispatch" ? preview.unitType : null, "complete-milestone");

    // Without the assumption the historical FAIL still blocks (the real state
    // has no waiver yet).
    const realPreWaiver = await evaluateCompleteMilestoneDispatch(ctx);
    assert.equal(realPreWaiver?.action, "stop");
    assert.match(
      realPreWaiver?.action === "stop" ? realPreWaiver.reason : "",
      /Manual UAT sign-off \(PASS\) is required/i,
    );
  });
});

describe("complete phase dispatch guard (#5683)", () => {
  let base = "";
  const rule = DISPATCH_RULES.find((candidate) => candidate.name === "complete → stop");
  assert.ok(rule, "complete phase terminal rule should exist");

  afterEach(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    if (base) rmSync(base, { recursive: true, force: true });
    base = "";
  });

  test("dispatches complete-milestone when derived state is complete but DB milestone is still open", async () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "in_progress" });

    const ctx = buildDispatchCtx(base);
    ctx.state.phase = "complete";

    const result = await rule.match(ctx);

    assert.equal(result?.action, "dispatch");
    assert.equal(result?.unitType, "complete-milestone");
    assert.equal(result?.unitId, "M001");
  });

  test("stops when derived state is complete and DB milestone is closed", async () => {
    base = makeCanonicalBase("dispatch-guard/terminal");
    await recordPassingValidation(base, "dispatch-guard/terminal/validate");
    // The real canonical completion: only milestone.complete may close the
    // milestone lifecycle.
    const completion = await handleCompleteMilestone({
      milestoneId: "M001",
      title: "Milestone One",
      oneLiner: "Done",
      narrative: "Done",
      verificationPassed: true,
    }, base, {
      idempotencyKey: "dispatch-guard/terminal/complete",
      sourceTransport: "internal",
      actorType: "agent",
    });
    assert.ok(!("error" in completion), JSON.stringify(completion));

    const ctx = buildDispatchCtx(base);
    ctx.state.phase = "complete";

    const result = await rule.match(ctx);

    assert.equal(result?.action, "stop");
    assert.equal(result?.reason, "All milestones complete.");
  });

  test("blocks terminal stop when pending gates have no closeout evidence", async () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "complete" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "Done", status: "complete" });
    insertGateRow({
      milestoneId: "M001",
      sliceId: "S01",
      gateId: "Q3",
      scope: "slice",
      status: "pending",
    });

    const ctx = buildDispatchCtx(base);
    ctx.state.phase = "complete";

    const result = await rule.match(ctx);

    assert.equal(result?.action, "stop");
    assert.equal(result?.level, "warning");
    assert.match(result?.reason ?? "", /closeout-consistency-blocked/);
    assert.match(result?.reason ?? "", /latest milestone validation is "absent"/);
    assert.match(result?.reason ?? "", /\/gsd dispatch validate M001/);
  });
});

describe("complete milestone context recovery guard (#5831)", () => {
  let base = "";
  const prePlanningRule = DISPATCH_RULES.find(
    (candidate) => candidate.name === "pre-planning (no context) → discuss-milestone",
  );
  assert.ok(prePlanningRule, "pre-planning missing-context rule should exist");

  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
    base = "";
  });

  test("does not discuss a complete pre-planning milestone with no CONTEXT file", async () => {
    base = makeBase();
    const ctx = buildDispatchCtx(base);
    ctx.state.registry = [{ id: "M001", title: "Milestone One", status: "complete" }];
    ctx.state.phase = "pre-planning";

    const result = await prePlanningRule.match(ctx);

    assert.equal(result, null);
  });
});
