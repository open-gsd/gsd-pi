// gsd-pi + Auto-mode worker registry tests (Phase B coordination)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDatabase, closeDatabase } from "../gsd-db.ts";
import { _getAdapter } from "../gsd-db.ts";
import {
  registerAutoWorker,
  heartbeatAutoWorker,
  markWorkerCrashed,
  markWorkerStopping,
  markWorkerStopped,
  markWorkerStoppingByPid,
  getActiveAutoWorkers,
  getAutoWorker,
  findStaleWorkerForProject,
  isDeadLocalAutoWorker,
} from "../db/auto-workers.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-auto-workers-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

test("registerAutoWorker creates a row with active status and heartbeat", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  assert.match(id, /^auto-/, "worker_id has expected prefix");

  const row = getAutoWorker(id);
  assert.ok(row, "row exists");
  assert.equal(row!.status, "active");
  assert.equal(row!.project_root_realpath, base);
  assert.equal(row!.pid, process.pid);
});

test("heartbeatAutoWorker updates last_heartbeat_at", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  const initial = getAutoWorker(id)!;
  await new Promise(r => setTimeout(r, 10));
  heartbeatAutoWorker(id);
  const after = getAutoWorker(id)!;
  const initialTs = Date.parse(initial.last_heartbeat_at);
  const afterTs = Date.parse(after.last_heartbeat_at);
  assert.ok(Number.isFinite(initialTs), "initial heartbeat parses");
  assert.ok(Number.isFinite(afterTs), "updated heartbeat parses");
  assert.ok(afterTs > initialTs, "heartbeat advanced");
});

test("markWorkerStopping flips status to stopping", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  markWorkerStopping(id);
  const row = getAutoWorker(id)!;
  assert.equal(row.status, "stopping");
});

test("markWorkerStoppingByPid flips matching active row to stopping", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  const pid = getAutoWorker(id)!.pid;
  markWorkerStoppingByPid(base, pid);
  const row = getAutoWorker(id)!;
  assert.equal(row.status, "stopping");
});

test("markWorkerCrashed flips status to crashed", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  markWorkerCrashed(id);
  const row = getAutoWorker(id)!;
  assert.equal(row.status, "crashed");
});

test("getActiveAutoWorkers filters by status and TTL", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const a = registerAutoWorker({ projectRootRealpath: base });
  const b = registerAutoWorker({ projectRootRealpath: base });

  const active = getActiveAutoWorkers();
  assert.equal(active.length, 2);
  assert.ok(active.find(w => w.worker_id === a));
  assert.ok(active.find(w => w.worker_id === b));

  _getAdapter()!.prepare(
    `UPDATE workers SET last_heartbeat_at = '1970-01-01T00:00:00.000Z' WHERE worker_id = :worker_id`,
  ).run({ ":worker_id": a });

  const after = getActiveAutoWorkers();
  assert.equal(after.length, 1);
  assert.equal(after[0].worker_id, b);
});

test("findStaleWorkerForProject returns dead PID immediately even before heartbeat TTL", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  _getAdapter()!.prepare(
    `UPDATE workers SET pid = -1 WHERE worker_id = :worker_id`,
  ).run({ ":worker_id": id });

  const stale = findStaleWorkerForProject(base);
  assert.ok(stale, "dead pid should be detected as stale immediately");
  assert.equal(stale!.worker_id, id);
});

for (const status of ["pending", "claimed", "running"] as const) {
  test(`findStaleWorkerForProject detects a stopping worker with a ${status} dispatch (#1773)`, (t) => {
    const base = makeBase();
    t.after(() => cleanup(base));
    openDatabase(join(base, ".gsd", "gsd.db"));

    const id = registerAutoWorker({ projectRootRealpath: base });
    markWorkerStopping(id);
    _getAdapter()!.prepare(
      `UPDATE workers SET pid = -1 WHERE worker_id = :worker_id`,
    ).run({ ":worker_id": id });
    _getAdapter()!.prepare(
      `INSERT INTO unit_dispatches (
        trace_id, turn_id, worker_id, milestone_lease_token,
        milestone_id, slice_id, task_id, unit_type, unit_id,
        status, attempt_n, started_at
      ) VALUES (
        'trace-orphan', 'turn-orphan', :worker_id, 7,
        'M001', 'S01', 'T01', 'validate-milestone', 'M001',
        :status, 1, '2026-07-13T00:00:00.000Z'
      )`,
    ).run({ ":worker_id": id, ":status": status });

    const stale = findStaleWorkerForProject(base);
    assert.ok(stale, `a stopping worker with a ${status} dispatch must be sweepable`);
    assert.equal(stale!.worker_id, id);
    assert.equal(isDeadLocalAutoWorker(id, base), true);
  });
}

test("findStaleWorkerForProject ignores a stopping worker with no active dispatch (#1773)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  markWorkerStopping(id);
  _getAdapter()!.prepare(
    `UPDATE workers SET pid = -1 WHERE worker_id = :worker_id`,
  ).run({ ":worker_id": id });

  assert.equal(
    findStaleWorkerForProject(base),
    null,
    "a stopping worker with nothing running is a normal shutdown, not an orphan",
  );
});

test("#3029: markWorkerStopped is the terminal retirement transition", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  markWorkerStopping(id);
  assert.equal(getAutoWorker(id)!.status, "stopping");

  markWorkerStopped(id);
  assert.equal(getAutoWorker(id)!.status, "stopped", "graceful shutdown completes in stopped");

  // Terminal: a later stopping/crashed transition cannot resurrect the row.
  markWorkerStopping(id);
  markWorkerCrashed(id);
  assert.equal(getAutoWorker(id)!.status, "stopped", "stopped rows never re-enter the lifecycle");
});

test("#3029: markWorkerStopped upgrades a crashed row only via active/stopping, never from crashed", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  markWorkerCrashed(id);
  assert.equal(getAutoWorker(id)!.status, "crashed");

  markWorkerStopped(id);
  assert.equal(getAutoWorker(id)!.status, "crashed", "crash provenance stays visible — no upgrade to stopped");
});

test("#3029: a stopped worker leaves the stale-worker scope and no longer counts as live", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  markWorkerStopping(id);
  // A stopping worker with no active dispatches is already out of the stale
  // scope; the important half is that stoppage keeps it out.
  markWorkerStopped(id);

  assert.equal(findStaleWorkerForProject(base)?.worker_id ?? null, null, "stopped worker is not stale-blocking");
  assert.equal(getActiveAutoWorkers().some((w) => w.worker_id === id), false, "stopped worker is not active");
});
