/**
 * journal-integration.test.ts — Integration tests proving that phase functions
 * emit correct journal event sequences with flowId threading, rule provenance,
 * and causedBy references.
 *
 * These tests call the real runUnitPhase and finalize phase
 * functions with mock LoopDeps that capture emitJournalEvent calls.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create a temp project root with a git repo for phase-function tests. */
function makeTestBase(prefix: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "chore: seed"], { cwd: base, stdio: "ignore" });
  return base;
}

import type { JournalEntry } from "../journal.js";
import type { LoopDeps } from "../auto/loop-deps.js";
import { WorktreeStateProjection } from "../worktree-state-projection.js";
import type { IterationContext, LoopState, IterationData } from "../auto/types.js";
import type { SessionLockStatus } from "../session-lock.js";
import { runUnitPhase } from "../auto/unit-phase.js";
import { runFinalize } from "../auto/finalize.js";
import { readUnitRuntimeRecord } from "../unit-runtime.js";
import { ModelPolicyDispatchBlockedError } from "../auto-model-selection.js";
import {
  closeDatabase,
  getTask,
  insertAssessment,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.js";
import { SourceObservationStore } from "../source-observations.js";
import { registerAutoWorker } from "../db/auto-workers.js";
import { claimMilestoneLease } from "../db/milestone-leases.js";
import { recordDispatchClaim } from "../db/unit-dispatches.js";
import { storeUnitRetry } from "../db/unit-dispatch-retries.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Captured journal events from the mock deps. */
function createEventCapture() {
  const events: JournalEntry[] = [];
  return {
    events,
    emitJournalEvent: (entry: JournalEntry) => { events.push(entry); },
  };
}

/** Minimal mock LoopDeps with journal event capture. */
function makeMockDeps(
  capture: ReturnType<typeof createEventCapture>,
  overrides?: Partial<LoopDeps>,
): LoopDeps {
  const baseDeps: LoopDeps = {
    lockBase: () => "/tmp/test-lock",
    buildSnapshotOpts: () => ({}),
    stopAuto: async () => {},
    pauseAuto: async () => {},
    clearUnitTimeout: () => {},
    updateProgressWidget: () => {},
    syncCmuxSidebar: () => {},
    logCmuxEvent: () => {},
    invalidateAllCaches: () => {},
    deriveState: async () => ({
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      activeTask: { id: "T01" },
      registry: [{ id: "M001", status: "active" }],
      blockers: [],
    }) as any,
    loadEffectiveGSDPreferences: () => ({ preferences: {} }),
    preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
    checkResourcesStale: () => null,
    validateSessionLock: () => ({ valid: true }) as SessionLockStatus,
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
    getLedger: () => ({ units: [] }),
    getProjectTotals: () => ({ cost: 0 }),
    formatCost: (c: number) => `$${c.toFixed(2)}`,
    getBudgetAlertLevel: () => 0,
    getNewBudgetAlertLevel: () => 0,
    getBudgetEnforcementAction: () => "none",
    getManifestStatus: async () => null,
    collectSecretsFromManifest: async () => null,
    resolveDispatch: async () => ({
      action: "dispatch" as const,
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do the thing",
      matchedRule: "test-rule-alpha",
    }),
    runPreDispatchHooks: () => ({ firedHooks: [], action: "proceed" }),
    getPriorSliceCompletionBlocker: () => null,
    getMainBranch: () => "main",
    closeoutUnit: async () => {},
    autoCommitUnit: async () => null,
    recordOutcome: () => {},
    writeLock: () => {},
    captureAvailableSkills: () => {},
    ensurePreconditions: () => {},
    updateSliceProgressCache: () => {},
    selectAndApplyModel: async () => ({ routing: null, appliedModel: null }),
    startUnitSupervision: () => {},
    getDeepDiagnostic: () => null,
    isDbAvailable: () => false,
    reorderForCaching: (p: string) => p,
    existsSync: (p: string) => p.endsWith(".git") || p.endsWith("package.json"),
    readFileSync: () => "",
    atomicWriteSync: () => {},
    GitServiceImpl: class {} as any,
    worktreeProjection: new WorktreeStateProjection(),
    lifecycle: {
      enterMilestone: () => ({ ok: true, mode: "worktree", path: "/tmp/project" }),
      exitMilestone: (_mid: string, opts: { merge: boolean }) => ({
        ok: true,
        merged: opts.merge,
        codeFilesChanged: false,
      }),
    } as any,
    postUnitPreVerification: async () => "continue" as const,
    runPostUnitVerification: async () => "continue" as const,
    postUnitPostVerification: async () => "continue" as const,
    getSessionFile: () => "/tmp/session.json",
    rebuildState: async () => {},
    resolveModelId: (id: string, models: any[]) => models.find((m: any) => m.id === id),
    emitJournalEvent: capture.emitJournalEvent,
    recordVerificationPause: () => {},
  };

  return { ...baseDeps, ...overrides };
}

/** Build a mock IterationContext with real flowId and seqCounter. */
function makeIC(
  deps: LoopDeps,
  overrides?: Partial<IterationContext>,
): IterationContext {
  const flowId = randomUUID();
  let seqCounter = 0;
  return {
    ctx: {
      ui: { notify: () => {}, setStatus: () => {} },
      model: { id: "test-model" },
      modelRegistry: { getAvailable: () => [] },
    } as any,
    pi: {
      sendMessage: () => {},
      setModel: async () => true,
      getThinkingLevel: () => "off",
      setThinkingLevel: () => {},
    } as any,
    s: makeSession(),
    deps,
    prefs: undefined,
    iteration: 1,
    flowId,
    nextSeq: () => ++seqCounter,
    ...overrides,
  };
}

/** Minimal mock session for phase calls. */
function makeSession() {
  return {
    active: true,
    verbose: false,
    stepMode: false,
    paused: false,
    basePath: makeTestBase("gsd-journal-session-"),
    originalBasePath: "",
    currentMilestoneId: "M001",
    currentUnit: null,
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
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("runUnitPhase emits unit-start and unit-end with causedBy reference", async () => {
  const capture = createEventCapture();

  // We need runUnit to return immediately — mock it by providing a session
  // whose cmdCtx.newSession resolves immediately and the result is completed.
  // Actually, runUnitPhase calls the real runUnit which creates a pending
  // promise and blocks. We need a different approach.
  //
  // Instead, we test that unit-start is emitted at the right point by examining
  // the event immediately after calling runUnitPhase with a session where
  // newSession resolves quickly, and we resolve the agent_end externally.
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();

  const deps = makeMockDeps(capture);
  const ic = makeIC(deps);
  const iterData: IterationData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };

  // Start runUnitPhase (it will block on runUnit internally)
  const unitPromise = runUnitPhase(ic, iterData, loopState);

  // Give it time to reach the await inside runUnit
  await new Promise(r => setTimeout(r, 50));

  // Resolve the agent_end
  resolveAgentEnd({ messages: [{ role: "assistant" }] });

  const result = await unitPromise;
  assert.equal(result.action, "next");

  // Check unit-start
  const startEvents = capture.events.filter(e => e.eventType === "unit-start");
  assert.equal(startEvents.length, 1, "should emit exactly one unit-start");
  assert.equal(startEvents[0].flowId, ic.flowId);
  assert.equal((startEvents[0].data as any).unitType, "execute-task");
  assert.equal((startEvents[0].data as any).unitId, "M001/S01/T01");

  // Check unit-end
  const endEvents = capture.events.filter(e => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1, "should emit exactly one unit-end");
  assert.equal(endEvents[0].flowId, ic.flowId);
  assert.equal((endEvents[0].data as any).unitType, "execute-task");
  assert.equal((endEvents[0].data as any).unitId, "M001/S01/T01");
  assert.equal((endEvents[0].data as any).status, "no-artifact");

  // Verify causedBy: unit-end references unit-start's seq
  assert.ok(endEvents[0].causedBy, "unit-end must have a causedBy reference");
  assert.equal(endEvents[0].causedBy!.flowId, ic.flowId);
  assert.equal(endEvents[0].causedBy!.seq, startEvents[0].seq, "unit-end causedBy.seq must match unit-start.seq");
});

test("runUnitPhase retries complete-slice tool errors with their failure context", async () => {
  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();

  const deps = makeMockDeps(capture);
  const ic = makeIC(deps);
  const iterData: IterationData = {
    unitType: "complete-slice",
    unitId: "M001/S01",
    prompt: "complete the slice",
    finalPrompt: "complete the slice",
    pauseAfterUatDispatch: false,
    state: { phase: "summarizing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };
  const toolError = "UAT requires browser verification. Re-author the UAT Type section and complete the slice again.";

  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({
    messages: [{
      role: "toolResult",
      toolName: "gsd_slice_complete",
      isError: true,
      content: [{ type: "text", text: toolError }],
    }],
  });

  const result = await unitPromise;
  assert.equal(result.action, "retry");
  assert.equal((result as { reason?: string }).reason, "complete-slice-tool-error");
  assert.equal(
    ic.s.pendingVerificationRetry?.failureContext,
    `gsd_slice_complete failed without writing the slice completion artifacts:\n\n${toolError}`,
  );

  const endEvents = capture.events.filter(e => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1);
  assert.equal((endEvents[0].data as any).status, "no-artifact");
  assert.equal((endEvents[0].data as any).artifactVerified, false);
});

test("runUnitPhase fails a gate-evaluate unit whose scope has gates without persisted verdicts", async (t) => {
  const { closeDatabase, insertGateRow, insertMilestone, insertSlice, openDatabase, saveGateResult } =
    await import("../gsd-db.ts");
  const base = makeTestBase("gsd-gate-eval-missing-");
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active", depends_on: [] });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Test Slice",
    status: "planned",
    risk: "low",
    depends: [],
    demo: "",
    sequence: 1,
  });
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });
  // Unit scope is Q3+Q4 but only Q3 was persisted — the #2309 failure mode
  // (background subagent dispatch drops Q4 and nobody relays its completion).
  saveGateResult({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "Q3",
    verdict: "pass",
    rationale: "ok",
    findings: "",
  });

  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();

  const deps = makeMockDeps(capture);
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: base,
      originalBasePath: base,
      canonicalProjectRoot: base,
    } as any,
  });
  const iterData: IterationData = {
    unitType: "gate-evaluate",
    unitId: "M001/S01/gates+Q3,Q4",
    prompt: "evaluate gates",
    finalPrompt: "evaluate gates",
    pauseAfterUatDispatch: false,
    state: {
      phase: "evaluating-gates",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      registry: [],
      blockers: [],
    } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };

  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });

  const result = await unitPromise;
  assert.equal(result.action, "retry", "missing gate verdicts must fail the unit, not complete it");
  assert.equal((result as { reason?: string }).reason, "gate-evaluate-missing-gate-results");
  const failureContext = ic.s.pendingVerificationRetry?.failureContext ?? "";
  assert.ok(failureContext.includes("Q4"), "corrective message must name the unpersisted gate Q4");
  assert.ok(
    failureContext.includes("gsd_save_gate_result"),
    "corrective message must instruct persisting via gsd_save_gate_result",
  );

  const endEvents = capture.events.filter(e => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1);
  assert.equal((endEvents[0].data as any).status, "no-artifact");
  assert.equal((endEvents[0].data as any).artifactVerified, false);
});

test("runUnitPhase completes a gate-evaluate unit when every scoped gate has a persisted verdict", async (t) => {
  const { closeDatabase, insertGateRow, insertMilestone, insertSlice, openDatabase, saveGateResult } =
    await import("../gsd-db.ts");
  const base = makeTestBase("gsd-gate-eval-complete-");
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active", depends_on: [] });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Test Slice",
    status: "planned",
    risk: "low",
    depends: [],
    demo: "",
    sequence: 1,
  });
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });
  saveGateResult({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", verdict: "pass", rationale: "ok", findings: "" });
  saveGateResult({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", verdict: "flag", rationale: "concerns", findings: "" });

  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();

  const deps = makeMockDeps(capture);
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: base,
      originalBasePath: base,
      canonicalProjectRoot: base,
    } as any,
  });
  const iterData: IterationData = {
    unitType: "gate-evaluate",
    unitId: "M001/S01/gates+Q3,Q4",
    prompt: "evaluate gates",
    finalPrompt: "evaluate gates",
    pauseAfterUatDispatch: false,
    state: {
      phase: "evaluating-gates",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      registry: [],
      blockers: [],
    } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };

  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });

  const result = await unitPromise;
  assert.equal(result.action, "next", "all scoped gates persisted — unit completes as today");
  assert.equal(ic.s.pendingVerificationRetry, null);

  const endEvents = capture.events.filter(e => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1);
  assert.equal((endEvents[0].data as any).status, "completed");
  assert.equal((endEvents[0].data as any).artifactVerified, true);
});

/** Gate-row seed state for a gate-evaluate fixture. */
type GateSeed = "pending" | "complete" | "absent";

/**
 * Temp git repo with an open DB seeding milestone M001 / slice S01 and the
 * Q3/Q4 gate rows in the requested states. Closes the DB and removes the
 * repo on test exit.
 */
async function setupGateEvaluateFixture(
  t: { after(cb: () => void): void },
  prefix: string,
  seed: { q3: GateSeed; q4: GateSeed },
): Promise<string> {
  const { closeDatabase, insertGateRow, insertMilestone, insertSlice, openDatabase, saveGateResult } =
    await import("../gsd-db.ts");
  const base = makeTestBase(prefix);
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });

  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active", depends_on: [] });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Test Slice",
    status: "planned",
    risk: "low",
    depends: [],
    demo: "",
    sequence: 1,
  });
  const seedGate = (gateId: "Q3" | "Q4", state: GateSeed): void => {
    if (state === "absent") return;
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId, scope: "slice" });
    if (state === "complete") {
      saveGateResult({ milestoneId: "M001", sliceId: "S01", gateId, verdict: "pass", rationale: "ok", findings: "" });
    }
  };
  seedGate("Q3", seed.q3);
  seedGate("Q4", seed.q4);
  return base;
}

function gateEvaluateIterData(): IterationData {
  return {
    unitType: "gate-evaluate",
    unitId: "M001/S01/gates+Q3,Q4",
    prompt: "evaluate gates",
    finalPrompt: "evaluate gates",
    pauseAfterUatDispatch: false,
    state: {
      phase: "evaluating-gates",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      registry: [],
      blockers: [],
    } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
}

test("runUnitPhase fails a gate-evaluate unit when the gate query errors at verify time", async (t) => {
  // Both verdicts ARE persisted — the query error itself must fail the unit
  // closed instead of verifyExpectedArtifact's fail-open `return true`.
  const base = await setupGateEvaluateFixture(t, "gsd-gate-eval-dberr-", { q3: "complete", q4: "complete" });
  const { _getAdapter } = await import("../gsd-db.ts");
  _getAdapter()!.exec("DROP TABLE quality_gates");

  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();

  const deps = makeMockDeps(capture);
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: base,
      originalBasePath: base,
      canonicalProjectRoot: base,
    } as any,
  });
  const iterData = gateEvaluateIterData();
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };

  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });

  const result = await unitPromise;
  assert.equal(result.action, "retry", "a gate query error must fail the unit closed, not complete it");
  assert.equal((result as { reason?: string }).reason, "gate-evaluate-missing-gate-results");
  const failureContext = ic.s.pendingVerificationRetry?.failureContext ?? "";
  assert.ok(failureContext.includes("Q3"), "corrective message must name scoped gate Q3");
  assert.ok(failureContext.includes("Q4"), "corrective message must name scoped gate Q4");

  const endEvents = capture.events.filter(e => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1);
  assert.equal((endEvents[0].data as any).status, "no-artifact");
  assert.equal((endEvents[0].data as any).artifactVerified, false);
});

test("runUnitPhase fails a gate-evaluate unit whose scoped gate has no quality_gates row at all", async (t) => {
  // Q3 persisted; Q4 has NO row — an absent row must count as missing.
  const base = await setupGateEvaluateFixture(t, "gsd-gate-eval-absent-", { q3: "complete", q4: "absent" });

  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();

  const deps = makeMockDeps(capture);
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: base,
      originalBasePath: base,
      canonicalProjectRoot: base,
    } as any,
  });
  const iterData = gateEvaluateIterData();
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };

  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });

  const result = await unitPromise;
  assert.equal(result.action, "retry", "an unseeded scoped gate must fail the unit, not complete it");
  assert.equal((result as { reason?: string }).reason, "gate-evaluate-missing-gate-results");
  const failureContext = ic.s.pendingVerificationRetry?.failureContext ?? "";
  assert.ok(failureContext.includes("Q4"), "corrective message must name the unseeded gate Q4");

  const endEvents = capture.events.filter(e => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1);
  assert.equal((endEvents[0].data as any).status, "no-artifact");
  assert.equal((endEvents[0].data as any).artifactVerified, false);
});

test("runUnitPhase fails a gate-evaluate unit whose scoped gates are all still pending", async (t) => {
  const base = await setupGateEvaluateFixture(t, "gsd-gate-eval-pending-", { q3: "pending", q4: "pending" });

  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();

  const deps = makeMockDeps(capture);
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: base,
      originalBasePath: base,
      canonicalProjectRoot: base,
    } as any,
  });
  const iterData = gateEvaluateIterData();
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };

  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });

  const result = await unitPromise;
  assert.equal(result.action, "retry", "gates still pending must fail the unit");
  assert.equal((result as { reason?: string }).reason, "gate-evaluate-missing-gate-results");
  const failureContext = ic.s.pendingVerificationRetry?.failureContext ?? "";
  assert.ok(failureContext.includes("Q3"), "corrective message must name pending gate Q3");
  assert.ok(failureContext.includes("Q4"), "corrective message must name pending gate Q4");
});

test("runUnitPhase retry dispatch receives the missing-gate corrective context and then completes", async (t) => {
  const base = await setupGateEvaluateFixture(t, "gsd-gate-eval-retry-", { q3: "pending", q4: "pending" });
  const { closeDatabase, saveGateResult } = await import("../gsd-db.ts");

  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();

  const sentPrompts: string[] = [];
  const deps = makeMockDeps(capture);
  const ic = makeIC(deps, {
    pi: {
      sendMessage: (msg: { content?: unknown }) => {
        sentPrompts.push(String(msg?.content ?? ""));
      },
      setModel: async () => true,
      getThinkingLevel: () => "off",
      setThinkingLevel: () => {},
    } as any,
    s: {
      ...makeSession(),
      basePath: base,
      originalBasePath: base,
      canonicalProjectRoot: base,
    } as any,
  });
  const iterData = gateEvaluateIterData();
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };

  // Attempt 1: nothing persisted — the unit must fail with corrective context.
  const firstRun = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  const firstResult = await firstRun;
  assert.equal(firstResult.action, "retry");
  assert.equal(sentPrompts.length, 1, "attempt 1 dispatches exactly one prompt");
  assert.ok(
    !sentPrompts[0].includes("VERIFICATION FAILED"),
    "the first dispatch must not carry retry context",
  );

  // Attempt 2: persist both verdicts; the retry prompt must carry the
  // corrective missing-gate context and the unit must then complete.
  saveGateResult({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", verdict: "pass", rationale: "ok", findings: "" });
  saveGateResult({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", verdict: "flag", rationale: "concerns", findings: "" });
  _resetPendingResolve();
  const secondRun = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  const secondResult = await secondRun;

  assert.equal(secondResult.action, "next", "the retry completes once every scoped gate is persisted");
  assert.equal(ic.s.pendingVerificationRetry, null, "the retry marker is consumed by the retry dispatch");
  assert.ok(sentPrompts.length >= 2, "attempt 2 dispatches a prompt");
  const retryPrompt = sentPrompts[sentPrompts.length - 1];
  assert.ok(retryPrompt.includes("VERIFICATION FAILED"), "retry prompt must carry the verification-failure header");
  assert.ok(retryPrompt.includes("Q4"), "retry prompt must name the missing gate");
  assert.ok(retryPrompt.includes("gsd_save_gate_result"), "retry prompt must instruct persisting via gsd_save_gate_result");
  assert.ok(retryPrompt.includes("evaluate gates"), "retry prompt must retain the original unit prompt");

  try { closeDatabase(); } catch { /* already closed by t.after ordering */ }
});

test("runUnitPhase gives a restarted planner the retry context stored on its dispatch row", async (t) => {
  const base = await setupGateEvaluateFixture(t, "gsd-stored-planner-retry-", { q3: "absent", q4: "absent" });
  // The planner run that the pre-execution check refused, before the kill.
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  if (!lease.ok) throw new Error("expected test lease");
  const claim = recordDispatchClaim({
    traceId: "trace",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    sliceId: "S01",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  if (!claim.ok) throw new Error(`expected dispatch claim: ${claim.error}`);
  storeUnitRetry("plan-slice", {
    unitId: "M001/S01",
    failureContext: "Task T01 reads missing-input.ts, which no task creates.",
    attempt: 1,
  });

  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();
  const sentPrompts: string[] = [];
  // The restarted process: a session with no retry context in memory.
  const ic = makeIC(makeMockDeps(capture), {
    pi: {
      sendMessage: (msg: { content?: unknown }) => {
        sentPrompts.push(String(msg?.content ?? ""));
      },
      setModel: async () => true,
      getThinkingLevel: () => "off",
      setThinkingLevel: () => {},
    } as any,
    s: {
      ...makeSession(),
      basePath: base,
      originalBasePath: base,
      canonicalProjectRoot: base,
    } as any,
  });
  const iterData: IterationData = {
    unitType: "plan-slice",
    unitId: "M001/S01",
    prompt: "plan the slice",
    finalPrompt: "plan the slice",
    pauseAfterUatDispatch: false,
    state: {
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      registry: [],
      blockers: [],
    } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };

  const run = runUnitPhase(ic, iterData, { consecutiveFinalizeTimeouts: 0 });
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  await run;

  assert.equal(sentPrompts.length, 1, "the planner is dispatched once");
  assert.ok(
    sentPrompts[0].includes("VERIFICATION FAILED — AUTO-FIX ATTEMPT 1"),
    "the planner prompt must carry the stored attempt number",
  );
  assert.ok(
    sentPrompts[0].includes("missing-input.ts"),
    "the planner prompt must carry the stored findings",
  );
  assert.ok(sentPrompts[0].includes("plan the slice"), "the planner prompt must keep the unit prompt");
});

test("runUnitPhase increments unitDispatchCount for repeated artifact-missing retries", async () => {
  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();

  const deps = makeMockDeps(capture);
  const ic = makeIC(deps);
  const iterData: IterationData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };

  const firstRun = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  await firstRun;
  assert.equal(ic.s.unitDispatchCount.get("execute-task/M001/S01/T01"), 1);

  _resetPendingResolve();
  const secondRun = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  await secondRun;
  assert.equal(ic.s.unitDispatchCount.get("execute-task/M001/S01/T01"), 2);
});

test("runUnitPhase completes a rewrite-docs unit before the host resolves its override", async (t) => {
  const { registerOverride } = await import("../overrides.ts");
  const base = makeTestBase("gsd-rewrite-docs-complete-");
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active", depends_on: [] });
  // Still active at unit end: the host resolves it later, in postUnitPreVerification.
  registerOverride(base, "Use Postgres instead of SQLite", "M001/none/none");

  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();

  const outcomes: boolean[] = [];
  const deps = makeMockDeps(capture, {
    selectAndApplyModel: async () => ({ routing: { tier: "standard", modelDowngraded: false }, appliedModel: null }),
    recordOutcome: (_unitType, _tier, success) => { outcomes.push(success); },
  });
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: base,
      originalBasePath: base,
      canonicalProjectRoot: base,
    } as any,
  });
  const iterData: IterationData = {
    unitType: "rewrite-docs",
    unitId: "M001",
    prompt: "apply the override",
    finalPrompt: "apply the override",
    pauseAfterUatDispatch: false,
    state: {
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      registry: [],
      blockers: [],
    } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };

  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });

  const result = await unitPromise;
  assert.equal(result.action, "next");

  const endEvents = capture.events.filter(e => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1);
  assert.equal((endEvents[0].data as any).status, "completed");
  assert.equal((endEvents[0].data as any).artifactVerified, true);
  assert.equal(ic.s.unitDispatchCount.has("rewrite-docs/M001"), false, "a later steer on the same unit id is not a retry");
  assert.deepEqual(outcomes, [true], "the unit is not recorded as a routing failure");
});

test("runUnitPhase pre-dispatch model validation failures do not emit unit-start or dispatch runtime state", async (t) => {
  const capture = createEventCapture();
  const base = makeTestBase(`gsd-pre-dispatch-block-${randomUUID()}`);
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const deps = makeMockDeps(capture, {
    selectAndApplyModel: async () => {
      throw new ModelPolicyDispatchBlockedError("execute-task", "M001/S01/T01", []);
    },
  });
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: base,
    } as any,
  });
  const iterData: IterationData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };

  await assert.rejects(() => runUnitPhase(ic, iterData, loopState), ModelPolicyDispatchBlockedError);
  await assert.rejects(() => runUnitPhase(ic, iterData, loopState), ModelPolicyDispatchBlockedError);

  const startEvents = capture.events.filter(e => e.eventType === "unit-start");
  assert.equal(startEvents.length, 0, "pre-dispatch validation failures must not emit unit-start");
  assert.equal(ic.s.unitDispatchCount.get("execute-task/M001/S01/T01") ?? 0, 0, "dispatch count must not increment on pre-dispatch validation failure");
  assert.equal(
    readUnitRuntimeRecord(base, "execute-task", "M001/S01/T01"),
    null,
    "pre-dispatch validation failures must not persist a dispatched runtime record",
  );
});

test("unit-end event contains errorContext when unit is cancelled with structured error", async () => {
  const capture = createEventCapture();
  const { resolveAgentEndCancelled, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();

  let pauseCalls = 0;
  let commitCalls = 0;
  const deps = makeMockDeps(capture, {
    pauseAuto: async () => { pauseCalls++; },
    autoCommitUnit: async () => {
      commitCalls++;
      return "commit";
    },
  });
  const ic = makeIC(deps);
  const iterData: IterationData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };

  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));

  // Resolve with errorContext (simulates a unit hard timeout — not session creation)
  resolveAgentEndCancelled({ message: "Hard timeout error: exceeded limit", category: "timeout", isTransient: true });

  const result = await unitPromise;
  // Unit hard timeouts pause (recoverable) without auto-resume
  assert.equal(result.action, "break");
  assert.equal((result as any).reason, "unit-hard-timeout");
  assert.equal(pauseCalls, 1, "timeout cancellations should pause auto-mode exactly once");
  assert.equal(commitCalls, 1, "timeout cancellations should flush a unit auto-commit once");

  const endEvents = capture.events.filter(e => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1, "timeout cancellations should still emit unit-end");
  assert.equal((endEvents[0].data as any).status, "cancelled");
  assert.equal((endEvents[0].data as any).artifactVerified, false);
  assert.equal((endEvents[0].data as any).errorContext.category, "timeout");
});

test("session-failed cancellations close out and emit unit-end before hard stop", async () => {
  const capture = createEventCapture();
  const { resolveAgentEndCancelled, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();

  let closeoutCalls = 0;
  let commitCalls = 0;
  let stopCalls = 0;
  const deps = makeMockDeps(capture, {
    closeoutUnit: async () => { closeoutCalls++; },
    autoCommitUnit: async () => {
      commitCalls++;
      return "commit";
    },
    stopAuto: async () => { stopCalls++; },
  });
  const ic = makeIC(deps);
  const iterData: IterationData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };

  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));

  resolveAgentEndCancelled({ message: "session bootstrap exploded", category: "session-failed", isTransient: false });

  const result = await unitPromise;
  assert.equal(result.action, "break");
  assert.equal((result as any).reason, "session-failed");
  assert.equal(closeoutCalls, 1, "session-failed cancellations should close out the unit before stopping");
  assert.equal(commitCalls, 1, "session-failed cancellations should try one auto-commit flush");
  assert.equal(stopCalls, 1, "session-failed cancellations should hard-stop auto-mode");

  const endEvents = capture.events.filter(e => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1, "session-failed cancellations should emit unit-end");
  assert.equal((endEvents[0].data as any).status, "cancelled");
  assert.equal((endEvents[0].data as any).artifactVerified, false);
  assert.equal((endEvents[0].data as any).errorContext.category, "session-failed");
});

test("runFinalize pauses and emits unit-end when pre-verification times out", async (t) => {
  const capture = createEventCapture();
  let pauseCalls = 0;
  const basePath = makeTestBase("gsd-finalize-timeout-");
  // The runtime record is a database row.
  openDatabase(":memory:");
  t.after(() => closeDatabase());

  const deps = makeMockDeps(capture, {
    pauseAuto: async () => { pauseCalls++; },
    postUnitPreVerification: async () => {
      await new Promise(() => {});
      return "continue" as const;
    },
  });

  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath,
      currentUnit: { type: "execute-task", id: "M001/S01/T01", startedAt: 1234 },
    } as any,
  });
  const iterData: IterationData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };

  const originalSetTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = ((handler: (...args: any[]) => void, _timeout?: number, ...args: any[]) =>
      originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;

    const result = await runFinalize(ic, iterData, loopState);
    assert.equal(result.action, "break");
    assert.equal((result as any).reason, "finalize-pre-timeout");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(pauseCalls, 1, "pre-verification timeout should pause auto-mode");
  assert.equal(loopState.consecutiveFinalizeTimeouts, 1, "timeout should increment finalize timeout counter");
  assert.equal(ic.s.currentUnit, null, "timed-out finalize should detach currentUnit");

  const runtime = readUnitRuntimeRecord(basePath, "execute-task", "M001/S01/T01");
  assert.ok(runtime, "timed-out finalize should persist a runtime record");
  assert.equal(runtime?.phase, "finalize-timeout");
  assert.equal(runtime?.lastProgressKind, "finalize-pre-timeout");
  assert.deepEqual(
    runtime?.unitEnd,
    { status: "timed-out-finalize", artifactVerified: false },
    "the unit-end outcome is stored on the database row, not only in the journal",
  );

  const endEvents = capture.events.filter((e) => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1, "timed-out finalize should emit terminal unit-end");
  assert.equal((endEvents[0].data as any).status, "timed-out-finalize");
  assert.equal((endEvents[0].data as any).artifactVerified, false);
  assert.equal((endEvents[0].data as any).finalizeStage, "pre");
});

test("transient session-failed cancellations pause instead of hard-stopping", async () => {
  const capture = createEventCapture();
  const { resolveAgentEndCancelled, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();

  const deps = makeMockDeps(capture);
  const ic = makeIC(deps);
  const iterData: IterationData = {
    unitType: "execute-task",
    unitId: "M001/S01/T02",
    prompt: "do more stuff",
    finalPrompt: "do more stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] } as any,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const loopState: LoopState = { consecutiveFinalizeTimeouts: 0 };

  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise(r => setTimeout(r, 50));

  resolveAgentEndCancelled({ message: "Session creation failed: temporary bootstrap overload", category: "session-failed", isTransient: true });

  const result = await unitPromise;
  assert.equal(result.action, "break");
  assert.equal((result as any).reason, "session-timeout");

});
