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
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
import { getAutoWorker, markWorkerStopping, registerAutoWorker } from "../db/auto-workers.ts";
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
import { claimTaskAttempt } from "../task-execution-domain-operation.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-crash-recovery-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
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
