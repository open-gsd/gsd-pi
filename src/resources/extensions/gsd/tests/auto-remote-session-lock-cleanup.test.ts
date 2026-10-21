import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkRemoteAutoSession, forceStopAutoRemote } from "../auto.ts";
import { openDatabase, closeDatabase, _getAdapter } from "../gsd-db.ts";
import { getAutoWorker, registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease, getMilestoneLease } from "../db/milestone-leases.ts";
import { normalizeRealPath } from "../paths.ts";
import { readCrashLock } from "../crash-recovery.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-remote-lock-cleanup-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch {}
  try { rmSync(base, { recursive: true, force: true }); } catch {}
}

function expireWorker(workerId: string): void {
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE workers SET last_heartbeat_at = '1970-01-01T00:00:00.000Z' WHERE worker_id = :worker_id`,
  ).run({ ":worker_id": workerId });
}

function setWorkerPid(workerId: string, pid: number): void {
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE workers SET pid = :pid WHERE worker_id = :worker_id`,
  ).run({ ":pid": pid, ":worker_id": workerId });
}

function insertMilestone(id: string): void {
  const db = _getAdapter()!;
  db.prepare(
    `INSERT INTO milestones (id, title, status, created_at)
     VALUES (:id, :title, 'active', :created_at)`,
  ).run({
    ":id": id,
    ":title": id,
    ":created_at": new Date().toISOString(),
  });
}

function writeLegacyLock(base: string, pid: number): void {
  const now = new Date().toISOString();
  writeFileSync(join(base, ".gsd", "auto.lock"), JSON.stringify({
    pid,
    startedAt: now,
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: now,
  }));
}

function findDeadPidCandidate(): number {
  const candidates = [99_999, 199_999, 299_999, 399_999];
  for (const pid of candidates) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("Could not find a dead PID candidate for stale-lock test");
}

test("checkRemoteAutoSession clears stale lock state when lock PID is dead", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  const workerId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  setWorkerPid(workerId, findDeadPidCandidate());
  expireWorker(workerId);

  assert.ok(readCrashLock(base), "precondition: stale lock exists before remote session check");

  const remote = checkRemoteAutoSession(base);
  assert.deepEqual(remote, { running: false });
  assert.equal(readCrashLock(base), null, "stale lock should be cleared by remote session check");
});

test("forceStopAutoRemote escalates a live remote PID and releases worker state", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  const workerId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  const pid = 424_242;
  setWorkerPid(workerId, pid);
  insertMilestone("M001");
  writeLegacyLock(base, pid);
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true, "precondition: worker holds a milestone lease");

  const signals: Array<NodeJS.Signals | 0> = [];
  const originalKill = process.kill;
  process.kill = ((target: number, signal?: NodeJS.Signals | number) => {
    assert.equal(target, pid);
    signals.push((signal ?? 0) as NodeJS.Signals | 0);
    return true;
  }) as typeof process.kill;
  t.after(() => {
    process.kill = originalKill;
  });

  const result = forceStopAutoRemote(base);

  assert.deepEqual(result, { found: true, pid });
  assert.ok(signals.includes("SIGTERM"), "force stop should request graceful termination first");
  assert.ok(signals.includes("SIGKILL"), "force stop should escalate when the PID is still alive");
  assert.equal(getAutoWorker(workerId)?.status, "stopping");
  assert.equal(
    getMilestoneLease("M001")?.status,
    "released",
    "force stop should release held milestone leases",
  );
  assert.equal(readCrashLock(base), null, "force stop should remove the visible remote lock");
});

test("forceStopAutoRemote does not SIGKILL a PID that exits during the grace window", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  const workerId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  const pid = 525_252;
  setWorkerPid(workerId, pid);
  writeLegacyLock(base, pid);

  // The process is alive until it receives SIGTERM, then exits cooperatively
  // (liveness probe throws ESRCH) — so the grace loop should break before SIGKILL.
  const signals: Array<NodeJS.Signals | 0> = [];
  let alive = true;
  const originalKill = process.kill;
  process.kill = ((target: number, signal?: NodeJS.Signals | number) => {
    assert.equal(target, pid);
    if (signal === 0) {
      if (!alive) {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }
    signals.push((signal ?? 0) as NodeJS.Signals | 0);
    if (signal === "SIGTERM") alive = false; // cooperative exit on SIGTERM
    return true;
  }) as typeof process.kill;
  t.after(() => {
    process.kill = originalKill;
  });

  const result = forceStopAutoRemote(base);

  assert.deepEqual(result, { found: true, pid });
  assert.ok(signals.includes("SIGTERM"), "force stop should request graceful termination first");
  assert.ok(!signals.includes("SIGKILL"), "force stop must not escalate when the PID exits during the grace window");
  assert.equal(readCrashLock(base), null, "force stop should remove the visible remote lock");
});
