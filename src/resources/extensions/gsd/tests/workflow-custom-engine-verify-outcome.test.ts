// Project/App: gsd-pi
// File Purpose: Unit tests for custom-engine verification outcome side-effect adapter.

import assert from "node:assert/strict";
import test from "node:test";

import {
  handleCustomEngineTaskVerifyOutcome,
  handleCustomEngineVerifyPause,
  handleCustomEngineVerifyRetryOutcome,
  type HandleCustomEngineVerifyOutcomeDeps,
} from "../auto/workflow-custom-engine-verify-outcome.ts";

test("Task verification abort is machine-terminal without a pause", () => {
  const calls: unknown[] = [];

  const flow = handleCustomEngineTaskVerifyOutcome({
    outcome: "abort",
    inputPayload: "abort evidence",
    finishTurn: (status, failureClass, error, guardId, inputPayload) =>
      calls.push([status, failureClass, error, guardId, inputPayload]),
  });

  assert.deepEqual(flow, { action: "break" });
  assert.deepEqual(calls, [["stopped", "verification", "custom-engine-task-verify-abort", "custom-engine-task-verify", "abort evidence"]]);
});

test("Task verification retry directly re-enters the loop", () => {
  const calls: unknown[] = [];

  const flow = handleCustomEngineTaskVerifyOutcome({
    outcome: "retry",
    inputPayload: "retry evidence",
    finishTurn: (status, failureClass, error, guardId, inputPayload) =>
      calls.push([status, failureClass, error, guardId, inputPayload]),
  });

  assert.deepEqual(flow, { action: "continue" });
  assert.deepEqual(calls, [["retry", "verification", "custom-engine-task-verify-retry", "custom-engine-task-verify", "retry evidence"]]);
});

function makeDeps(): {
  deps: HandleCustomEngineVerifyOutcomeDeps;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const deps: HandleCustomEngineVerifyOutcomeDeps = {
    pauseAuto: async () => {
      calls.push(["pauseAuto"]);
    },
    stopAuto: async reason => {
      calls.push(["stopAuto", reason]);
    },
    reportPause: details => calls.push(["reportPause", details]),
    finishTurn: (status, failureClass, error, guardId, inputPayload) =>
      calls.push(["finishTurn", status, failureClass, error, guardId, inputPayload]),
  };
  return { deps, calls };
}

test("handleCustomEngineVerifyPause pauses and reports unit details", async () => {
  const { deps, calls } = makeDeps();

  const flow = await handleCustomEngineVerifyPause({
    unitType: "execute-task",
    unitId: "T01",
    inputPayload: '{"policy":"human-review"}',
    deps,
  });

  assert.deepEqual(flow, { action: "break" });
  assert.deepEqual(calls, [
    ["pauseAuto"],
    ["reportPause", { unitType: "execute-task", unitId: "T01" }],
    ["finishTurn", "paused", "manual-attention", "custom-engine-verify-pause", "custom-engine-verify", '{"policy":"human-review"}'],
  ]);
});

test("handleCustomEngineVerifyRetryOutcome pauses after recovery pause", async () => {
  const { deps, calls } = makeDeps();

  const flow = await handleCustomEngineVerifyRetryOutcome({
    outcome: { action: "pause", attempts: 4, turnError: "recovery-pause" },
    inputPayload: '{"policy":"content-heuristic","failure":"missing file"}',
    deps,
  });

  assert.deepEqual(flow, { action: "break" });
  assert.deepEqual(calls, [
    ["pauseAuto"],
    ["finishTurn", "paused", "manual-attention", "recovery-pause", "custom-engine-verify", '{"policy":"content-heuristic","failure":"missing file"}'],
  ]);
});

test("handleCustomEngineVerifyRetryOutcome stops after recovery stop", async () => {
  const { deps, calls } = makeDeps();

  const flow = await handleCustomEngineVerifyRetryOutcome({
    outcome: {
      action: "stop",
      attempts: 4,
      stopMessage: "Recovery failed",
      turnError: "recovery-stop",
    },
    inputPayload: '{"policy":"shell-command","exitCode":1}',
    deps,
  });

  assert.deepEqual(flow, { action: "break" });
  assert.deepEqual(calls, [
    ["stopAuto", "Recovery failed"],
    ["finishTurn", "stopped", "manual-attention", "recovery-stop", "custom-engine-verify", '{"policy":"shell-command","exitCode":1}'],
  ]);
});

test("handleCustomEngineVerifyRetryOutcome continues for retry", async () => {
  const { deps, calls } = makeDeps();

  const flow = await handleCustomEngineVerifyRetryOutcome({
    outcome: { action: "retry", attempts: 1 },
    inputPayload: '{"policy":"shell-command","exitCode":2}',
    deps,
  });

  assert.deepEqual(flow, { action: "continue" });
  assert.deepEqual(calls, [
    ["finishTurn", "retry", "manual-attention", undefined, "custom-engine-verify", '{"policy":"shell-command","exitCode":2}'],
  ]);
});
