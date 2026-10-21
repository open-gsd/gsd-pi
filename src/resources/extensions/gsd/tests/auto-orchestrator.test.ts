// Project/App: gsd-pi
// File Purpose: Auto Orchestration module contract and ADR-015 invariant sequence tests.
//
// Phase 2 of #442 collapsed the nine adapter seams into AutoOrchestrator. These
// tests therefore drive the REAL collapsed orchestrator against real temp
// SQLite + git fixtures (fixture builder modelled on
// state-reconciliation-drift.test.ts) and inject dispatch decisions through the
// real unified rule registry (setRegistry) rather than mock adapters. Decision
// logic is asserted on observable advance() outcomes and journal events instead
// of an internal calls[] array. Dispatch-decision parity (formerly the
// createWiredDispatchAdapter tests) is asserted against the exported pure
// decideOrchestratorDispatch helper.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _setPreserveProjectionChangesFnForTests,
  classifyAutoAdvanceFailure,
  createAutoOrchestrator,
  decideOrchestratorDispatch,
  resolveLiveOrchestratorBasePath,
} from "../auto/orchestrator.js";
import type { OrchestratorContext } from "../auto/orchestrator.js";
import type { AutoOrchestrationModule, AutoSessionContext } from "../auto/contracts.js";
import type { GSDState } from "../types.js";
import { resolveDispatch, type DispatchContext } from "../auto-dispatch.js";
import { RuleRegistry, setRegistry, resetRegistry } from "../rule-registry.js";
import type { UnifiedRule } from "../rule-types.js";
import { supportsStructuredQuestions } from "../workflow-mcp.js";
import {
  closeDatabase,
  insertArtifact,
  insertAssessment,
  insertGateRow,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.js";
import { AutoSession } from "../auto/session.js";
import { markWorkerCrashed, registerAutoWorker } from "../db/auto-workers.js";
import { claimMilestoneLease, forceReleaseLeasesForWorker, getMilestoneLease, releaseMilestoneLease } from "../db/milestone-leases.js";
import { recordDispatchClaim } from "../db/unit-dispatches.js";
import { claimTaskAttempt, settleTaskAttempt } from "../task-execution-domain-operation.js";
import { recordFailureAndSelectRecovery, resumeTaskRecovery } from "../task-recovery-domain-operation.js";
import { internalExecutionInvocation } from "../execution-invocation.js";
import { normalizeRealPath, resolveMilestoneFile } from "../paths.js";
import { acquireSessionLock, releaseSessionLock } from "../session-lock.js";
import { queryJournal } from "../journal.js";
import { invalidateAllCaches } from "../cache.js";
import { invalidateStateCache } from "../state.js";
import {
  COMPLETED_NO_ADVANCE_GUARD_ID,
  getOpenWedge,
} from "../auto-liveness-backstop.js";
import { renderRoadmapFromDb } from "../markdown-renderer.js";
import {
  clearInFlightTools,
  getInFlightToolCount,
  hasInteractiveToolInFlight,
  markToolStart,
} from "../auto-tool-tracking.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builder
//
// Builds a real, isolated project: a git repo (so the pre-dispatch health gate
// and merge-state reconciliation have something real to probe), a SQLite DB
// seeded with one active milestone/slice/task, and the matching ROADMAP/PLAN
// markdown projection. A real session lock is acquired so the orchestrator's
// ensureLockOwnership passes. A fresh AutoSession is wired to the base path. A
// dispatch rule is installed in the real unified registry so resolveDispatch
// yields a deterministic decision — this is the only "injection", and it is the
// same public seam (setRegistry) the dispatch engine already exposes.
// ─────────────────────────────────────────────────────────────────────────────

type DispatchRuleResult =
  | { action: "dispatch"; unitType: string; unitId: string; prompt: string; pauseAfterDispatch?: boolean }
  | { action: "stop"; reason: string; level: "info" | "warning" | "error" }
  | { action: "skip"; matchedRule?: string };

interface FixtureOptions {
  /** When provided, the rule returns this result. Defaults to dispatching M001/S01/T01. */
  dispatch?: () => DispatchRuleResult | Promise<DispatchRuleResult>;
  /** Rule name (becomes the dispatch `reason`/`matchedRule`). */
  ruleName?: string;
  /** Skip seeding a ready task (used for the "no remaining units" / complete scenarios). */
  noTask?: boolean;
  /** Mark the seeded milestone complete (drives the completion → stopped path). */
  complete?: boolean;
}

interface Fixture {
  base: string;
  session: AutoSession;
  ctx: OrchestratorContext;
  orchestrator: AutoOrchestrationModule;
  /** Names emitted to the journal by the orchestrator (data.name), in order. */
  journalNames(): string[];
  cleanup(): void;
}

const DEFAULT_DISPATCH: DispatchRuleResult = {
  action: "dispatch",
  unitType: "execute-task",
  unitId: "M001/S01/T01",
  prompt: "fixture-prompt",
};

function gitInit(base: string): void {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, ".gitkeep"), "");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: base, stdio: "ignore" });
}

function makeFixture(opts: FixtureOptions = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "gsd-orchestrator-"));
  gitInit(base);

  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  mkdirSync(join(sliceDir, "tasks"), { recursive: true });

  invalidateAllCaches();
  invalidateStateCache();
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: opts.complete ? "complete" : "active" });
  if (opts.complete) {
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice",
      status: "complete",
      risk: "low",
      depends: [],
      demo: "",
      sequence: 1,
    });
  } else if (!opts.noTask) {
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active", risk: "low", depends: [], demo: "", sequence: 1 });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "active" });
  }

  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Milestone",
      "",
      "**Vision:** Fixture milestone",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Slice** `risk:low` `depends:[]`",
      "",
    ].join("\n"),
  );
  if (!opts.noTask && !opts.complete) {
    writeFileSync(
      join(sliceDir, "S01-PLAN.md"),
      [
        "# S01: Slice",
        "",
        "**Goal:** Fixture goal",
        "**Demo:** Fixture demo",
        "",
        "## Must-Haves",
        "",
        "- Everything works",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: Task** `est:1h`",
        "",
      ].join("\n"),
    );
  }

  acquireSessionLock(base);

  const session = new AutoSession();
  session.basePath = base;
  session.originalBasePath = base;
  session.currentMilestoneId = "M001";
  session.resourceVersionOnStart = null;
  session.workerId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });

  const ctx: OrchestratorContext = {
    ctx: { model: {}, modelRegistry: { getAll: () => [], getAvailable: () => [] }, ui: { notify() {} } } as never,
    pi: { getActiveTools: () => [] } as never,
    dispatchBasePath: base,
    runtimeBasePath: base,
    session,
  };

  const ruleName = opts.ruleName ?? "fixture-dispatch";
  const decide = opts.dispatch ?? (() => DEFAULT_DISPATCH);
  const rule: UnifiedRule = {
    name: ruleName,
    when: "dispatch",
    evaluation: "first-match",
    where: async () => decide(),
    then: (r: unknown) => r,
  };
  setRegistry(new RuleRegistry([rule]));

  const orchestrator = createAutoOrchestrator(ctx);

  return {
    base,
    session,
    ctx,
    orchestrator,
    journalNames() {
      return queryJournal(base)
        .map((e) => (e.data as Record<string, unknown> | undefined)?.name)
        .filter((n): n is string => typeof n === "string");
    },
    cleanup() {
      resetRegistry();
      try { releaseSessionLock(base); } catch { /* */ }
      try { closeDatabase(); } catch { /* */ }
      try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

/**
 * Seed the canonical Task Attempt that makes `verifyExpectedArtifact` report the
 * fixture task as complete on disk while its DB row stays open — the #1622
 * projection-drift shape that drives stuck recovery down the execute-task
 * (read-only) branch.
 */
function seedSucceededTaskAttempt(base: string): void {
  const workerId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) throw new Error("fixture lease claim failed");
  const claim = recordDispatchClaim({
    traceId: "read-only-recovery",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) throw new Error("fixture dispatch claim failed");
  const attempt = claimTaskAttempt({
    invocation: internalExecutionInvocation("test:orchestrator:read-only-recovery:claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId,
    milestoneLeaseToken: lease.token,
    coordinationDispatchId: claim.dispatchId,
  });
  settleTaskAttempt({
    invocation: internalExecutionInvocation("test:orchestrator:read-only-recovery:settle"),
    attemptId: attempt.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "executor succeeded",
    output: {},
  });
}

function makeState(): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Milestone" },
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

function openDispatchDecisionDatabase(
  t: { after(fn: () => void): void },
  milestones: Array<{ id: string; title: string; status: string }> = [
    { id: "M001", title: "Milestone", status: "active" },
  ],
): void {
  const base = mkdtempSync(join(tmpdir(), "gsd-orchestrator-decision-db-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  closeDatabase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  for (const milestone of milestones) insertMilestone(milestone);
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
}

const SESSION_CONTEXT: AutoSessionContext = { basePath: "/tmp/project", trigger: "manual" };

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle: start / resume / stop
// ─────────────────────────────────────────────────────────────────────────────

test("start() enters running phase without dispatching", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const result = await f.orchestrator.start(SESSION_CONTEXT);

  assert.equal(result.kind, "started");
  const status = f.orchestrator.getStatus();
  assert.equal(status.phase, "running");
  assert.equal(status.activeUnit, undefined);
  assert.ok(f.journalNames().includes("start"));
  assert.ok(!f.journalNames().includes("advance"));
});

test("resume() enters running phase without dispatching", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const result = await f.orchestrator.resume();

  assert.equal(result.kind, "resumed");
  assert.equal(f.orchestrator.getStatus().phase, "running");
  assert.ok(!f.journalNames().includes("advance"));
});

test("transitionCount increases across lifecycle transitions", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const before = f.orchestrator.getStatus().transitionCount;
  await f.orchestrator.start(SESSION_CONTEXT);
  const afterStart = f.orchestrator.getStatus().transitionCount;
  await f.orchestrator.stop("done");
  const afterStop = f.orchestrator.getStatus().transitionCount;

  assert.ok(afterStart > before);
  assert.ok(afterStop > afterStart);
});

test("stop() transitions to stopped and journals stop", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const result = await f.orchestrator.stop("user-request");

  assert.equal(result.kind, "stopped");
  assert.equal(f.orchestrator.getStatus().phase, "stopped");
  assert.ok(f.journalNames().includes("stop"));
});

// ─────────────────────────────────────────────────────────────────────────────
// advance(): happy path + ADR-015 invariant sequence
// ─────────────────────────────────────────────────────────────────────────────

test("advance() dispatches the resolved unit and journals advance", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "advanced");
  if (result.kind !== "advanced") return;
  assert.deepEqual(result.unit, { unitType: "execute-task", unitId: "M001/S01/T01" });
  assert.equal(f.orchestrator.getStatus().phase, "running");
  // Journal records the advance AFTER the invariant gates (lock, health,
  // reconcile, dispatch, tool-contract, worktree) — i.e. no advance-blocked.
  const names = f.journalNames();
  assert.ok(names.includes("advance"));
  assert.ok(!names.includes("advance-blocked"));
});

test("advance() preserves an external projection edit without blocking valid work", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());
  const rendered = await renderRoadmapFromDb(f.base, "M001");
  assert.ok("roadmapPath" in rendered);
  const externalEdit = Buffer.from("# External roadmap evidence\n");
  writeFileSync(rendered.roadmapPath, externalEdit);

  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "advanced");
  if (result.kind !== "advanced") return;
  assert.deepEqual(result.unit, { unitType: "execute-task", unitId: "M001/S01/T01" });
  const currentRoadmapPath = resolveMilestoneFile(f.base, "M001", "ROADMAP");
  assert.ok(currentRoadmapPath);
  assert.match(readFileSync(currentRoadmapPath, "utf-8"), /S01: Slice/);
  const quarantineRoot = join(f.base, ".gsd", "quarantine", "projections");
  const preservedPath = readdirSync(quarantineRoot, { recursive: true })
    .map(String)
    .find((path) => path.endsWith("ROADMAP.md")
      && readFileSync(join(quarantineRoot, path)).equals(externalEdit));
  assert.ok(preservedPath);
  assert.ok(!f.journalNames().includes("advance-blocked"));
});

test("#1677: advance() blocks an unproven open-task SUMMARY instead of filtering its text", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());
  const summaryPath = join(
    f.base,
    ".gsd",
    "milestones",
    "M001",
    "slices",
    "S01",
    "tasks",
    "T01-SUMMARY.md",
  );
  const summary = "# T01 Summary\n\nUnproven failure-path output.\n";
  writeFileSync(summaryPath, summary);
  insertArtifact({
    path: summaryPath,
    artifact_type: "SUMMARY",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    full_content: summary,
  });

  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "blocked");
  if (result.kind !== "blocked") return;
  assert.equal(result.action, "pause");
  assert.match(result.reason, /Artifact\/DB status drift/);
  assert.ok(f.journalNames().includes("advance-blocked"));
  assert.ok(!f.journalNames().includes("advance"));
});

test("advance() sets active unit and is reflected in status", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  await f.orchestrator.advance();

  assert.deepEqual(f.orchestrator.getStatus().activeUnit, {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
  });
});

test("advance() reclaims a released milestone lease before isolated source dispatch", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  writeFileSync(
    join(f.base, ".gsd", "PREFERENCES.md"),
    "---\ngit:\n  isolation: branch\n---\n",
  );
  execFileSync("git", ["checkout", "-b", "milestone/M001"], { cwd: f.base, stdio: "ignore" });

  const priorWorkerId = registerAutoWorker({ projectRootRealpath: f.base });
  const priorLease = claimMilestoneLease(priorWorkerId, "M001");
  assert.equal(priorLease.ok, true);
  if (!priorLease.ok) return;
  assert.equal(releaseMilestoneLease(priorWorkerId, "M001", priorLease.token), true);

  const resumedWorkerId = registerAutoWorker({ projectRootRealpath: f.base });
  f.session.workerId = resumedWorkerId;
  f.session.currentMilestoneId = null;
  f.session.milestoneLeaseToken = null;

  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "advanced", JSON.stringify(result));
  assert.equal(f.session.currentMilestoneId, "M001");
  assert.equal(f.session.milestoneLeaseToken, priorLease.token + 1);
  const lease = getMilestoneLease("M001");
  assert.equal(lease?.worker_id, resumedWorkerId);
  assert.equal(lease?.status, "held");
  assert.ok(f.journalNames().includes("advance"));
  assert.ok(!f.journalNames().includes("advance-blocked"));
});

test("advance() claims the active milestone lease even when session still holds a prior milestone token", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  writeFileSync(
    join(f.base, ".gsd", "PREFERENCES.md"),
    "---\ngit:\n  isolation: branch\n---\n",
  );
  execFileSync("git", ["checkout", "-b", "milestone/M001"], { cwd: f.base, stdio: "ignore" });

  insertMilestone({ id: "M000", title: "Prior", status: "complete" });
  const workerId = registerAutoWorker({ projectRootRealpath: f.base });
  const staleLease = claimMilestoneLease(workerId, "M000");
  assert.equal(staleLease.ok, true);
  if (!staleLease.ok) return;

  f.session.workerId = workerId;
  f.session.currentMilestoneId = "M000";
  f.session.milestoneLeaseToken = staleLease.token;

  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "advanced", JSON.stringify(result));
  assert.equal(f.session.currentMilestoneId, "M001");
  const activeLease = getMilestoneLease("M001");
  assert.equal(activeLease?.worker_id, workerId);
  assert.equal(activeLease?.status, "held");
  assert.equal(f.session.milestoneLeaseToken, activeLease?.fencing_token);
  assert.ok(f.journalNames().includes("advance"));
  assert.ok(!f.journalNames().includes("advance-blocked"));
});

test("advance() blocks source dispatch when an earlier slice is incomplete", async (t) => {
  const f = makeFixture({
    dispatch: () => ({
      action: "dispatch",
      unitType: "execute-task",
      unitId: "M001/S02/T01",
      prompt: "fixture-prompt",
    }),
  });
  t.after(() => f.cleanup());

  insertSlice({
    id: "S02",
    milestoneId: "M001",
    title: "Second slice",
    status: "active",
    risk: "low",
    depends: [],
    demo: "",
    sequence: 2,
  });
  insertTask({
    id: "T01",
    sliceId: "S02",
    milestoneId: "M001",
    title: "Second task",
    status: "active",
  });

  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "blocked");
  if (result.kind !== "blocked") return;
  assert.equal(result.action, "stop");
  assert.match(result.reason, /earlier slice M001\/S01 is not complete/);
  assert.equal(f.session.pendingOrchestrationDispatch, null);
  assert.deepEqual(f.orchestrator.getStatus().activeUnit, undefined);
  assert.ok(f.journalNames().includes("advance-blocked"));
});

test("getStatus() returns defensive copy of activeUnit", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  await f.orchestrator.advance();
  const snap1 = f.orchestrator.getStatus();
  if (snap1.activeUnit) snap1.activeUnit.unitId = "MUTATED";
  const snap2 = f.orchestrator.getStatus();

  assert.equal(snap2.activeUnit?.unitId, "M001/S01/T01");
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch passthrough decisions (skip / blocked / no-remaining-units)
// ─────────────────────────────────────────────────────────────────────────────

test("advance() keeps running when dispatch intentionally skips a phase", async (t) => {
  const f = makeFixture({
    dispatch: () => ({ action: "skip", matchedRule: "evaluating-gates skipped after marking gates omitted" }),
  });
  t.after(() => f.cleanup());

  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "skipped");
  if (result.kind !== "skipped") return;
  assert.equal(result.reason, "evaluating-gates skipped after marking gates omitted");
  assert.equal(f.orchestrator.getStatus().phase, "running");
  const names = f.journalNames();
  assert.ok(names.includes("advance-skipped"));
  assert.ok(!names.includes("advance-stopped"));
});

test("advance() surfaces dispatch blocker reason instead of generic no remaining units", async (t) => {
  const reason = "Milestone M001 validation verdict is needs-remediation but all slices are complete.";
  const f = makeFixture({
    dispatch: () => ({ action: "stop", reason, level: "warning" }),
  });
  t.after(() => f.cleanup());

  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "blocked");
  if (result.kind !== "blocked") return;
  assert.equal(result.reason, reason);
  assert.equal(result.action, "pause");
  const names = f.journalNames();
  assert.ok(names.includes("advance-blocked"));
  assert.ok(!names.includes("advance-stopped"));
});

test("advance() stop level=error blocks with action stop", async (t) => {
  const f = makeFixture({
    dispatch: () => ({ action: "stop", reason: "hard blocker", level: "error" }),
  });
  t.after(() => f.cleanup());

  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "blocked");
  if (result.kind !== "blocked") return;
  assert.equal(result.action, "stop");
});

test("advance() reports completion when complete state has no next unit", async (t) => {
  const f = makeFixture({ complete: true, noTask: true });
  t.after(() => f.cleanup());

  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "stopped");
  if (result.kind !== "stopped") return;
  assert.equal(result.reason, "All milestones complete");
  assert.equal(result.terminalOutcome?.code, "all-complete");
  assert.equal(f.orchestrator.getStatus().phase, "stopped");
});

test("advance() merges a completed milestone worktree before all-complete stop", async (t) => {
  const f = makeFixture({ complete: true, noTask: true });
  t.after(() => f.cleanup());

  insertAssessment({
    path: "milestones/M001/M001-VALIDATION.md",
    milestoneId: "M001",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "verdict: pass",
  });
  insertGateRow({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "Q3",
    scope: "slice",
    status: "pending",
  });

  const worktreePath = join(f.base, ".gsd", "worktrees", "M001");
  mkdirSync(join(f.base, ".gsd", "worktrees"), { recursive: true });
  execFileSync("git", ["worktree", "add", "-b", "milestone/M001", worktreePath], { cwd: f.base, stdio: "ignore" });
  mkdirSync(join(worktreePath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(worktreePath, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\n");
  f.session.basePath = worktreePath;
  f.session.originalBasePath = f.base;
  f.session.currentMilestoneId = "M001";
  f.session.milestoneMergedInPhases = false;

  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "stopped");
  if (result.kind !== "stopped") return;
  assert.equal(result.reason, "All milestones complete");
  assert.equal(result.terminalOutcome?.code, "all-complete");
  assert.equal(f.orchestrator.getStatus().phase, "stopped");
  assert.equal(f.session.milestoneMergedInPhases, true);
  assert.deepEqual(f.session.milestoneSettlement, { ok: true, reason: "settled" });
  const names = f.journalNames();
  assert.ok(names.includes("advance-stopped"));
  assert.ok(!names.includes("advance-blocked"));
});

test("advance() stopped clears previous activeUnit and resets idempotent lock", async (t) => {
  // First advance dispatches; then we make the milestone resolve to no unit by
  // closing it on disk + DB and re-deriving. Simpler: drive a fixture that
  // dispatches once, finalize externally, then the next decision is complete.
  let dispatchOnce = true;
  const f = makeFixture({
    dispatch: () => {
      if (dispatchOnce) {
        dispatchOnce = false;
        return DEFAULT_DISPATCH;
      }
      // After the first advance, signal completion via a benign skip → still
      // exercises the running/active-unit transition. For the stopped path we
      // rely on the complete-state test above.
      return { action: "skip", matchedRule: "done" };
    },
  });
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "advanced");

  const second = await f.orchestrator.advance();
  assert.equal(second.kind, "skipped");
  // skip clears activeUnit
  assert.equal(f.orchestrator.getStatus().activeUnit, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency + finalized guard (issues #5786 / #5787 / #415)
// ─────────────────────────────────────────────────────────────────────────────

test("advance() is idempotent for the same active unit", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  f.session.unitExecutionInFlight = true;
  const second = await f.orchestrator.advance();

  assert.equal(first.kind, "advanced");
  if (first.kind === "advanced") {
    assert.deepEqual(first.unit, { unitType: "execute-task", unitId: "M001/S01/T01" });
  }
  assert.equal(second.kind, "skipped");
  if (second.kind !== "skipped") return;
  assert.equal(second.reason, "idempotent advance: unit already active");
  assert.equal(second.code, "unit-already-active");
});

test("idempotency skip fires with its own reason before saturation", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");
  const workerId = f.session.workerId;
  const milestoneLeaseToken = f.session.milestoneLeaseToken;
  assert.ok(workerId);
  assert.ok(milestoneLeaseToken);
  claimTaskAttempt({
    invocation: internalExecutionInvocation("test:orchestrator:live-executor:claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId,
    milestoneLeaseToken,
    coordinationDispatchId: first.dispatchId,
  });
  f.session.unitExecutionInFlight = true;
  const second = await f.orchestrator.advance();

  assert.equal(second.kind, "skipped");
  if (second.kind !== "skipped") return;
  assert.equal(second.reason, "idempotent advance: unit already active");
  assert.equal(second.code, "unit-already-active");
});

async function terminateUnitRunWithSettledAbort(f: Fixture, key: string) {
  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");
  const workerId = f.session.workerId;
  const milestoneLeaseToken = f.session.milestoneLeaseToken;
  assert.ok(workerId);
  assert.ok(milestoneLeaseToken);

  const attempt = claimTaskAttempt({
    invocation: internalExecutionInvocation(`test:orchestrator:${key}:claim`),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId,
    milestoneLeaseToken,
    coordinationDispatchId: first.dispatchId,
  });
  const settled = settleTaskAttempt({
    invocation: internalExecutionInvocation(`test:orchestrator:${key}:settle`),
    attemptId: attempt.attemptId,
    outcome: "failed",
    failureClass: "execution",
    summary: "executor stopped before closeout",
    output: {},
  });
  const recovery = recordFailureAndSelectRecovery({
    invocation: internalExecutionInvocation(`test:orchestrator:${key}:route`),
    attemptId: attempt.attemptId,
    resultId: settled.resultId,
    owner: "agent",
    classification: { failureKind: "fatal" },
    summary: "executor stopped before closeout",
    evidence: { source: "test" },
    rationale: "preserve a durable resume action",
  });
  assert.equal(recovery.action, "abort");
  // settleTaskAttempt already terminalized the UnitRun's dispatch row.

  // Crash recovery pairs the crashed marker with a lease release
  // (crash-recovery.ts); a settled abort must then reach dispatch.
  markWorkerCrashed(workerId);
  forceReleaseLeasesForWorker(workerId);
  f.session.workerId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(f.base) });
  f.session.milestoneLeaseToken = null;
  f.session.unitExecutionInFlight = false;
  return recovery;
}

test("a settled abort on a terminated UnitRun reaches task recovery cutover", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  await terminateUnitRunWithSettledAbort(f, "settled-abort");
  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "advanced");
});

test("an authorized settled abort reaches the successor retry claim", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const recovery = await terminateUnitRunWithSettledAbort(f, "authorized-abort");
  resumeTaskRecovery({
    invocation: internalExecutionInvocation("test:orchestrator:authorized-abort:resume"),
    recoveryActionId: recovery.recoveryActionId,
    repairSummary: "Repaired the executor lifecycle and verified a retry is safe.",
    evidence: { verification: "focused recovery check passed" },
  });
  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "advanced");
});

test("an active UnitRun checks its running Attempt worker before idling", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");
  const workerId = f.session.workerId;
  const milestoneLeaseToken = f.session.milestoneLeaseToken;
  assert.ok(workerId);
  assert.ok(milestoneLeaseToken);

  const attempt = claimTaskAttempt({
    invocation: internalExecutionInvocation("test:orchestrator:dead-executor:claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId,
    milestoneLeaseToken,
    coordinationDispatchId: first.dispatchId,
  });
  markWorkerCrashed(workerId);
  f.session.unitExecutionInFlight = true;

  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "blocked");
  if (result.kind !== "blocked") throw new Error("expected dead executor to block");
  assert.equal(result.action, "stop");
  assert.match(result.reason, new RegExp(attempt.attemptId));
  assert.match(result.reason, /is running/);
  assert.match(result.reason, /executor worker .* is not live/);
  assert.match(result.reason, /gsd_task_settle/);
});

test("completeActiveUnit clears in-flight idempotency and stops stale same-unit advance", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");

  await f.orchestrator.completeActiveUnit(first.unit);
  const beforeRepeat = getOpenWedge(normalizeRealPath(f.base));
  assert.equal(beforeRepeat.ok, true);
  assert.equal(beforeRepeat.ok ? beforeRepeat.wedge : null, null, "one occurrence must not trip");
  const second = await f.orchestrator.advance();

  assert.equal(f.orchestrator.getStatus().activeUnit, undefined);
  assert.equal(second.kind, "blocked");
  if (second.kind !== "blocked") throw new Error("expected stale same-unit block");
  assert.equal(second.action, "stop");
  assert.match(second.reason, /liveness backstop tripped/);
  const wedge = getOpenWedge(normalizeRealPath(f.base));
  assert.equal(wedge.ok, true);
  assert.equal(wedge.ok ? wedge.wedge?.guardId : null, COMPLETED_NO_ADVANCE_GUARD_ID);
  assert.equal(wedge.ok ? wedge.wedge?.occurrenceCount : null, 2);
  if (!wedge.ok || !wedge.wedge) throw new Error("expected completed-no-advance wedge");
  const recheck = await f.orchestrator.recheckWedge!(wedge.wedge);
  assert.equal(recheck.blocking, true);
  assert.match(recheck.reason ?? "", /state did not advance/);
  assert.equal((await f.orchestrator.recheckWedge!({
    ...wedge.wedge,
    inputHash: "different-target-state",
  })).blocking, false);
  assert.ok(f.journalNames().includes("unit-finalized"));
});

test("dispatch-rule wedge recheck preserves a live blocker and clears after it resolves", async (t) => {
  let blocked = true;
  const f = makeFixture({
    dispatch: () => blocked
      ? { action: "stop", reason: "stale recovery abort", level: "error" }
      : DEFAULT_DISPATCH,
  });
  t.after(() => f.cleanup());

  assert.equal((await f.orchestrator.advance()).kind, "blocked");
  assert.equal((await f.orchestrator.advance()).kind, "blocked");
  const open = getOpenWedge(normalizeRealPath(f.base));
  assert.equal(open.ok, true);
  if (!open.ok || !open.wedge) throw new Error("expected dispatch-rule-stop wedge");
  assert.equal(open.wedge.guardId, "dispatch-rule-stop");

  const stillBlocked = await f.orchestrator.recheckWedge!(open.wedge);
  assert.equal(stillBlocked.blocking, true);
  assert.match(stillBlocked.reason ?? "", /stale recovery abort/);

  blocked = false;
  assert.equal((await f.orchestrator.recheckWedge!(open.wedge)).blocking, false);
});

test("ADR-047: finalized-repeat guard does not run legacy graduated recovery", async (t) => {
  const f = makeFixture({
    dispatch: () => ({ action: "dispatch", unitType: "plan-milestone", unitId: "M001", prompt: "p" }),
  });
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  if (first.kind !== "advanced") {
    throw new Error(`expected advanced, got ${first.kind}: ${(first as { reason?: string }).reason ?? ""}`);
  }
  await f.orchestrator.completeActiveUnit(first.unit);

  const second = await f.orchestrator.advance();
  assert.equal(second.kind, "blocked");
  if (second.kind !== "blocked") throw new Error("expected finalized-repeat guard block");
  assert.match(second.reason, /completed-no-advance/);
  assert.ok(f.journalNames().includes("advance-blocked"));
});

test("ADR-047: unavailable liveness storage fails the advance boundary closed", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());
  closeDatabase();

  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "blocked");
  if (result.kind !== "blocked") throw new Error("expected a blocked advance");
  assert.equal(result.action, "stop");
  assert.match(result.reason, /liveness backstop unavailable/i);
});

test("ADR-047: a rejected unit-run claim blocks with a stable identity, not backstop-unavailable", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  // Force the unit-run claim (openUnitRun -> claimUnitRun) to be rejected:
  // clearing the session worker id yields a "degraded: missing-worker" claim,
  // which openUnitRun maps to a blocked AutoAdvanceResult before any dispatch
  // opens. This is the #2097 shape: the claim-block path used to return without
  // registering a liveness identity, degrading into "semantic guard did not
  // provide a stable identity" backstop-unavailable — an unrecoverable stop
  // that no DB repair (/gsd doctor --fix) could clear.
  f.session.workerId = null;

  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "blocked");
  if (first.kind !== "blocked") throw new Error("expected a blocked claim");
  assert.equal(first.action, "stop");
  // The block carries the real claim reason and a stable identity ...
  assert.match(first.reason, /missing-worker/);
  // ... and MUST NOT degrade into the no-stable-identity backstop failure.
  assert.doesNotMatch(first.reason, /semantic guard did not provide a stable identity/);
  assert.doesNotMatch(first.reason, /liveness backstop unavailable/i);

  // Because the claim block now registers a stable "unit-run-claim" signature,
  // a second identical rejection trips the liveness wedge (threshold 2) instead
  // of hard-failing the backstop boundary.
  const second = await f.orchestrator.advance();
  assert.equal(second.kind, "blocked");
  if (second.kind !== "blocked") throw new Error("expected a second blocked claim");
  assert.match(second.reason, /liveness backstop tripped/);
  const wedge = getOpenWedge(normalizeRealPath(f.base));
  assert.equal(wedge.ok, true);
  assert.equal(wedge.ok ? wedge.wedge?.guardId : null, "unit-run-claim");
  assert.equal(wedge.ok ? wedge.wedge?.occurrenceCount : null, 2);
  // ADR-047 §5: the wedge MUST carry an actionable recovery instruction, not
  // just the raw claim reason. Guards against regressing to the
  // `sanctionedExit ?? inputPayload` fallback (which would only store
  // `missing-worker`).
  const sanctionedExit = wedge.ok ? wedge.wedge?.sanctionedExit ?? "" : "";
  assert.notEqual(sanctionedExit, "missing-worker");
  assert.match(sanctionedExit, /could not claim a unit-run/i);
  assert.match(sanctionedExit, /\/gsd status/);
});

test("completeActiveUnit allows a different next unit to advance", async (t) => {
  let nextTaskId = "M001/S01/T01";
  const f = makeFixture({
    dispatch: () => ({ action: "dispatch", unitType: "execute-task", unitId: nextTaskId, prompt: "p" }),
  });
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");

  await f.orchestrator.completeActiveUnit(first.unit);
  nextTaskId = "M001/S01/T02";
  const second = await f.orchestrator.advance();

  assert.equal(second.kind, "advanced");
  if (second.kind !== "advanced") throw new Error("expected second advance");
  assert.deepEqual(second.unit, { unitType: "execute-task", unitId: "M001/S01/T02" });
});

test("completeActiveUnit guard survives an intervening advance and blocks X→Y→X re-dispatch (#415)", async (t) => {
  let nextTaskId = "M001/S01/T01";
  const f = makeFixture({
    dispatch: () => ({ action: "dispatch", unitType: "execute-task", unitId: nextTaskId, prompt: "p" }),
  });
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");

  await f.orchestrator.completeActiveUnit(first.unit);

  nextTaskId = "M001/S01/T02";
  const second = await f.orchestrator.advance();
  assert.equal(second.kind, "advanced");
  if (second.kind !== "advanced") throw new Error("expected second advance (T02)");
  assert.deepEqual(second.unit, { unitType: "execute-task", unitId: "M001/S01/T02" });

  nextTaskId = "M001/S01/T01";
  const third = await f.orchestrator.advance();
  assert.equal(third.kind, "blocked");
  if (third.kind !== "blocked") throw new Error("expected X→Y→X re-dispatch to be blocked");
  assert.equal(third.action, "stop");
  assert.match(third.reason, /completed-no-advance/);
});

test("retryActiveUnit clears in-flight idempotency without marking the unit finalized", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");

  await f.orchestrator.retryActiveUnit(first.unit);
  const second = await f.orchestrator.advance();

  assert.equal(second.kind, "advanced");
  if (second.kind !== "advanced") throw new Error("expected retry advance");
  assert.deepEqual(second.unit, first.unit);
  assert.ok(f.journalNames().includes("unit-retry"));
});

// #2198: the finalize-retry recurrence is known to be non-progressing, so the
// trip must pause with the concrete finalize-failure cause instead of wedging
// behind a generic notice + `--resume-wedge` acknowledgement. The signature
// ledger still re-trips an unchanged re-entry.
test("retryActiveUnit pauses with the finalize cause when finalize-retry trips the liveness backstop", async (t) => {
  const notifications: Array<[string, string]> = [];
  const f = makeFixture();
  t.after(() => f.cleanup());
  (f.ctx.ctx as any).ui.notify = (message: string, level: string) => {
    notifications.push([message, level]);
  };

  const cause = "finalize-retry: source-integrity inconclusive: host snapshot no longer matches closeout evidence";
  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");
  await f.orchestrator.settle(first.dispatchId, "retry", cause);
  assert.notEqual(f.orchestrator.getStatus().phase, "stopped");
  assert.equal(notifications.length, 0, "first failure must allow a retry");

  const second = await f.orchestrator.advance();
  assert.equal(second.kind, "advanced");
  if (second.kind !== "advanced") throw new Error("expected retry advance");
  await f.orchestrator.settle(second.dispatchId, "retry", cause);

  assert.equal(f.orchestrator.getStatus().phase, "stopped");
  const pause = notifications.find(([message, level]) => level === "error" && /pausing auto-mode/.test(message));
  assert.ok(pause, "the trip must pause with the concrete finalize cause");
  assert.match(pause[0], /failed finalize twice with identical inputs/);
  assert.ok(pause[0].includes(cause));
  assert.doesNotMatch(pause[0], /liveness backstop tripped/);
  const wedge = getOpenWedge(normalizeRealPath(f.base));
  assert.equal(wedge.ok, true);
  assert.equal(wedge.ok ? wedge.wedge : null, null, "no wedge record may gate plain /gsd auto re-entry");

  assert.equal((await f.orchestrator.resume()).kind, "resumed");
  const resumed = await f.orchestrator.advance();
  assert.equal(resumed.kind, "advanced", "plain resume must redispatch without wedge acknowledgement");
  if (resumed.kind !== "advanced") throw new Error("expected resumed dispatch");
  assert.deepEqual(resumed.unit, first.unit);
  await f.orchestrator.settle(resumed.dispatchId, "retry", cause);
  assert.equal(f.orchestrator.getStatus().phase, "stopped");
  assert.equal(notifications.length, 2, "one unchanged resumed failure must pause again");
  assert.equal(notifications[1][0], pause[0]);
  assert.deepEqual(getOpenWedge(normalizeRealPath(f.base)), { ok: true, wedge: null });
  t.diagnostic(JSON.stringify({ scenario: "finalize-retry then plain resume", notifications, wedge: getOpenWedge(normalizeRealPath(f.base)), resumedUnit: resumed.unit }));
});

test("settle canceled clears a deferred dispatch claim without finalizing the unit", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");

  await f.orchestrator.settle(first.dispatchId, "canceled", "deferred-closeout");
  const second = await f.orchestrator.advance();

  assert.equal(f.orchestrator.getStatus().activeUnit?.unitId, first.unit.unitId);
  assert.equal(second.kind, "advanced");
  if (second.kind !== "advanced") throw new Error("expected deferred unit to re-advance");
  assert.deepEqual(second.unit, first.unit);
  assert.notEqual(second.dispatchId, first.dispatchId);
  assert.equal(f.journalNames().includes("unit-finalized"), false);
  const wedge = getOpenWedge(normalizeRealPath(f.base));
  assert.equal(wedge.ok, true);
  assert.equal(wedge.ok ? wedge.wedge : null, null);
});

test("abandonActiveUnit clears an abnormal exit so the same unit can advance again", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");

  await f.orchestrator.abandonActiveUnit(first.unit, "unit execution crashed");
  const second = await f.orchestrator.advance();

  assert.equal(second.kind, "advanced");
  if (second.kind !== "advanced") throw new Error("expected re-advance after abandonment");
  assert.deepEqual(second.unit, first.unit);
  assert.ok(f.journalNames().includes("unit-abandon"));
});

test("#2212: abandonActiveUnit aborts the turn hosting a pending elicitation and clears in-flight tool entries", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());
  t.after(() => clearInFlightTools());

  // Simulate the abandoned turn: still alive (not idle — a pending
  // ask_user_questions dialog is mounted) with the interactive tool in flight.
  const extCtx = f.ctx.ctx as { isIdle: () => boolean; abort: () => void };
  let abortCalls = 0;
  extCtx.isIdle = () => false;
  extCtx.abort = () => {
    abortCalls += 1;
  };
  markToolStart("tc-2212-pending-question", true, "ask_user_questions");
  assert.equal(hasInteractiveToolInFlight(), true, "precondition: interactive elicitation in flight");

  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");

  await f.orchestrator.abandonActiveUnit(first.unit, "verify-gate wedge");

  // The abort is what dismisses the mounted dialog: the tool's abort signal
  // makes showInterviewRound finish and unmount (mechanism pinned in
  // shared/tests/interview-abort-dismiss.test.ts).
  assert.equal(abortCalls, 1, "unit-abandon must abort the turn hosting the pending elicitation");
  assert.equal(hasInteractiveToolInFlight(), false, "unit-abandon must clear the interactive in-flight watchdog exemption");
  assert.equal(getInFlightToolCount(), 0, "unit-abandon must clear stale in-flight tool entries");
  assert.ok(f.journalNames().includes("unit-abandon"));
});

test("retryActiveUnit clears finalized same-unit guard for post-hook retries", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");

  await f.orchestrator.completeActiveUnit(first.unit);
  await f.orchestrator.retryActiveUnit(first.unit);
  const second = await f.orchestrator.advance();

  assert.equal(second.kind, "advanced");
  if (second.kind !== "advanced") throw new Error("expected retry advance");
  assert.deepEqual(second.unit, first.unit);
  const names = f.journalNames();
  assert.ok(names.includes("unit-finalized"));
  assert.ok(names.includes("unit-retry"));
});

test("resume() keeps an in-flight UnitRun skip, then resumes the claimed row", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  f.session.unitExecutionInFlight = true;
  const idempotent = await f.orchestrator.advance();
  const resumed = await f.orchestrator.resume();
  f.session.unitExecutionInFlight = false;
  const next = await f.orchestrator.advance();

  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");
  assert.equal(idempotent.kind, "skipped");
  assert.equal(resumed.kind, "resumed");
  assert.equal(next.kind, "advanced");
  if (next.kind !== "advanced") throw new Error("expected resume advance");
  assert.equal(next.dispatchId, first.dispatchId);
});

test("start() does not skip-string-match a claimed UnitRun after restart", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  f.session.unitExecutionInFlight = true;
  const idempotent = await f.orchestrator.advance();
  const restarted = await f.orchestrator.start(SESSION_CONTEXT);
  f.session.unitExecutionInFlight = false;
  const next = await f.orchestrator.advance();

  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");
  assert.equal(idempotent.kind, "skipped");
  assert.equal(restarted.kind, "started");
  assert.equal(next.kind, "advanced");
  if (next.kind !== "advanced") throw new Error("expected restarted advance");
  assert.equal(next.dispatchId, first.dispatchId);
});

test("stop() cancels the UnitRun so advance can claim again", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  f.session.unitExecutionInFlight = true;
  const idempotent = await f.orchestrator.advance();
  const stopped = await f.orchestrator.stop("reset");
  f.session.unitExecutionInFlight = false;
  const second = await f.orchestrator.advance();

  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");
  assert.equal(idempotent.kind, "skipped");
  assert.equal(stopped.kind, "stopped");
  assert.equal(second.kind, "advanced");
  if (second.kind !== "advanced") throw new Error("expected post-stop advance");
  assert.notEqual(second.dispatchId, first.dispatchId);
});

test("idempotent path journals advance-skipped and records a health snapshot", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  await f.orchestrator.advance();
  f.session.unitExecutionInFlight = true;
  await f.orchestrator.advance();

  assert.ok(f.journalNames().includes("advance-skipped"));
});

test("a new orchestrator resumes the claimed UnitRun instead of skip-string-matching", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  const first = await f.orchestrator.advance();
  assert.equal(first.kind, "advanced");
  if (first.kind !== "advanced") throw new Error("expected first advance");

  const restarted = createAutoOrchestrator(f.ctx);
  const second = await restarted.advance();

  assert.equal(second.kind, "advanced");
  if (second.kind !== "advanced") throw new Error("expected UnitRun resume");
  assert.equal(second.dispatchId, first.dispatchId);
  assert.equal(second.unit.unitId, first.unit.unitId);
  assert.equal(restarted.getStatus().activeUnit?.unitId, first.unit.unitId);
});

// ─── Stuck-loop ring buffer (issue #5787) ──────────────────────────────────

test("advance() routes a lost-lock error through recovery and journals an outcome", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());

  // Release the lock so ensureLockOwnership() sees missing-metadata and throws,
  // exercising the catch → classifyAutoAdvanceFailure → result-mapping branch.
  releaseSessionLock(f.base);
  // Remove the lockfile artifact so getSessionLockStatus returns !valid.
  try { rmSync(join(f.base, ".gsd", "auto.lock"), { force: true }); } catch { /* */ }
  try { rmSync(join(f.base, ".gsd.lock"), { recursive: true, force: true }); } catch { /* */ }

  const result = await f.orchestrator.advance();

  // classifyFailure maps a generic Error to a recovery action; the orchestrator
  // surfaces it as paused/stopped/error and journals the corresponding event.
  assert.ok(["paused", "stopped", "error"].includes(result.kind), `unexpected kind ${result.kind}`);
  const names = f.journalNames();
  assert.ok(
    names.includes("advance-paused") || names.includes("advance-stopped") || names.includes("advance-error"),
    "recovery must journal an advance-paused/stopped/error event",
  );
});

test("projection lock classification survives the paused result boundary", () => {
  const nativeError = new Error("native projection root identity locking failed", {
    cause: new Error("projection root operation failed: The process cannot access the file (os error 32)"),
  });

  const result = classifyAutoAdvanceFailure({ error: nativeError });

  assert.equal(result.kind, "paused");
  if (result.kind !== "paused") throw new Error("expected paused projection-lock recovery");
  assert.equal(result.failureKind, "projection-lock-transient");
  assert.ok(result.backoffMs && result.backoffMs.length > 0);
  assert.equal(result.reason, "Projection root busy: native projection root identity locking failed");
});

test("advance() propagates projection observation lock failures as typed pauses (#2001)", async (t) => {
  const f = makeFixture();
  t.after(() => f.cleanup());
  const nativeError = new Error("native projection root identity locking failed", {
    cause: new Error("projection root operation failed: The process cannot access the file (os error 32)"),
  });
  const restoreProjectionObservation = _setPreserveProjectionChangesFnForTests(async () => {
    throw nativeError;
  });
  t.after(restoreProjectionObservation);

  const result = await f.orchestrator.advance();

  assert.equal(result.kind, "paused");
  if (result.kind !== "paused") throw new Error("expected paused projection-lock recovery");
  assert.equal(result.failureKind, "projection-lock-transient");
  assert.ok(result.backoffMs && result.backoffMs.length > 0);
  assert.equal(result.reason, "Projection root busy: native projection root identity locking failed");
  assert.equal(f.orchestrator.getStatus().phase, "paused");
  assert.ok(f.journalNames().includes("advance-paused"));
  assert.ok(!f.journalNames().includes("advance-blocked"));
});

// ─────────────────────────────────────────────────────────────────────────────
// closeout regression: live-base resolver after worktree cleanup
// ─────────────────────────────────────────────────────────────────────────────

test("live orchestrator base resolver prefers live project root after worktree cleanup", (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-orch-root-"));
  const staleWorktreeRoot = join(projectRoot, ".gsd", "worktrees", "M002");
  mkdirSync(join(staleWorktreeRoot, ".bg-shell"), { recursive: true });
  t.after(() => { try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* */ } });

  assert.equal(
    resolveLiveOrchestratorBasePath({
      capturedBasePath: staleWorktreeRoot,
      runtimeBasePath: projectRoot,
      sessionBasePath: projectRoot,
      originalBasePath: projectRoot,
    }),
    projectRoot,
  );
});

test("live orchestrator base resolver keeps a captured active git worktree", (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-orch-worktree-"));
  const worktreeRoot = join(projectRoot, ".gsd", "worktrees", "M003");
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(join(worktreeRoot, ".git"), "gitdir: /tmp/gsd-orch-worktree/.git/worktrees/M003\n");
  t.after(() => { try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* */ } });

  assert.equal(
    resolveLiveOrchestratorBasePath({
      capturedBasePath: worktreeRoot,
      runtimeBasePath: projectRoot,
    }),
    worktreeRoot,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch-decision parity (#5789) — formerly the createWiredDispatchAdapter
// tests. These exercise the exported pure decideOrchestratorDispatch helper.
// ─────────────────────────────────────────────────────────────────────────────

test("decideOrchestratorDispatch forwards session-derived dispatch inputs identically to runDispatch", async (t) => {
  openDispatchDecisionDatabase(t);
  const stateSnapshot = makeState();

  const captured: DispatchContext[] = [];
  const captureRule: UnifiedRule = {
    name: "test-capture",
    when: "dispatch",
    evaluation: "first-match",
    where: async (ctx: DispatchContext) => {
      captured.push(ctx);
      return {
        action: "dispatch" as const,
        unitType: "execute-task",
        unitId: "T01",
        prompt: "parity-fixture",
      };
    },
    then: (r: unknown) => r,
  };
  setRegistry(new RuleRegistry([captureRule]));

  try {
    const fakeModelRegistry = {
      getAll: () => [],
      getAvailable: () => [],
      getProviderAuthMode: (_provider: string) => "apiKey" as const,
    };
    const ctx = {
      model: {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        contextWindow: 200_000,
      },
      modelRegistry: fakeModelRegistry,
    } as never;
    const pi = {
      getActiveTools: () => ["read_file", "write_file"],
    } as never;
    const basePath = "/tmp/parity-fixture";

    // Path A — the orchestrator's pure dispatch decision.
    const adapterResult = await decideOrchestratorDispatch(ctx, pi, basePath, undefined, { stateSnapshot });

    // Path B — direct resolveDispatch call mirroring phases.ts:runDispatch.
    const prefs = undefined;
    const provider = (ctx as { model?: { provider?: string } }).model?.provider;
    const authMode = provider && typeof fakeModelRegistry.getProviderAuthMode === "function"
      ? fakeModelRegistry.getProviderAuthMode(provider)
      : undefined;
    const activeTools = ["read_file", "write_file"];
    const structuredQuestionsAvailable: "true" | "false" =
      prefs !== undefined && (prefs as { planning_depth?: string }).planning_depth === "deep"
        ? "false"
        : supportsStructuredQuestions(activeTools, {
            authMode,
            baseUrl: (ctx as { model?: { baseUrl?: string } }).model?.baseUrl,
          })
          ? "true"
          : "false";

    const builtDirectCtx: DispatchContext = {
      basePath,
      mid: stateSnapshot.activeMilestone!.id,
      midTitle: stateSnapshot.activeMilestone!.title,
      state: stateSnapshot,
      prefs,
      structuredQuestionsAvailable,
      sessionContextWindow: 200_000,
      sessionProvider: "anthropic",
      modelRegistry: fakeModelRegistry,
    };
    const directAction = await resolveDispatch(builtDirectCtx);

    assert.equal(captured.length, 2, "expected two captured dispatch contexts");
    const [adapterCtx, directCtx] = captured;

    assert.equal(adapterCtx.structuredQuestionsAvailable, directCtx.structuredQuestionsAvailable);
    assert.equal(adapterCtx.sessionContextWindow, directCtx.sessionContextWindow);
    assert.equal(adapterCtx.sessionProvider, directCtx.sessionProvider);
    assert.equal(adapterCtx.modelRegistry, directCtx.modelRegistry);
    assert.equal(adapterCtx.basePath, directCtx.basePath);
    assert.equal(adapterCtx.mid, directCtx.mid);
    assert.equal(adapterCtx.midTitle, directCtx.midTitle);

    if (!adapterResult || !("unitType" in adapterResult)) {
      assert.fail("expected adapter result to be a dispatch decision");
    }
    assert.equal(adapterResult.unitType, "execute-task");
    assert.equal(adapterResult.unitId, "T01");
    assert.equal(adapterResult.reason, "test-capture");
    assert.equal(directAction.action, "dispatch");
    if (directAction.action === "dispatch") {
      assert.equal(directAction.unitType, adapterResult.unitType);
      assert.equal(directAction.unitId, adapterResult.unitId);
      assert.equal(directAction.matchedRule, adapterResult.reason);
    }
  } finally {
    resetRegistry();
  }
});

test("decideOrchestratorDispatch prefers caller-supplied dispatch inputs over ctx-derived values", async (t) => {
  openDispatchDecisionDatabase(t);
  const stateSnapshot = makeState();
  const captured: DispatchContext[] = [];
  const captureRule: UnifiedRule = {
    name: "test-capture-overrides",
    when: "dispatch",
    evaluation: "first-match",
    where: async (ctx: DispatchContext) => {
      captured.push(ctx);
      return {
        action: "dispatch" as const,
        unitType: "execute-task",
        unitId: "T01",
        prompt: "override-fixture",
      };
    },
    then: (r: unknown) => r,
  };
  setRegistry(new RuleRegistry([captureRule]));

  try {
    const ctxModelRegistry = {
      getAll: () => [],
      getAvailable: () => [],
      getProviderAuthMode: (_provider: string) => "apiKey" as const,
    };
    const overrideModelRegistry = {
      getAll: () => [],
      getAvailable: () => [],
      getProviderAuthMode: (_provider: string) => "oauth" as const,
    };
    const ctx = {
      model: {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        contextWindow: 200_000,
      },
      modelRegistry: ctxModelRegistry,
    } as never;
    const pi = { getActiveTools: () => [] } as never;
    const session = { basePath: "/tmp/session-fixture" } as never;

    const result = await decideOrchestratorDispatch(ctx, pi, "/tmp/parity-fixture", undefined, {
      stateSnapshot,
      session,
      structuredQuestionsAvailable: "true",
      sessionContextWindow: 500_000,
      sessionProvider: "openai",
      modelRegistry: overrideModelRegistry,
    });

    assert.ok(result);
    assert.equal(captured.length, 1, "expected one captured dispatch context");
    assert.equal(captured[0].structuredQuestionsAvailable, "true");
    assert.equal(captured[0].sessionContextWindow, 500_000);
    assert.equal(captured[0].sessionProvider, "openai");
    assert.equal(captured[0].modelRegistry, overrideModelRegistry);
    assert.equal(captured[0].session, session);
    assert.equal(captured[0].basePath, "/tmp/session-fixture");
  } finally {
    resetRegistry();
  }
});

test("decideOrchestratorDispatch forwards constructor session when advance input omits session", async (t) => {
  openDispatchDecisionDatabase(t);
  const stateSnapshot = makeState();
  const captured: DispatchContext[] = [];
  const captureRule: UnifiedRule = {
    name: "test-session-fallback",
    when: "dispatch",
    evaluation: "first-match",
    where: async (ctx: DispatchContext) => {
      captured.push(ctx);
      return {
        action: "dispatch" as const,
        unitType: "execute-task",
        unitId: "T01",
        prompt: "session-fallback-fixture",
      };
    },
    then: (r: unknown) => r,
  };
  setRegistry(new RuleRegistry([captureRule]));

  try {
    const ctx = { model: {}, modelRegistry: { getAll: () => [], getAvailable: () => [] } } as never;
    const pi = { getActiveTools: () => [] } as never;
    const session = {
      basePath: "/tmp/worktree-fixture",
      originalBasePath: "/tmp/project-fixture",
      currentMilestoneId: "M001",
    } as never;

    const result = await decideOrchestratorDispatch(ctx, pi, "/tmp/project-fixture", session, { stateSnapshot });

    assert.ok(result);
    assert.equal(captured.length, 1, "expected one captured dispatch context");
    assert.equal(captured[0].session, session);
    assert.equal(captured[0].basePath, "/tmp/worktree-fixture");
  } finally {
    resetRegistry();
  }
});

test("decideOrchestratorDispatch evaluates deep pre-planning rules without an active milestone", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-orchestrator-no-active-"));
  t.after(() => {
    resetRegistry();
    rmSync(base, { recursive: true, force: true });
  });
  resetRegistry();
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "planning_depth: deep",
      "workflow_prefs_captured: true",
      "---",
      "",
    ].join("\n"),
  );

  const stateSnapshot: GSDState = {
    ...makeState(),
    activeMilestone: null,
    phase: "pre-planning",
    nextAction: "All remaining milestones are parked (M027). Run /gsd unpark M027 or create a new milestone.",
    registry: [{ id: "M027", title: "Parked", status: "parked" }],
  };
  const ctx = { model: {}, modelRegistry: { getAll: () => [], getAvailable: () => [] } } as never;
  const pi = { getActiveTools: () => [] } as never;
  const session = {
    basePath: base,
    originalBasePath: base,
    currentMilestoneId: "M027",
  } as never;

  const result = await decideOrchestratorDispatch(ctx, pi, base, session, { stateSnapshot });

  assert.ok(result && "unitType" in result, `expected project-level dispatch, got ${JSON.stringify(result)}`);
  assert.equal(result.unitType, "discuss-project");
  assert.equal(result.unitId, "PROJECT");
});

test("decideOrchestratorDispatch does not replay milestone-scoped verification retry when no milestone is active", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-orchestrator-no-active-retry-"));
  t.after(() => {
    resetRegistry();
    rmSync(base, { recursive: true, force: true });
  });
  resetRegistry();
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "planning_depth: deep",
      "workflow_prefs_captured: true",
      "---",
      "",
    ].join("\n"),
  );

  const stateSnapshot: GSDState = {
    ...makeState(),
    activeMilestone: null,
    phase: "pre-planning",
    nextAction: "All remaining milestones are parked (M027). Run /gsd unpark M027 or create a new milestone.",
    registry: [{ id: "M027", title: "Parked", status: "parked" }],
  };
  const ctx = { model: {}, modelRegistry: { getAll: () => [], getAvailable: () => [] } } as never;
  const pi = { getActiveTools: () => [] } as never;
  const stalePendingRetry = {
    unitType: "execute-task",
    unitId: "M027.S1.T1",
    prompt: "stale retry prompt",
    pauseAfterUatDispatch: false,
    state: stateSnapshot,
    mid: "M027",
    midTitle: "Parked",
  };
  const session = {
    basePath: base,
    originalBasePath: base,
    currentMilestoneId: "M027",
    pendingVerificationRetryDispatch: stalePendingRetry,
  } as never;

  const result = await decideOrchestratorDispatch(ctx, pi, base, session, { stateSnapshot });

  assert.ok(result && "unitType" in result, `expected project-level dispatch, got ${JSON.stringify(result)}`);
  assert.equal(result.unitType, "discuss-project");
  assert.equal(result.unitId, "PROJECT");
  // The stale retry must be preserved for a future tick, not consumed by this
  // no-active-milestone path (mirrors pre-#712-fix behavior where !active
  // returned null before touching the retry).
  const sess = session as unknown as { pendingVerificationRetryDispatch: unknown };
  assert.equal(sess.pendingVerificationRetryDispatch, stalePendingRetry);
});

test("decideOrchestratorDispatch adopts next active milestone after the session milestone is closed, parked, or deferred", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-orchestrator-milestone-adopt-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const captured: DispatchContext[] = [];
  const captureRule: UnifiedRule = {
    name: "test-milestone-adoption",
    when: "dispatch",
    evaluation: "first-match",
    where: async (ctx: DispatchContext) => {
      captured.push(ctx);
      return {
        action: "dispatch" as const,
        unitType: "execute-task",
        unitId: "M002/S01/T01",
        prompt: "adopted-milestone-fixture",
      };
    },
    then: (r: unknown) => r,
  };
  setRegistry(new RuleRegistry([captureRule]));

  try {
    for (const status of ["complete", "parked", "deferred"] as const) {
      // Reset per iteration so the assertion below cannot pass by reading a
      // captured context from an earlier status when this iteration failed to
      // invoke the dispatch rule.
      captured.length = 0;
      openDispatchDecisionDatabase(t, [
        { id: "M001", title: "First", status },
        { id: "M002", title: "Next", status: "active" },
      ]);

      const stateSnapshot: GSDState = {
        ...makeState(),
        activeMilestone: { id: "M002", title: "Next" },
        registry: [
          // "deferred" is a valid isSkippedForDispatch input but not a status
          // deriveState emits for a milestone, so the narrow registry union
          // omits it; cast at this boundary to exercise the predicate's
          // deferred branch without widening the production type.
          { id: "M001", title: "First", status: status as GSDState["registry"][number]["status"] },
          { id: "M002", title: "Next", status: "active" },
        ],
      };
      const ctx = { model: {}, modelRegistry: { getAll: () => [], getAvailable: () => [] } } as never;
      const pi = { getActiveTools: () => [] } as never;
      const session = {
        basePath: base,
        originalBasePath: base,
        currentMilestoneId: "M001",
      } as never;

      const result = await decideOrchestratorDispatch(ctx, pi, base, session, { stateSnapshot });

      assert.ok(result);
      if (!result || !("unitType" in result)) assert.fail(`expected dispatch decision, got ${JSON.stringify(result)}`);
      assert.equal(result.unitId, "M002/S01/T01");
      assert.equal((session as { currentMilestoneId: string }).currentMilestoneId, "M002", status);
      assert.equal(captured.length, 1, status);
      assert.equal(captured[0]?.session?.currentMilestoneId, "M002", status);
    }
  } finally {
    resetRegistry();
  }
});

test("decideOrchestratorDispatch keeps blocking stale milestone worktree scope", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-orchestrator-worktree-block-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const stateSnapshot: GSDState = {
    ...makeState(),
    activeMilestone: { id: "M002", title: "Next" },
    registry: [
      { id: "M001", title: "First", status: "complete" },
      { id: "M002", title: "Next", status: "active" },
    ],
  };
  const worktreePath = join(base, ".gsd", "worktrees", "M001");
  mkdirSync(worktreePath, { recursive: true });
  const ctx = { model: {}, modelRegistry: { getAll: () => [], getAvailable: () => [] } } as never;
  const pi = { getActiveTools: () => [] } as never;
  const session = {
    basePath: worktreePath,
    originalBasePath: base,
    currentMilestoneId: "M001",
  } as never;

  const result = await decideOrchestratorDispatch(ctx, pi, base, session, { stateSnapshot });

  assert.deepEqual(result, {
    kind: "blocked",
    reason:
      'Dispatch milestone mismatch: context mid "M002" does not match session.currentMilestoneId "M001". The active worktree/session and derived project state disagree; recover, park, or discard the stranded milestone before continuing.',
    action: "pause",
    guardId: "dispatch-rule-stop",
  });
  assert.equal((session as { currentMilestoneId: string }).currentMilestoneId, "M001");
});

test("decideOrchestratorDispatch replays pending verification retry dispatch", async () => {
  const stateSnapshot = makeState();
  const base = mkdtempSync(join(tmpdir(), "gsd-orchestrator-retry-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M004", title: "Milestone 4", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M004", title: "Slice", status: "active", depends: [] });
  const ctx = { model: {}, modelRegistry: { getAll: () => [], getAvailable: () => [] } } as never;
  const pi = { getActiveTools: () => [] } as never;
  const session = {
    basePath: "/tmp/worktree-fixture",
    pendingOrchestrationDispatch: null,
    pendingVerificationRetryDispatch: {
      unitType: "complete-slice",
      unitId: "M004/S01",
      prompt: "repair slice closeout",
      pauseAfterUatDispatch: false,
      state: stateSnapshot,
      mid: "M004",
      midTitle: "Milestone 4",
    },
  } as never;

  const result = await decideOrchestratorDispatch(ctx, pi, base, session, { stateSnapshot });

  assert.ok(result);
  if (!result || !("unitType" in result)) assert.fail("expected dispatch decision");
  assert.equal(result.unitType, "complete-slice");
  assert.equal(result.unitId, "M004/S01");
  assert.equal(result.reason, "verification-retry");
  const sess = session as {
    pendingVerificationRetryDispatch: unknown;
    pendingOrchestrationDispatch: { prompt?: string; state?: unknown } | null;
  };
  assert.equal(sess.pendingVerificationRetryDispatch, null);
  assert.equal(sess.pendingOrchestrationDispatch?.prompt, "repair slice closeout");
  assert.equal(sess.pendingOrchestrationDispatch?.state, stateSnapshot);
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
});

test("decideOrchestratorDispatch blocks a non-slice verification retry without DB authority", async () => {
  closeDatabase();
  const stateSnapshot = makeState();
  const pendingRetry = {
    unitType: "validate-milestone",
    unitId: "M001",
    prompt: "retry validation",
    pauseAfterUatDispatch: false,
    state: stateSnapshot,
    mid: "M001",
    midTitle: "Milestone",
  };
  const session = {
    basePath: "/tmp/worktree-fixture",
    pendingOrchestrationDispatch: null,
    pendingVerificationRetryDispatch: pendingRetry,
  } as never;

  const result = await decideOrchestratorDispatch(
    { model: {}, modelRegistry: { getAll: () => [], getAvailable: () => [] } } as never,
    { getActiveTools: () => [] } as never,
    "/tmp/project-fixture",
    session,
    { stateSnapshot },
  );

  assert.deepEqual(result, {
    kind: "blocked",
    reason: "Cannot dispatch validate-milestone M001: workflow DB is unavailable.",
    action: "stop",
    guardId: "dispatch-authority",
  });
  assert.equal(
    (session as unknown as { pendingVerificationRetryDispatch: unknown }).pendingVerificationRetryDispatch,
    pendingRetry,
  );
});

test("decideOrchestratorDispatch clears verification retry state when skipping an already closed retry dispatch", async () => {
  const stateSnapshot = makeState();
  const base = mkdtempSync(join(tmpdir(), "gsd-orchestrator-closed-retry-"));

  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "Slice", status: "active" });
    insertTask({ milestoneId: "M001", sliceId: "S01", id: "T01", title: "Task", status: "complete" });

    const retryRule: UnifiedRule = {
      name: "test-closed-verification-retry",
      when: "dispatch",
      evaluation: "first-match",
      where: async () => ({
        action: "dispatch" as const,
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "retry closed task",
      }),
      then: (r: unknown) => r,
    };
    setRegistry(new RuleRegistry([retryRule]));

    const ctx = { model: {}, modelRegistry: { getAll: () => [], getAvailable: () => [] } } as never;
    const pi = { getActiveTools: () => [] } as never;
    const session = {
      basePath: base,
      pendingOrchestrationDispatch: { stale: true },
      pendingVerificationRetry: {
        unitId: "M001/S01/T01",
        failureContext: "artifact missing",
        attempt: 1,
      },
    } as never;

    const result = await decideOrchestratorDispatch(ctx, pi, base, session, { stateSnapshot });

    assert.deepEqual(result, {
      kind: "skipped",
      code: "already-closed",
      reason: "execute-task M001/S01/T01 is already complete",
    });
    const sess = session as { pendingVerificationRetry: unknown; pendingOrchestrationDispatch: unknown };
    assert.equal(sess.pendingVerificationRetry, null);
    assert.equal(sess.pendingOrchestrationDispatch, null);
  } finally {
    resetRegistry();
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("decideOrchestratorDispatch re-dispatches a closed execute-task for git-commit remediation instead of skipping", async () => {
  // Regression for #1491 / bugbot 3609601306: after task verification the task
  // is already `complete` in the DB, but its post-task commit was rejected by a
  // pre-commit hook. The remediation retry carries a `git-commit:` signature, so
  // the already-closed dispatch guard must honor it (re-deliver the hook rejection
  // to the agent) rather than clearing the retry and stranding the uncommitted work.
  const stateSnapshot = makeState();
  const base = mkdtempSync(join(tmpdir(), "gsd-orchestrator-closed-remediation-"));

  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "Slice", status: "active" });
    insertTask({ milestoneId: "M001", sliceId: "S01", id: "T01", title: "Task", status: "complete" });

    const ctx = { model: {}, modelRegistry: { getAll: () => [], getAvailable: () => [] } } as never;
    const pi = { getActiveTools: () => [] } as never;
    const session = {
      basePath: base,
      pendingOrchestrationDispatch: null,
      pendingVerificationRetryDispatch: {
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "retry commit remediation",
        pauseAfterUatDispatch: false,
        state: stateSnapshot,
        mid: "M001",
        midTitle: "Milestone",
      },
      pendingVerificationRetry: {
        unitId: "M001/S01/T01",
        failureContext: "Git commit failed after task verification. blocked by test hook",
        signature: "git-commit:1:blocked by test hook",
        attempt: 1,
      },
    } as never;

    const result = await decideOrchestratorDispatch(ctx, pi, base, session, { stateSnapshot });

    assert.ok(result);
    if (!result || !("unitType" in result)) assert.fail("expected dispatch decision, not skip");
    assert.equal(result.unitType, "execute-task");
    assert.equal(result.unitId, "M001/S01/T01");
    assert.equal(result.reason, "verification-retry");
    const sess = session as {
      pendingVerificationRetry: { unitId?: string } | null;
      pendingVerificationRetryDispatch: unknown;
      pendingOrchestrationDispatch: { prompt?: string } | null;
    };
    // The retry must survive the already-closed guard (not be cleared) so the
    // hook rejection is re-delivered to the agent on the next unit run.
    assert.equal(sess.pendingVerificationRetry?.unitId, "M001/S01/T01");
    assert.equal(sess.pendingVerificationRetryDispatch, null);
    assert.equal(sess.pendingOrchestrationDispatch?.prompt, "retry commit remediation");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("decideOrchestratorDispatch preserves stop reason as a blocked decision", async (t) => {
  openDispatchDecisionDatabase(t);
  const stateSnapshot = makeState();
  const stopRule: UnifiedRule = {
    name: "test-stop",
    when: "dispatch",
    evaluation: "first-match",
    where: async () => ({
      action: "stop" as const,
      reason: "remediation blocker",
      level: "warning" as const,
    }),
    then: (r: unknown) => r,
  };
  setRegistry(new RuleRegistry([stopRule]));

  try {
    const ctx = { model: {}, modelRegistry: { getAll: () => [], getAvailable: () => [] } } as never;
    const pi = { getActiveTools: () => [] } as never;

    const result = await decideOrchestratorDispatch(ctx, pi, "/tmp/parity-fixture", undefined, { stateSnapshot });

    assert.deepEqual(result, {
      kind: "blocked",
      reason: "remediation blocker",
      action: "pause",
      guardId: "dispatch-rule-stop",
    });
  } finally {
    resetRegistry();
  }
});

test("decideOrchestratorDispatch preserves dispatch skip instead of collapsing it to no remaining units", async (t) => {
  openDispatchDecisionDatabase(t);
  const stateSnapshot = makeState();
  const skipRule: UnifiedRule = {
    name: "test-skip-gate",
    when: "dispatch",
    evaluation: "first-match",
    where: async () => ({
      action: "skip" as const,
      matchedRule: "evaluating-gates -> omitted",
    }),
    then: (r: unknown) => r,
  };
  setRegistry(new RuleRegistry([skipRule]));

  try {
    const ctx = { model: {}, modelRegistry: { getAll: () => [], getAvailable: () => [] } } as never;
    const pi = { getActiveTools: () => [] } as never;

    const result = await decideOrchestratorDispatch(ctx, pi, "/tmp/parity-fixture", undefined, { stateSnapshot });

    assert.deepEqual(result, {
      kind: "skipped",
      code: "no-dispatch",
      reason: "evaluating-gates -> omitted",
    });
  } finally {
    resetRegistry();
  }
});
