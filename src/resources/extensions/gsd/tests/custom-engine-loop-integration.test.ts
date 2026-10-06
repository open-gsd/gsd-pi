/**
 * custom-engine-loop-integration.test.ts — Integration test proving that
 * autoLoop dispatches a 3-step custom workflow through the real pipeline.
 *
 * Creates a real run directory with GRAPH.yaml, mocks LoopDeps minimally,
 * and verifies all 3 steps complete in dependency order.
 */

import { describe, it, afterEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { autoLoop } from "../auto/loop.js";
import {
  resolveAgentEnd,
  _getCurrentResolveForTest,
  _hasPendingResolveForTest,
  _resetPendingResolve,
} from "../auto/resolve.js";
import type { LoopDeps } from "../auto/loop-deps.js";
import { WorktreeStateProjection } from "../worktree-state-projection.js";
import type { SessionLockStatus } from "../session-lock.js";
import { writeGraph, readGraph, type WorkflowGraph, type GraphStep } from "../graph.ts";
import { SourceObservationStore } from "../source-observations.js";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.js";
import { getAutoWorker, markWorkerStopping, registerAutoWorker } from "../db/auto-workers.ts";
import { getDispatchById, getLatestForUnit, recordRunDispatchClaim } from "../db/unit-dispatches.ts";
import { CustomWorkflowEngine } from "../custom-workflow-engine.ts";
import {
  customWorkflowRunId,
  getLatestCustomWorkflowStepVerification,
} from "../db/custom-workflow-runs.ts";
import { createRun, listRuns } from "../run-manager.ts";
import { recordNonAdvancingOutcome } from "../auto-liveness-backstop.js";
import { stringify } from "yaml";

// ─── Helpers ─────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loop-integ-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * A run directory from a release that kept runs in files, with an open
 * database: the engine imports the directory to rows on its first use.
 */
function makeRunDir(): string {
  const dir = makeTmpDir();
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(dir, ".gsd", "gsd.db")), true);
  return dir;
}

async function resolveNextAgentEnd(timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!_hasPendingResolveForTest()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for pending agent_end resolver");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
}

afterEach(() => {
  _resetPendingResolve();
  // Close the singleton workflow database while its temp dir still exists —
  // closing it after the directory is gone raises a disk I/O error that leaves
  // the stale handle installed for the next case.
  closeDatabase();
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM — OS cleans up temp dirs */ }
  }
  tmpDirs.length = 0;
});

function makeStep(overrides: Partial<GraphStep> & { id: string }): GraphStep {
  return {
    title: overrides.id,
    status: "pending",
    prompt: `Do ${overrides.id}`,
    dependsOn: [],
    ...overrides,
  };
}

function makeGraph(steps: GraphStep[], name = "test-wf"): WorkflowGraph {
  return {
    steps,
    metadata: { name, createdAt: "2026-01-01T00:00:00.000Z" },
  };
}

/** Write a minimal DEFINITION.yaml that matches the graph steps (needed by resolveDispatch since S06). */
function writeDefinition(runDir: string, steps: GraphStep[], name = "test-wf"): void {
  const def = {
    version: 1,
    name,
    description: `Test workflow: ${name}`,
    steps: steps.map((s) => ({
      id: s.id,
      name: s.title ?? s.id,
      prompt: s.prompt ?? `Do ${s.id}`,
      produces: `${s.id}/output.md`,
      ...(s.dependsOn?.length ? { requires: s.dependsOn } : {}),
    })),
  };
  writeFileSync(join(runDir, "DEFINITION.yaml"), stringify(def));
}

function makeMockCtx() {
  return {
    ui: { notify: () => {}, setStatus: () => {} },
    model: { id: "test-model" },
    sessionManager: { getSessionFile: () => "/tmp/session.json" },
  } as any;
}

function makeMockPi() {
  const calls: unknown[] = [];
  return {
    sendMessage: (...args: unknown[]) => {
      calls.push(args);
    },
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
    calls,
  } as any;
}

function makeLoopSession(overrides?: Record<string, unknown>) {
  return {
    // A custom workflow step is claimed as a dispatch row, so a session that
    // runs one needs a registered worker.
    workerId: overrides?.activeEngineId === "custom" && _getAdapter()
      ? registerAutoWorker({ projectRootRealpath: String(overrides.basePath) })
      : null,
    active: true,
    verbose: false,
    stepMode: false,
    paused: false,
    basePath: "/tmp/project",
    originalBasePath: "",
    currentMilestoneId: null,
    currentUnit: null,
    unitExecutionInFlight: false,
    currentUnitRouting: null,
    sourceObservations: new SourceObservationStore(),
    completedUnits: [],
    resourceVersionOnStart: null,
    lastPromptCharCount: undefined,
    lastBaselineCharCount: undefined,
    lastBudgetAlertLevel: 0,
    pendingVerificationRetry: null,
    pendingCrashRecovery: null,
    autoModeStartModel: null,
    unitDispatchCount: new Map<string, number>(),
    unitLifetimeDispatches: new Map<string, number>(),
    verificationRetryCount: new Map<string, number>(),
    unclaimedUnitBudgets: new Map<string, number>(),
    gitService: null,
    autoStartTime: Date.now(),
    activeEngineId: null,
    activeRunDir: null,
    rewriteAttemptCount: 0,
    cmdCtx: {
      newSession: () => Promise.resolve({ cancelled: false }),
      getContextUsage: () => ({ percent: 10, tokens: 1000, limit: 10000 }),
    },
    setCurrentUnit(this: any, unit: any) {
      this.currentUnit = unit;
      this.sourceObservations.beginUnit({
        unitType: unit.type,
        unitId: unit.id,
        startedAt: unit.startedAt,
        basePath: unit.workspaceRoot ?? this.basePath,
      });
    },
    clearCurrentUnit(this: any) {
      this.currentUnit = null;
      this.sourceObservations.clear();
    },
    clearTimers: () => {},
    lockBasePath: "/tmp/project",
    ...overrides,
  } as any;
}

function makeMockDeps(overrides?: Partial<LoopDeps>): LoopDeps & { callLog: string[] } {
  const callLog: string[] = [];

  const baseDeps: LoopDeps = {
    // These loop-integration cases run against a bare temp run dir with no
    // workflow DB, so the ADR-047 backstop would fail closed on its first
    // non-advancing turn and stop the loop before the behaviour under test.
    // Backstop adjudication has its own coverage in auto-loop.test.ts.
    adjudicateNonAdvancingOutcome: () => null,
    lockBase: () => "/tmp/test-lock",
    buildSnapshotOpts: () => ({}),
    stopAuto: async (_ctx, _pi, reason) => {
      callLog.push(`stopAuto:${reason ?? "no-reason"}`);
    },
    pauseAuto: async () => {
      callLog.push("pauseAuto");
    },
    clearUnitTimeout: () => {},
    updateProgressWidget: () => {},
    syncCmuxSidebar: () => {},
    logCmuxEvent: () => {},
    invalidateAllCaches: () => {},
    deriveState: async () => {
      callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Workflow", status: "active" },
        activeSlice: null,
        activeTask: null,
        registry: [],
        blockers: [],
      } as any;
    },
    rebuildState: async () => {},
    loadEffectiveGSDPreferences: () => undefined,
    preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
    checkResourcesStale: () => null,
    validateSessionLock: () => ({ valid: true } as SessionLockStatus),
    updateSessionLock: () => {},
    handleLostSessionLock: () => {},
    sendDesktopNotification: () => {},
    setActiveMilestoneId: () => {},
    pruneQueueOrder: () => {},
    isInAutoWorktree: () => false,
    shouldUseWorktreeIsolation: () => false,
    teardownAutoWorktree: () => {},
    createAutoWorktree: () => "/tmp/wt",
    captureIntegrationBranch: () => {},
    getIsolationMode: () => "none",
    getCurrentBranch: () => "main",
    autoWorktreeBranch: () => "auto/M001",
    resolveMilestoneFile: () => null,
    reconcileMergeState: () => "clean",
    preflightCleanRoot: () => ({ stashPushed: false, summary: "" }),
    postflightPopStash: () => ({
      restored: true,
      needsManualRecovery: false,
      message: "restored",
    }),
    getLedger: () => null,
    getBudgetSpend: () => 0,
    formatCost: (c: number) => `$${c.toFixed(2)}`,
    getBudgetAlertLevel: () => 0,
    getNewBudgetAlertLevel: () => 0,
    getBudgetEnforcementAction: () => "none",
    getManifestStatus: async () => null,
    collectSecretsFromManifest: async () => null,
    resolveDispatch: async () => {
      callLog.push("resolveDispatch");
      return { action: "dispatch" as const, unitType: "execute-task", unitId: "M001/S01/T01", prompt: "unused" };
    },
    runPreDispatchHooks: () => ({ firedHooks: [], action: "proceed" }),
    getPriorSliceCompletionBlocker: () => null,
    getMainBranch: () => "main",
    closeoutUnit: async () => {},
    recordOutcome: () => {},
    writeLock: () => {},
    captureAvailableSkills: () => {},
    ensurePreconditions: () => {},
    updateSliceProgressCache: () => {},
    selectAndApplyModel: async () => ({ routing: null, appliedModel: null }),
    resolveModelId: () => undefined,
    startUnitSupervision: () => {},
    getDeepDiagnostic: () => null,
    isDbAvailable: () => false,
    reorderForCaching: (p: string) => p,
    existsSync: (p: string) => existsSync(p),
    readFileSync: () => "",
    atomicWriteSync: () => {},
    GitServiceImpl: class {} as any,
    lifecycle: {
      enterMilestone: () => ({ ok: true, mode: "none", path: "/tmp/project" }),
      exitMilestone: (_mid: string, opts: { merge: boolean }) => ({
        ok: true,
        merged: opts.merge,
        codeFilesChanged: false,
      }),
      degradeToBranchMode: () => {},
      restoreToProjectRoot: () => {},
      isInMilestone: () => true,
      getCurrentMilestoneIfAny: () => "M001",
    } as any,
    worktreeProjection: new WorktreeStateProjection(),
    postUnitPreVerification: async () => "continue" as const,
    runPostUnitVerification: async () => "continue" as const,
    postUnitPostVerification: async () => "continue" as const,
    getSessionFile: () => "/tmp/session.json",
    emitJournalEvent: (entry) => {
      callLog.push(`journal:${entry.eventType}`);
    },
    recordVerificationPause: () => {},
  };

  return { ...baseDeps, ...overrides, callLog };
}

interface VerificationObservation {
  inputPayload: string;
  count: number;
  tripped: boolean;
}

async function runVerificationScenario(input: {
  runDir: string;
  mutateFiles: () => void;
  observations: VerificationObservation[];
}): Promise<void> {
  input.mutateFiles();
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const session = makeLoopSession({
    activeEngineId: "custom",
    activeRunDir: input.runDir,
    basePath: input.runDir,
  });
  const deps = makeMockDeps({
    adjudicateNonAdvancingOutcome: (_session, outcome) => {
      const recorded = recordNonAdvancingOutcome({
        scopeId: realpathSync(input.runDir),
        guardId: outcome.guardId,
        unitType: outcome.unitType,
        unitId: outcome.unitId,
        inputPayload: outcome.inputPayload,
      }, outcome.sanctionedExit ? { sanctionedExit: outcome.sanctionedExit } : undefined);
      if (outcome.guardId === "custom-engine-verify") {
        input.observations.push({
          inputPayload: outcome.inputPayload,
          count: recorded.count,
          tripped: recorded.tripped,
        });
      }
      return null;
    },
    pauseAuto: async () => {
      session.active = false;
    },
    stopAuto: async (_ctx, _pi, reason) => {
      deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
      session.active = false;
    },
  });

  const resolver = setInterval(() => {
    if (_hasPendingResolveForTest()) {
      resolveAgentEnd({ messages: [{ role: "assistant" }] });
    }
  }, 25);
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      autoLoop(ctx, pi, session, deps),
      new Promise((_, reject) =>
        timeout = setTimeout(() => {
          session.active = false;
          resolveAgentEnd({ messages: [{ role: "assistant" }] });
          reject(new Error(`autoLoop did not stop; log=${deps.callLog.join(",")}`));
        }, 5_000),
      ),
    ]);
  } finally {
    clearInterval(resolver);
    if (timeout) clearTimeout(timeout);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────

// concurrency 1: these cases share process-global state — the pending
// agent_end resolver and the singleton workflow database — so two DB-backed
// cases running at once would close each other's database mid-run.
describe("Custom engine loop integration", { concurrency: 1 }, () => {
  it("threads custom-engine runGuards ids and budget inputs through adjudication", async () => {
    _resetPendingResolve();
    const runDir = makeRunDir();
    const graph = makeGraph([makeStep({ id: "guarded-step" })], "guarded-workflow");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "guarded-workflow");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });
    let adjudicated: { guardId: string; inputPayload: string } | undefined;
    const deps = makeMockDeps({
      loadEffectiveGSDPreferences: () => ({
        preferences: { budget_ceiling: 5, budget_enforcement: "pause" },
      } as any),
      getBudgetSpend: () => 10,
      getNewBudgetAlertLevel: () => 100,
      getBudgetAlertLevel: () => 100,
      getBudgetEnforcementAction: () => "pause",
      adjudicateNonAdvancingOutcome: (_session, input) => {
        adjudicated = { guardId: input.guardId, inputPayload: input.inputPayload };
        return null;
      },
    });

    await autoLoop(ctx, pi, s, deps);

    assert.equal(adjudicated?.guardId, "budget-pause");
    assert.deepEqual(JSON.parse(adjudicated!.inputPayload), {
      budgetCeiling: 5,
      totalCost: 10,
      budgetPct: 2,
      enforcement: "pause",
      effectiveAction: "pause",
      hookAction: null,
      newBudgetAlertLevel: 100,
      thresholdPct: 100,
    });
  });

  it("dispatches a 3-step workflow through autoLoop and all steps complete", async () => {
    _resetPendingResolve();

    // Create a real run directory with 3 steps: a → b → c
    const runDir = makeRunDir();
    const graph = makeGraph([
      makeStep({ id: "step-a" }),
      makeStep({ id: "step-b", dependsOn: ["step-a"] }),
      makeStep({ id: "step-c", dependsOn: ["step-b"] }),
    ], "integ-test");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "integ-test");

    const ctx = makeMockCtx();
    const pi = makeMockPi();

    let unitCount = 0;

    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });

    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
    });

    // Start autoLoop — it will block inside runUnit awaiting resolveAgentEnd
    const loopPromise = autoLoop(ctx, pi, s, deps);

    // Each iteration: the custom engine path derives state → resolves dispatch →
    // runs guards → runs runUnitPhase (which calls runUnit) → we resolve →
    // engine.reconcile marks the step complete → loop continues.
    // We need to resolve resolveAgentEnd for each step.

    // Step 1: step-a
    unitCount++;
    await resolveNextAgentEnd();

    // Step 2: step-b
    unitCount++;
    await resolveNextAgentEnd();

    // Step 3: step-c
    unitCount++;
    await resolveNextAgentEnd();

    // After step-c completes, engine.reconcile marks it complete, then
    // next deriveState sees isComplete=true → stopAuto → loop exits
    await loopPromise;

    // Verify GRAPH.yaml shows all 3 steps complete
    const finalGraph = readGraph(runDir);
    assert.equal(finalGraph.steps.length, 3, "Should have 3 steps");
    for (const step of finalGraph.steps) {
      assert.equal(step.status, "complete", `Step ${step.id} should be complete, got ${step.status}`);
      assert.ok(step.finishedAt, `Step ${step.id} should have finishedAt timestamp`);
    }

    // Verify exactly 3 units were dispatched (3 pi.sendMessage calls)
    assert.equal(pi.calls.length, 3, `Should have dispatched exactly 3 units, got ${pi.calls.length}`);

    // Verify the loop stopped because the workflow completed
    const stopEntry = deps.callLog.find((e: string) => e.startsWith("stopAuto:"));
    assert.ok(stopEntry, "stopAuto should have been called");
    assert.ok(
      stopEntry!.includes("Workflow complete"),
      `stopAuto reason should include "Workflow complete", got: ${stopEntry}`,
    );

    assert.equal(
      deps.callLog.filter((e: string) => e === "deriveState").length,
      3,
      "custom engine should stop immediately after a milestone-complete reconcile",
    );

    // Verify dev path was NOT used (resolveDispatch should not appear)
    assert.ok(
      !deps.callLog.includes("resolveDispatch"),
      "Custom engine path should skip resolveDispatch (dev path not taken)",
    );
  });

  it("runs a database-backed run through autoLoop and ignores a hand-edited GRAPH.yaml", async () => {
    _resetPendingResolve();

    const base = realpathSync(makeTmpDir());
    mkdirSync(join(base, ".gsd", "workflow-defs"), { recursive: true });
    writeFileSync(join(base, ".gsd", "workflow-defs", "db-run.yaml"), [
      "version: 1",
      "name: db-run",
      "steps:",
      "  - id: step-a",
      "    name: A",
      "    prompt: Do step-a",
      "    requires: []",
      "    produces: []",
      "  - id: step-b",
      "    name: B",
      "    prompt: Do step-b",
      "    requires: [step-a]",
      "    produces: []",
    ].join("\n"), "utf-8");
    openDatabase(join(base, ".gsd", "gsd.db"));
    const runDir = createRun(base, "db-run");
    // The step rows are the state: a hand edit that marks every step complete is not read.
    const edited = readGraph(runDir);
    writeGraph(runDir, { ...edited, steps: edited.steps.map((step) => ({ ...step, status: "complete" as const })) });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: base,
      workerId: registerAutoWorker({ projectRootRealpath: base }),
    });
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);
    await resolveNextAgentEnd();
    await resolveNextAgentEnd();
    await loopPromise;

    assert.equal(pi.calls.length, 2, "each step is dispatched once");
    assert.ok(deps.callLog.includes("stopAuto:Workflow complete"), deps.callLog.join("\n"));
    assert.deepEqual(listRuns(base)[0]?.steps, { total: 2, completed: 2, pending: 0, active: 0 });
    assert.deepEqual(readGraph(runDir).steps.map((step) => step.status), ["complete", "complete"]);
    // Each step advanced on a stored verification result, here a waiver: no verify policy.
    for (const stepId of ["step-a", "step-b"]) {
      const verification = getLatestCustomWorkflowStepVerification(customWorkflowRunId(runDir), stepId);
      assert.equal(verification?.verdict, "inconclusive", stepId);
      assert.equal(verification?.waiverRationale, "The step has no verify policy.", stepId);
    }
  });

  describe("the dispatch claim of a workflow step", () => {
    /** A one-step run with rows, and a way to start an auto session on it. */
    function makeClaimedRun(t: TestContext) {
      _resetPendingResolve();
      const sessions: Array<{ active: boolean }> = [];
      // A failed assertion must not leave a loop waiting for its agent turn.
      t.after(() => {
        for (const session of sessions) session.active = false;
        resolveAgentEnd({ messages: [{ role: "assistant" }] });
      });
      const base = realpathSync(makeTmpDir());
      mkdirSync(join(base, ".gsd", "workflow-defs"), { recursive: true });
      writeFileSync(join(base, ".gsd", "workflow-defs", "claimed.yaml"), [
        "version: 1",
        "name: claimed",
        "steps:",
        "  - id: only",
        "    name: Only",
        "    prompt: Do the only step",
        "    requires: []",
        "    produces: []",
      ].join("\n"), "utf-8");
      openDatabase(join(base, ".gsd", "gsd.db"));
      const runDir = createRun(base, "claimed");
      const startSession = (overrides?: Partial<LoopDeps>) => {
        const pi = makeMockPi();
        const s = makeLoopSession({
          activeEngineId: "custom",
          activeRunDir: runDir,
          basePath: base,
          canonicalProjectRoot: base,
        });
        const notices: string[] = [];
        const ctx = makeMockCtx();
        ctx.ui.notify = (message: string) => { notices.push(message); };
        const deps = makeMockDeps({
          stopAuto: async (_ctx, _pi, reason) => {
            deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
            s.active = false;
          },
          ...overrides,
        });
        sessions.push(s);
        return { pi, s, notices, loop: autoLoop(ctx, pi, s, deps) };
      };
      return { base, runDir, unitId: `${customWorkflowRunId(runDir)}/only`, startSession };
    }

    async function waitForUnit(): Promise<void> {
      const deadline = Date.now() + 3_000;
      while (!_hasPendingResolveForTest()) {
        assert.ok(Date.now() < deadline, "the session did not start the step");
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    it("a second session cannot run the step that a live session runs", async (t) => {
      const { base, unitId, startSession } = makeClaimedRun(t);

      // The first session runs the step: its unit waits for the agent.
      const first = startSession();
      await waitForUnit();
      const claimed = getLatestForUnit(unitId);
      assert.equal(claimed?.status, "running");
      assert.equal(claimed?.worker_id, first.s.workerId);
      assert.equal(claimed?.unit_type, "custom-step");

      // The two sessions are two processes: the exit of the second loop must
      // not drop the agent turn that the first one waits for in this process.
      const finishFirstUnit = _getCurrentResolveForTest()!;

      // A second session on the same run is refused before its unit runs.
      let secondRanUnit = false;
      const second = startSession({
        taskExecutionBoundary: async () => {
          secondRanUnit = true;
          second.s.active = false;
          return { action: "break", reason: "the second session ran the step" };
        },
      });
      await second.loop;
      assert.equal(secondRanUnit, false, "the second session must not run the step");
      assert.match(second.notices.join("\n"), /is running in another session/);
      assert.equal(getLatestForUnit(unitId)?.id, claimed?.id, "the refused session wrote no dispatch row");
      assert.equal(getLatestForUnit(unitId)?.status, "running");

      // The first session finishes the step and settles its claim.
      finishFirstUnit({ status: "completed", event: { messages: [{ role: "assistant" }] } });
      await first.loop;
      assert.equal(first.pi.calls.length, 1);
      assert.equal(getDispatchById(claimed!.id)?.status, "completed");
      assert.deepEqual(listRuns(base)[0]?.steps, { total: 1, completed: 1, pending: 0, active: 0 });
    });

    it("a session takes over the step of a worker that died", async (t) => {
      const { base, runDir, unitId, startSession } = makeClaimedRun(t);

      // A worker activated the step, claimed it, and died with the claim open.
      const engine = new CustomWorkflowEngine(runDir);
      await engine.resolveDispatch(await engine.deriveState(base), { basePath: base });
      const deadWorker = registerAutoWorker({ projectRootRealpath: base });
      const deadClaim = recordRunDispatchClaim({
        traceId: "dead-session",
        workerId: deadWorker,
        milestoneId: customWorkflowRunId(runDir),
        unitType: "custom-step",
        unitId,
      });
      assert.equal(deadClaim.ok, true);
      _getAdapter()!.prepare("UPDATE workers SET pid = -1 WHERE worker_id = :worker_id")
        .run({ ":worker_id": deadWorker });

      const next = startSession();
      await waitForUnit();
      assert.equal(deadClaim.ok && getDispatchById(deadClaim.dispatchId)?.status, "canceled");
      const takenOver = getLatestForUnit(unitId);
      assert.equal(takenOver?.worker_id, next.s.workerId);
      assert.equal(takenOver?.status, "running");
      assert.equal(takenOver?.attempt_n, 2);

      await resolveNextAgentEnd();
      await next.loop;
      assert.equal(getDispatchById(takenOver!.id)?.status, "completed");
      assert.deepEqual(listRuns(base)[0]?.steps, { total: 1, completed: 1, pending: 0, active: 0 });
    });

    it("a new session in the same process takes over the step of a session that stopped while it ran", async (t) => {
      const { base, unitId, startSession } = makeClaimedRun(t);

      const first = startSession();
      await waitForUnit();
      const stranded = getLatestForUnit(unitId);
      assert.equal(stranded?.status, "running");
      const stoppedWorker: string = first.s.workerId;

      // The order of stopAuto: it marks the worker stopping and closes the
      // database before it unblocks the unit, so the loop cannot settle the claim.
      markWorkerStopping(stoppedWorker);
      first.s.workerId = null;
      first.s.active = false;
      closeDatabase();
      resolveAgentEnd({ messages: [] });
      _resetPendingResolve();
      await first.loop;

      openDatabase(join(base, ".gsd", "gsd.db"));
      assert.equal(getDispatchById(stranded!.id)?.status, "running", "the stop left the claim open");
      assert.equal(getAutoWorker(stoppedWorker)?.pid, process.pid, "the holder has the PID of this process");

      const next = startSession();
      await waitForUnit();
      assert.equal(getDispatchById(stranded!.id)?.status, "canceled");
      const takenOver = getLatestForUnit(unitId);
      assert.equal(takenOver?.worker_id, next.s.workerId);
      assert.equal(takenOver?.status, "running");
      assert.equal(takenOver?.attempt_n, 2);

      await resolveNextAgentEnd();
      await next.loop;
      assert.equal(next.pi.calls.length, 1, "the new session runs the step");
      assert.equal(getDispatchById(takenOver!.id)?.status, "completed");
      assert.deepEqual(listRuns(base)[0]?.steps, { total: 1, completed: 1, pending: 0, active: 0 });
    });

    it("two runs of one workflow claim the same step id independently", async (t) => {
      const { base, unitId, startSession } = makeClaimedRun(t);
      const otherRunId = "claimed/2000-01-01T00-00-00";
      const otherWorker = registerAutoWorker({ projectRootRealpath: base });
      const otherClaim = recordRunDispatchClaim({
        traceId: "other-run",
        workerId: otherWorker,
        milestoneId: otherRunId,
        unitType: "custom-step",
        unitId: `${otherRunId}/only`,
      });
      assert.equal(otherClaim.ok, true);

      const session = startSession();
      await waitForUnit();
      assert.equal(getLatestForUnit(unitId)?.status, "running");
      await resolveNextAgentEnd();
      await session.loop;
      assert.equal(getLatestForUnit(unitId)?.status, "completed");
      assert.equal(getLatestForUnit(`${otherRunId}/only`)?.status, "claimed");
    });
  });

  it("a human-review step pauses once, the operator approves it, and the next step runs", async () => {
    _resetPendingResolve();

    const base = realpathSync(makeTmpDir());
    mkdirSync(join(base, ".gsd", "workflow-defs"), { recursive: true });
    writeFileSync(join(base, ".gsd", "workflow-defs", "release.yaml"), [
      "version: 1",
      "name: release",
      "steps:",
      "  - id: publish",
      "    name: Publish",
      "    prompt: Do publish",
      "    requires: []",
      "    produces: []",
      "    verify:",
      "      policy: human-review",
      "  - id: announce",
      "    name: Announce",
      "    prompt: Do announce",
      "    requires: [publish]",
      "    produces: []",
    ].join("\n"), "utf-8");
    openDatabase(join(base, ".gsd", "gsd.db"));
    const runDir = createRun(base, "release");
    const runId = customWorkflowRunId(runDir);

    const notices: string[] = [];
    const ctx = makeMockCtx();
    ctx.ui.notify = (message: string) => { notices.push(message); };
    const pi = makeMockPi();
    /** One auto session on the run: it ends at a pause or a stop. */
    const runSession = async (): Promise<string[]> => {
      const s = makeLoopSession({
        activeEngineId: "custom",
        activeRunDir: runDir,
        basePath: base,
        workerId: registerAutoWorker({ projectRootRealpath: base }),
      });
      const deps = makeMockDeps({
        // pauseAuto releases the worker of the session, as auto.ts does.
        pauseAuto: async () => {
          deps.callLog.push("pauseAuto");
          markWorkerStopping(s.workerId);
          s.active = false;
        },
        stopAuto: async (_ctx, _pi, reason) => {
          deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
          s.active = false;
        },
      });
      const loopPromise = autoLoop(ctx, pi, s, deps);
      await resolveNextAgentEnd();
      await loopPromise;
      return deps.callLog;
    };

    // The publish step runs, and its human-review policy pauses the run.
    assert.ok((await runSession()).includes("pauseAuto"));
    assert.equal(pi.calls.length, 1, "publish is dispatched once");
    assert.equal(getLatestCustomWorkflowStepVerification(runId, "publish")?.verdict, "inconclusive");
    assert.ok(
      notices.some((message) =>
        message.includes(`/gsd workflow approve ${runId} publish`)
        && message.includes(`/gsd workflow resume ${runId}`)),
      `the pause notice names the approve and resume commands, got: ${notices.join(" | ")}`,
    );

    const { handleWorkflowCommand } = await import("../commands/handlers/workflow.ts");
    const { withCommandCwd } = await import("../commands/context.ts");
    const replies: string[] = [];
    const commandCtx = { ui: { notify: (message: string) => { replies.push(message); } } };
    await withCommandCwd(base, () => handleWorkflowCommand(`workflow approve ${runId} publish`, commandCtx as any, pi));

    // The approval is a stored verification result of the operator.
    const approval = _getAdapter()!.prepare(
      `SELECT verification.verdict AS verdict, operation.actor_type AS actor
       FROM custom_workflow_step_verifications verification
       JOIN workflow_operations operation ON operation.operation_id = verification.operation_id
       WHERE verification.run_id = :run_id AND verification.step_id = 'publish'
       ORDER BY verification.id DESC LIMIT 1`,
    ).get({ ":run_id": runId });
    assert.deepEqual({ ...approval }, { verdict: "pass", actor: "user" }, replies.join(" | "));
    assert.deepEqual(readGraph(runDir).steps.map((step) => step.status), ["complete", "pending"]);

    // The resumed run dispatches announce. publish does not run again.
    const resumed = await runSession();
    assert.ok(resumed.includes("stopAuto:Workflow complete"), resumed.join("\n"));
    assert.equal(pi.calls.length, 2, "only announce is dispatched after the approval");
    assert.ok(String((pi.calls[1] as [{ content?: string }])[0]?.content).includes("Do announce"));
    assert.deepEqual(readGraph(runDir).steps.map((step) => step.status), ["complete", "complete"]);
  });

  it("a verification retry of a database-backed run writes no retry file", async () => {
    _resetPendingResolve();

    const base = realpathSync(makeTmpDir());
    mkdirSync(join(base, ".gsd", "workflow-defs"), { recursive: true });
    // The check fails on its first run and passes on its second.
    writeFileSync(join(base, ".gsd", "workflow-defs", "retry-run.yaml"), [
      "version: 1",
      "name: retry-run",
      "steps:",
      "  - id: step-a",
      "    name: A",
      "    prompt: Do step-a",
      "    requires: []",
      "    produces: []",
      "    verify:",
      "      policy: shell-command",
      "      command: test -f marker || (touch marker && false)",
    ].join("\n"), "utf-8");
    openDatabase(join(base, ".gsd", "gsd.db"));
    const runDir = createRun(base, "retry-run");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: base,
      workerId: registerAutoWorker({ projectRootRealpath: base }),
    });
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);
    await resolveNextAgentEnd();
    await resolveNextAgentEnd();
    await loopPromise;

    const verdicts = _getAdapter()!.prepare(
      "SELECT verdict FROM custom_workflow_step_verifications ORDER BY id",
    ).all().map((row) => row["verdict"]);
    assert.deepEqual(verdicts, ["fail", "pass"]);
    assert.equal(pi.calls.length, 2, "the step is dispatched again after the failed check");
    assert.deepEqual(listRuns(base)[0]?.steps, { total: 1, completed: 1, pending: 0, active: 0 });
    assert.equal(existsSync(join(runDir, "runtime")), false, "the retry count is on the step row");
  });

  it("step mode stops after one custom workflow step", async () => {
    _resetPendingResolve();

    const runDir = makeRunDir();
    const graph = makeGraph([
      makeStep({ id: "step-a" }),
      makeStep({ id: "step-b", dependsOn: ["step-a"] }),
      makeStep({ id: "step-c", dependsOn: ["step-b"] }),
    ], "step-mode-custom");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "step-mode-custom");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
      stepMode: true,
    });

    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);
    await resolveNextAgentEnd();

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        loopPromise,
        new Promise((_, reject) =>
          timeout = setTimeout(() => {
            s.active = false;
            if (_hasPendingResolveForTest()) {
              resolveAgentEnd({ messages: [{ role: "assistant" }] });
            }
            reject(new Error(
              `step mode did not stop after one custom workflow step; calls=${pi.calls.length}; log=${deps.callLog.join(",")}`,
            ));
          }, 1_000),
        ),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    const finalGraph = readGraph(runDir);
    assert.equal(pi.calls.length, 1, "step mode should dispatch exactly one custom step");
    assert.equal(finalGraph.steps[0]?.status, "complete", "first step should complete");
    assert.equal(finalGraph.steps[1]?.status, "pending", "second step should wait for the next /gsd next");
    assert.equal(finalGraph.steps[2]?.status, "pending", "third step should wait for a later step");
    assert.equal(
      deps.callLog.some((e: string) => e.startsWith("stopAuto:")),
      false,
      "step-mode pause should not complete or stop the whole workflow",
    );
    assert.equal(s.preserveStepSurfaceAfterLoopExit, true);
  });

  it("stops when engine reports isComplete on first derive", async () => {
    _resetPendingResolve();

    // Create a run directory where all steps are already complete
    const runDir = makeRunDir();
    const graph = makeGraph([
      makeStep({ id: "step-a", status: "complete" }),
    ], "already-done");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "already-done");

    const ctx = makeMockCtx();
    const pi = makeMockPi();

    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });

    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
    });

    await autoLoop(ctx, pi, s, deps);

    // No units should have been dispatched
    assert.equal(pi.calls.length, 0, "Should not dispatch units for complete workflow");

    // Should stop with "Workflow complete" reason
    const stopEntry = deps.callLog.find((e: string) => e.startsWith("stopAuto:"));
    assert.ok(stopEntry?.includes("Workflow complete"), "Should stop with 'Workflow complete'");
  });

  it("finalizes custom-engine complete turns and clears current turn state", async () => {
    _resetPendingResolve();

    const runDir = makeRunDir();
    const graph = makeGraph([
      makeStep({ id: "step-a", status: "complete" }),
    ], "already-done");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "already-done");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });
    const turnResults: Array<{ status: string; failureClass: string; error?: string }> = [];
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
      uokObserver: {
        onTurnStart: () => {},
        onTurnResult: (result) => {
          deps.callLog.push(`turnResult:${result.status}`);
          turnResults.push({
            status: result.status,
            failureClass: result.failureClass,
            error: result.error,
          });
        },
        onPhaseResult: () => {},
      },
    });

    await autoLoop(ctx, pi, s, deps);

    assert.deepEqual(turnResults, [{ status: "completed", failureClass: "none", error: undefined }]);
    assert.ok(
      deps.callLog.includes("journal:iteration-end"),
      `complete workflow should emit iteration-end; log=${deps.callLog.join(",")}`,
    );
    assert.ok(
      deps.callLog.indexOf("turnResult:completed") < deps.callLog.indexOf("stopAuto:Workflow complete"),
      `turn should finalize before stopAuto; log=${deps.callLog.join(",")}`,
    );
    assert.equal(s.currentTraceId, null);
    assert.equal(s.currentTurnId, null);
    assert.equal(pi.calls.length, 0, "complete workflow should not dispatch work");
  });

  it("stops blocked custom workflows and clears current turn state", async () => {
    _resetPendingResolve();

    const runDir = makeRunDir();
    const graph = makeGraph([
      makeStep({ id: "step-a", dependsOn: ["step-b"] }),
      makeStep({ id: "step-b", dependsOn: ["step-a"] }),
    ], "blocked-workflow");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "blocked-workflow");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });
    const turnResults: Array<{ status: string; failureClass: string; error?: string }> = [];
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
      uokObserver: {
        onTurnStart: () => {},
        onTurnResult: (result) => {
          turnResults.push({
            status: result.status,
            failureClass: result.failureClass,
            error: result.error,
          });
        },
        onPhaseResult: () => {},
      },
    });

    await autoLoop(ctx, pi, s, deps);

    assert.equal(turnResults.length, 1);
    assert.equal(turnResults[0].status, "stopped");
    assert.equal(turnResults[0].failureClass, "manual-attention");
    assert.match(turnResults[0].error ?? "", /Workflow blocked: no pending steps are ready/);
    assert.ok(
      deps.callLog.includes("journal:iteration-end"),
      `blocked workflow should emit iteration-end; log=${deps.callLog.join(",")}`,
    );
    assert.equal(s.currentTraceId, null);
    assert.equal(s.currentTurnId, null);
    assert.equal(pi.calls.length, 0, "blocked workflow should not dispatch a custom step");
    assert.match(
      deps.callLog.find((e: string) => e.startsWith("stopAuto:")) ?? "",
      /Workflow blocked: no pending steps are ready/,
    );
  });

  it("finalizes the active turn when the session lock is lost", async () => {
    _resetPendingResolve();

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession();
    const turnResults: Array<{ status: string; failureClass: string; error?: string }> = [];
    const deps = makeMockDeps({
      validateSessionLock: () => ({
        valid: false,
        failureReason: "pid-mismatch",
        expectedPid: 111,
        existingPid: 222,
      } as SessionLockStatus),
      handleLostSessionLock: () => {
        deps.callLog.push("handleLostSessionLock");
      },
      uokObserver: {
        onTurnStart: () => {},
        onTurnResult: (result) => {
          turnResults.push({
            status: result.status,
            failureClass: result.failureClass,
            error: result.error,
          });
        },
        onPhaseResult: () => {},
      },
    });

    await autoLoop(ctx, pi, s, deps);

    assert.deepEqual(turnResults, [{
      status: "stopped",
      failureClass: "manual-attention",
      error: "session-lock-lost",
    }]);
    assert.equal(s.currentTraceId, null);
    assert.equal(s.currentTurnId, null);
    assert.equal(pi.calls.length, 0, "lost session lock must not dispatch work");
    assert.ok(deps.callLog.includes("handleLostSessionLock"));
  });

  it("does not call runPreDispatch or runFinalize on the custom path", async () => {
    _resetPendingResolve();

    // Single-step workflow
    const runDir = makeRunDir();
    const graph = makeGraph([makeStep({ id: "only" })], "single");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "single");

    const ctx = makeMockCtx();
    const pi = makeMockPi();

    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });

    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
      postUnitPreVerification: async () => {
        deps.callLog.push("postUnitPreVerification");
        return "continue" as const;
      },
      postUnitPostVerification: async () => {
        deps.callLog.push("postUnitPostVerification");
        return "continue" as const;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);

    await resolveNextAgentEnd();

    await loopPromise;

    // Custom path should NOT call runFinalize's post-unit phases
    assert.ok(
      !deps.callLog.includes("postUnitPreVerification"),
      "Custom path should skip postUnitPreVerification (runFinalize not called)",
    );
    assert.ok(
      !deps.callLog.includes("postUnitPostVerification"),
      "Custom path should skip postUnitPostVerification (runFinalize not called)",
    );

    // Should NOT have called resolveDispatch (dev dispatch)
    assert.ok(
      !deps.callLog.includes("resolveDispatch"),
      "Custom path should skip resolveDispatch",
    );
  });

  it("respects dependency ordering — step-b waits for step-a", async () => {
    _resetPendingResolve();

    const runDir = makeRunDir();
    // step-b depends on step-a, both pending
    const graph = makeGraph([
      makeStep({ id: "step-a" }),
      makeStep({ id: "step-b", dependsOn: ["step-a"] }),
    ], "dep-order");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "dep-order");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const dispatchedUnitIds: string[] = [];

    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });

    const originalSendMessage = pi.sendMessage;
    pi.sendMessage = (...args: unknown[]) => {
      // Track dispatched prompts to verify ordering
      const promptArg = args[0] as { content?: string };
      dispatchedUnitIds.push(promptArg?.content ?? "unknown");
      return originalSendMessage(...args);
    };

    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);

    // Resolve step-a
    await resolveNextAgentEnd();

    // Resolve step-b
    await resolveNextAgentEnd();

    await loopPromise;

    // Verify step-a was dispatched before step-b
    assert.equal(dispatchedUnitIds.length, 2, "Should have dispatched 2 steps");
    assert.ok(
      dispatchedUnitIds[0].includes("Do step-a"),
      `First dispatch should be step-a, got: ${dispatchedUnitIds[0]}`,
    );
    assert.ok(
      dispatchedUnitIds[1].includes("Do step-b"),
      `Second dispatch should be step-b, got: ${dispatchedUnitIds[1]}`,
    );
  });

  it("stops custom workflow after repeated verification retries", async () => {
    _resetPendingResolve();

    const runDir = makeRunDir();
    const graph = makeGraph([makeStep({ id: "retry-step" })], "retry-exhaustion");
    writeGraph(runDir, graph);
    writeFileSync(join(runDir, "DEFINITION.yaml"), stringify({
      version: 1,
      name: "retry-exhaustion",
      steps: [{
        id: "retry-step",
        name: "retry-step",
        prompt: "Do retry-step",
        produces: "retry-step/output.md",
        verify: { policy: "shell-command", command: "exit 1" },
      }],
    }));

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });
    const journalEvents: Array<{ eventType: string; data?: any }> = [];
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
      emitJournalEvent: (entry: any) => {
        journalEvents.push(entry);
        deps.callLog.push(`journal:${entry.eventType}`);
      },
    });

    const resolver = setInterval(() => {
      if (_hasPendingResolveForTest()) {
        resolveAgentEnd({ messages: [{ role: "assistant" }] });
      }
    }, 25);
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        autoLoop(ctx, pi, s, deps),
        new Promise((_, reject) =>
          timeout = setTimeout(() => {
            s.active = false;
            resolveAgentEnd({ messages: [{ role: "assistant" }] });
            reject(new Error(
              `autoLoop did not stop after verification retry exhaustion; calls=${pi.calls.length}; log=${deps.callLog.join(",")}`,
            ));
          }, 3_000),
        ),
      ]);
    } finally {
      clearInterval(resolver);
      if (timeout) clearTimeout(timeout);
    }

    assert.equal(pi.calls.length, 4, "verification retry should be capped after four dispatched attempts");
    const stopEntry = deps.callLog.find((e: string) => e.startsWith("stopAuto:"));
    assert.match(stopEntry ?? "", /requested retry 4 times without passing/);
    const finalGraph = readGraph(runDir);
    assert.equal(finalGraph.steps[0]?.status, "active", "failed verification must not reconcile the step complete");

    const unitEndIndexes = journalEvents
      .map((entry, index) => entry.eventType === "unit-end" ? index : -1)
      .filter((index) => index >= 0);
    const iterationEndIndexes = journalEvents
      .map((entry, index) => entry.eventType === "iteration-end" ? index : -1)
      .filter((index) => index >= 0);
    assert.equal(unitEndIndexes.length, 4, "each custom verification retry/stop attempt must emit unit-end");
    assert.equal(iterationEndIndexes.length, 4, "each custom verification retry/stop iteration must close after unit-end");
    for (const [i, unitEndIndex] of unitEndIndexes.entries()) {
      assert.ok(
        iterationEndIndexes[i]! > unitEndIndex,
        `custom verification attempt ${i + 1} should emit iteration-end after unit-end`,
      );
    }
  });

  it("persists custom verification retry budget across a session restart", async () => {
    _resetPendingResolve();

    const runDir = makeRunDir();
    const graph = makeGraph([makeStep({ id: "retry-step" })], "retry-restart");
    writeGraph(runDir, graph);
    writeFileSync(join(runDir, "DEFINITION.yaml"), stringify({
      version: 1,
      name: "retry-restart",
      steps: [{
        id: "retry-step",
        name: "retry-step",
        prompt: "Do retry-step",
        produces: "retry-step/output.md",
        verify: { policy: "shell-command", command: "exit 1" },
      }],
    }));

    const ctx1 = makeMockCtx();
    const pi1 = makeMockPi();
    const s1 = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });
    const deps1 = makeMockDeps();
    const resolver1 = setInterval(() => {
      if (_hasPendingResolveForTest()) {
        resolveAgentEnd({ messages: [{ role: "assistant" }] });
      }
      if (pi1.calls.length >= 2) {
        s1.active = false;
      }
    }, 25);
    let timeout1: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        autoLoop(ctx1, pi1, s1, deps1),
        new Promise((_, reject) =>
          timeout1 = setTimeout(() => {
            s1.active = false;
            resolveAgentEnd({ messages: [{ role: "assistant" }] });
            reject(new Error(
              `first autoLoop did not pause after two retry attempts; calls=${pi1.calls.length}; log=${deps1.callLog.join(",")}`,
            ));
          }, 3_000),
        ),
      ]);
    } finally {
      clearInterval(resolver1);
      if (timeout1) clearTimeout(timeout1);
    }
    assert.equal(pi1.calls.length, 2, "first session should consume two retry attempts");
    assert.equal(
      deps1.callLog.some((e: string) => e.startsWith("stopAuto:")),
      false,
      "first session should stop because the session deactivated, not because retry budget exhausted",
    );

    _resetPendingResolve();
    const ctx2 = makeMockCtx();
    const pi2 = makeMockPi();
    const s2 = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });
    const deps2 = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps2.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s2.active = false;
      },
    });
    const resolver2 = setInterval(() => {
      if (_hasPendingResolveForTest()) {
        resolveAgentEnd({ messages: [{ role: "assistant" }] });
      }
    }, 25);
    let timeout2: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        autoLoop(ctx2, pi2, s2, deps2),
        new Promise((_, reject) =>
          timeout2 = setTimeout(() => {
            s2.active = false;
            resolveAgentEnd({ messages: [{ role: "assistant" }] });
            reject(new Error(
              `second autoLoop did not stop after persisted retry exhaustion; calls=${pi2.calls.length}; log=${deps2.callLog.join(",")}`,
            ));
          }, 3_000),
        ),
      ]);
    } finally {
      clearInterval(resolver2);
      if (timeout2) clearTimeout(timeout2);
    }

    assert.equal(pi2.calls.length, 2, "second session should exhaust after attempts 3 and 4");
    const stopEntry = deps2.callLog.find((e: string) => e.startsWith("stopAuto:"));
    assert.match(stopEntry ?? "", /requested retry 4 times without passing/);
  });

  it("#1672: custom-engine stop persists its signature before database teardown", async (t) => {
    // Gap 1 (#1672): the custom-engine verification adapters used to call
    // finishTurn with three arguments, so pendingLoopLiveness stayed unset and
    // a verification retry could recur forever without a block signature.
    // Every retry turn must now hand the adjudication boundary a guard id and
    // an actionable sanctioned exit.
    _resetPendingResolve();

    const runDir = makeTmpDir();
    const graph = makeGraph([makeStep({ id: "retry-step" })], "retry-liveness");
    writeGraph(runDir, graph);
    writeFileSync(join(runDir, "DEFINITION.yaml"), stringify({
      version: 1,
      name: "retry-liveness",
      steps: [{
        id: "retry-step",
        name: "retry-step",
        prompt: "Do retry-step",
        produces: "retry-step/output.md",
        verify: { policy: "shell-command", command: "exit 1" },
      }],
    }));

    const dbPath = join(runDir, ".gsd", "gsd.db");
    mkdirSync(join(runDir, ".gsd"), { recursive: true });
    openDatabase(dbPath);
    t.after(() => {
      try { closeDatabase(); } catch { /* noop */ }
    });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });
    let stopOutcome: {
      guardId: string;
      unitType: string;
      unitId: string;
      inputPayload: string;
      sanctionedExit?: string;
    } | undefined;
    const verifyOutcomes: Array<{
      guardId: string;
      inputPayload: string;
      count: number;
      tripped: boolean;
    }> = [];
    const deps = makeMockDeps({
      adjudicateNonAdvancingOutcome: (_session, input) => {
        const recorded = recordNonAdvancingOutcome({
          scopeId: realpathSync(runDir),
          guardId: input.guardId,
          unitType: input.unitType,
          unitId: input.unitId,
          inputPayload: input.inputPayload,
        }, input.sanctionedExit ? { sanctionedExit: input.sanctionedExit } : undefined);
        if (input.guardId === "custom-engine-verify") {
          verifyOutcomes.push({
            guardId: input.guardId,
            inputPayload: input.inputPayload,
            count: recorded.count,
            tripped: recorded.tripped,
          });
          stopOutcome = input;
        }
        return null;
      },
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
        closeDatabase();
      },
    });

    const resolver = setInterval(() => {
      if (_hasPendingResolveForTest()) {
        resolveAgentEnd({ messages: [{ role: "assistant" }] });
      }
    }, 25);
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        autoLoop(ctx, pi, s, deps),
        new Promise((_, reject) =>
          timeout = setTimeout(() => {
            s.active = false;
            resolveAgentEnd({ messages: [{ role: "assistant" }] });
            reject(new Error(
              `autoLoop did not stop; log=${deps.callLog.join(",")}`,
            ));
          }, 3_000),
        ),
      ]);
    } finally {
      clearInterval(resolver);
      if (timeout) clearTimeout(timeout);
    }

    assert.ok(stopOutcome, "the exhausted custom-engine verification stop must reach adjudication");
    assert.equal(verifyOutcomes.length, 4, "every verification retry, including exhaustion, must reach adjudication");
    const retryEvidence = verifyOutcomes.slice(0, 3).map((outcome) => JSON.parse(outcome.inputPayload));
    assert.deepEqual(retryEvidence, [
      { policy: "shell-command", command: "exit 1", exitCode: 1, signal: null, error: null },
      { policy: "shell-command", command: "exit 1", exitCode: 1, signal: null, error: null },
      { policy: "shell-command", command: "exit 1", exitCode: 1, signal: null, error: null },
    ]);
    assert.equal(verifyOutcomes[0]?.tripped, false);
    assert.equal(verifyOutcomes[1]?.tripped, true, "identical engine evidence must trip at occurrence two");

    // Changed-evidence fidelity is proven through production in the #1674
    // case below; synthesising payloads here would pass even if the loop
    // collapsed distinct engine evidence.
    assert.equal(stopOutcome.guardId, "custom-engine-verify");
    assert.match(stopOutcome.sanctionedExit ?? "", /`\/gsd forensics`/);
    openDatabase(dbPath);
    const repeated = recordNonAdvancingOutcome({
      scopeId: realpathSync(runDir),
      guardId: stopOutcome.guardId,
      unitType: stopOutcome.unitType,
      unitId: stopOutcome.unitId,
      inputPayload: stopOutcome.inputPayload,
    }, stopOutcome.sanctionedExit ? { sanctionedExit: stopOutcome.sanctionedExit } : undefined);
    assert.equal(repeated.tripped, true, "the stop signature must survive database reopen as occurrence one");
  });

  it("#1674: differing custom verification content keeps distinct signatures through autoLoop", async () => {
    // ADR-047 §3: a block signature hashes the inputs the guard actually read.
    // Pattern verification reads the produced file's content, so two runs whose
    // nonmatching content differs must persist different signatures (no false
    // trip), while two runs with identical content must trip at occurrence two.
    // Everything here is driven through autoLoop — the verification evidence is
    // built by production custom verification and threaded by the loop.
    _resetPendingResolve();

    const runDir = makeTmpDir();
    const graph = makeGraph([makeStep({ id: "content-step" })], "content-fidelity");
    writeGraph(runDir, graph);
    writeFileSync(join(runDir, "DEFINITION.yaml"), stringify({
      version: 1,
      name: "content-fidelity",
      steps: [{
        id: "content-step",
        name: "content-step",
        prompt: "Do content-step",
        produces: ["content-step/output.md"],
        verify: { policy: "content-heuristic", pattern: "^ok" },
      }],
    }));
    mkdirSync(join(runDir, "content-step"), { recursive: true });
    const outputPath = join(runDir, "content-step", "output.md");

    mkdirSync(join(runDir, ".gsd"), { recursive: true });
    openDatabase(join(runDir, ".gsd", "gsd.db"));

    const verifyOutcomes: VerificationObservation[] = [];

    const runWithContent = async (content: string): Promise<void> => {
      await runVerificationScenario({
        runDir,
        mutateFiles: () => writeFileSync(outputPath, content),
        observations: verifyOutcomes,
      });
    };

    await runWithContent("bad-1\n");
    await runWithContent("bad-2\n");
    await runWithContent("bad-2\n");

    assert.equal(
      verifyOutcomes.length,
      3,
      "each pattern-mismatch pause must reach adjudication once",
    );
    const payloads = verifyOutcomes.map((outcome) => outcome.inputPayload);
    assert.notEqual(
      payloads[0],
      payloads[1],
      "distinct nonmatching content must produce distinct verification evidence",
    );
    assert.equal(verifyOutcomes[0]?.tripped, false);
    assert.equal(
      verifyOutcomes[0]?.count,
      1,
      "the first mismatch is occurrence one",
    );
    assert.equal(
      verifyOutcomes[1]?.tripped,
      false,
      "changed content must not trip the backstop at occurrence two",
    );
    assert.equal(
      verifyOutcomes[1]?.count,
      1,
      "changed content starts its own signature counter",
    );
    assert.equal(
      payloads[1],
      payloads[2],
      "identical content must produce identical verification evidence",
    );
    assert.equal(
      verifyOutcomes[2]?.tripped,
      true,
      "identical evidence must trip at occurrence two",
    );
  });

  it("#1674: every output the content guard read stays in the signature through autoLoop", async () => {
    // ADR-047 §3: the guard reads each `produces` entry in order before one of
    // them fails, so all of those reads are signature inputs. Recording only the
    // failing file collapsed "output a changed while b still fails" into the
    // signature of "b fails" and falsely tripped the wedge at occurrence two.
    // Driven entirely through autoLoop: production content verification builds
    // the evidence and the loop threads it to adjudication.
    _resetPendingResolve();

    const runDir = makeTmpDir();
    const graph = makeGraph([makeStep({ id: "multi-step" })], "multi-output-fidelity");
    writeGraph(runDir, graph);
    writeFileSync(join(runDir, "DEFINITION.yaml"), stringify({
      version: 1,
      name: "multi-output-fidelity",
      steps: [{
        id: "multi-step",
        name: "multi-step",
        prompt: "Do multi-step",
        produces: ["multi-step/a.md", "multi-step/b.md"],
        verify: { policy: "content-heuristic", pattern: "^ok" },
      }],
    }));
    mkdirSync(join(runDir, "multi-step"), { recursive: true });
    const matchingPath = join(runDir, "multi-step", "a.md");
    const failingPath = join(runDir, "multi-step", "b.md");

    mkdirSync(join(runDir, ".gsd"), { recursive: true });
    openDatabase(join(runDir, ".gsd", "gsd.db"));

    const verifyOutcomes: VerificationObservation[] = [];

    const runWithMatchingOutput = async (matchingContent: string): Promise<void> => {
      await runVerificationScenario({
        runDir,
        mutateFiles: () => {
          writeFileSync(matchingPath, matchingContent);
          writeFileSync(failingPath, "bad\n");
        },
        observations: verifyOutcomes,
      });
    };

    await runWithMatchingOutput("ok-1\n");
    await runWithMatchingOutput("ok-2\n");
    await runWithMatchingOutput("ok-2\n");

    assert.equal(verifyOutcomes.length, 3, "each mismatch pause must reach adjudication once");
    const payloads = verifyOutcomes.map((outcome) => outcome.inputPayload);
    assert.notEqual(
      payloads[0],
      payloads[1],
      "a changed matching output must produce distinct evidence even though the same output fails",
    );
    assert.equal(verifyOutcomes[1]?.tripped, false, "a changed read must not trip the backstop");
    assert.equal(verifyOutcomes[1]?.count, 1, "the changed read starts its own signature counter");
    assert.equal(payloads[1], payloads[2], "identical reads must produce identical evidence");
    assert.equal(verifyOutcomes[2]?.tripped, true, "identical reads must trip at occurrence two");
  });

  it("#1674: min-size evidence includes every preceding size read through autoLoop", async () => {
    _resetPendingResolve();

    const runDir = makeTmpDir();
    const graph = makeGraph([makeStep({ id: "size-step" })], "multi-size-fidelity");
    writeGraph(runDir, graph);
    writeFileSync(join(runDir, "DEFINITION.yaml"), stringify({
      version: 1,
      name: "multi-size-fidelity",
      steps: [{
        id: "size-step",
        name: "size-step",
        prompt: "Do size-step",
        produces: ["size-step/a.md", "size-step/b.md"],
        verify: { policy: "content-heuristic", minSize: 5 },
      }],
    }));
    mkdirSync(join(runDir, "size-step"), { recursive: true });
    const passingPath = join(runDir, "size-step", "a.md");
    const failingPath = join(runDir, "size-step", "b.md");
    mkdirSync(join(runDir, ".gsd"), { recursive: true });
    openDatabase(join(runDir, ".gsd", "gsd.db"));

    const observations: VerificationObservation[] = [];
    const runWithPassingSize = async (content: string): Promise<void> => {
      await runVerificationScenario({
        runDir,
        mutateFiles: () => {
          writeFileSync(passingPath, content);
          writeFileSync(failingPath, "x");
        },
        observations,
      });
    };

    await runWithPassingSize("1234567890");
    await runWithPassingSize("12345678901");
    await runWithPassingSize("12345678901");

    assert.equal(observations.length, 3);
    const payloads = observations.map((outcome) => outcome.inputPayload);
    assert.notEqual(payloads[0], payloads[1], "changing a preceding size read must change evidence");
    assert.deepEqual(JSON.parse(payloads[1] ?? "{}").reads, [
      { path: "size-step/a.md", exists: true, size: 11 },
      { path: "size-step/b.md", exists: true, size: 1 },
    ]);
    assert.equal(observations[1]?.tripped, false);
    assert.equal(payloads[1], payloads[2]);
    assert.equal(observations[2]?.tripped, true);
  });

  it("two-step workflow drives both steps to complete and stops when isComplete fires", async () => {
    // Note (#4831): renamed from "GRAPH.yaml step stays pending when session
    // deactivates before reconcile" — the assertion body never proved the
    // pending-on-deactivate claim and even comments that "the reconcile
    // will still run for step-b". The behaviour this test actually pins is:
    // both steps reconcile complete and stopAuto fires once isComplete.
    _resetPendingResolve();

    // Two-step workflow: a → b. We will complete step-a, then force a break
    // during step-b's runUnitPhase (by returning cancelled status + deactivating).
    const runDir = makeRunDir();
    const graph = makeGraph([
      makeStep({ id: "step-a" }),
      makeStep({ id: "step-b", dependsOn: ["step-a"] }),
    ], "failure-test");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "failure-test");

    const ctx = makeMockCtx();
    const pi = makeMockPi();

    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir,
    });

    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
    });

    const loopPromise = autoLoop(ctx, pi, s, deps);

    // Resolve step-a successfully
    await resolveNextAgentEnd();

    // Step-b enters runUnit — deactivate the session before resolving.
    // runUnit checks s.active after newSession and returns cancelled if false.
    // But since newSession resolves synchronously in our mock (before the
    // active check), the unit still runs. Instead, let's just cancel it.
    // Resolve as cancelled to simulate a failed session
    await resolveNextAgentEnd();

    // The reconcile will still run for step-b in this flow since
    // runUnitPhase returns "next" (not "break") for completed units.
    // After both steps complete, the engine detects isComplete and stops.
    await loopPromise;

    // Both steps reconcile complete; the renamed expectation pins that the
    // engine drives the workflow through isComplete rather than leaving any
    // step pending.
    const finalGraph = readGraph(runDir);
    const stepA = finalGraph.steps.find(s => s.id === "step-a");
    const stepB = finalGraph.steps.find(s => s.id === "step-b");
    assert.equal(stepA?.status, "complete", "Step-a should be complete");
    assert.equal(stepB?.status, "complete", "Step-b should be complete");

    // The loop must stop once isComplete fires.
    assert.ok(
      deps.callLog.some((e: string) => e.startsWith("stopAuto:")),
      "stopAuto should have been called",
    );
  });
});
