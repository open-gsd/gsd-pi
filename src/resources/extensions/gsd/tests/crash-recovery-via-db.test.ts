// gsd-pi + Crash recovery via DB (Phase C pt 2 — auto.lock migration)
//
// auto.lock file IO is gone. readCrashLock now synthesizes a LockData
// from the workers + unit_dispatches + runtime_kv tables. These tests
// verify the synthesis end-to-end: register a worker, simulate it going
// stale (heartbeat lapsed), and confirm readCrashLock returns the
// correct LockData with PID, started_at, unit details, and session
// file derived from the DB.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  _getAdapter,
} from "../gsd-db.ts";
import { getAutoWorker, markWorkerStopping, findStaleWorkerForProject, registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { getLatestForUnit, markRunning, recordDispatchClaim } from "../db/unit-dispatches.ts";
import { setRuntimeKv, getRuntimeKv } from "../db/runtime-kv.ts";
import {
  writeLock,
  readCrashLock,
  clearLock,
  clearStaleWorkerLock,
  isLockProcessAlive,
} from "../crash-recovery.ts";
import { normalizeRealPath } from "../paths.ts";
import { writeUnitRuntimeRecord } from "../unit-runtime.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import { claimTaskAttempt, settleTaskAttempt } from "../task-execution-domain-operation.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-crash-recovery-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

/**
 * Return a PID that is genuinely dead on this machine: spawn a controlled
 * subprocess, observe its exit, and use its PID. We verify with the real
 * isLockProcessAlive() so the fixture never assumes an arbitrary high PID is
 * unused (#2441 review): a hardcoded PID like 99999 may be live on some host.
 */
function makeDeadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid && pid > 0, "spawned a fixture child process");
  const lock: import("../crash-recovery.ts").LockData = {
    pid,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "fixture/dead-pid",
    unitStartedAt: new Date().toISOString(),
  };
  assert.equal(isLockProcessAlive(lock), false, `fixture pid ${pid} must be dead after exit`);
  return pid;
}

/** Force a worker's last_heartbeat_at into the past so the stale-detector picks it up. */
function expireWorker(workerId: string): void {
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE workers SET last_heartbeat_at = '1970-01-01T00:00:00.000Z' WHERE worker_id = :w`,
  ).run({ ":w": workerId });
}

function setWorkerPid(workerId: string, pid: number): void {
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE workers SET pid = :pid WHERE worker_id = :w`,
  ).run({ ":pid": pid, ":w": workerId });
}

test("readCrashLock returns null when no workers exist", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  assert.equal(readCrashLock(base), null);
});

test("readCrashLock returns null when only fresh (un-expired) workers exist", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  // Heartbeat is fresh — not stale yet.
  assert.equal(readCrashLock(base), null);
});

test("readCrashLock ignores a stale heartbeat when the worker PID is still alive", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  expireWorker(workerId);

  assert.equal(readCrashLock(base), null);
});

test("readCrashLock synthesizes LockData from a stale dead worker (no dispatches yet)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  setWorkerPid(workerId, 99999);
  expireWorker(workerId);

  const lock = readCrashLock(base);
  assert.ok(lock, "stale worker surfaced as a crash lock");
  assert.equal(lock!.pid, 99999);
  // Bootstrap default — no dispatches recorded
  assert.equal(lock!.unitType, "starting");
  assert.equal(lock!.unitId, "bootstrap");
  assert.ok(lock!.startedAt, "startedAt populated from workers.started_at");
});

test("readCrashLock falls back to latest in-flight runtime record when dispatch claim is missing", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  writeUnitRuntimeRecord(base, "execute-task", "M008/S04/T02", 1778069087937, {
    phase: "dispatched",
    lastProgressAt: 1778069087937,
    lastProgressKind: "dispatch",
  });
  setWorkerPid(workerId, 99999);
  expireWorker(workerId);

  const lock = readCrashLock(base);
  assert.ok(lock, "stale worker surfaced as a crash lock");
  assert.equal(lock!.unitType, "execute-task");
  assert.equal(lock!.unitId, "M008/S04/T02");
  assert.equal(lock!.unitStartedAt, new Date(1778069087937).toISOString());
});

test("readCrashLock includes the most recent dispatch as unitType/unitId", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  recordDispatchClaim({
    traceId: "t1", workerId, milestoneLeaseToken: lease.token,
    milestoneId: "M001", unitType: "plan-slice", unitId: "M001/S01",
  });
  setWorkerPid(workerId, 99999);
  expireWorker(workerId);

  const lock = readCrashLock(base);
  assert.ok(lock);
  assert.equal(lock!.unitType, "plan-slice");
  assert.equal(lock!.unitId, "M001/S01");
});

test("recordDispatchClaim rejects an expired held lease so the iteration re-arms its fencing token (#2443)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "S", status: "active" });
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T01", title: "T", status: "pending" });
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  // Simulate the lease TTL lapsing during a long unit turn + finalize: the
  // row stays status='held' but its expiry is in the past — exactly what the
  // attempt fencing trigger refuses for later attempt state transitions.
  _getAdapter()!.prepare(
    `UPDATE milestone_leases SET expires_at = '2020-01-01T00:00:00.000Z' WHERE milestone_id = 'M001'`,
  ).run();

  const stale = recordDispatchClaim({
    traceId: "t1", workerId, milestoneLeaseToken: lease.token,
    milestoneId: "M001", unitType: "execute-task", unitId: "M001/S01/T01",
  });
  assert.equal(stale.ok, false, "an expired held lease must not pass the dispatch claim guard");
  if (stale.ok) return;
  assert.equal(stale.error, "stale_lease");

  // The poisoning surface this fixes: under the expired generation the
  // Attempt claim cannot even insert (attempt fencing trigger) — this is the
  // abort that stranded the task at in_progress in #2443. Pre-fix the
  // dispatch guard above happily created this stale dispatch row; insert it
  // directly to pin the fencing behavior the guard now prevents reaching.
  _getAdapter()!.prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES ('t1-stale', 'turn-stale', :worker_id, :token,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01', 'claimed', 1,
      '2020-01-01T00:00:00.000Z')
  `).run({ ":worker_id": workerId, ":token": lease.token });

  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: "fixture/2443-task-ready",
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
  const staleDispatchId = Number(
    (_getAdapter()!.prepare(
      `SELECT id FROM unit_dispatches WHERE trace_id = 't1-stale'`,
    ).get() as { id: number }).id,
  );
  assert.throws(
    () => claimTaskAttempt({
      invocation: { idempotencyKey: "fixture/2443/stale-claim", sourceTransport: "internal", actorType: "agent" },
      task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
      workerId,
      milestoneLeaseToken: lease.token,
      coordinationDispatchId: staleDispatchId,
    }),
    /workflow attempt requires the current held lease/,
    "an attempt claim under the expired generation must abort on the fencing trigger",
  );

  // The stale-lease recovery path re-claims the worker's own expired lease
  // (fencing token bumps) and the dispatch claim then succeeds. The stale
  // dispatch row is terminalized first — only one active dispatch per unit
  // is allowed.
  _getAdapter()!.prepare(`UPDATE unit_dispatches SET status = 'failed' WHERE trace_id = 't1-stale'`).run();
  const rearmed = claimMilestoneLease(workerId, "M001");
  assert.equal(rearmed.ok, true);
  if (!rearmed.ok) return;
  assert.equal(rearmed.token, lease.token + 1, "re-claiming our own expired lease bumps the fencing token");
  const claimed = recordDispatchClaim({
    traceId: "t2", workerId, milestoneLeaseToken: rearmed.token,
    milestoneId: "M001", sliceId: "S01", taskId: "T01",
    unitType: "execute-task", unitId: "M001/S01/T01",
  });
  assert.equal(claimed.ok, true, "the re-armed token must open the dispatch claim");
  if (!claimed.ok) return;

  // The recovery end-state: under the re-armed token the Attempt claim and
  // its settlement pass the real fencing triggers.
  const attempt = claimTaskAttempt({
    invocation: { idempotencyKey: "fixture/2443/rearmed-claim", sourceTransport: "internal", actorType: "agent" },
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId,
    milestoneLeaseToken: rearmed.token,
    coordinationDispatchId: Number(claimed.dispatchId),
  });
  const settled = settleTaskAttempt({
    invocation: { idempotencyKey: "fixture/2443/rearmed-settle", sourceTransport: "internal", actorType: "agent" },
    attemptId: attempt.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "re-armed generation settles cleanly",
    output: {},
  });
  assert.ok(settled.resultId, "the re-armed attempt must settle without a fencing abort");
});

test("readCrashLock surfaces sessionFile from runtime_kv", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  setRuntimeKv("worker", workerId, "session_file", "/tmp/pi-session-abc.jsonl");
  setWorkerPid(workerId, 99999);
  expireWorker(workerId);

  const lock = readCrashLock(base);
  assert.ok(lock);
  assert.equal(lock!.sessionFile, "/tmp/pi-session-abc.jsonl");
});

test("isLockProcessAlive returns true for the current process", () => {
  const lock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: new Date().toISOString(),
  };
  assert.equal(isLockProcessAlive(lock), true);
});

test("isLockProcessAlive returns false for a dead PID", () => {
  // PID 99999 is essentially guaranteed dead on a fresh test box.
  const lock = {
    pid: 99999,
    startedAt: new Date().toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: new Date().toISOString(),
  };
  assert.equal(isLockProcessAlive(lock), false);
});

test("writeLock stores the session_file in runtime_kv (worker scope)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });

  writeLock(base, "plan-slice", "M001/S01", "/tmp/session-xyz.jsonl");

  // Verify the value was written for the live worker.
  const stored = getRuntimeKv<string>("worker", workerId, "session_file");
  assert.equal(stored, "/tmp/session-xyz.jsonl");

  // Confirm a stale read picks it up via readCrashLock.
  setWorkerPid(workerId, 99999);
  expireWorker(workerId);
  const lock = readCrashLock(base);
  assert.ok(lock);
  assert.equal(lock!.sessionFile, "/tmp/session-xyz.jsonl");
});

test("writeLock without session file clears stale worker session_file pointer", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });

  writeLock(base, "plan-slice", "M001/S01", "/tmp/session-stale.jsonl");
  assert.equal(getRuntimeKv("worker", workerId, "session_file"), "/tmp/session-stale.jsonl");

  writeLock(base, "execute-task", "M001/S01/T01");
  assert.equal(
    getRuntimeKv("worker", workerId, "session_file"),
    null,
    "preliminary lock write must clear stale session_file pointer",
  );
});

test("clearLock removes the session_file row for the active worker", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });

  writeLock(base, "plan-slice", "M001/S01", "/tmp/session-xyz.jsonl");
  assert.equal(getRuntimeKv("worker", workerId, "session_file"), "/tmp/session-xyz.jsonl");

  // clearLock operates on the active worker (this process) — must run
  // BEFORE expiring the heartbeat, mirroring stopAuto's order: clearLock
  // → markWorkerStopping → done.
  clearLock(base);
  assert.equal(getRuntimeKv("worker", workerId, "session_file"), null,
    "session_file row deleted by clearLock");
});

test("clearLock marks stale worker stopping when no current-process worker matches", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });

  setRuntimeKv("worker", workerId, "session_file", "/tmp/stale-session.jsonl");
  setWorkerPid(workerId, 99999);
  expireWorker(workerId);
  assert.ok(readCrashLock(base), "stale worker is detected before clearLock");

  clearLock(base);

  assert.equal(getAutoWorker(workerId)?.status, "stopping");
  assert.equal(getRuntimeKv("worker", workerId, "session_file"), null);
  assert.equal(readCrashLock(base), null);
});

test("clearStaleWorkerLock cancels all active dispatches for a dead stopping worker", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  const pending = recordDispatchClaim({
    traceId: "t1",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    unitType: "hook/codex-review",
    unitId: "M001/S01/T01",
  });
  assert.equal(pending.ok, true);
  if (!pending.ok) return;
  _getAdapter()!.prepare("UPDATE unit_dispatches SET status = 'pending' WHERE id = :id")
    .run({ ":id": pending.dispatchId });

  const claimed = recordDispatchClaim({
    traceId: "t2",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T02",
    unitType: "hook/codex-review",
    unitId: "M001/S01/T02",
  });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;

  const running = recordDispatchClaim({
    traceId: "t3",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T03",
    unitType: "validate-milestone",
    unitId: "M001",
  });
  assert.equal(running.ok, true);
  if (!running.ok) return;
  markRunning(running.dispatchId);
  setRuntimeKv("worker", workerId, "session_file", "/tmp/pi-session-hook.jsonl");
  markWorkerStopping(workerId);
  setWorkerPid(workerId, 99999);
  expireWorker(workerId);

  assert.ok(readCrashLock(base), "stale worker is detected before cleanup");

  clearStaleWorkerLock(base);

  assert.equal(getAutoWorker(workerId)?.status, "stopping");
  for (const unitId of ["M001/S01/T01", "M001/S01/T02", "M001"]) {
    const dispatch = getLatestForUnit(unitId);
    assert.ok(dispatch);
    assert.equal(dispatch!.status, "canceled");
    assert.equal(dispatch!.exit_reason, "crash-recovered");
  }
  const leaseRow = _getAdapter()!.prepare(
    `SELECT status FROM milestone_leases WHERE fencing_token = :ft`,
  ).get({ ":ft": lease.token }) as { status: string } | undefined;
  assert.equal(leaseRow?.status, "released");
  assert.equal(getRuntimeKv("worker", workerId, "session_file"), null);
  assert.equal(readCrashLock(base), null);
});

test("clearStaleWorkerLock settles running Attempts before releasing the stale worker lease", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "S", status: "active" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  const claim = recordDispatchClaim({
    traceId: "t1",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T02",
    unitType: "execute-task",
    unitId: "M001/S01/T02",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: "fixture/crash-recovery/task-ready",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T02" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T02",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.task.ready",
        entityType: "task",
        entityId: "M001/S01/T02",
        payload: { taskId: "T02" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/m001/s01/t02",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  const attempt = claimTaskAttempt({
    invocation: {
      idempotencyKey: "fixture/crash-recovery/attempt-claim",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: workerId,
    },
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T02" },
    workerId,
    milestoneLeaseToken: lease.token,
    coordinationDispatchId: claim.dispatchId,
  });
  _getAdapter()!.prepare(`
    UPDATE milestone_leases SET expires_at = '1970-01-01T00:00:00.000Z'
    WHERE milestone_id = 'M001'
  `).run();
  setRuntimeKv("worker", workerId, "session_file", "/tmp/pi-session-hook.jsonl");
  setWorkerPid(workerId, 99999);
  expireWorker(workerId);

  assert.ok(readCrashLock(base), "stale worker is detected before cleanup");

  clearStaleWorkerLock(base);

  assert.equal(getAutoWorker(workerId)?.status, "stopping");
  const dispatch = getLatestForUnit("M001/S01/T02");
  assert.ok(dispatch);
  assert.equal(dispatch!.status, "canceled");
  assert.equal(dispatch!.exit_reason, "crash-recovered");
  const attemptRow = _getAdapter()!.prepare(`
    SELECT attempt.attempt_state, attempt.settle_outcome, attempt.ended_at,
           result.failure_class
    FROM workflow_execution_attempts attempt
    JOIN workflow_attempt_results result ON result.attempt_id = attempt.attempt_id
    WHERE attempt.attempt_id = :attempt_id
  `).get({ ":attempt_id": attempt.attemptId }) as {
    attempt_state: string;
    settle_outcome: string;
    ended_at: string | null;
    failure_class: string;
  } | undefined;
  assert.deepEqual(attemptRow && {
    attempt_state: attemptRow.attempt_state,
    settle_outcome: attemptRow.settle_outcome,
    failure_class: attemptRow.failure_class,
  }, {
    attempt_state: "settled",
    settle_outcome: "interrupted",
    failure_class: "stale-worker",
  });
  assert.ok(attemptRow?.ended_at, "stale worker cleanup must timestamp the Attempt settlement");
  const leaseRow = _getAdapter()!.prepare(
    `SELECT status FROM milestone_leases WHERE fencing_token = :ft`,
  ).get({ ":ft": lease.token }) as { status: string } | undefined;
  assert.equal(leaseRow?.status, "released");
  assert.equal(getRuntimeKv("worker", workerId, "session_file"), null);
  assert.equal(readCrashLock(base), null);
});

test("clearLock settles a stale worker's orphaned running Attempt before releasing the lease", (t) => {
  // Regression for the #kunnen-we-dit-in-de-toekomst-voorkomen incident:
  // bootstrapAutoSession's fresh-start path (auto-start.ts) calls clearLock(),
  // not clearStaleWorkerLock(). Previously clearLock() released the stale
  // worker's milestone lease without settling any workflow_execution_attempts
  // row left in attempt_state='running' for that worker, so a subsequent
  // `gsd auto` run failed to claim the unit with "dispatch claim skipped:
  // stale-lease" until a human ran gsd_task_settle by hand.
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "S", status: "active" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  const claim = recordDispatchClaim({
    traceId: "t1",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T02",
    unitType: "execute-task",
    unitId: "M001/S01/T02",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: "fixture/crash-recovery/clearlock-task-ready",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T02" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T02",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.task.ready",
        entityType: "task",
        entityId: "M001/S01/T02",
        payload: { taskId: "T02" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/m001/s01/t02/clearlock",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  const attempt = claimTaskAttempt({
    invocation: {
      idempotencyKey: "fixture/crash-recovery/clearlock-attempt-claim",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: workerId,
    },
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T02" },
    workerId,
    milestoneLeaseToken: lease.token,
    coordinationDispatchId: claim.dispatchId,
  });
  _getAdapter()!.prepare(`
    UPDATE milestone_leases SET expires_at = '1970-01-01T00:00:00.000Z'
    WHERE milestone_id = 'M001'
  `).run();
  setWorkerPid(workerId, 99999);
  expireWorker(workerId);

  assert.ok(readCrashLock(base), "stale worker is detected before clearLock");

  clearLock(base);

  assert.equal(getAutoWorker(workerId)?.status, "stopping");
  const attemptRow = _getAdapter()!.prepare(`
    SELECT attempt.attempt_state, attempt.settle_outcome
    FROM workflow_execution_attempts attempt
    WHERE attempt.attempt_id = :attempt_id
  `).get({ ":attempt_id": attempt.attemptId }) as {
    attempt_state: string;
    settle_outcome: string | null;
  } | undefined;
  assert.deepEqual(attemptRow, { attempt_state: "settled", settle_outcome: "interrupted" });
  const leaseRow = _getAdapter()!.prepare(
    `SELECT status FROM milestone_leases WHERE fencing_token = :ft`,
  ).get({ ":ft": lease.token }) as { status: string } | undefined;
  assert.equal(leaseRow?.status, "released");
});

test("clearLock leaves a live legacy-lock holder's worker, Attempt, and lease intact", (t) => {
  // Safety contract for the live-PID guard (#2532/#2537): a legacy auto.lock
  // that names a *live* process is not evidence of an orphaned Attempt. The
  // worker must stay active, its running Attempt must keep running, and its
  // milestone lease must stay held. An earlier version of this test asserted
  // the opposite (cleanup of a live holder) and so tested the exact behavior
  // the upstream guard was added to prevent.
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "S", status: "active" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  const claim = recordDispatchClaim({
    traceId: "t1",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T02",
    unitType: "execute-task",
    unitId: "M001/S01/T02",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: "fixture/crash-recovery/live-legacy-lock-task-ready",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T02" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T02",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.task.ready",
        entityType: "task",
        entityId: "M001/S01/T02",
        payload: { taskId: "T02" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/m001/s01/t02/live-legacy-lock",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  const attempt = claimTaskAttempt({
    invocation: {
      idempotencyKey: "fixture/crash-recovery/live-legacy-lock-attempt-claim",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: workerId,
    },
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T02" },
    workerId,
    milestoneLeaseToken: lease.token,
    coordinationDispatchId: claim.dispatchId,
  });

  // Live pid (the test runner's parent) + fresh heartbeat: the worker is not
  // stale and the legacy lock names that same live pid, exercising the guard.
  setWorkerPid(workerId, process.ppid);
  writeFileSync(
    join(base, ".gsd", "auto.lock"),
    JSON.stringify({
      pid: process.ppid,
      startedAt: new Date().toISOString(),
      unitType: "execute-task",
      unitId: "M001/S01/T02",
      unitStartedAt: new Date().toISOString(),
      sessionFile: null,
    }),
  );

  assert.equal(
    findStaleWorkerForProject(projectRoot),
    null,
    "live worker is not stale-detected before clearLock",
  );

  clearLock(base);

  assert.equal(getAutoWorker(workerId)?.status, "active");
  const liveAttemptRow = _getAdapter()!.prepare(`
    SELECT attempt.attempt_state, attempt.settle_outcome
    FROM workflow_execution_attempts attempt
    WHERE attempt.attempt_id = :attempt_id
  `).get({ ":attempt_id": attempt.attemptId }) as {
    attempt_state: string;
    settle_outcome: string | null;
  } | undefined;
  assert.deepEqual(liveAttemptRow, { attempt_state: "running", settle_outcome: null });
  const liveLeaseRow = _getAdapter()!.prepare(
    `SELECT status, worker_id FROM milestone_leases WHERE fencing_token = :ft`,
  ).get({ ":ft": lease.token }) as { status: string; worker_id: string } | undefined;
  assert.equal(liveLeaseRow?.status, "held");
  assert.equal(liveLeaseRow?.worker_id, workerId);
});

test("clearLock settles and releases every worker row matching a dead legacy-lock PID", (t) => {
  // Real legacy fallback (Copilot review on #2441): the legacy auto.lock names
  // a genuinely dead PID. Multiple worker rows can share that PID and project
  // root across repeated sessions; clearLock() must clean up ALL of them (not
  // just the oldest .find() match), while a separate live worker on a different
  // milestone keeps its running Attempt and held lease untouched.
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T1", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "S1", status: "active" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Task A", status: "pending" });
  insertMilestone({ id: "M002", title: "T2", status: "active" });
  insertSlice({ id: "S02", milestoneId: "M002", title: "S2", status: "active" });
  insertTask({ id: "T03", sliceId: "S02", milestoneId: "M002", title: "Task B", status: "pending" });
  const projectRoot = normalizeRealPath(base);
  const deadPid = makeDeadPid();

  // Helper: register a worker, then drive it to a running Task Attempt + held
  // lease on the given milestone/task via the real production APIs.
  function buildRunningWorker(opts: {
    milestoneId: string;
    sliceId: string;
    taskId: string;
    keyPrefix: string;
  }) {
    const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
    const lease = claimMilestoneLease(workerId, opts.milestoneId);
    assert.equal(lease.ok, true, `lease claimed for ${opts.keyPrefix}`);
    if (!lease.ok) throw new Error("unreachable");
    const claim = recordDispatchClaim({
      traceId: `${opts.keyPrefix}-trace`,
      workerId,
      milestoneLeaseToken: lease.token,
      milestoneId: opts.milestoneId,
      sliceId: opts.sliceId,
      taskId: opts.taskId,
      unitType: "execute-task",
      unitId: `${opts.milestoneId}/${opts.sliceId}/${opts.taskId}`,
    });
    assert.equal(claim.ok, true, `dispatch claimed for ${opts.keyPrefix}`);
    if (!claim.ok) throw new Error("unreachable");
    const fence = readDomainOperationFence();
    executeDomainOperation({
      operationType: "test.task.ready",
      idempotencyKey: `fixture/crash-recovery/${opts.keyPrefix}-task-ready`,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: "test",
      sourceTransport: "test",
      payload: { taskId: opts.taskId },
    }, (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: opts.milestoneId,
        sliceId: opts.sliceId,
        taskId: opts.taskId,
        lifecycleStatus: "ready",
      });
      return {
        events: [{
          eventType: "test.task.ready",
          entityType: "task",
          entityId: `${opts.milestoneId}/${opts.sliceId}/${opts.taskId}`,
          payload: { taskId: opts.taskId },
          destinations: ["test"],
        }],
        projections: [{
          projectionKey: `test/${opts.keyPrefix}`,
          projectionKind: "test",
          rendererVersion: "1",
        }],
      };
    });
    const attempt = claimTaskAttempt({
      invocation: {
        idempotencyKey: `fixture/crash-recovery/${opts.keyPrefix}-attempt-claim`,
        sourceTransport: "internal",
        actorType: "agent",
        actorId: workerId,
      },
      task: { milestoneId: opts.milestoneId, sliceId: opts.sliceId, taskId: opts.taskId },
      workerId,
      milestoneLeaseToken: lease.token,
      coordinationDispatchId: claim.dispatchId,
    });
    return { workerId, lease, attempt };
  }

  // Row 1 (oldest): a historical worker sharing the dead PID, already retired
  // (stopping) with no live Attempt or lease — the row a bare .find() would
  // wrongly select first.
  const historicalWorkerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  setWorkerPid(historicalWorkerId, deadPid);
  markWorkerStopping(historicalWorkerId);

  // Row 2 (newer): the real dead holder — same dead PID, status active, with a
  // running Attempt and held lease on M001.
  const deadHolder = buildRunningWorker({
    milestoneId: "M001", sliceId: "S01", taskId: "T02", keyPrefix: "dead-holder",
  });
  setWorkerPid(deadHolder.workerId, deadPid);

  // Row 3 (newest): a live sentinel on M002 with its own running Attempt and
  // held lease. Its pid stays the test process's own (alive) so it must not be
  // touched by the dead-PID cleanup.
  const sentinel = buildRunningWorker({
    milestoneId: "M002", sliceId: "S02", taskId: "T03", keyPrefix: "live-sentinel",
  });

  // Force a deterministic started_at ordering (oldest -> newest) instead of
  // relying on millisecond timing between register calls.
  _getAdapter()!.prepare(
    `UPDATE workers SET started_at = :ts WHERE worker_id = :w`,
  ).run({ ":ts": "2026-01-01T00:00:00.000Z", ":w": historicalWorkerId });
  _getAdapter()!.prepare(
    `UPDATE workers SET started_at = :ts WHERE worker_id = :w`,
  ).run({ ":ts": "2026-01-02T00:00:00.000Z", ":w": deadHolder.workerId });
  _getAdapter()!.prepare(
    `UPDATE workers SET started_at = :ts WHERE worker_id = :w`,
  ).run({ ":ts": "2026-01-03T00:00:00.000Z", ":w": sentinel.workerId });

  // The legacy lock names the dead PID. The dead holder must not be
  // stale-detected first (fresh heartbeat, and the newest row is the live
  // sentinel), which is what routes clearLock() into the legacy-PID branch.
  writeFileSync(
    join(base, ".gsd", "auto.lock"),
    JSON.stringify({
      pid: deadPid,
      startedAt: new Date().toISOString(),
      unitType: "execute-task",
      unitId: "M001/S01/T02",
      unitStartedAt: new Date().toISOString(),
      sessionFile: null,
    }),
  );

  assert.equal(
    findStaleWorkerForProject(projectRoot),
    null,
    "no row is stale-detected before clearLock (live sentinel is newest, heartbeats fresh)",
  );
  assert.equal(
    isLockProcessAlive({
      pid: deadPid,
      startedAt: new Date().toISOString(),
      unitType: "execute-task",
      unitId: "M001/S01/T02",
      unitStartedAt: new Date().toISOString(),
    }),
    false,
    "legacy lock pid is genuinely dead",
  );

  clearLock(base);

  // Both rows sharing the dead PID are cleaned up (not just the oldest).
  assert.equal(getAutoWorker(historicalWorkerId)?.status, "stopping");
  assert.equal(getAutoWorker(deadHolder.workerId)?.status, "stopping");

  // The real dead holder's Attempt is settled + interrupted, its lease released.
  const deadAttemptRow = _getAdapter()!.prepare(`
    SELECT attempt.attempt_state, attempt.settle_outcome
    FROM workflow_execution_attempts attempt
    WHERE attempt.attempt_id = :attempt_id
  `).get({ ":attempt_id": deadHolder.attempt.attemptId }) as {
    attempt_state: string;
    settle_outcome: string | null;
  } | undefined;
  assert.deepEqual(deadAttemptRow, { attempt_state: "settled", settle_outcome: "interrupted" });
  const deadLeaseRow = _getAdapter()!.prepare(
    `SELECT status FROM milestone_leases WHERE milestone_id = :mid`,
  ).get({ ":mid": "M001" }) as { status: string } | undefined;
  assert.equal(deadLeaseRow?.status, "released");

  // The live sentinel is untouched: still active, Attempt still running, lease
  // still held with the same worker_id and fencing token.
  assert.equal(getAutoWorker(sentinel.workerId)?.status, "active");
  const sentinelAttemptRow = _getAdapter()!.prepare(`
    SELECT attempt.attempt_state, attempt.settle_outcome
    FROM workflow_execution_attempts attempt
    WHERE attempt.attempt_id = :attempt_id
  `).get({ ":attempt_id": sentinel.attempt.attemptId }) as {
    attempt_state: string;
    settle_outcome: string | null;
  } | undefined;
  assert.deepEqual(sentinelAttemptRow, { attempt_state: "running", settle_outcome: null });
  const sentinelLeaseRow = _getAdapter()!.prepare(
    `SELECT status, worker_id, fencing_token FROM milestone_leases WHERE milestone_id = :mid`,
  ).get({ ":mid": "M002" }) as {
    status: string;
    worker_id: string;
    fencing_token: number;
  } | undefined;
  assert.equal(sentinelLeaseRow?.status, "held");
  assert.equal(sentinelLeaseRow?.worker_id, sentinel.workerId);
  assert.equal(sentinelLeaseRow?.fencing_token, sentinel.lease.token);

  // The legacy lock file itself is removed.
  assert.equal(existsSync(join(base, ".gsd", "auto.lock")), false);
});

test("clearLock marks stale worker stopping and releases held milestone lease", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;

  setWorkerPid(workerId, 99999);
  expireWorker(workerId);
  assert.ok(readCrashLock(base), "stale worker is detected before clearLock");

  clearLock(base);

  assert.equal(getAutoWorker(workerId)?.status, "stopping");
  const leaseRow = _getAdapter()!.prepare(
    `SELECT status FROM milestone_leases WHERE fencing_token = :ft`,
  ).get({ ":ft": lease.token }) as { status: string } | undefined;
  assert.equal(leaseRow?.status, "released");
});
