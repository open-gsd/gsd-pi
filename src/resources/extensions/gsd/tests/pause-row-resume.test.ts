// Project/App: gsd-pi
// File Purpose: Behavior tests for the pause row (auto_pauses) and the stage checkpoint on the dispatch row that resume reads.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _handlePausedSessionResumeRecoveryForTest, pauseAuto, startAuto } from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { getRuntimeKv, setRuntimeKv } from "../db/runtime-kv.ts";
import { getDispatchStage, markCompleted, recordDispatchClaim, setDispatchStage } from "../db/unit-dispatches.ts";
import { openAutoPause } from "../db/writers/auto-pauses.ts";
import { checkRuntimeHealth } from "../doctor-runtime-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import {
  assessInterruptedSession,
  clearPausedSession,
  PAUSED_SESSION_KV_KEY,
  readPausedSessionMetadata,
} from "../interrupted-session.ts";
import { assertMigrationTargetAvailable } from "../migrate/safety.ts";
import { _setProperLockfileForTests } from "../session-lock.ts";

function makeProject(t: TestContext): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-pause-row-")));
  const previousCwd = process.cwd();
  // Resume routing still asks for a milestone directory that holds content.
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# Milestone\n", "utf-8");
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  autoSession.reset();
  t.after(() => {
    autoSession.reset();
    try { closeDatabase(); } catch { /* already closed */ }
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

/**
 * Claim the dispatch row of a unit, as advance() does before the unit runs.
 * With `held`, the worker that ran an earlier unit claims the row.
 */
function claimUnit(
  base: string,
  unitType: string,
  unitId: string,
  held?: { workerId: string; leaseToken: number },
): { workerId: string; leaseToken: number; dispatchId: number } {
  const workerId = held?.workerId ?? registerAutoWorker({ projectRootRealpath: base });
  let leaseToken = held?.leaseToken;
  if (leaseToken === undefined) {
    const lease = claimMilestoneLease(workerId, "M001");
    if (!lease.ok) throw new Error("expected a milestone lease");
    leaseToken = lease.token;
  }
  const [, sliceId = null, taskId = null] = unitId.split("/");
  const claim = recordDispatchClaim({
    traceId: "trace-pause-row",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M001",
    sliceId,
    taskId,
    unitType,
    unitId,
  });
  if (!claim.ok) throw new Error(`expected a dispatch claim: ${claim.error}`);
  return { workerId, leaseToken, dispatchId: claim.dispatchId };
}

/** A session file of a unit that ran one tool call before it stopped. */
function writeSessionFile(base: string): string {
  const sessionFile = join(base, "unit-session.jsonl");
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: "session", id: "session-1" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", id: "tool-1", arguments: { command: "echo work" } }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", toolCallId: "tool-1", toolName: "bash", isError: false, content: "work\n" },
      }),
    ].join("\n"),
    "utf-8",
  );
  return sessionFile;
}

function openPauseRows(): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare(
    "SELECT * FROM auto_pauses WHERE closed_at IS NULL ORDER BY id",
  ).all() as Array<Record<string, unknown>>;
}

/** Make the session lock fail, so startAuto returns after it restored the pause. */
function refuseSessionLock(t: TestContext): void {
  const restore = _setProperLockfileForTests({
    lockSync: () => {
      throw new Error("lock is held");
    },
  } as NonNullable<Parameters<typeof _setProperLockfileForTests>[0]>);
  t.after(restore);
}

function makeStartAutoHost(notifications: string[]): {
  ctx: Parameters<typeof startAuto>[0];
  pi: Parameters<typeof startAuto>[1];
} {
  const ctx = {
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: { getSessionId: () => "pause-row-resume-test" },
    modelRegistry: { getAvailable: () => [], isProviderRequestReady: () => false },
    model: undefined,
  } as unknown as Parameters<typeof startAuto>[0];
  const pi = { getThinkingLevel: () => "off" } as unknown as Parameters<typeof startAuto>[1];
  return { ctx, pi };
}

test("pauseAuto stores the pause as a row with the blocker kind and the link to the active dispatch", async (t) => {
  const base = makeProject(t);
  const unit = claimUnit(base, "plan-slice", "M001/S01");
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M001";
  autoSession.workerId = unit.workerId;
  autoSession.milestoneLeaseToken = unit.leaseToken;
  autoSession.currentUnit = { type: "plan-slice", id: "M001/S01", startedAt: Date.now() };
  process.chdir(base);

  await pauseAuto(undefined, undefined, "user_limit", {
    message: "Budget ceiling reached",
    category: "unknown",
  });

  const rows = openPauseRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["blocker_kind"], "user_limit");
  assert.equal(rows[0]["dispatch_id"], unit.dispatchId);
  assert.equal(rows[0]["milestone_id"], "M001");
  assert.equal(rows[0]["unit_type"], "plan-slice");
  assert.equal(rows[0]["unit_id"], "M001/S01");
  assert.equal(rows[0]["pause_reason"], "Budget ceiling reached");
  assert.equal(
    getRuntimeKv("global", "", PAUSED_SESSION_KV_KEY),
    null,
    "the retired runtime_kv key must not be written",
  );

  const stored = readPausedSessionMetadata(base);
  assert.equal(stored?.blockerKind, "user_limit");
  assert.equal(stored?.dispatchId, unit.dispatchId);
});

/** Pause the session of a worker, then resume with a session file that has a tool call. */
async function pauseThenResume(
  base: string,
  worker: { workerId: string; leaseToken: number },
  currentUnit: { type: string; id: string } | null,
): Promise<{ dispatchId: unknown; skippedReplay: boolean; replayPrompt: string | null }> {
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M001";
  autoSession.workerId = worker.workerId;
  autoSession.milestoneLeaseToken = worker.leaseToken;
  autoSession.currentUnit = currentUnit ? { ...currentUnit, startedAt: Date.now() } : null;
  process.chdir(base);

  await pauseAuto(undefined, undefined, "missing_access");

  const state = {
    pausedSessionFile: writeSessionFile(base),
    pausedDispatchId: readPausedSessionMetadata(base)?.dispatchId ?? null,
    pendingCrashRecovery: null as string | null,
  };
  const { skippedReplay } = _handlePausedSessionResumeRecoveryForTest(base, state);
  return { dispatchId: openPauseRows()[0]["dispatch_id"], skippedReplay, replayPrompt: state.pendingCrashRecovery };
}

test("a pause after the claim and before the first unit starts has no dispatch link and no replay", async (t) => {
  const base = makeProject(t);
  // The loop claimed the row. The unit did not start, so the session file is
  // not the file of this unit.
  const claimed = claimUnit(base, "execute-task", "M001/S01/T01");

  const result = await pauseThenResume(base, claimed, null);

  assert.equal(result.dispatchId, null);
  assert.equal(result.skippedReplay, true);
  assert.equal(result.replayPrompt, null);
});

test("a pause after the claim and before the next unit starts links the previous unit and does not replay", async (t) => {
  const base = makeProject(t);
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Next task", status: "pending" });
  const previous = claimUnit(base, "execute-task", "M001/S01/T01");
  setDispatchStage(previous.dispatchId, "closeout");
  markCompleted(previous.dispatchId);
  const next = claimUnit(base, "execute-task", "M001/S01/T02", previous);

  // The session file is still the file of T01: T02 did not start.
  const result = await pauseThenResume(base, previous, { type: "execute-task", id: "M001/S01/T01" });

  assert.notEqual(result.dispatchId, next.dispatchId, "the unit that did not start must not own the session file");
  assert.equal(result.dispatchId, previous.dispatchId);
  assert.equal(result.skippedReplay, true);
  assert.equal(result.replayPrompt, null);
});

test("a new pause closes the open pause of the scope and keeps its row", (t) => {
  makeProject(t);

  openAutoPause({ blockerKind: "machine_fixable", milestoneId: "M001", pauseReason: "first" });
  openAutoPause({ blockerKind: "consent", milestoneId: "M001", pauseReason: "second" });

  const open = openPauseRows();
  assert.equal(open.length, 1);
  assert.equal(open[0]["pause_reason"], "second");
  const all = _getAdapter()!.prepare("SELECT pause_reason, closed_at FROM auto_pauses ORDER BY id").all();
  assert.equal(all.length, 2, "the closed pause stays in the table");
  assert.notEqual(all[0]["closed_at"], null);
});

test("the pause row refuses a blocker kind that is not in the taxonomy", (t) => {
  makeProject(t);

  assert.throws(
    () => openAutoPause({ blockerKind: "provider-error" as never, milestoneId: "M001" }),
    /CHECK constraint failed/,
  );
  assert.equal(openPauseRows().length, 0);
});

test("a pause that an older build left in runtime_kv is read when no row is open, and the row wins", (t) => {
  const base = makeProject(t);
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, { milestoneId: "M001", stepMode: true });

  const legacy = readPausedSessionMetadata(base);
  assert.equal(legacy?.milestoneId, "M001");
  assert.equal(legacy?.stepMode, true);
  assert.equal(legacy?.blockerKind, undefined, "a legacy pause has no blocker kind");

  openAutoPause({ blockerKind: "user_request", milestoneId: "M002" });
  assert.equal(readPausedSessionMetadata(base)?.milestoneId, "M002");

  clearPausedSession();
  assert.equal(readPausedSessionMetadata(base), null, "clearing closes the row and deletes the legacy key");
  assert.equal(getRuntimeKv("global", "", PAUSED_SESSION_KV_KEY), null);
});

test("resume replays the session of a paused unit that is still in the execute stage", (t) => {
  const base = makeProject(t);
  const unit = claimUnit(base, "execute-task", "M001/S01/T01");
  const state = {
    pausedSessionFile: writeSessionFile(base),
    pausedDispatchId: unit.dispatchId,
    pendingCrashRecovery: null as string | null,
  };

  const result = _handlePausedSessionResumeRecoveryForTest(base, state);

  assert.equal(result.skippedReplay, false);
  assert.match(state.pendingCrashRecovery ?? "", /echo work/);
  assert.equal(state.pausedSessionFile, null);
  assert.equal(state.pausedDispatchId, null);
});

test("resume does not replay a paused unit whose dispatch row left the execute stage", (t) => {
  const base = makeProject(t);
  const unit = claimUnit(base, "execute-task", "M001/S01/T01");
  setDispatchStage(unit.dispatchId, "verify");
  const state = {
    pausedSessionFile: writeSessionFile(base),
    pausedDispatchId: unit.dispatchId,
    pendingCrashRecovery: "stale-recovery-prompt" as string | null,
  };

  const result = _handlePausedSessionResumeRecoveryForTest(base, state);

  assert.equal(result.skippedReplay, true);
  assert.equal(state.pendingCrashRecovery, null);
});

test("restart after a kill in the execute stage replays the session file of the unit", async (t) => {
  const base = makeProject(t);
  const unit = claimUnit(base, "execute-task", "M001/S01/T01");
  setRuntimeKv("worker", unit.workerId, "session_file", writeSessionFile(base));
  killWorker(unit.workerId);

  const assessment = await assessInterruptedSession(base);

  assert.equal(assessment.lock?.dispatchId, unit.dispatchId);
  assert.equal(assessment.artifactSatisfied, false);
  assert.equal(assessment.recoveryToolCallCount, 1);
  assert.match(assessment.recoveryPrompt ?? "", /echo work/);
});

test("restart after a kill in the verify stage reads the stage from the dispatch row and does not replay", async (t) => {
  const base = makeProject(t);
  const unit = claimUnit(base, "execute-task", "M001/S01/T01");
  setRuntimeKv("worker", unit.workerId, "session_file", writeSessionFile(base));
  setDispatchStage(unit.dispatchId, "verify");
  killWorker(unit.workerId);

  // The next process reads the stage from the database file.
  closeDatabase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  const assessment = await assessInterruptedSession(base);

  assert.equal(getDispatchStage(unit.dispatchId), "verify");
  assert.equal(assessment.lock?.dispatchId, unit.dispatchId);
  assert.equal(assessment.artifactSatisfied, true, "the unit has no execution to continue");
  assert.equal(assessment.recoveryToolCallCount, 0);
  assert.equal(assessment.recoveryPrompt, null);
});

test("restart resumes a pause that had no active unit from the pause row", async (t) => {
  const base = makeProject(t);
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M001";
  autoSession.stepMode = true;
  process.chdir(base);
  await pauseAuto(undefined, undefined, "ambiguous_intent");
  assert.equal(openPauseRows()[0]["dispatch_id"], null, "no unit was active");

  // The restart: a new process has no session memory.
  autoSession.reset();
  refuseSessionLock(t);
  const notifications: string[] = [];
  const { ctx, pi } = makeStartAutoHost(notifications);

  await startAuto(ctx, pi, base, false);

  assert.ok(
    notifications.some((message) => message.includes("Resuming paused session for M001")),
    `resume must read the pause row; got: ${notifications.join(" | ")}`,
  );
  assert.equal(autoSession.currentMilestoneId, "M001");
  assert.equal(autoSession.stepMode, true);
  assert.equal(autoSession.pausedDispatchId, null);

  // No unit was active, so the resumed session gets no tool-call replay.
  const state = {
    pausedSessionFile: writeSessionFile(base),
    pausedDispatchId: autoSession.pausedDispatchId,
    pendingCrashRecovery: null as string | null,
  };
  assert.equal(_handlePausedSessionResumeRecoveryForTest(base, state).skippedReplay, true);
  assert.equal(state.pendingCrashRecovery, null);
});

test("restart resumes the named run of a custom-engine pause from the pause row", async (t) => {
  const base = makeProject(t);
  const runDir = join(base, ".gsd", "workflow-runs", "release-notes-1");
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.activeEngineId = "custom";
  autoSession.activeRunDir = runDir;
  // A custom-engine step that is not a Task runs with no dispatch row.
  autoSession.currentUnit = { type: "custom-step", id: "release-notes/draft", startedAt: Date.now() };
  process.chdir(base);
  await pauseAuto(undefined, undefined, "user_request");
  const row = openPauseRows()[0];
  assert.equal(row["dispatch_id"], null, "the custom-engine step has no dispatch row");
  assert.equal(row["active_run_dir"], runDir);

  // The restart: a new process has no session memory.
  autoSession.reset();
  refuseSessionLock(t);
  const notifications: string[] = [];
  const { ctx, pi } = makeStartAutoHost(notifications);

  await startAuto(ctx, pi, base, false);

  assert.ok(
    notifications.some((message) => message.includes(`Resuming paused custom workflow (${runDir})`)),
    `resume must read the pause row; got: ${notifications.join(" | ")}`,
  );
  assert.equal(autoSession.activeEngineId, "custom");
  assert.equal(autoSession.activeRunDir, runDir);
});

/** Open the pause of a parallel worker on a milestone, from a process that is not that worker. */
function pauseParallelWorker(t: TestContext, milestoneId: string, sliceId?: string): void {
  const previousWorker = process.env.GSD_PARALLEL_WORKER;
  const previousLock = process.env.GSD_MILESTONE_LOCK;
  const previousSliceLock = process.env.GSD_SLICE_LOCK;
  const restore = (): void => {
    if (previousWorker === undefined) delete process.env.GSD_PARALLEL_WORKER;
    else process.env.GSD_PARALLEL_WORKER = previousWorker;
    if (previousLock === undefined) delete process.env.GSD_MILESTONE_LOCK;
    else process.env.GSD_MILESTONE_LOCK = previousLock;
    if (previousSliceLock === undefined) delete process.env.GSD_SLICE_LOCK;
    else process.env.GSD_SLICE_LOCK = previousSliceLock;
  };
  t.after(restore);
  process.env.GSD_PARALLEL_WORKER = "1";
  process.env.GSD_MILESTONE_LOCK = milestoneId;
  if (sliceId) process.env.GSD_SLICE_LOCK = sliceId;
  openAutoPause({ blockerKind: "machine_fixable", milestoneId });
  restore();
}

function completeMilestone(milestoneId: string): void {
  _getAdapter()!.prepare(
    "UPDATE milestones SET status = 'complete' WHERE id = :id",
  ).run({ ":id": milestoneId });
}

function pauseRowsOfScope(scope: string): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare(
    "SELECT * FROM auto_pauses WHERE scope = :scope ORDER BY id",
  ).all({ ":scope": scope }) as Array<Record<string, unknown>>;
}

test("the pause of a parallel worker scope blocks migration until the doctor fix closes it for a closed milestone", async (t) => {
  const base = makeProject(t);
  const dbPath = join(base, ".gsd", "gsd.db");
  insertMilestone({ id: "M002", title: "Open milestone", status: "active" });

  await assertMigrationTargetAvailable(base);

  // The process that migrates is not the worker, so its own scope has no open pause.
  openDatabase(dbPath);
  pauseParallelWorker(t, "M001");
  assert.equal(readPausedSessionMetadata(base), null);
  await assert.rejects(
    () => assertMigrationTargetAvailable(base),
    /paused auto-mode session exists.*worker scope M001\/: resume its worker with \/gsd parallel start/,
  );

  // M001 is completed from the root session: no worker starts for it again.
  openDatabase(dbPath);
  completeMilestone("M001");
  await assert.rejects(
    () => assertMigrationTargetAvailable(base),
    /worker scope M001\/: its milestone or slice is closed, run \/gsd doctor fix/,
  );

  openDatabase(dbPath);
  const issues: DoctorIssue[] = [];
  await checkRuntimeHealth(base, issues, [], () => false);
  assert.deepEqual(
    issues.filter((issue) => issue.code === "stale_paused_session").map((issue) => issue.unitId),
    ["M001/"],
  );
  assert.equal(pauseRowsOfScope("M001/")[0]["closed_at"], null, "read-only doctor keeps the pause open");

  const fixesApplied: string[] = [];
  await checkRuntimeHealth(base, [], fixesApplied, (code) => code === "stale_paused_session");
  assert.ok(fixesApplied.some((fix) => fix.includes("worker scope M001/")), fixesApplied.join(" | "));
  const closed = pauseRowsOfScope("M001/");
  assert.equal(closed.length, 1, "the closed pause row stays in the database");
  assert.notEqual(closed[0]["closed_at"], null);
  await assertMigrationTargetAvailable(base);

  // A pause of a scope whose milestone is still open is not stale: it still blocks.
  openDatabase(dbPath);
  pauseParallelWorker(t, "M002");
  await checkRuntimeHealth(base, [], [], (code) => code === "stale_paused_session");
  assert.equal(pauseRowsOfScope("M002/")[0]["closed_at"], null);
  await assert.rejects(
    () => assertMigrationTargetAvailable(base),
    /worker scope M002\/: resume its worker with \/gsd parallel start/,
  );
});

test("the migration refusal for the pause of an open slice scope names the slice completion, not the parallel start", async (t) => {
  const base = makeProject(t);
  pauseParallelWorker(t, "M001", "S01");

  await assert.rejects(
    () => assertMigrationTargetAvailable(base),
    (error: Error) => {
      assert.match(error.message, /worker scope M001\/S01: it closes when the slice completes/);
      assert.doesNotMatch(error.message, /parallel start/);
      return true;
    },
  );
});

test("the root session closes the pause of a parallel worker scope whose milestone is closed at start", async (t) => {
  const base = makeProject(t);
  insertMilestone({ id: "M002", title: "Open milestone", status: "active" });
  pauseParallelWorker(t, "M001");
  pauseParallelWorker(t, "M002");
  completeMilestone("M001");
  process.chdir(base);
  refuseSessionLock(t);
  const { ctx, pi } = makeStartAutoHost([]);

  await startAuto(ctx, pi, base, false);

  assert.notEqual(pauseRowsOfScope("M001/")[0]["closed_at"], null);
  assert.equal(pauseRowsOfScope("M002/")[0]["closed_at"], null);
});

/** The process that ran the worker was killed: its pid is dead and its heartbeat is old. */
function killWorker(workerId: string): void {
  _getAdapter()!.prepare(
    `UPDATE workers
     SET pid = 99999, last_heartbeat_at = '1970-01-01T00:00:00.000Z'
     WHERE worker_id = :worker_id`,
  ).run({ ":worker_id": workerId });
}
