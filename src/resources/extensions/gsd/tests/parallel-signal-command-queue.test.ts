// Project/App: gsd-pi
// File Purpose: Behavior tests for coordinator-to-worker signals as command_queue rows.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";

import { postUnitPreVerification, type PostUnitContext } from "../auto-post-unit.ts";
import { takeNextCommand } from "../db/command-queue.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { awaitWorkerResume, consumeSignal, removeSessionStatus, sendSignal } from "../session-status-io.ts";

/** A project root with an open project database. The coordinator and the worker share it. */
function makeProject(t: TestContext): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-signal-queue-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  const lock = process.env.GSD_MILESTONE_LOCK;
  t.after(() => {
    if (lock === undefined) delete process.env.GSD_MILESTONE_LOCK;
    else process.env.GSD_MILESTONE_LOCK = lock;
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  return base;
}

function signalFile(base: string, milestoneId: string): string {
  return join(base, ".gsd", "parallel", `${milestoneId}.signal.json`);
}

test("a stop command reaches the worker of its milestone with no signal file", async (t) => {
  const base = makeProject(t);

  sendSignal("M001", "stop");
  assert.equal(existsSync(signalFile(base, "M001")), false, "the coordinator writes no signal file");

  // The worker reads its command at the unit boundary.
  process.env.GSD_MILESTONE_LOCK = "M001";
  let stops = 0;
  const outcome = await postUnitPreVerification({
    s: { basePath: base },
    stopAuto: async () => { stops += 1; },
  } as unknown as PostUnitContext);

  assert.equal(outcome, "dispatched");
  assert.equal(stops, 1, "the worker stops");
  assert.equal(consumeSignal("M001"), null, "the command is delivered one time");
  const row = _getAdapter()!.prepare("SELECT claimed_by, completed_at FROM command_queue").get();
  assert.equal(row?.["claimed_by"], `pid-${process.pid}`);
  assert.notEqual(row?.["completed_at"], null, "a taken command is closed");
});

test("a legacy signal file becomes a command_queue row, the file is removed, and the worker acts on the row", async (t) => {
  const base = makeProject(t);
  mkdirSync(join(base, ".gsd", "parallel"), { recursive: true });
  writeFileSync(signalFile(base, "M001"), JSON.stringify({ signal: "stop", sentAt: Date.now(), from: "coordinator" }));

  process.env.GSD_MILESTONE_LOCK = "M001";
  let stops = 0;
  await postUnitPreVerification({
    s: { basePath: base },
    stopAuto: async () => { stops += 1; },
  } as unknown as PostUnitContext);

  assert.equal(stops, 1, "the worker stops");
  assert.equal(existsSync(signalFile(base, "M001")), false, "the file is removed");
  const rows = _getAdapter()!.prepare("SELECT target_worker, command, claimed_by FROM command_queue").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ target_worker: "M001", command: "stop", claimed_by: `pid-${process.pid}` }]);
});

test("a legacy signal file lifts the pause of a waiting worker", async (t) => {
  const base = makeProject(t);
  mkdirSync(join(base, ".gsd", "parallel"), { recursive: true });
  writeFileSync(signalFile(base, "M001"), JSON.stringify({ signal: "resume" }));

  assert.equal(await awaitWorkerResume("M001", { timeoutMs: 500, pollMs: 20, basePath: base }), "resume");
});

test("a signal file with an unknown command queues no row", (t) => {
  const base = makeProject(t);
  mkdirSync(join(base, ".gsd", "parallel"), { recursive: true });
  writeFileSync(signalFile(base, "M001"), JSON.stringify({ signal: "restart" }));

  assert.equal(consumeSignal("M001", base), null);
  assert.equal(_getAdapter()!.prepare("SELECT count(*) AS n FROM command_queue").get()?.["n"], 0);
});

/** Another process holds the write lock of the project database. Returns the release. */
function holdWriteLock(base: string): () => void {
  _getAdapter()!.exec("PRAGMA busy_timeout = 50");
  const other = new DatabaseSync(join(base, ".gsd", "gsd.db"));
  other.exec("BEGIN IMMEDIATE");
  return () => { other.exec("ROLLBACK"); other.close(); };
}

test("a poll with no pending command takes no write lock", (t) => {
  const base = makeProject(t);
  const release = holdWriteLock(base);
  try {
    assert.equal(takeNextCommand("M001", "worker"), null);
  } finally {
    release();
  }
});

test("a busy database at the poll is no command this time, and the command is taken at the next poll", async (t) => {
  const base = makeProject(t);
  sendSignal("M001", "stop");
  process.env.GSD_MILESTONE_LOCK = "M001";
  let stops = 0;
  const pctx = { s: { basePath: base }, stopAuto: async () => { stops += 1; } } as unknown as PostUnitContext;

  const release = holdWriteLock(base);
  try {
    await postUnitPreVerification(pctx);
  } finally {
    release();
  }
  assert.equal(stops, 0, "the busy poll does not throw and takes no command");

  await postUnitPreVerification(pctx);
  assert.equal(stops, 1, "the next poll takes the command");
});

test("a paused worker polls again when the database is busy", async (t) => {
  const base = makeProject(t);
  sendSignal("M001", "resume");
  const release = holdWriteLock(base);
  const releaseSoon = setTimeout(release, 30);
  t.after(() => clearTimeout(releaseSoon));

  assert.equal(await awaitWorkerResume("M001", { timeoutMs: 5000, pollMs: 20 }), "resume");
});

test("signals are delivered in the order sent, to their milestone only", (t) => {
  makeProject(t);
  sendSignal("M001", "pause");
  sendSignal("M002", "stop");
  sendSignal("M001", "resume");

  assert.equal(consumeSignal("M001")?.signal, "pause");
  assert.equal(consumeSignal("M001")?.signal, "resume");
  assert.equal(consumeSignal("M001"), null);
  assert.equal(consumeSignal("M002")?.signal, "stop");
});

test("a signal that a worker did not take does not reach the next worker of the milestone", (t) => {
  const base = makeProject(t);
  sendSignal("M001", "stop");
  sendSignal("M002", "pause");

  removeSessionStatus(base, "M001"); // the session of M001 is over

  assert.equal(consumeSignal("M001"), null);
  assert.equal(consumeSignal("M002")?.signal, "pause", "the signal of another milestone stays");
});

test("sendSignal throws when no database is open, and consumeSignal reports no signal", () => {
  assert.throws(() => sendSignal("M001", "stop"), /No database open/);
  assert.equal(consumeSignal("M001"), null);
});
