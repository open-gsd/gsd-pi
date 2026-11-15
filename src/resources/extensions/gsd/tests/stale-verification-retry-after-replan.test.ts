// Project/App: gsd-pi
// File Purpose: Regression tests for #3089 — stored verification retry state
// belongs to the Verify contract that produced it, not only to the Task.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LoopDeps } from "../auto/loop-deps.ts";
import type { IterationContext, IterationData, LoopState } from "../auto/types.ts";
import { AutoSession } from "../auto/session.ts";
import { DEFECTIVE_VERIFY_GUIDANCE, runUnitPhase } from "../auto/unit-phase.ts";
import { renderTaskRecoveryDispatchContext } from "../auto-prompts.ts";
import { WorktreeStateProjection } from "../worktree-state-projection.ts";
import { SourceObservationStore } from "../source-observations.ts";
import { readUnitBudget, spendUnitBudget } from "../db/unit-dispatch-budgets.ts";
import { readStoredUnitRetry, storeUnitRetry } from "../db/unit-dispatch-retries.ts";
import {
  _getAdapter,
  closeDatabase,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  upsertTaskPlanning,
} from "../gsd-db.ts";
import { internalPlanningInvocation } from "../planning-invocation.ts";
import { handleReplanTask, type ReplanTaskParams } from "../tools/replan-task.ts";
import { claimTestDispatch } from "./helpers/unit-dispatch.ts";

const MID = "M001";
const SID = "S01";
const TID = "T01";
const UNIT_ID = `${MID}/${SID}/${TID}`;

const VERIFY_A = "node --test a.test.ts";
const VERIFY_B = "node --test b.test.ts";

interface Fixture {
  base: string;
  cleanup: () => void;
}

function makeBase(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "gsd-stale-verify-retry-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "chore: seed"], { cwd: base, stdio: "ignore" });
  mkdirSync(join(base, ".gsd", "phases", "01-test"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: MID, title: "Test Milestone", status: "active" });
  insertSlice({ id: SID, milestoneId: MID, title: "Test Slice", status: "active", demo: "Demo." });
  insertTask({ id: TID, sliceId: SID, milestoneId: MID, title: "Task", status: "in_progress" });
  return {
    base,
    cleanup: () => {
      try { closeDatabase(); } catch { /* noop */ }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function seedVerify(verify: string): void {
  upsertTaskPlanning(MID, SID, TID, {
    description: "Task description.",
    estimate: "30m",
    files: ["src/a.ts"],
    verify,
    inputs: ["src/a.ts"],
    expectedOutput: ["src/a.ts"],
  });
}

/** Store the retry a host verification gate records after Verify fails. */
function storeVerificationRetry(verify: string, attempt = 1, includeContract = true): void {
  storeUnitRetry("execute-task", {
    unitId: UNIT_ID,
    failureContext:
      `## Verification Failures\n\n### ❌ \`${verify}\` (exit code 1)\n\`\`\`stderr\nfailed\n\`\`\``,
    signature: `${verify}#1`,
    attempt,
    ...(includeContract ? { verifyContract: verify } : {}),
  });
}

function replanParams(verify: string, title = "Replanned Task"): ReplanTaskParams {
  return {
    milestoneId: MID,
    sliceId: SID,
    taskId: TID,
    title,
    description: "Replanned task description.",
    estimate: "30m",
    files: ["src/replanned.ts"],
    verify,
    inputs: ["src/a.ts"],
    expectedOutput: ["src/replanned.ts"],
    requiredWorkflowTools: [],
  };
}

async function replan(base: string, verify: string, title = "Replanned Task"): Promise<void> {
  const result = await handleReplanTask(replanParams(verify, title), base, internalPlanningInvocation());
  assert.ok(!("error" in result), `replan failed: ${"error" in result ? result.error : ""}`);
}

function makeSession(base: string): any {
  return {
    active: true,
    verbose: false,
    stepMode: false,
    paused: false,
    basePath: base,
    originalBasePath: base,
    canonicalProjectRoot: base,
    currentMilestoneId: MID,
    currentUnit: null,
    currentUnitRouting: null,
    currentUnitModel: null,
    currentDispatchedModelId: null,
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
  };
}

function makeMockDeps(): LoopDeps {
  return {
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
      activeMilestone: { id: MID, title: "Test", status: "active" },
      activeSlice: { id: SID, title: "Slice" },
      activeTask: { id: TID },
      registry: [{ id: MID, status: "active" }],
      blockers: [],
    }) as any,
    loadEffectiveGSDPreferences: () => ({ preferences: {} }),
    preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
    checkResourcesStale: () => null,
    validateSessionLock: () => ({ valid: true }) as any,
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
    postflightPopStash: () => ({ restored: true, needsManualRecovery: false, message: "restored" }),
    getLedger: () => ({ units: [] }),
    getBudgetSpend: () => 0,
    formatCost: (c: number) => `$${c.toFixed(2)}`,
    getBudgetAlertLevel: () => 0,
    getNewBudgetAlertLevel: () => 0,
    getBudgetEnforcementAction: () => "none",
    getManifestStatus: async () => null,
    collectSecretsFromManifest: async () => null,
    resolveDispatch: async () => ({
      action: "dispatch" as const,
      unitType: "execute-task",
      unitId: UNIT_ID,
      prompt: "execute the task",
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
    recordVerificationPause: () => {},
    emitJournalEvent: () => {},
  } as LoopDeps;
}

function makeIC(base: string, deps: LoopDeps): IterationContext {
  let seq = 0;
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
    s: makeSession(base),
    deps,
    prefs: undefined,
    iteration: 1,
    flowId: "flow-test",
    nextSeq: () => ++seq,
  } as unknown as IterationContext;
}

async function executeTaskPrompt(base: string): Promise<string> {
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.ts");
  _resetPendingResolve();
  const sentPrompts: string[] = [];
  const ic = makeIC(base, makeMockDeps());
  (ic as any).pi.sendMessage = (msg: { content?: unknown }) => {
    sentPrompts.push(String(msg?.content ?? ""));
  };
  const iterData: IterationData = {
    unitType: "execute-task",
    unitId: UNIT_ID,
    prompt: "execute the task",
    finalPrompt: "execute the task",
    pauseAfterUatDispatch: false,
    state: {
      phase: "executing",
      activeMilestone: { id: MID, title: "Test", status: "active" },
      activeSlice: { id: SID, title: "Slice" },
      activeTask: { id: TID, title: "Task" },
      registry: [],
      blockers: [],
    } as any,
    mid: MID,
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
  const run = runUnitPhase(ic, iterData, { consecutiveFinalizeTimeouts: 0 } as LoopState);
  await new Promise((resolve) => setTimeout(resolve, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  await run;
  assert.ok(sentPrompts.length >= 1, "the executor is dispatched");
  return sentPrompts[0];
}

// ── Primary reproduction ─────────────────────────────────────────────────────

test("#3089: a retry from a replaced Verify contract is not presented as the current gate failure", async (t) => {
  const fixture = makeBase();
  t.after(fixture.cleanup);

  seedVerify(VERIFY_A);
  const dispatch = claimTestDispatch(fixture.base, {
    milestoneId: MID, sliceId: SID, taskId: TID, unitType: "execute-task", unitId: UNIT_ID,
  });
  storeVerificationRetry(VERIFY_A, 1);

  // The gate failed against A; the Task is replanned with B.
  await replan(fixture.base, VERIFY_B);

  // A new Attempt is dispatched; the stored retry is still on the older dispatch row.
  dispatch.claimNext();
  assert.equal(getTask(MID, SID, TID)?.verify, VERIFY_B, "the replan is durable");

  const prompt = await executeTaskPrompt(fixture.base);

  assert.ok(
    !prompt.includes(DEFECTIVE_VERIFY_GUIDANCE),
    "a superseded contract must not carry defective-Verify guidance",
  );
  assert.ok(
    !prompt.includes("VERIFICATION FAILED — AUTO-FIX ATTEMPT"),
    "a superseded contract must not be presented as the current failure",
  );
  assert.ok(
    prompt.includes("VERIFICATION CONTRACT CHANGED — PREVIOUS FAILURE SUPERSEDED"),
    "the historical failure must be marked superseded",
  );
  assert.ok(prompt.includes(VERIFY_B), "the current Verify contract must be named");
});

// ── Contract identity behavior ──────────────────────────────────────────────

test("#3089: an unchanged Verify contract keeps its legitimate retry guidance", async (t) => {
  const fixture = makeBase();
  t.after(fixture.cleanup);

  seedVerify(VERIFY_A);
  claimTestDispatch(fixture.base, {
    milestoneId: MID, sliceId: SID, taskId: TID, unitType: "execute-task", unitId: UNIT_ID,
  });
  storeVerificationRetry(VERIFY_A, 1);

  // Replanning unrelated fields must not release the retry.
  await replan(fixture.base, VERIFY_A, "Renamed Task");

  const prompt = await executeTaskPrompt(fixture.base);
  assert.ok(prompt.includes("VERIFICATION FAILED — AUTO-FIX ATTEMPT 1"));
  assert.ok(prompt.includes(DEFECTIVE_VERIFY_GUIDANCE));
  assert.ok(prompt.includes(VERIFY_A));
});

test("#3089: a legacy retry row with no stored contract is compared from its recorded failure", async (t) => {
  const fixture = makeBase();
  t.after(fixture.cleanup);

  seedVerify(VERIFY_A);
  claimTestDispatch(fixture.base, {
    milestoneId: MID, sliceId: SID, taskId: TID, unitType: "execute-task", unitId: UNIT_ID,
  });
  // Persisted before the fix: no verify_contract column/value.
  storeVerificationRetry(VERIFY_A, 1, false);

  await replan(fixture.base, VERIFY_B);

  const prompt = await executeTaskPrompt(fixture.base);
  assert.ok(!prompt.includes(DEFECTIVE_VERIFY_GUIDANCE));
  assert.ok(prompt.includes("PREVIOUS FAILURE SUPERSEDED"));
  assert.ok(prompt.includes(VERIFY_B));
});

test("#3089: the superseded decision survives a process restart", async (t) => {
  const fixture = makeBase();
  t.after(fixture.cleanup);

  seedVerify(VERIFY_A);
  claimTestDispatch(fixture.base, {
    milestoneId: MID, sliceId: SID, taskId: TID, unitType: "execute-task", unitId: UNIT_ID,
  });
  storeVerificationRetry(VERIFY_A, 1);

  await replan(fixture.base, VERIFY_B);

  // Simulate a restart: the session memory is gone and the database is reopened.
  closeDatabase();
  openDatabase(join(fixture.base, ".gsd", "gsd.db"));
  assert.ok(readStoredUnitRetry("execute-task", UNIT_ID), "the historical retry is still durable");

  const prompt = await executeTaskPrompt(fixture.base);
  assert.ok(!prompt.includes(DEFECTIVE_VERIFY_GUIDANCE));
  assert.ok(prompt.includes("PREVIOUS FAILURE SUPERSEDED"));
});

test("#3089: a new failure against the current contract keeps its guidance", async (t) => {
  const fixture = makeBase();
  t.after(fixture.cleanup);

  seedVerify(VERIFY_B);
  claimTestDispatch(fixture.base, {
    milestoneId: MID, sliceId: SID, taskId: TID, unitType: "execute-task", unitId: UNIT_ID,
  });
  storeVerificationRetry(VERIFY_B, 2);

  const prompt = await executeTaskPrompt(fixture.base);
  assert.ok(prompt.includes("VERIFICATION FAILED — AUTO-FIX ATTEMPT 2"));
  assert.ok(prompt.includes(DEFECTIVE_VERIFY_GUIDANCE));
  assert.ok(prompt.includes(VERIFY_B));
});

test("#3089: differently quoted but textually different commands are separate contracts", async (t) => {
  const fixture = makeBase();
  t.after(fixture.cleanup);

  const quoted = 'node --test "a.test.ts"';
  seedVerify(quoted);
  claimTestDispatch(fixture.base, {
    milestoneId: MID, sliceId: SID, taskId: TID, unitType: "execute-task", unitId: UNIT_ID,
  });
  storeVerificationRetry(quoted, 1);

  await replan(fixture.base, VERIFY_A);

  const prompt = await executeTaskPrompt(fixture.base);
  assert.ok(!prompt.includes(DEFECTIVE_VERIFY_GUIDANCE));
  assert.ok(prompt.includes("PREVIOUS FAILURE SUPERSEDED"));
});

test("#3089: replanning after a Verify change resets the contract's verification budget", async (t) => {
  const fixture = makeBase();
  t.after(fixture.cleanup);

  seedVerify(VERIFY_A);
  claimTestDispatch(fixture.base, {
    milestoneId: MID, sliceId: SID, taskId: TID, unitType: "execute-task", unitId: UNIT_ID,
  });
  storeVerificationRetry(VERIFY_A, 1);

  const budgetRef = { unitType: "execute-task", unitId: UNIT_ID, kind: "verification" } as const;
  spendUnitBudget(new AutoSession().unclaimedUnitBudgets, budgetRef);
  assert.equal(
    readUnitBudget(new AutoSession().unclaimedUnitBudgets, budgetRef),
    1,
    "the old contract used a retry",
  );

  await replan(fixture.base, VERIFY_B);

  assert.equal(
    readUnitBudget(new AutoSession().unclaimedUnitBudgets, budgetRef),
    0,
    "the new contract starts with a fresh verification budget",
  );
});

test("#3089: a retry table predating the contract column keeps its rows and gains the column on open", async (t) => {
  const fixture = makeBase();
  t.after(fixture.cleanup);

  seedVerify(VERIFY_A);
  claimTestDispatch(fixture.base, {
    milestoneId: MID, sliceId: SID, taskId: TID, unitType: "execute-task", unitId: UNIT_ID,
  });
  storeVerificationRetry(VERIFY_A, 1);

  // Simulate a database that got the retry table before this fix.
  _getAdapter()!.exec("ALTER TABLE unit_dispatch_retries DROP COLUMN verify_contract");
  closeDatabase();
  openDatabase(join(fixture.base, ".gsd", "gsd.db"));

  assert.ok(readStoredUnitRetry("execute-task", UNIT_ID), "the historical retry survives the migration");
  assert.equal(
    _getAdapter()!.prepare("SELECT verify_contract FROM unit_dispatch_retries LIMIT 1").get()?.verify_contract,
    null,
    "legacy rows stay NULL and are compared from their recorded failure",
  );

  // Writing the contract after the migration works.
  storeVerificationRetry(VERIFY_A, 1);
  assert.equal(readStoredUnitRetry("execute-task", UNIT_ID)?.verifyContract, VERIFY_A);
});

test("#3089: whitespace inside a quoted argument is part of the contract", async (t) => {
  const fixture = makeBase();
  t.after(fixture.cleanup);

  const spaced = 'node --test "a  b"';
  seedVerify(spaced);
  claimTestDispatch(fixture.base, {
    milestoneId: MID, sliceId: SID, taskId: TID, unitType: "execute-task", unitId: UNIT_ID,
  });
  storeVerificationRetry(spaced, 1);

  await replan(fixture.base, 'node --test "a b"');

  const prompt = await executeTaskPrompt(fixture.base);
  assert.ok(!prompt.includes(DEFECTIVE_VERIFY_GUIDANCE));
  assert.ok(prompt.includes("PREVIOUS FAILURE SUPERSEDED"));
});

test("#3089: a legacy multi-command Verify keeps its retry when only one advertised command failed", async (t) => {
  const fixture = makeBase();
  t.after(fixture.cleanup);

  const multi = "node --test a.test.ts\nnode --test b.test.ts";
  seedVerify(multi);
  claimTestDispatch(fixture.base, {
    milestoneId: MID, sliceId: SID, taskId: TID, unitType: "execute-task", unitId: UNIT_ID,
  });

  // Persisted before the fix: the signature names only the failed check, not
  // the whole Task Verify field.
  storeUnitRetry("execute-task", {
    unitId: UNIT_ID,
    failureContext:
      "## Verification Failures\n\n### ❌ `node --test b.test.ts` (exit code 1)\n```stderr\nfailed\n```",
    signature: "node --test b.test.ts#1",
    attempt: 1,
  });

  const prompt = await executeTaskPrompt(fixture.base);
  assert.ok(prompt.includes("VERIFICATION FAILED — AUTO-FIX ATTEMPT 1"));
  assert.ok(prompt.includes(DEFECTIVE_VERIFY_GUIDANCE));
});

test("#3089: timeout rationales annotate the superseded durable recovery block", () => {
  const recovery = {
    recoveryActionId: "action-timeout",
    attemptId: "attempt-timeout",
    resultId: "result-timeout",
    failureKind: "verification-failed",
    summary: "Host verification failed",
    evidence: { verdict: "fail" },
    rationale:
      "Host verification fail: check node --test a.test.ts observed timeout after 120000ms (exit 2), " +
      "expected exit 0 / pass. Evidence: db://host-verification/attempt-timeout.",
    replanCompleted: false,
    checkpoint: {
      checkpointId: "checkpoint-timeout",
      confirmedContext: "Host verification failed",
      unresolvedSummary: "verification-failed",
      evidenceSummary: "{}",
      suggestedNextAction: "recover",
    },
    action: "remediate",
  } as const;

  const block = renderTaskRecoveryDispatchContext(recovery as any, {
    currentVerify: VERIFY_B,
  });
  assert.match(block, /\*\*Verification contract status:\*\* superseded/);
  assert.ok(block.includes(VERIFY_B));
  assert.ok(block.includes("not as the current gate result, and do not report it as defective"));
});

test("#3089: escaped-space Verify contracts remain distinct after whitespace collapse", async (t) => {
  const fixture = makeBase();
  t.after(fixture.cleanup);

  const escapedOld = "node --test a\\  b.test.ts";
  const escapedNew = "node --test a\\ b.test.ts";
  seedVerify(escapedOld);
  claimTestDispatch(fixture.base, {
    milestoneId: MID, sliceId: SID, taskId: TID, unitType: "execute-task", unitId: UNIT_ID,
  });
  storeVerificationRetry(escapedOld, 1);

  await replan(fixture.base, escapedNew);

  const prompt = await executeTaskPrompt(fixture.base);
  assert.ok(!prompt.includes(DEFECTIVE_VERIFY_GUIDANCE));
  assert.ok(prompt.includes("PREVIOUS FAILURE SUPERSEDED"));
});

test("#3089: receipt replay after a contract change leaves the reset budget durable", async (t) => {
  const fixture = makeBase();
  t.after(fixture.cleanup);

  seedVerify(VERIFY_A);
  claimTestDispatch(fixture.base, {
    milestoneId: MID, sliceId: SID, taskId: TID, unitType: "execute-task", unitId: UNIT_ID,
  });
  storeVerificationRetry(VERIFY_A, 1);

  const budgetRef = { unitType: "execute-task", unitId: UNIT_ID, kind: "verification" } as const;
  spendUnitBudget(new AutoSession().unclaimedUnitBudgets, budgetRef);

  const invocation = internalPlanningInvocation();
  const params = replanParams(VERIFY_B);
  const first = await handleReplanTask(params, fixture.base, invocation);
  assert.ok(!("error" in first), `first replan failed: ${"error" in first ? first.error : ""}`);
  const second = await handleReplanTask(params, fixture.base, invocation);
  assert.ok(!("error" in second), `replayed replan failed: ${"error" in second ? second.error : ""}`);

  assert.equal(
    readUnitBudget(new AutoSession().unclaimedUnitBudgets, budgetRef),
    0,
    "the contract reset is durable whether the receipt is replayed or not",
  );
});

test("#3089: a multiline quoted command in a recovery rationale matches the same current contract", () => {
  const command = `node --eval "console.log('a
b')"`;
  const recovery = {
    recoveryActionId: "action-multiline",
    attemptId: "attempt-multiline",
    resultId: "result-multiline",
    failureKind: "verification-failed",
    summary: "Host verification failed",
    evidence: { verdict: "fail" },
    rationale: `Host verification fail: check ${command} observed exit 1, expected exit 0 / pass. Evidence: db://host-verification/attempt-multiline.`,
    replanCompleted: false,
    checkpoint: {
      checkpointId: "checkpoint-multiline",
      confirmedContext: "Host verification failed",
      unresolvedSummary: "verification-failed",
      evidenceSummary: "{}",
      suggestedNextAction: "recover",
    },
    action: "remediate",
  } as const;

  const block = renderTaskRecoveryDispatchContext(recovery as any, {
    currentVerify: command,
  });
  assert.ok(!block.includes("Verification contract status:"));
});
