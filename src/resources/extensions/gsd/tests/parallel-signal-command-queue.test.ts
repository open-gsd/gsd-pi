// Project/App: gsd-pi
// File Purpose: Behavior tests for coordinator-to-worker signals as command_queue rows.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { postUnitPreVerification, type PostUnitContext } from "../auto-post-unit.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { consumeSignal, removeSessionStatus, sendSignal } from "../session-status-io.ts";

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

test("a signal file is not a command", (t) => {
  const base = makeProject(t);
  mkdirSync(join(base, ".gsd", "parallel"), { recursive: true });
  writeFileSync(signalFile(base, "M001"), JSON.stringify({ signal: "stop", sentAt: Date.now(), from: "coordinator" }));

  assert.equal(consumeSignal("M001"), null);
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
