// gsd-pi — Orchestrator advance() log coverage.
//
// The orchestrator's private methods (findPriorSliceCompletionBlocker,
// emitUokGate, mergePendingCompleteMilestone) each emit `engine` warnings on
// their failure paths (orchestrator.ts:660 / :538 / :637). They are only
// reachable by driving advance() through a real AutoOrchestrator constructed
// via createAutoOrchestrator. This file builds a minimal fixture (git repo +
// seeded DB + session lock + registry dispatch rule, modelled on
// auto-orchestrator.test.ts's makeFixture) and drives advance() into each
// branch, asserting the log output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createAutoOrchestrator,
  _setProjectionRebuildFnForTests,
  type OrchestratorContext,
} from "../auto/orchestrator.ts";
import type { AutoSessionContext } from "../auto/contracts.ts";
import { RuleRegistry, setRegistry, resetRegistry } from "../rule-registry.ts";
import type { UnifiedRule } from "../rule-types.ts";
import {
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  _getAdapter,
} from "../gsd-db.ts";
import { resolveExpectedArtifactPath } from "../auto-artifact-paths.ts";
import { AutoSession } from "../auto/session.ts";
import { acquireSessionLock, releaseSessionLock } from "../session-lock.ts";
import { clearGSDPreferencesCache } from "../preferences.ts";
import { invalidateAllCaches } from "../cache.ts";
import { invalidateStateCache } from "../state.ts";
import {
  drainLogs,
  setStderrLoggingEnabled,
  _resetLogs,
  type LogEntry,
} from "../workflow-logger.ts";

const SESSION_CONTEXT: AutoSessionContext = { basePath: "/tmp/project", trigger: "manual" };

function gitInit(base: string): void {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, ".gitkeep"), "");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: base, stdio: "ignore" });
}

interface FixtureOptions {
  /** Override the session's originalBasePath (used by findPriorSliceCompletionBlocker's guard). */
  originalBasePath?: string;
  /** The dispatch decision the registry rule returns. */
  dispatch?: UnifiedRule["where"];
  /** Drop the gate_runs table after seeding so emitUokGate's insertGateRun throws (:538 path). */
  dropGateRuns?: boolean;
  /** Write project preferences that disable UOK gate telemetry. */
  disableUokGates?: boolean;
}

interface Fixture {
  base: string;
  session: AutoSession;
  orchestrator: ReturnType<typeof createAutoOrchestrator>;
  getAvailableCalls(): number;
  cleanup(): void;
}

function makeFixture(opts: FixtureOptions = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "gsd-orch-logs-"));
  gitInit(base);

  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  mkdirSync(join(sliceDir, "tasks"), { recursive: true });

  invalidateAllCaches();
  invalidateStateCache();
  clearGSDPreferencesCache();
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active", risk: "low", depends: [], demo: "", sequence: 1 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "active" });
  if (opts.dropGateRuns) {
    // Break the gate_runs sink so UokGateRunner.run → insertGateRun throws,
    // exercising emitUokGate's catch (orchestrator.ts:538).
    _getAdapter()!.exec("DROP TABLE gate_runs");
  }

  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    ["# M001: Milestone", "", "**Vision:** Fixture", "", "## Slices", "", "- [ ] **S01: Slice** `risk:low` `depends:[]`", ""].join("\n"),
  );
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    ["# S01: Slice", "", "**Goal:** g", "**Demo:** d", "", "## Tasks", "", "- [ ] **T01: Task** `est:1h`", ""].join("\n"),
  );
  if (opts.disableUokGates) {
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      "---\nuok:\n  gates:\n    enabled: false\n---\n",
    );
    clearGSDPreferencesCache();
  }

  acquireSessionLock(base);

  const session = new AutoSession();
  session.basePath = base;
  // originalBasePath feeds resolveWorktreeProjectRoot inside
  // findPriorSliceCompletionBlocker → getMainBranch(guardBasePath). Pointing it
  // at a non-git directory makes branch discovery throw → :660 warning.
  session.originalBasePath = opts.originalBasePath ?? base;
  session.currentMilestoneId = "M001";
  session.resourceVersionOnStart = null;

  let getAvailableCalls = 0;
  const ctx: OrchestratorContext = {
    ctx: {
      model: {},
      modelRegistry: {
        getAll: () => [],
        getAvailable: () => {
          getAvailableCalls += 1;
          return [];
        },
      },
      ui: { notify() {} },
    } as never,
    pi: { getActiveTools: () => [] } as never,
    dispatchBasePath: base,
    runtimeBasePath: base,
    session,
  };

  const rule: UnifiedRule = {
    name: "fixture-dispatch",
    when: "dispatch",
    evaluation: "first-match",
    where: opts.dispatch ?? (async () => ({
      action: "dispatch",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "fixture-prompt",
    })),
    then: (r) => r,
  };
  setRegistry(new RuleRegistry([rule]));

  const orchestrator = createAutoOrchestrator(ctx);

  return {
    base,
    session,
    orchestrator,
    getAvailableCalls: () => getAvailableCalls,
    cleanup() {
      resetRegistry();
      clearGSDPreferencesCache();
      try { releaseSessionLock(base); } catch { /* */ }
      try { closeDatabase(); } catch { /* */ }
      try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

/** Capture log entries emitted during fn, with stderr suppressed. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: LogEntry[] }> {
  const previous = setStderrLoggingEnabled(false);
  _resetLogs();
  try {
    const result = await fn();
    return { result, logs: drainLogs() };
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previous);
  }
}

// orchestrator.ts:660 — findPriorSliceCompletionBlocker catches a getMainBranch
// failure and logs `branch discovery failed, falling back to main`. Triggered
// by pointing session.originalBasePath at a non-git directory.
test("advance() logs an engine warning when branch discovery fails (orchestrator.ts:660)", async (t) => {
  // A second temp dir that is deliberately NOT a git repo.
  const nonGit = mkdtempSync(join(tmpdir(), "gsd-orch-logs-nongit-"));
  const f = makeFixture({ originalBasePath: nonGit });
  t.after(() => {
    f.cleanup();
    rmSync(nonGit, { recursive: true, force: true });
  });

  const { logs } = await captureLogs(() => f.orchestrator.advance());

  const branchWarn = logs.find(
    (e) => e.component === "engine" && e.severity === "warn" && /branch discovery failed/u.test(e.message),
  );
  assert.ok(
    branchWarn,
    "an engine warning must be logged when getMainBranch fails (got: " +
      logs.filter((e) => e.component === "engine").map((e) => e.message).join(" | ") + ")",
  );
  assert.match(branchWarn!.message, /branch discovery failed, falling back to main/u);
});

// orchestrator.ts:538 — emitUokGate catches a UokGateRunner.run failure and logs
// `uok gate emit failed`. Gates are enabled by default (uok.gates.enabled ?? true),
// and runner.run persists via insertGateRun; dropping the gate_runs table makes
// that persistence throw, surfacing through the catch.
test("advance() logs an engine warning when the uok gate emit fails (orchestrator.ts:538)", async (t) => {
  const f = makeFixture({ dropGateRuns: true });
  t.after(() => f.cleanup());

  const { logs } = await captureLogs(() => f.orchestrator.advance());

  const uokFail = logs.find(
    (e) => e.component === "engine" && e.severity === "warn" && /uok gate emit failed/u.test(e.message),
  );
  assert.ok(
    uokFail,
    "an engine warning must be logged when UokGateRunner.run fails (got: " +
      logs.filter((e) => e.component === "engine").map((e) => e.message).join(" | ") + ")",
  );
  assert.match(uokFail!.message, /uok gate emit failed/u);
  assert.equal(uokFail!.context?.file, "orchestrator.ts");
  assert.ok(uokFail!.context?.gateId, "the failing gate id must be captured in context");
});

test("advance() resolves disabled uok gate flags once before gate emission", async (t) => {
  const f = makeFixture({ dropGateRuns: true, disableUokGates: true });
  t.after(() => f.cleanup());

  const { logs } = await captureLogs(() => f.orchestrator.advance());

  assert.equal(
    logs.some((e) => e.component === "engine" && /uok gate emit failed/u.test(e.message)),
    false,
    "disabled uok gates must not construct the runner or write gate rows",
  );
  assert.ok(
    f.getAvailableCalls() <= 2,
    `uok gate preferences should be resolved once per advance, not once per emitted gate (getAvailable calls: ${f.getAvailableCalls()})`,
  );
});

// orchestrator.ts:637 — mergePendingCompleteMilestone catches a
// rebuildMarkdownProjectionsFromDb failure after the system-owned milestone
// merge and logs `markdown projection rebuild after settlement merge failed`.
// Reached only when advance() hits a merge-pending settlement (auto-worktree,
// complete milestone, proven closeout, no remaining units). We build that state
// (real git worktree + closed milestone + SUMMARY artifact, modelled on
// milestone-settlement.test.ts), inject a throwing rebuild via the test seam,
// and assert the engine warning.
test("advance() logs an engine warning when the post-settlement projection rebuild fails (orchestrator.ts:637)", async (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-orch-logs-settle-"));
  // Real git repo at the project root.
  execFileSync("git", ["init", "-b", "main"], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: projectRoot, stdio: "ignore" });
  writeFileSync(join(projectRoot, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "."], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "chore: init"], { cwd: projectRoot, stdio: "ignore" });

  // Auto-worktree for M001 — required so evaluateAllCompleteSettlement returns
  // merge-pending (isActiveUnmergedWorktree must be true).
  const worktree = join(projectRoot, ".gsd", "worktrees", "M001");
  mkdirSync(dirname(worktree), { recursive: true });
  execFileSync("git", ["worktree", "add", "-b", "milestone/M001", worktree, "HEAD"], { cwd: projectRoot, stdio: "ignore" });

  // Seed a closed milestone + proven closeout SUMMARY so proveMilestoneCloseout
  // passes and the settlement resolves to merge-pending.
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
  invalidateAllCaches();
  invalidateStateCache();
  openDatabase(join(projectRoot, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone One", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice One", status: "complete" });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task One",
    status: "complete",
    verificationResult: "passed",
  });
  insertAssessment({
    path: ".gsd/milestones/M001/M001-VALIDATION.md",
    milestoneId: "M001",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "verdict: pass\n",
  });
  // Create the milestone projection dir in the worktree BEFORE resolving the
  // summary artifact path (resolveExpectedArtifactPath needs the dir to exist).
  const milestoneProjDir = join(worktree, ".gsd", "milestones", "M001");
  mkdirSync(milestoneProjDir, { recursive: true });
  // A content-bearing legacy milestone dir requires at least one non-META file
  // (dirIsContentBearingLegacyMilestone) so the layout sniffer treats it as a
  // real legacy milestone rather than a metadata-only placeholder.
  writeFileSync(join(milestoneProjDir, "M001-CONTEXT.md"), "# M001\n");
  const summaryPath = resolveExpectedArtifactPath("complete-milestone", "M001", worktree);
  assert.ok(summaryPath, "complete-milestone summary path must resolve");
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, "# Milestone One\n\nComplete.\n");

  acquireSessionLock(projectRoot);

  const session = new AutoSession();
  session.basePath = worktree;
  session.originalBasePath = projectRoot;
  session.currentMilestoneId = "M001";
  session.resourceVersionOnStart = null;

  const ctx: OrchestratorContext = {
    ctx: { model: {}, modelRegistry: { getAll: () => [], getAvailable: () => [] }, ui: { notify() {} } } as never,
    pi: { getActiveTools: () => [] } as never,
    dispatchBasePath: worktree,
    runtimeBasePath: worktree,
    session,
  };

  // Registry rule returns skip (no remaining units) so advance() reaches the
  // no-remaining-units settlement branch and calls mergePendingCompleteMilestone.
  const rule: UnifiedRule = {
    name: "settle-no-units",
    when: "dispatch",
    evaluation: "first-match",
    where: async () => ({ action: "skip", matchedRule: "settle-no-units" }),
    then: (r) => r,
  };
  setRegistry(new RuleRegistry([rule]));

  const orchestrator = createAutoOrchestrator(ctx);

  // Inject a throwing projection rebuild so :637 fires after exitMilestone
  // completes the system-owned merge. restoreDefault() in finally keeps the
  // seam production-neutral for every other test in the process.
  const restoreDefault = _setProjectionRebuildFnForTests(async () => {
    throw new Error("forced projection rebuild failure");
  });

  t.after(() => {
    restoreDefault();
    resetRegistry();
    try { releaseSessionLock(projectRoot); } catch { /* */ }
    try { closeDatabase(); } catch { /* */ }
    try { execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: projectRoot, stdio: "ignore" }); } catch { /* */ }
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  const previous = setStderrLoggingEnabled(false);
  _resetLogs();
  let logs: LogEntry[] = [];
  try {
    await orchestrator.advance();
    logs = drainLogs();
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previous);
  }

  const rebuildWarn = logs.find(
    (e) => e.component === "engine" && e.severity === "warn" &&
      /markdown projection rebuild after settlement merge failed/u.test(e.message),
  );
  assert.ok(
    rebuildWarn,
    "an engine warning must be logged when the post-settlement projection rebuild fails (got: " +
      logs.filter((e) => e.component === "engine").map((e) => e.message).join(" | ") + ")",
  );
  assert.match(rebuildWarn!.message, /forced projection rebuild failure/u);
});
