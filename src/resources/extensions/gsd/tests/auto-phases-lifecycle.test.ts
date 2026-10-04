// Project/App: gsd-pi
// File Purpose: Auto-loop phase lifecycle regression tests.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveDispatchRecoveryAttempts } from "../auto/unit-phase.ts";
import { runFinalize } from "../auto/finalize.ts";
import { AutoSession } from "../auto/session.ts";
import { hashVerificationFailureContext } from "../auto/verification-retry-policy.ts";
import { readUnitRuntimeRecord, writeUnitRuntimeRecord } from "../unit-runtime.ts";
import { captureRootDirtySnapshot } from "../root-write-leak-guard.ts";
import { emitJournalEvent as emitJournalEventFn, type JournalEntry } from "../journal.ts";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { recordDispatchClaim } from "../db/unit-dispatches.ts";
import { readStoredUnitRetry, storeUnitRetry } from "../db/unit-dispatch-retries.ts";

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(root: string): void {
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.email", "test@example.com"]);
  runGit(root, ["config", "user.name", "Test User"]);
  writeFileSync(join(root, "index.html"), "<h1>Base</h1>\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "chore: init"]);
}

test("resolveDispatchRecoveryAttempts preserves cross-session recovery attempts before in-session recovery", () => {
  const recoveryCounts = new Map<string, number>();

  assert.equal(
    resolveDispatchRecoveryAttempts(recoveryCounts, "execute-task", "M001/S01/T01"),
    undefined,
  );
});

test("resolveDispatchRecoveryAttempts resets after recovery ran in the current session", () => {
  const recoveryCounts = new Map<string, number>([
    ["execute-task/M001/S01/T01", 1],
  ]);

  assert.equal(
    resolveDispatchRecoveryAttempts(recoveryCounts, "execute-task", "M001/S01/T01"),
    0,
  );
});

async function runSuccessfulFinalize(s: AutoSession) {
  const unit = s.currentUnit;
  assert.ok(unit, "test setup must provide currentUnit");

  writeUnitRuntimeRecord(s.basePath, unit.type, unit.id, unit.startedAt, {
    phase: "dispatched",
  });

  const deps = {
    clearUnitTimeout() {},
    buildSnapshotOpts() {
      return {};
    },
    stopAuto: async () => {},
    pauseAuto: async () => {},
    checkpointWorkflowDatabase() {},
    updateProgressWidget() {},
    postUnitPreVerification: async () => "continue",
    runPostUnitVerification: async () => "continue",
    postUnitPostVerification: async () => "continue",
  };

  return runFinalize(
    {
      ctx: { ui: { notify() {} } },
      pi: {},
      s,
      deps,
      prefs: undefined,
      iteration: 1,
      flowId: "flow-1",
      nextSeq: () => 1,
    } as any,
    {
      unitType: unit.type,
      unitId: unit.id,
      prompt: "",
      finalPrompt: "",
      pauseAfterUatDispatch: false,
      state: {} as any,
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: undefined,
    },
    {
      consecutiveFinalizeTimeouts: 0,
    },
  );
}

async function runFinalizeWithDeps(
  s: AutoSession,
  depsOverrides: Record<string, unknown>,
  ctxOverride?: Record<string, unknown>,
) {
  const unit = s.currentUnit;
  assert.ok(unit, "test setup must provide currentUnit");

  writeUnitRuntimeRecord(s.basePath, unit.type, unit.id, unit.startedAt, {
    phase: "dispatched",
  });

  const deps = {
    clearUnitTimeout() {},
    buildSnapshotOpts() {
      return {};
    },
    stopAuto: async () => {},
    pauseAuto: async () => {},
    updateProgressWidget() {},
    postUnitPreVerification: async () => "continue",
    runPostUnitVerification: async () => "continue",
    postUnitPostVerification: async () => "continue",
    ...depsOverrides,
  };

  return runFinalize(
    {
      ctx: ctxOverride ?? { ui: { notify() {} } },
      pi: {},
      s,
      deps,
      prefs: undefined,
      iteration: 1,
      flowId: "flow-1",
      nextSeq: () => 1,
    } as any,
    {
      unitType: unit.type,
      unitId: unit.id,
      prompt: "",
      finalPrompt: "",
      pauseAfterUatDispatch: false,
      state: {} as any,
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: undefined,
    },
    {
      consecutiveFinalizeTimeouts: 0,
    },
  );
}

test("runFinalize clears currentUnit after successful finalize", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-current-unit-"));
  const s = new AutoSession();
  s.basePath = base;
  s.currentUnit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt: Date.now(),
  };

  try {
    const result = await runSuccessfulFinalize(s);

    assert.equal(result.action, "next");
    assert.equal(s.currentUnit, null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runFinalize persists the durable verification-pause receipt (#2334)", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-verification-pause-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });

  const s = new AutoSession();
  s.basePath = base;
  s.currentUnit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt: Date.now(),
  };

  const recorded: Array<[string, string]> = [];
  const result = await runFinalizeWithDeps(s, {
    runPostUnitVerification: async () => "pause",
    emitJournalEvent: (entry: JournalEntry) => emitJournalEventFn(base, entry),
    recordVerificationPause: (unitType: string, unitId: string) => {
      recorded.push([unitType, unitId]);
    },
  });

  assert.equal(result.action, "break");
  assert.equal(result.reason, "verification-pause");
  assert.equal(s.currentUnit, null);
  assert.deepEqual(recorded, [["execute-task", "M001/S01/T01"]]);
});

test("runFinalize still pauses and warns when the verification-pause receipt cannot be recorded", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-verification-pause-fail-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const s = new AutoSession();
  s.basePath = base;
  s.currentUnit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt: Date.now(),
  };
  const notices: Array<[string, string]> = [];
  const result = await runFinalizeWithDeps(s, {
    runPostUnitVerification: async () => "pause",
    emitJournalEvent: () => {},
    recordVerificationPause: () => {
      throw new Error("database is closed");
    },
  }, { ui: { notify: (message: string, level: string) => notices.push([message, level]) } });

  assert.equal(result.action, "break");
  assert.equal(result.reason, "verification-pause");
  assert.ok(
    notices.some(([message, level]) => level === "warning" && /verification-pause receipt.*database is closed/.test(message)),
    "a lost receipt must be reported, not swallowed",
  );
});

test("runFinalize keeps a durable Task verification retry agent-owned across repeated failure signatures", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-task-retry-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const s = new AutoSession();
  s.basePath = base;
  let verificationAttempt = 0;
  let pauseCalls = 0;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, _timeout?: number, ...args: unknown[]) =>
    originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  async function finalizeAttempt(startedAt: number) {
    s.currentUnit = {
      type: "execute-task",
      id: "M001/S01/T01",
      startedAt,
    };
    return runFinalizeWithDeps(s, {
      pauseAuto: async () => {
        pauseCalls++;
      },
      runPostUnitVerification: async () => {
        verificationAttempt++;
        s.pendingVerificationRetry = {
          unitId: "M001/S01/T01",
          failureContext: "npm test failed after volatile timing",
          signature: "npm test#1",
          attempt: verificationAttempt,
        };
        return "retry";
      },
    });
  }

  assert.deepEqual(await finalizeAttempt(1), { action: "continue" });
  assert.deepEqual(await finalizeAttempt(2), { action: "continue" });
  assert.equal(pauseCalls, 0, "durable Task recovery must remain agent-owned after the same failure repeats");
  assert.equal(s.pendingVerificationRetry?.attempt, 2);
});

test("runFinalize still pauses a non-Task verification retry with a repeated failure signature", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-slice-retry-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const s = new AutoSession();
  s.basePath = base;
  s.currentUnit = {
    type: "complete-slice",
    id: "M001/S01",
    startedAt: 1,
  };
  s.verificationRetryFailureHashes.set(
    "complete-slice:M001/S01",
    hashVerificationFailureContext("npm test failed"),
  );
  let pauseCalls = 0;

  const result = await runFinalizeWithDeps(s, {
    pauseAuto: async () => {
      pauseCalls++;
    },
    runPostUnitVerification: async () => {
      s.pendingVerificationRetry = {
        unitId: "M001/S01",
        failureContext: "npm test failed",
        attempt: 2,
      };
      return "retry";
    },
  });

  assert.deepEqual(result, { action: "break", reason: "duplicate-failure-context" });
  assert.equal(pauseCalls, 1);
});

test("runFinalize keeps an execute-task deferred git-commit remediation retry agent-owned across repeated failure signatures", async (t) => {
  // #2119: after publishVerifiedTask the task is DB-complete, and a hook-rejected
  // deferred closeout commit returns "retry" from postUnitPostVerification with a
  // `git-commit:` signature. That retry is bounded by its own remediation cap and
  // must flow through the durable verification-retry policy — not the legacy
  // duplicate-signature breaker, which would pause mid-remediation with the
  // uncommitted work stranded in a paused state.
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-git-commit-retry-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const s = new AutoSession();
  s.basePath = base;
  s.currentUnit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt: 1,
  };
  const signature = "git-commit:1:blocked by test hook";
  s.verificationRetryFailureHashes.set(
    "execute-task:M001/S01/T01",
    hashVerificationFailureContext(signature),
  );
  let pauseCalls = 0;
  const journalEvents: Array<{ eventType: string; data: Record<string, unknown> }> = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, _timeout?: number, ...args: unknown[]) =>
    originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  const result = await runFinalizeWithDeps(s, {
    pauseAuto: async () => {
      pauseCalls++;
    },
    emitJournalEvent: (event: { eventType: string; data: Record<string, unknown> }) => {
      journalEvents.push(event);
    },
    postUnitPostVerification: async () => {
      s.pendingVerificationRetry = {
        unitId: "M001/S01/T01",
        failureContext: "Git commit failed after task verification. blocked by test hook",
        signature,
        attempt: 1,
      };
      return "retry";
    },
  });

  assert.deepEqual(result, { action: "continue" });
  assert.equal(pauseCalls, 0, "git-commit remediation retries are bounded by their own cap, not the legacy duplicate-signature breaker");
  assert.equal(s.pendingVerificationRetryDispatch?.unitType, "execute-task");
  assert.equal(
    s.pendingVerificationRetryDispatch?.unitId,
    "M001/S01/T01",
    "remediation re-dispatch must target the same published task with its failure context",
  );
  // #2119: the durable retry must be journaled as verification-retry, not the
  // misleading pre-execution-retry label.
  const retryEvents = journalEvents.filter((event) => event.eventType === "verification-retry");
  assert.equal(retryEvents.length, 1, "the deferred closeout retry must emit a verification-retry journal event");
  assert.equal(retryEvents[0]?.data.unitId, "M001/S01/T01");
  assert.equal(retryEvents[0]?.data.attempt, 1);
  assert.equal(
    journalEvents.some((event) => event.eventType === "pre-execution-retry"),
    false,
    "execute-task closeout retries must not be mislabeled as pre-execution-retry",
  );
});

test("runFinalize still pauses a non-task post-verification retry with a repeated failure signature", async (t) => {
  // Planning units keep the legacy pre-execution-retry policy: a repeated
  // failure signature must pause instead of re-dispatching (#2119 scope guard).
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-preexec-retry-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const s = new AutoSession();
  s.basePath = base;
  s.currentUnit = {
    type: "plan-slice",
    id: "M001/S01",
    startedAt: 1,
  };
  s.verificationRetryFailureHashes.set(
    "plan-slice:M001/S01",
    hashVerificationFailureContext("pre-execution check: missing UAT section"),
  );
  let pauseCalls = 0;
  const journalEvents: Array<{ eventType: string; data: Record<string, unknown> }> = [];

  const result = await runFinalizeWithDeps(s, {
    pauseAuto: async () => {
      pauseCalls++;
    },
    emitJournalEvent: (event: { eventType: string; data: Record<string, unknown> }) => {
      journalEvents.push(event);
    },
    postUnitPostVerification: async () => {
      s.pendingVerificationRetry = {
        unitId: "M001/S01",
        failureContext: "pre-execution check: missing UAT section",
        attempt: 2,
      };
      return "retry";
    },
  });

  assert.deepEqual(result, { action: "break", reason: "duplicate-failure-context" });
  assert.equal(pauseCalls, 1);
  // Planning units keep the legacy pre-execution-retry telemetry.
  const retryEvents = journalEvents.filter((event) => event.eventType === "pre-execution-retry");
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0]?.data.unitId, "M001/S01");
  assert.equal(retryEvents[0]?.data.attempt, 2);
});

/** A project database with a claimed plan-slice dispatch row for M001/S01. */
function openProjectWithPlanSliceDispatch(t: { after(cb: () => void): void }): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-stored-retry-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
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
  return base;
}

/** Run the retry delay of the retry policy with no wait. */
function skipRetryDelay(t: { after(cb: () => void): void }): void {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, _timeout?: number, ...args: unknown[]) =>
    originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
  });
}

const PLANNER_RETRY = {
  unitId: "M001/S01",
  failureContext: "pre-execution check: task T01 reads a file that no task creates",
  attempt: 1,
};

test("runFinalize keeps no session snapshot for a planner retry stored on the dispatch row", async (t) => {
  const s = new AutoSession();
  s.basePath = openProjectWithPlanSliceDispatch(t);
  s.currentUnit = { type: "plan-slice", id: "M001/S01", startedAt: 1 };
  skipRetryDelay(t);

  const result = await runFinalizeWithDeps(s, {
    emitJournalEvent() {},
    postUnitPostVerification: async () => {
      s.pendingVerificationRetry = PLANNER_RETRY;
      storeUnitRetry("plan-slice", PLANNER_RETRY);
      return "retry";
    },
  });

  assert.deepEqual(result, { action: "continue" });
  assert.equal(
    s.pendingVerificationRetryDispatch,
    null,
    "the dispatch rules select a stored retry from the database, not from a session snapshot",
  );
  assert.deepEqual(readStoredUnitRetry("plan-slice", "M001/S01"), PLANNER_RETRY);
});

test("runFinalize replays a planner retry with no dispatch row from the session snapshot", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-unclaimed-retry-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  const s = new AutoSession();
  s.basePath = base;
  s.currentUnit = { type: "plan-slice", id: "M001/S01", startedAt: 1 };
  skipRetryDelay(t);

  const result = await runFinalizeWithDeps(s, {
    emitJournalEvent() {},
    postUnitPostVerification: async () => {
      s.pendingVerificationRetry = PLANNER_RETRY;
      storeUnitRetry("plan-slice", PLANNER_RETRY);
      return "retry";
    },
  });

  assert.deepEqual(result, { action: "continue" });
  assert.equal(s.pendingVerificationRetryDispatch?.unitType, "plan-slice");
  assert.equal(s.pendingVerificationRetryDispatch?.unitId, "M001/S01");
});

test("a retry-policy pause releases the planner retry stored on the dispatch row", async (t) => {
  const s = new AutoSession();
  s.basePath = openProjectWithPlanSliceDispatch(t);
  s.currentUnit = { type: "plan-slice", id: "M001/S01", startedAt: 1 };
  s.verificationRetryFailureHashes.set(
    "plan-slice:M001/S01",
    hashVerificationFailureContext(PLANNER_RETRY.failureContext),
  );

  const result = await runFinalizeWithDeps(s, {
    emitJournalEvent() {},
    postUnitPostVerification: async () => {
      s.pendingVerificationRetry = PLANNER_RETRY;
      storeUnitRetry("plan-slice", PLANNER_RETRY);
      return "retry";
    },
  });

  assert.deepEqual(result, { action: "break", reason: "duplicate-failure-context" });
  assert.equal(
    readStoredUnitRetry("plan-slice", "M001/S01"),
    null,
    "the pause gives the plan to a person, so a resume must not send the slice back to the planner",
  );
});

test("runFinalize marks unit runtime finalized after successful finalize", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-runtime-"));
  const s = new AutoSession();
  const startedAt = Date.now();
  s.basePath = base;
  s.currentUnit = {
    type: "complete-milestone",
    id: "M001",
    startedAt,
  };

  const { openDatabase, closeDatabase } = await import("../gsd-db.ts");
  try {
    openDatabase(":memory:");
    const result = await runSuccessfulFinalize(s);
    const runtime = readUnitRuntimeRecord(base, "complete-milestone", "M001");

    assert.equal(result.action, "next");
    assert.equal(runtime?.phase, "finalized");
    assert.equal(runtime?.lastProgressKind, "finalize-success");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("runFinalize merges a verified complete-milestone immediately and only once", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-merge-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const s = new AutoSession();
  const startedAt = Date.now();
  let lifecycleMergeCalls = 0;
  let resolverMergeCalls = 0;
  const stopAutoCalls: Array<{ reason?: string; options?: unknown }> = [];
  s.basePath = base;
  s.originalBasePath = base;
  s.currentMilestoneId = "M001";
  s.currentUnit = {
    type: "complete-milestone",
    id: "M001",
    startedAt,
  };

  const result = await runFinalizeWithDeps(s, {
    preflightCleanRoot: () => ({ stashPushed: false }),
    postflightPopStash: () => ({ needsManualRecovery: false }),
    stopAuto: async (_ctx: unknown, _pi: unknown, reason?: string, options?: unknown) => {
      stopAutoCalls.push({ reason, options });
    },
    resolver: {
      mergeAndExit() {
        resolverMergeCalls++;
      },
    },
    lifecycle: {
      exitMilestone(_mid: string, opts: { merge: boolean }) {
        if (opts.merge) lifecycleMergeCalls++;
        return { ok: true, merged: opts.merge, codeFilesChanged: false };
      },
    },
  });

  assert.equal(result.action, "break");
  assert.equal(result.reason, "milestone-complete");
  assert.equal(lifecycleMergeCalls, 1);
  assert.equal(resolverMergeCalls, 0);
  assert.equal(s.milestoneMergedInPhases, true);
  assert.equal(stopAutoCalls.length, 1);
  assert.equal(stopAutoCalls[0]?.reason, "Milestone M001 complete");
  assert.deepEqual(stopAutoCalls[0]?.options, {
    completionWidget: {
      milestoneId: "M001",
      milestoneTitle: "Milestone",
    },
  });

  s.currentUnit = {
    type: "complete-milestone",
    id: "M001",
    startedAt: startedAt + 1,
  };
  const second = await runFinalizeWithDeps(s, {
    preflightCleanRoot: () => ({ stashPushed: false }),
    postflightPopStash: () => ({ needsManualRecovery: false }),
    stopAuto: async (_ctx: unknown, _pi: unknown, reason?: string, options?: unknown) => {
      stopAutoCalls.push({ reason, options });
    },
    resolver: {
      mergeAndExit() {
        resolverMergeCalls++;
      },
    },
    lifecycle: {
      exitMilestone(_mid: string, opts: { merge: boolean }) {
        if (opts.merge) lifecycleMergeCalls++;
        return { ok: true, merged: opts.merge, codeFilesChanged: false };
      },
    },
  });

  assert.equal(second.action, "break");
  assert.equal(second.reason, "milestone-complete");
  assert.equal(lifecycleMergeCalls, 1);
  assert.equal(resolverMergeCalls, 0);
  assert.equal(stopAutoCalls.length, 2);
});

test("runFinalize does not render next-phase handoff for complete-milestone", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-complete-handoff-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const s = new AutoSession();
  const widgetCalls: Array<[string, unknown]> = [];
  s.basePath = base;
  s.originalBasePath = base;
  s.currentMilestoneId = "M001";
  s.currentUnit = {
    type: "complete-milestone",
    id: "M001",
    startedAt: Date.now(),
  };

  const result = await runFinalizeWithDeps(
    s,
    {
      preflightCleanRoot: () => ({ stashPushed: false }),
      postflightPopStash: () => ({ needsManualRecovery: false }),
      lifecycle: {
        exitMilestone() {
          return { ok: true, merged: true, codeFilesChanged: false };
        },
      },
    },
    {
      hasUI: true,
      ui: {
        notify() {},
        setWidget(key: string, value: unknown) {
          widgetCalls.push([key, value]);
        },
      },
    },
  );

  assert.equal(result.action, "break");
  assert.equal(
    widgetCalls.some(([key]) => key === "gsd-outcome"),
    false,
    "complete-milestone finalize should leave terminal completion UI to stopAuto",
  );
});

test("runFinalize clears gsd-step and gsd-progress before stopAuto on complete-milestone", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-stale-widget-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const s = new AutoSession();
  s.basePath = base;
  s.originalBasePath = base;
  s.currentMilestoneId = "M001";
  s.currentUnit = {
    type: "complete-milestone",
    id: "M001",
    startedAt: Date.now(),
  };

  const statusCalls: Array<[string, unknown]> = [];
  const widgetCalls: Array<[string, unknown]> = [];

  await runFinalizeWithDeps(
    s,
    {
      preflightCleanRoot: () => ({ stashPushed: false }),
      postflightPopStash: () => ({ needsManualRecovery: false }),
      lifecycle: {
        exitMilestone() {
          return { ok: true, merged: true, codeFilesChanged: false };
        },
      },
    },
    {
      hasUI: true,
      ui: {
        notify() {},
        setStatus(key: string, value: unknown) {
          statusCalls.push([key, value]);
        },
        setWidget(key: string, value: unknown) {
          widgetCalls.push([key, value]);
        },
      },
    },
  );

  assert.ok(
    statusCalls.some(([key, val]) => key === "gsd-step" && val === undefined),
    "gsd-step status should be cleared before stopAuto",
  );
  assert.ok(
    widgetCalls.some(([key, val]) => key === "gsd-progress" && val === undefined),
    "gsd-progress widget should be cleared before stopAuto",
  );
});

test("runFinalize stops before merge when an isolated unit leaks app files into project root", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-root-leak-root-"));
  const worktree = join(root, ".gsd", "worktrees", "M001");
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  initRepo(root);
  mkdirSync(worktree, { recursive: true });

  const s = new AutoSession();
  s.basePath = worktree;
  s.originalBasePath = root;
  s.currentMilestoneId = "M001";
  s.rootWriteBaseline = captureRootDirtySnapshot(root);
  s.currentUnit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt: Date.now(),
  };

  writeFileSync(join(root, "index.html"), "<h1>Leaked root edit</h1>\n");
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "verify-s09.sh"), "#!/usr/bin/env bash\n");

  const notifications: Array<{ message: string; level?: string }> = [];
  const stopCalls: Array<{ reason?: string; preserve?: boolean }> = [];
  const mergeCalls: string[] = [];
  const checkpointCalls: string[] = [];
  const result = await runFinalizeWithDeps(
    s,
    {
      checkpointWorkflowDatabase() {
        checkpointCalls.push("checkpoint");
      },
      stopAuto: async (_ctx: unknown, _pi: unknown, reason?: string, options?: { preserveCompletedMilestoneBranch?: boolean }) => {
        stopCalls.push({ reason, preserve: options?.preserveCompletedMilestoneBranch });
      },
      preflightCleanRoot() {
        mergeCalls.push("preflight");
        return { stashPushed: false };
      },
      lifecycle: {
        exitMilestone() {
          mergeCalls.push("merge");
          return { ok: true, merged: true, codeFilesChanged: true };
        },
      },
    },
    {
      ui: {
        notify(message: string, level?: string) {
          notifications.push({ message, level });
        },
      },
    },
  );

  assert.equal(result.action, "break");
  assert.equal(result.reason, "root-write-leak");
  assert.deepEqual(checkpointCalls, ["checkpoint"], "root-write leak should flush DB before stopAuto");
  assert.deepEqual(stopCalls, [{ reason: "Root-write leak during isolated auto-mode", preserve: true }]);
  assert.deepEqual(mergeCalls, [], "root-write leak must stop before merge preflight");
  const message = notifications.find((n) => n.level === "error")?.message ?? "";
  assert.match(message, /execute-task M001\/S01\/T01/);
  assert.match(message, /Project root:/);
  assert.match(message, /Expected worktree:/);
  assert.doesNotMatch(message, /index\.html/);
  assert.match(message, /tests\/verify-s09\.sh/);
});

test("runFinalize ignores tracked root artifact changes during isolated units", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-root-leak-tracked-"));
  const worktree = join(root, ".gsd", "worktrees", "M001");
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  initRepo(root);
  writeFileSync(join(root, "openapi.json"), "{}\n");
  runGit(root, ["add", "openapi.json"]);
  runGit(root, ["commit", "-m", "chore: add generated spec"]);
  mkdirSync(worktree, { recursive: true });

  const s = new AutoSession();
  s.basePath = worktree;
  s.originalBasePath = root;
  s.currentMilestoneId = "M001";
  s.rootWriteBaseline = captureRootDirtySnapshot(root);
  s.currentUnit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt: Date.now(),
  };

  writeFileSync(join(root, "openapi.json"), "{\"generated\":true}\n");

  const stopCalls: string[] = [];
  const result = await runFinalizeWithDeps(s, {
    stopAuto: async (_ctx: unknown, _pi: unknown, reason?: string) => {
      stopCalls.push(reason ?? "");
    },
  });

  assert.equal(result.action, "next");
  assert.deepEqual(stopCalls, []);
});

test("runFinalize allows root .gsd-only changes during isolated units", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-root-leak-gsd-"));
  const worktree = join(root, ".gsd", "worktrees", "M001");
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  initRepo(root);
  mkdirSync(join(root, ".gsd"), { recursive: true });
  mkdirSync(worktree, { recursive: true });

  const s = new AutoSession();
  s.basePath = worktree;
  s.originalBasePath = root;
  s.currentMilestoneId = "M001";
  s.rootWriteBaseline = captureRootDirtySnapshot(root);
  s.currentUnit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt: Date.now(),
  };

  writeFileSync(join(root, ".gsd", "metrics.json"), "{}\n");

  const stopCalls: string[] = [];
  const result = await runFinalizeWithDeps(s, {
    stopAuto: async (_ctx: unknown, _pi: unknown, reason?: string) => {
      stopCalls.push(reason ?? "");
    },
  });

  assert.equal(result.action, "next");
  assert.deepEqual(stopCalls, []);
});

// ── #2443: finalize retry of a verified Attempt re-runs finalize/publication only ──

interface FinalizeRetryFixture {
  basePath: string;
}

async function seedVerifiedTaskAttempt(): Promise<FinalizeRetryFixture> {
  const { openDatabase, closeDatabase: _close, _getAdapter } = await import("../gsd-db.ts");
  const { executeDomainOperation } = await import("../db/domain-operation.ts");
  const { adoptOrTransitionLifecycle, readDomainOperationFence } = await import("../db/writers/lifecycle-commands.ts");
  const { claimTaskAttempt, settleTaskAttempt } = await import("../task-execution-domain-operation.ts");
  void _close;

  const base = mkdtempSync(join(tmpdir(), "gsd-finalize-verified-retry-"));
  assert.equal(openDatabase(join(base, "gsd.db")), true);
  _getAdapter()!.exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Finalize retry', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Retry', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, full_summary_md)
    VALUES ('M001', 'S01', 'T01', 'Verified task', 'pending', '# T01\n');
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-12T00:00:00.000Z', 'test',
      '2026-07-12T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-12T00:00:00.000Z',
      '2099-07-12T00:00:00.000Z', 'held'
    );
  `);
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: "fixture/finalize-retry-task-ready",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T01" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.task.ready",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: { taskId: "T01" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/m001/s01/t01",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  _getAdapter()!.prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES ('trace-finalize-retry', 'turn-finalize-retry', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01', 'claimed', 1,
      '2026-07-12T00:01:00.000Z')
  `).run();
  const dispatchRow = _getAdapter()!.prepare("SELECT MAX(id) AS id FROM unit_dispatches").get() as { id: number };
  const claimed = claimTaskAttempt({
    invocation: { idempotencyKey: "fixture/finalize-retry/claim/1", sourceTransport: "internal", actorType: "agent" },
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatchRow.id),
  });
  settleTaskAttempt({
    invocation: { idempotencyKey: "fixture/finalize-retry/settle/1", sourceTransport: "internal", actorType: "agent" },
    attemptId: claimed.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "executor staged completion",
    output: {},
  });
  return { basePath: base };
}

test("runFinalize re-runs finalize/publication only when an artifact retry hits a verified Attempt (#2443)", async (t) => {
  const { closeDatabase } = await import("../gsd-db.ts");
  const { basePath } = await seedVerifiedTaskAttempt();
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(basePath, { recursive: true, force: true });
  });

  const s = new AutoSession();
  s.basePath = basePath;
  const startedAt = Date.now();
  s.currentUnit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt,
  };
  writeUnitRuntimeRecord(s.basePath, "execute-task", "M001/S01/T01", startedAt, {
    phase: "dispatched",
  });

  let gateRuns = 0;
  let publishCalls = 0;
  const journalEvents: Array<{ eventType: string; data: Record<string, unknown> }> = [];
  const deps = {
    clearUnitTimeout() {},
    buildSnapshotOpts() {
      return {};
    },
    stopAuto: async () => {},
    pauseAuto: async () => {},
    updateProgressWidget() {},
    emitJournalEvent: (event: { eventType: string; data: Record<string, unknown> }) => {
      journalEvents.push(event);
    },
    // The artifact re-verification inside pre-verification failed (e.g. the
    // readiness read raced the DB), while the canonical Attempt already sits
    // at the verify stage with a verified artifact.
    postUnitPreVerification: async () => {
      s.pendingVerificationRetry = {
        unitId: "M001/S01/T01",
        failureContext: "SUMMARY.md check raced the DB read",
        attempt: 1,
      };
      return "retry";
    },
    runPostUnitVerification: async () => {
      gateRuns += 1;
      return "continue";
    },
    postUnitPostVerification: async () => "continue",
  };

  const result = await runFinalize(
    {
      ctx: { ui: { notify() {} } },
      pi: {},
      s,
      deps,
      prefs: undefined,
      iteration: 1,
      flowId: "flow-finalize-retry",
      nextSeq: () => 1,
    } as any,
    {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "",
      finalPrompt: "",
      pauseAfterUatDispatch: false,
      state: {} as any,
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: undefined,
    },
    {
      consecutiveFinalizeTimeouts: 0,
    },
    undefined,
    async () => {
      publishCalls += 1;
    },
  );

  assert.equal(result.action, "next", "the verified Attempt must complete finalize in this pass");
  assert.equal(gateRuns, 1, "the verification gate must re-run in the same finalize pass");
  assert.equal(publishCalls, 1, "publication must run from the existing verified artifact");
  assert.equal(s.pendingVerificationRetry, null, "the consumed retry marker must not linger");
  assert.equal(
    s.pendingVerificationRetryDispatch,
    null,
    "no unit re-dispatch may be enqueued for a verified Attempt",
  );
  assert.ok(
    journalEvents.some((event) => event.eventType === "artifact-verification-retry"),
    "the spurious artifact retry stays journaled for forensics",
  );
});

test("runFinalize still re-dispatches a git-commit remediation retry for a verified Attempt (#2443)", async (t) => {
  const { closeDatabase } = await import("../gsd-db.ts");
  const { basePath } = await seedVerifiedTaskAttempt();
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(basePath, { recursive: true, force: true });
  });

  const s = new AutoSession();
  s.basePath = basePath;
  const startedAt = Date.now();
  s.currentUnit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt,
  };
  writeUnitRuntimeRecord(s.basePath, "execute-task", "M001/S01/T01", startedAt, {
    phase: "dispatched",
  });

  let gateRuns = 0;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, _timeout?: number, ...args: unknown[]) =>
    originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  const result = await runFinalize(
    {
      ctx: { ui: { notify() {} } },
      pi: {},
      s,
      deps: {
        clearUnitTimeout() {},
        buildSnapshotOpts() {
          return {};
        },
        stopAuto: async () => {},
        pauseAuto: async () => {},
        updateProgressWidget() {},
        emitJournalEvent: () => {},
        postUnitPreVerification: async () => {
          // A hook rejected the closeout commit after task verification —
          // this retry re-dispatches the task on purpose (#2119).
          s.pendingVerificationRetry = {
            unitId: "M001/S01/T01",
            failureContext: "Git commit failed after task verification. hook rejected",
            signature: "git-commit:1:hook rejected",
            attempt: 1,
          };
          return "retry";
        },
        runPostUnitVerification: async () => {
          gateRuns += 1;
          return "continue";
        },
        postUnitPostVerification: async () => "continue",
      },
      prefs: undefined,
      iteration: 1,
      flowId: "flow-git-commit-retry",
      nextSeq: () => 1,
    } as any,
    {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "",
      finalPrompt: "",
      pauseAfterUatDispatch: false,
      state: {} as any,
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: undefined,
    },
    {
      consecutiveFinalizeTimeouts: 0,
    },
  );

  assert.deepEqual(result, { action: "continue" }, "git-commit remediation keeps its re-dispatch path");
  assert.equal(gateRuns, 0, "the gate must not run instead of the remediation re-dispatch");
  assert.equal(s.pendingVerificationRetryDispatch?.unitId, "M001/S01/T01");
});
