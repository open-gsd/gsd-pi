// Project/App: gsd-pi
// File Purpose: Unit tests for best-effort auto-mode dispatch ledger helpers.

import assert from "node:assert/strict";
import test from "node:test";

import {
  settleDispatchCompleted,
  settleDispatchFailed,
  settleDispatchIfNeeded,
} from "../auto/workflow-dispatch-ledger.ts";

test("canonical settlement suppresses later legacy completion and finalize-failure writes", () => {
  const calls: string[] = [];

  assert.equal(settleDispatchIfNeeded(true, () => {
    calls.push("completed");
    return true;
  }), true);
  assert.equal(settleDispatchIfNeeded(true, () => {
    calls.push("finalize-failed");
    return true;
  }), true);

  assert.deepEqual(calls, []);
});

test("settleDispatchFailed writes failures and reports settled state", () => {
  const calls: Array<{ dispatchId: number; errorSummary: string }> = [];

  const settled = settleDispatchFailed(42, "unit-break", {
    markFailed: (dispatchId, details) => {
      calls.push({ dispatchId, ...details });
      return true;
    },
    logWriteFailure: () => assert.fail("logWriteFailure should not be called"),
  });

  assert.equal(settled, true);
  assert.deepEqual(calls, [{ dispatchId: 42, errorSummary: "unit-break" }]);
});

test("settleDispatchFailed forwards the timeout exit reason to the ledger (#2218)", () => {
  const calls: Array<{ dispatchId: number; errorSummary: string; exitReason?: string }> = [];

  const settled = settleDispatchFailed(42, "unit-hard-timeout", {
    markFailed: (dispatchId, details) => {
      calls.push({ dispatchId, ...details });
      return true;
    },
    logWriteFailure: () => assert.fail("logWriteFailure should not be called"),
  }, "timeout");

  assert.equal(settled, true);
  assert.deepEqual(calls, [{ dispatchId: 42, errorSummary: "unit-hard-timeout", exitReason: "timeout" }]);
});

test("settleDispatchFailed reports a no-op failure write as unsettled", () => {
  const settled = settleDispatchFailed(42, "unit-break", {
    markFailed: () => false,
    logWriteFailure: () => assert.fail("logWriteFailure should not be called"),
  });

  assert.equal(settled, false);
});

test("settleDispatchFailed skips null dispatch ids", () => {
  const settled = settleDispatchFailed(null, "unit-break", {
    markFailed: () => assert.fail("markFailed should not be called"),
    logWriteFailure: () => assert.fail("logWriteFailure should not be called"),
  });

  assert.equal(settled, false);
});

test("settleDispatchFailed logs failed ledger writes without throwing", () => {
  const logged: unknown[] = [];
  const writeError = new Error("db locked");

  const settled = settleDispatchFailed(42, "unit-break", {
    markFailed: () => {
      throw writeError;
    },
    logWriteFailure: err => logged.push(err),
  });

  assert.equal(settled, false);
  assert.deepEqual(logged, [writeError]);
});

test("settleDispatchCompleted writes completion and reports settled state", () => {
  const calls: number[] = [];

  const settled = settleDispatchCompleted(42, {
    markCompleted: dispatchId => {
      calls.push(dispatchId);
      return true;
    },
    logWriteFailure: () => assert.fail("logWriteFailure should not be called"),
  });

  assert.equal(settled, true);
  assert.deepEqual(calls, [42]);
});

test("settleDispatchCompleted reports a no-op completion write as unsettled", () => {
  const settled = settleDispatchCompleted(42, {
    markCompleted: () => false,
    logWriteFailure: () => assert.fail("logWriteFailure should not be called"),
  });

  assert.equal(settled, false);
});

test("settleDispatchCompleted skips null dispatch ids", () => {
  const settled = settleDispatchCompleted(null, {
    markCompleted: () => assert.fail("markCompleted should not be called"),
    logWriteFailure: () => assert.fail("logWriteFailure should not be called"),
  });

  assert.equal(settled, false);
});

test("settleDispatchCompleted logs failed ledger writes without throwing", () => {
  const logged: unknown[] = [];
  const writeError = new Error("db locked");

  const settled = settleDispatchCompleted(42, {
    markCompleted: () => {
      throw writeError;
    },
    logWriteFailure: err => logged.push(err),
  });

  assert.equal(settled, false);
  assert.deepEqual(logged, [writeError]);
});
