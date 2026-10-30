// Project/App: gsd-pi
// File Purpose: Workflow DB lock-holder parsing regression tests (#1826).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeDormantWorkflowDbLockHolderSkip,
  isDormantWorkflowDbLockHolderSafeToTerminate,
  formatLockedWorkflowDatabaseNotice,
  NO_WORKER_ROWS,
  parseElapsedSeconds,
  parseLsofProcessFields,
  terminateDormantWorkflowDbLockHolders,
  type WorkflowDbLockHolder,
} from "../workflow-db-locks.ts";

test("parseLsofProcessFields extracts holder PIDs, commands, and numeric users", () => {
  assert.deepEqual(parseLsofProcessFields("p123\ncnode\nu501\nf21\np456\ncgsd\nu501\nf22"), [
    { pid: 123, command: "node", uid: 501 },
    { pid: 456, command: "gsd", uid: 501 },
  ]);
});

test("parseElapsedSeconds handles day and clock forms", () => {
  assert.equal(parseElapsedSeconds("03:04"), 184);
  assert.equal(parseElapsedSeconds("02:03:04"), 7_384);
  assert.equal(parseElapsedSeconds("1-02:03:04"), 93_784);
});

test("a holder with no workers row is orphaned, not protected (#3052)", () => {
  const holder: WorkflowDbLockHolder = {
    pid: 123,
    command: "node /opt/@opengsd/gsd-pi/dist/loader.js",
    uid: 501,
    state: "S",
    elapsedSeconds: 600,
    sameUser: true,
    gsdProcess: true,
    dormant: true,
    processStartIdentity: "sha256:test-process",
    processStartedAtMs: 1_000,
  };

  // #3052: the registry row is exactly the artifact an orphaned holder can no
  // longer maintain — missing (never registered) and terminal rows must count
  // toward orphaned, not shield the holder. The probe represents both as an
  // absent entry, so NO_WORKER_ROWS is the terminal-row case too.
  assert.equal(isDormantWorkflowDbLockHolderSafeToTerminate(holder, NO_WORKER_ROWS), true);
});

test("automatic termination requires OS-level dormancy and refuses only live sessions (#3052)", () => {
  const holder: WorkflowDbLockHolder = {
    pid: 123,
    command: "node /opt/@opengsd/gsd-pi/dist/loader.js",
    uid: 501,
    state: "S",
    elapsedSeconds: 600,
    sameUser: true,
    gsdProcess: true,
    dormant: true,
    processStartIdentity: "sha256:test-process",
    processStartedAtMs: 1_000,
  };

  assert.equal(
    isDormantWorkflowDbLockHolderSafeToTerminate(
      holder,
      { staleStartedAtByPid: new Map([[123, 2_000]]), livePids: new Set() },
    ),
    true,
  );
  assert.equal(
    isDormantWorkflowDbLockHolderSafeToTerminate(
      { ...holder, sameUser: false },
      { staleStartedAtByPid: new Map([[123, 2_000]]), livePids: new Set() },
    ),
    false,
  );
  assert.equal(
    isDormantWorkflowDbLockHolderSafeToTerminate(
      { ...holder, processStartedAtMs: 100_000 },
      { staleStartedAtByPid: new Map([[123, 2_000]]), livePids: new Set() },
    ),
    false,
    "a stale row that started after the process is PID reuse, not this holder's row",
  );
  assert.equal(
    isDormantWorkflowDbLockHolderSafeToTerminate(
      holder,
      { staleStartedAtByPid: new Map(), livePids: new Set([123]) },
    ),
    false,
    "a fresh-heartbeat active row is a genuinely live session",
  );
});

test("skip reasons name the failed gate for doctor diagnostics (#3052)", () => {
  const holder: WorkflowDbLockHolder = {
    pid: 123,
    command: "node /opt/@opengsd/gsd-pi/dist/loader.js",
    uid: 501,
    state: "S",
    elapsedSeconds: 600,
    sameUser: true,
    gsdProcess: true,
    dormant: true,
    processStartIdentity: "sha256:test-process",
    processStartedAtMs: 1_000,
  };

  assert.equal(describeDormantWorkflowDbLockHolderSkip(holder, NO_WORKER_ROWS), null);
  assert.match(
    describeDormantWorkflowDbLockHolderSkip(
      { ...holder, dormant: false, state: "R", elapsedSeconds: 30 },
      NO_WORKER_ROWS,
    )!,
    /not dormant/,
  );
  assert.match(
    describeDormantWorkflowDbLockHolderSkip(
      holder,
      { staleStartedAtByPid: new Map(), livePids: new Set([123]) },
    )!,
    /fresh heartbeat/,
  );
  assert.match(
    describeDormantWorkflowDbLockHolderSkip(
      { ...holder, processStartedAtMs: 100_000 },
      { staleStartedAtByPid: new Map([[123, 2_000]]), livePids: new Set() },
    )!,
    /PID reuse/,
  );
  assert.match(
    describeDormantWorkflowDbLockHolderSkip(
      { ...holder, processStartIdentity: null },
      NO_WORKER_ROWS,
    )!,
    /identity unavailable/,
  );
});

test("termination signals only a stale, same-instance GSD holder", async () => {
  const holder: WorkflowDbLockHolder = {
    pid: 123,
    command: "node /opt/@opengsd/gsd-pi/dist/loader.js",
    uid: 501,
    state: "S",
    elapsedSeconds: 600,
    sameUser: true,
    gsdProcess: true,
    dormant: true,
    processStartIdentity: "sha256:test-process",
    processStartedAtMs: 1_000,
  };
  const signaled: number[] = [];
  const result = await terminateDormantWorkflowDbLockHolders(
    [holder, { ...holder, pid: 456, processStartIdentity: "sha256:active" }],
    { staleStartedAtByPid: new Map([[123, 2_000], [456, 2_000]]), livePids: new Set() },
    {
      signal: (pid) => { signaled.push(pid); },
      isAlive: () => false,
      wait: async () => {},
      processIdentity: (pid) => pid === 123 ? "sha256:test-process" : "sha256:reused",
    },
  );

  assert.deepEqual(signaled, [123]);
  assert.deepEqual(result, { signaled: [123], terminated: [123], remaining: [] });
});

test("locked auto notice includes discovered holder PIDs and remediation", () => {
  assert.match(formatLockedWorkflowDatabaseNotice([123, 456]), /PIDs 123, 456/);
  assert.match(formatLockedWorkflowDatabaseNotice([123, 456]), /doctor --fix/);
  // #3052: the notice must not promise --fix will always succeed.
  assert.match(formatLockedWorkflowDatabaseNotice([123, 456]), /reports any holder it cannot safely stop/);
});
