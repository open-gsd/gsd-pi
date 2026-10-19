// Project/App: gsd-pi
// File Purpose: #2532 — a step-mode loop exit must retire the session worker
// (lease released, row 'stopping', s.workerId cleared) so the next auto run
// registers a fresh active worker instead of reusing a dead row.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupAfterLoopExit,
  _registerAutoWorkerForSessionForTest,
} from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { openDatabase, closeDatabase, insertMilestone, _getAdapter } from "../gsd-db.ts";
import { registerAutoWorker, getAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease, getMilestoneLease } from "../db/milestone-leases.ts";
import { normalizeRealPath } from "../paths.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-2532-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}

// One combined hook so ordering is deterministic: the loop exit may chdir
// into `base` (restoreToProjectRoot), so CWD must be restored before the
// directory is removed.
function teardownAfter(t: { after(fn: () => void): unknown }, base: string): void {
  const previousCwd = process.cwd();
  t.after(() => {
    try { if (process.cwd() === base) process.chdir(previousCwd); } catch { /* */ }
    try { closeDatabase(); } catch { /* */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
  });
  t.after(() => autoSession.reset());
}

function loopExitCtx(): unknown {
  return {
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: () => {},
    },
  };
}

test("#2532: cleanupAfterLoopExit marks the worker stopping and clears the cached workerId", async (t) => {
  const base = makeTmpBase();
  teardownAfter(t, base);

  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  const workerId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  autoSession.workerId = workerId;

  await cleanupAfterLoopExit(loopExitCtx() as any);

  assert.equal(autoSession.workerId, null, "workerId cleared after loop exit");
  assert.equal(autoSession.milestoneLeaseToken, null, "milestoneLeaseToken cleared after loop exit");
  assert.equal(
    getAutoWorker(workerId)?.status,
    "stopping",
    "worker row retired to 'stopping' (mirrors stopAuto)",
  );
});

test("#2532: cleanupAfterLoopExit keeps a preserved paused worker and its held lease (#2429)", async (t) => {
  const base = makeTmpBase();
  teardownAfter(t, base);

  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.paused = true;
  const workerId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  autoSession.workerId = workerId;
  try { insertMilestone({ id: "M001", title: "Test M001", status: "active" }); } catch { /* exists */ }
  const lease = claimMilestoneLease(workerId, "M001");
  assert.ok(lease.ok, "lease acquired for the paused worker");
  autoSession.currentMilestoneId = "M001";
  autoSession.milestoneLeaseToken = lease.token;

  await cleanupAfterLoopExit(loopExitCtx() as any);

  assert.equal(autoSession.workerId, workerId, "paused coordination preserved: id kept");
  assert.equal(autoSession.milestoneLeaseToken, lease.token, "paused coordination preserved: token kept");
  assert.equal(getAutoWorker(workerId)?.status, "active", "paused coordination preserved: row stays active");
  assert.equal(getMilestoneLease("M001")?.status, "held", "paused coordination preserved: lease stays held");
});

test("#2532: cleanupAfterLoopExit releases a held milestone lease on a step exit", async (t) => {
  const base = makeTmpBase();
  teardownAfter(t, base);

  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  const workerId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  autoSession.workerId = workerId;
  try { insertMilestone({ id: "M001", title: "Test M001", status: "active" }); } catch { /* exists */ }
  const lease = claimMilestoneLease(workerId, "M001");
  assert.ok(lease.ok, "lease acquired for the test worker");
  autoSession.currentMilestoneId = "M001";
  autoSession.milestoneLeaseToken = lease.token;

  await cleanupAfterLoopExit(loopExitCtx() as any);

  assert.equal(
    getMilestoneLease("M001")?.status,
    "released",
    "held lease released on loop exit (mirrors stopAuto)",
  );
});

test("#2532: registerAutoWorkerForSession re-registers when the cached id's row is not active", (t) => {
  const base = makeTmpBase();
  teardownAfter(t, base);

  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  const staleId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  _getAdapter()!.prepare(
    `UPDATE workers SET status = 'stopping' WHERE worker_id = :w`,
  ).run({ ":w": staleId });
  autoSession.workerId = staleId;

  _registerAutoWorkerForSessionForTest(autoSession);

  assert.notEqual(autoSession.workerId, staleId, "stale id dropped instead of reused");
  assert.ok(autoSession.workerId, "fresh worker registered");
  assert.equal(
    getAutoWorker(autoSession.workerId!)?.status,
    "active",
    "fresh row is active so heartbeat and status gates work",
  );
});

test("#2532: registerAutoWorkerForSession releases the stale worker's leftover lease on replacement", (t) => {
  const base = makeTmpBase();
  teardownAfter(t, base);

  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  const staleId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  try { insertMilestone({ id: "M001", title: "Test M001", status: "active" }); } catch { /* exists */ }
  const lease = claimMilestoneLease(staleId, "M001");
  assert.ok(lease.ok, "lease acquired for the stale worker");
  _getAdapter()!.prepare(
    `UPDATE workers SET status = 'stopping' WHERE worker_id = :w`,
  ).run({ ":w": staleId });
  autoSession.workerId = staleId;
  autoSession.currentMilestoneId = "M001";
  autoSession.milestoneLeaseToken = lease.token;

  _registerAutoWorkerForSessionForTest(autoSession);

  assert.notEqual(autoSession.workerId, staleId, "fresh worker registered");
  assert.equal(autoSession.milestoneLeaseToken, null, "stale fencing token dropped");
  assert.equal(
    getMilestoneLease("M001")?.status,
    "released",
    "stale worker's lease released on replacement",
  );
});

test("#2532: registerAutoWorkerForSession keeps a cached id whose row is still active", (t) => {
  const base = makeTmpBase();
  teardownAfter(t, base);

  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  const workerId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
  autoSession.workerId = workerId;

  _registerAutoWorkerForSessionForTest(autoSession);

  assert.equal(autoSession.workerId, workerId, "resume re-runs keep the healthy active id");
});
