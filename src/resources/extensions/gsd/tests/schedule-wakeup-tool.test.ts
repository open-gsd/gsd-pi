// Project/App: gsd-pi
// File Purpose: Regression tests for ScheduleWakeup tool behavior.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { autoSession } from "../auto-runtime-state.ts";
import {
  registerScheduleWakeupTool,
  _resetInteractiveWakeupsForTest,
} from "../bootstrap/schedule-wakeup-tool.ts";

test("ScheduleWakeup arms an interactive wakeup when auto-mode is inactive", async () => {
  autoSession.reset();
  _resetInteractiveWakeupsForTest();
  mock.timers.enable({ apis: ["setTimeout"] });

  const sent: Array<{ message: unknown; options: unknown }> = [];
  let tool: any;
  const pi = {
    registerTool(registered: any) {
      tool = registered;
    },
    sendMessage(message: unknown, options: unknown) {
      sent.push({ message, options });
    },
  };

  try {
    registerScheduleWakeupTool(pi as any);
    assert.equal(tool.name, "gsd_schedule_wakeup");

    const result = await tool.execute(
      "call-1",
      {
        delaySeconds: 1,
        prompt: "Check the external job and report back.",
        reason: "poll external job",
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Wakeup scheduled for 1s/);
    assert.equal(sent.length, 0, "wakeup should not dispatch synchronously");

    mock.timers.tick(999);
    assert.equal(sent.length, 0, "wakeup should wait for the configured delay");

    mock.timers.tick(1);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].options, { triggerTurn: true });
    assert.deepEqual(sent[0].message, {
      customType: "gsd-schedule-wakeup",
      content: "Check the external job and report back.",
      display: true,
      details: {
        delaySeconds: 1,
        reason: "poll external job",
      },
    });
  } finally {
    mock.timers.reset();
    _resetInteractiveWakeupsForTest();
    autoSession.reset();
  }
});

test("ScheduleWakeup re-arm cancels the prior interactive timer instead of stacking", async () => {
  autoSession.reset();
  _resetInteractiveWakeupsForTest();
  mock.timers.enable({ apis: ["setTimeout"] });

  const sent: Array<{ message: any; options: unknown }> = [];
  let tool: any;
  const pi = {
    registerTool(registered: any) {
      tool = registered;
    },
    sendMessage(message: unknown, options: unknown) {
      sent.push({ message, options } as { message: any; options: unknown });
    },
  };

  try {
    registerScheduleWakeupTool(pi as any);
    assert.equal(tool.name, "gsd_schedule_wakeup");

    const ctx = { cwd: process.cwd() };
    await tool.execute(
      "call-1",
      { delaySeconds: 5, prompt: "stale prompt", reason: "first arm" },
      undefined,
      undefined,
      ctx,
    );
    await tool.execute(
      "call-2",
      { delaySeconds: 5, prompt: "fresh prompt", reason: "re-arm" },
      undefined,
      undefined,
      ctx,
    );

    mock.timers.tick(5000);

    assert.equal(sent.length, 1, "re-arming must not stack overlapping wakeups");
    assert.equal(sent[0].message.content, "fresh prompt");
  } finally {
    mock.timers.reset();
    _resetInteractiveWakeupsForTest();
    autoSession.reset();
  }
});

test("ScheduleWakeup keeps interactive wakeups isolated per session base path", async () => {
  autoSession.reset();
  _resetInteractiveWakeupsForTest();
  mock.timers.enable({ apis: ["setTimeout"] });

  const sent: Array<{ message: any; options: unknown }> = [];
  let tool: any;
  const pi = {
    registerTool(registered: any) {
      tool = registered;
    },
    sendMessage(message: unknown, options: unknown) {
      sent.push({ message, options } as { message: any; options: unknown });
    },
  };

  try {
    registerScheduleWakeupTool(pi as any);
    assert.equal(tool.name, "gsd_schedule_wakeup");

    // Two concurrent interactive sessions (different cwds) arm wakeups. One
    // session re-arming must not cancel the other session's pending wakeup.
    await tool.execute(
      "call-a",
      { delaySeconds: 5, prompt: "session A", reason: "poll A" },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );
    await tool.execute(
      "call-b",
      { delaySeconds: 5, prompt: "session B", reason: "poll B" },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    mock.timers.tick(5000);

    assert.equal(sent.length, 2, "distinct sessions must each keep their wakeup");
    assert.deepEqual(
      sent.map((s) => s.message.content).sort(),
      ["session A", "session B"],
    );
  } finally {
    mock.timers.reset();
    _resetInteractiveWakeupsForTest();
    autoSession.reset();
  }
});

test("ScheduleWakeup tool contract discloses non-blocking, turn-end, and replacement semantics (#2760)", () => {
  let tool: any;
  const pi = {
    registerTool(registered: any) {
      tool = registered;
    },
  };
  registerScheduleWakeupTool(pi as any);

  const description: string = tool.description;
  assert.match(description, /non-blocking/i, "description must state scheduling is non-blocking");
  assert.match(
    description,
    /returns immediately and does not wait or advance\s+elapsed time/i,
    "description must state the call returns immediately without advancing elapsed time",
  );
  assert.match(
    description,
    /finish the current turn/i,
    "description must require finishing the turn instead of polling",
  );
  // Interactive and auto-mode differ: interactive arms a timer immediately and
  // keeps one per project; auto-mode consumes the wakeup when the unit turn
  // returns (then waits the full requested delay) and keeps one per unit.
  assert.match(
    description,
    /armed immediately/i,
    "description must state the interactive timer is armed immediately",
  );
  assert.match(
    description,
    /per project/i,
    "description must state the interactive one-pending-timer-per-project scope",
  );
  assert.match(
    description,
    /per unit/i,
    "description must state the auto-mode one-pending-wakeup-per-unit scope",
  );
  assert.match(description, /replaces/i, "description must document re-schedule replacement semantics");
  assert.match(
    description,
    /full requested delay/,
    "description must state the auto-mode delay runs after the unit turn returns",
  );

  const delayDescription: string = tool.parameters.properties.delaySeconds.description;
  assert.match(
    delayDescription,
    /returns immediately|does not block/i,
    "delaySeconds must not read as a blocking sleep",
  );

  const guidelines: string[] = tool.promptGuidelines;
  assert.ok(
    guidelines.some((g) => /non-blocking/i.test(g) && /finish the current turn/i.test(g)),
    "prompt guidelines must state the non-blocking finish-turn contract",
  );
  assert.ok(
    guidelines.some((g) => /replaces/i.test(g) && /per project/i.test(g) && /per unit/i.test(g)),
    "prompt guidelines must state replacement and its per-mode scope",
  );
});

