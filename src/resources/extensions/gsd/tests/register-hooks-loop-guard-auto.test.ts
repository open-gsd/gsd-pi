import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { autoSession } from "../auto-runtime-state.ts";
import { postUnitPreVerification } from "../auto-post-unit.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";
import { resetToolCallLoopGuard } from "../bootstrap/tool-call-loop-guard.ts";
import { closeDatabase, openDatabase } from "../gsd-db.ts";
import { readUnitHarnessAbort } from "../unit-runtime.ts";

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function makeHookHarness(): {
  emitToolCall: (toolName: string, input: Record<string, unknown>) => Promise<any>;
  emitToolResult: (event: Record<string, unknown>) => Promise<void>;
  emitToolExecutionEnd: (event: Record<string, unknown>) => Promise<void>;
  emitAgentEnd: (event: Record<string, unknown>) => Promise<void>;
} {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  };
  const ctx = {
    cwd: process.cwd(),
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
  };
  let callId = 0;

  registerHooks(pi as any, []);

  return {
    async emitToolCall(toolName: string, input: Record<string, unknown>): Promise<any> {
      callId += 1;
      const loopGuardHandler = handlers.get("tool_call")?.[0];
      assert.ok(loopGuardHandler, "loop-guard tool_call handler should be registered");
      return loopGuardHandler({ toolCallId: `loop-${callId}`, toolName, input }, ctx);
    },
    async emitToolResult(event: Record<string, unknown>): Promise<void> {
      callId += 1;
      for (const handler of handlers.get("tool_result") ?? []) {
        await handler({
          toolCallId: `result-${callId}`,
          ...event,
        }, ctx);
      }
    },
    async emitToolExecutionEnd(event: Record<string, unknown>): Promise<void> {
      callId += 1;
      for (const handler of handlers.get("tool_execution_end") ?? []) {
        await handler({
          toolCallId: `exec-${callId}`,
          ...event,
        }, ctx);
      }
    },
    async emitAgentEnd(event: Record<string, unknown>): Promise<void> {
      for (const handler of handlers.get("agent_end") ?? []) {
        await handler(event, ctx);
      }
    },
  };
}

function makeRuntimeBase(): string {
  const base = join(tmpdir(), `gsd-hook-runtime-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

test("register-hooks keeps loop-guard block reason interactive outside auto-mode", async (t) => {
  autoSession.reset();
  resetToolCallLoopGuard();
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
  });

  const { emitToolCall } = makeHookHarness();

  for (let i = 0; i < 4; i += 1) {
    await emitToolCall("web_search", { query: "same query" });
  }
  const block = await emitToolCall("web_search", { query: "same query" });

  assert.equal(block?.block, true);
  assert.match(block.reason, /respond to the user in text/);
  assert.doesNotMatch(block.reason, /auto-mode recovery\/replan path/);
});

test("register-hooks rewrites loop-guard block reason for auto-mode identical-args blocks", async (t) => {
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
  });

  const { emitToolCall } = makeHookHarness();

  for (let i = 0; i < 4; i += 1) {
    await emitToolCall("web_search", { query: "same query" });
  }
  const block = await emitToolCall("web_search", { query: "same query" });

  assert.equal(block?.block, true);
  assert.match(block.reason, /Tool loop detected \(identical args\): web_search/);
  assert.match(block.reason, /Do not re-issue this blocked tool/);
  assert.match(block.reason, /auto-mode recovery\/replan path/);
  assert.doesNotMatch(block.reason, /respond to the user in text/);
});

test("register-hooks rewrites loop-guard block reason for auto-mode per-tool blocks", async (t) => {
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
  });

  const { emitToolCall } = makeHookHarness();

  for (let i = 0; i < 6; i += 1) {
    await emitToolCall("gsd_complete_milestone", { milestone: `M${i}` });
  }
  const block = await emitToolCall("gsd_complete_milestone", { milestone: "M7" });

  assert.equal(block?.block, true);
  assert.match(block.reason, /Tool loop detected \(repeated tool\): gsd_complete_milestone/);
  assert.match(block.reason, /Do not re-issue this blocked tool/);
  assert.match(block.reason, /auto-mode recovery\/replan path/);
  assert.doesNotMatch(block.reason, /respond to the user in text/);
});

test("register-hooks does not record normal product tool failures as harness aborts", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "gate-evaluate", id: "M001/S01/gates+Q3", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "mcp__gsd-workflow__browser_click",
    isError: true,
    result: {
      content: [{ type: "text", text: "Element not found: #submit" }],
    },
  });

  const abort = readUnitHarnessAbort(base, "gate-evaluate", "M001/S01/gates+Q3", startedAt);
  assert.equal(abort, null);
});

test("tool_execution_end latches a failed ScheduleWakeup across unrelated tool success", async (t) => {
  const base = makeRuntimeBase();
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "discuss-milestone", id: "M001", startedAt: Date.now() };
  t.after(() => {
    closeDatabase();
    autoSession.reset();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  const error = "`prompt` is required when `stop` is not true";

  await emitToolExecutionEnd({
    toolName: "ScheduleWakeup",
    isError: true,
    result: error,
  });
  assert.equal(autoSession.lastToolInvocationError, `ScheduleWakeup: ${error}`);

  await emitToolExecutionEnd({
    toolName: "read",
    isError: false,
    result: "file contents",
  });
  assert.equal(
    autoSession.lastToolInvocationError,
    `ScheduleWakeup: ${error}`,
    "an unrelated success must not erase a failed continuation before the unit boundary",
  );

  await emitToolExecutionEnd({
    toolName: "parse_payload",
    isError: true,
    result: "Unexpected end of JSON input",
  });
  assert.equal(
    autoSession.lastToolInvocationError,
    `ScheduleWakeup: ${error}`,
    "a later invocation error must not replace the failed continuation",
  );

  let pauseCalled = false;
  const notifications: Array<{ message: string; severity?: string }> = [];
  const result = await postUnitPreVerification(
    {
      s: autoSession,
      ctx: {
        ui: {
          notify: (message: string, severity?: string) => notifications.push({ message, severity }),
        },
      } as any,
      pi: {} as any,
      buildSnapshotOpts: () => ({}) as any,
      lockBase: () => base,
      stopAuto: async () => {},
      pauseAuto: async () => { pauseCalled = true; },
      updateProgressWidget: () => {},
    },
    { skipSettleDelay: true, skipWorktreeSync: true },
  );

  assert.equal(result, "dispatched");
  assert.equal(pauseCalled, true);
  assert.equal(autoSession.pendingVerificationRetry, null);
  assert.ok(
    notifications.some(({ message, severity }) => severity === "error" && message.includes(error)),
    "the unit boundary must surface the rejected continuation",
  );
  assert.equal(autoSession.lastToolInvocationError, null);

  await emitToolExecutionEnd({
    toolName: "ScheduleWakeup",
    isError: true,
    result: error,
  });
  await emitToolExecutionEnd({
    toolName: "ScheduleWakeup",
    isError: false,
    result: "Wakeup scheduled",
  });
  assert.equal(autoSession.lastToolInvocationError, null);
});

test("tool_execution_end ignores ScheduleWakeup-shaped business validation from other tools", async (t) => {
  autoSession.reset();
  autoSession.active = true;
  t.after(() => autoSession.reset());

  const { emitToolExecutionEnd } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "submit_review",
    isError: true,
    result: "`prompt` is required when `stop` is not true",
  });

  assert.equal(autoSession.lastToolInvocationError, null);
});

test("register-hooks does not classify normal gsd_uat_exec nonzero exits as harness aborts", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "run-uat", id: "M001/S01", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "gsd_uat_exec",
    isError: true,
    result: {
      content: [{ type: "text", text: "gsd_exec[exec-1] runtime=bash exit=1 duration=12ms" }],
      details: {
        operation: "gsd_uat_exec",
        exit_code: 1,
        aborted: false,
        force_resolved: false,
      },
    },
  });

  const abort = readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt);
  assert.equal(abort, null);
});

test("register-hooks does not record schema-invalid gsd_uat_exec as a harness abort", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "run-uat", id: "M001/S01", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "gsd_uat_exec",
    isError: true,
    result: {
      content: [{
        type: "text",
        text: 'Validation failed for tool "gsd_uat_exec": - milestoneId: must have required properties milestoneId, sliceId, checkId',
      }],
      details: { operation: "uat_exec" },
    },
  });

  assert.equal(
    readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt),
    null,
    "model-fixable schema errors must not poison the unit run",
  );
});

test("register-hooks records exec deadline timeouts as harness aborts", async () => {
  for (const scenario of [
    { toolName: "gsd_exec", unitType: "gate-evaluate", unitId: "M001/S01/gates+Q3" },
    { toolName: "gsd_uat_exec", unitType: "run-uat", unitId: "M001/S01" },
  ]) {
    const base = makeRuntimeBase();
    const startedAt = Date.now();
    autoSession.reset();
    resetToolCallLoopGuard();
    autoSession.active = true;
    autoSession.basePath = base;
    autoSession.currentUnit = { type: scenario.unitType, id: scenario.unitId, startedAt };

    try {
      const { emitToolExecutionEnd } = makeHookHarness();
      await emitToolExecutionEnd({
        toolName: scenario.toolName,
        isError: true,
        result: {
          content: [{ type: "text", text: "gsd_exec[exec-timeout] runtime=bash timeout duration=600000ms" }],
          details: {
            operation: scenario.toolName,
            exit_code: null,
            aborted: false,
            force_resolved: false,
            timed_out: true,
          },
        },
      });

      const abort = readUnitHarnessAbort(base, scenario.unitType, scenario.unitId, startedAt);
      assert.equal(abort?.kind, "tool-error");
      assert.equal(abort?.toolName, scenario.toolName);
      assert.match(abort?.reason ?? "", /timeout/);
    } finally {
      autoSession.reset();
      resetToolCallLoopGuard();
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test("register-hooks preserves retryable harness abort after later successful tools", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "run-uat", id: "M001/S01", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd, emitToolResult } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "mcp__gsd-workflow__browser_click",
    isError: true,
    result: {
      content: [{ type: "text", text: "No such tool available: browser_click" }],
    },
  });

  const recorded = readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt);
  assert.equal(recorded?.kind, "tool-error");

  await emitToolResult({
    toolName: "read",
    isError: false,
    input: { path: "README.md" },
    result: {
      content: [{ type: "text", text: "file contents" }],
    },
  });
  assert.equal(
    readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt)?.kind,
    "tool-error",
    "successful native tool_result must not clear the harness abort",
  );

  await emitToolExecutionEnd({
    toolName: "read",
    isError: false,
    result: {
      content: [{ type: "text", text: "file contents" }],
    },
  });
  assert.equal(
    readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt)?.kind,
    "tool-error",
    "successful universal tool_execution_end must not clear the harness abort",
  );
});

test("register-hooks clears a stale tool-error abort after successful execution", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "run-uat", id: "M001/S01", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "gsd_uat_exec",
    isError: true,
    result: {
      content: [{ type: "text", text: "No such tool available: gsd_uat_exec" }],
      details: {},
    },
  });
  assert.equal(readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt)?.kind, "tool-error");

  await emitToolExecutionEnd({
    toolName: "gsd_uat_exec",
    isError: false,
    result: {
      content: [{ type: "text", text: "evidence captured" }],
      details: { exit_code: 0, aborted: false, force_resolved: false, timed_out: false },
    },
  });

  assert.equal(
    readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt),
    null,
    "successful execution proves a tool-error abort is stale",
  );
});

test("register-hooks heals an exec deadline timeout abort after subsequent successful execution", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "run-uat", id: "M001/S01", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "gsd_uat_exec",
    isError: true,
    result: {
      content: [{ type: "text", text: "Execution timed out" }],
      details: { timed_out: true, aborted: true, operation: "uat_exec" },
    },
  });
  assert.equal(readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt)?.kind, "tool-error");

  await emitToolExecutionEnd({
    toolName: "gsd_uat_exec",
    isError: false,
    result: {
      content: [{ type: "text", text: "all checks passed on retry" }],
      details: { exit_code: 0, aborted: false, force_resolved: false, timed_out: false },
    },
  });

  assert.equal(
    readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt),
    null,
    "subsequent successful execution supersedes prior exec deadline timeout abort",
  );
});

test("register-hooks allows cross-tool execution success (gsd_exec) to heal a gsd_uat_exec abort", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "run-uat", id: "M001/S01", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "gsd_uat_exec",
    isError: true,
    result: {
      content: [{ type: "text", text: "No such tool available: gsd_uat_exec" }],
      details: {},
    },
  });
  assert.equal(readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt)?.kind, "tool-error");

  await emitToolExecutionEnd({
    toolName: "gsd_exec",
    isError: false,
    result: {
      content: [{ type: "text", text: "command output" }],
      details: { exit_code: 0, aborted: false, force_resolved: false, timed_out: false },
    },
  });

  assert.equal(
    readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt),
    null,
    "gsd_exec success clears same-run tool-error abort from gsd_uat_exec",
  );
});

test("register-hooks preserves a turn-abort and does not overwrite it with a subsequent tool-error or clear it on tool success", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "run-uat", id: "M001/S01", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitAgentEnd, emitToolExecutionEnd } = makeHookHarness();
  await emitAgentEnd({
    messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "context truncated" }],
  });
  assert.equal(readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt)?.kind, "turn-abort");

  // Subsequent tool error in the same run must not downgrade the turn-abort
  await emitToolExecutionEnd({
    toolName: "gsd_uat_exec",
    isError: true,
    result: {
      content: [{ type: "text", text: "No such tool available: gsd_uat_exec" }],
      details: {},
    },
  });
  assert.equal(
    readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt)?.kind,
    "turn-abort",
    "turn-abort must not be overwritten by tool-error",
  );

  // Subsequent tool success must not clear the genuine turn-abort
  await emitToolExecutionEnd({
    toolName: "gsd_exec",
    isError: false,
    result: {
      content: [{ type: "text", text: "command output" }],
      details: { exit_code: 0, aborted: false, force_resolved: false, timed_out: false },
    },
  });
  assert.equal(
    readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt)?.kind,
    "turn-abort",
    "genuine turn-abort must remain protected across tool success",
  );
});

test("register-hooks does not record save-tool validation errors as harness aborts", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "run-uat", id: "M001/S01", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "gsd_uat_result_save",
    isError: true,
    result: {
      content: [{ type: "text", text: "Error: UAT Assessment requires at least one fresh gsd_uat_exec evidence reference" }],
      details: { operation: "save_uat_result", error: "uat_missing_fresh_evidence" },
    },
  });

  const abort = readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt);
  assert.equal(abort, null);
});

test("register-hooks does not record pending approval hard-blocks as harness aborts", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "gate-evaluate", id: "M001/S01/gates+Q3", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "gsd_summary_save",
    isError: true,
    result: {
      content: [{
        type: "text",
        text: 'HARD BLOCK: Discussion gate "depth:M001" has not been confirmed by the user.',
      }],
    },
  });

  const abort = readUnitHarnessAbort(base, "gate-evaluate", "M001/S01/gates+Q3", startedAt);
  assert.equal(abort, null);
});

test("register-hooks only records agent_end turn aborts for aborted or error stop reasons", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "gate-evaluate", id: "M001/S01/gates+Q3", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitAgentEnd } = makeHookHarness();
  await emitAgentEnd({
    abortOrigin: "auto-context",
    messages: [{ stopReason: "stop" }],
  });

  const abort = readUnitHarnessAbort(base, "gate-evaluate", "M001/S01/gates+Q3", startedAt);
  assert.equal(abort, null);
});
