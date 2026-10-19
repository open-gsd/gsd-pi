import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { autoSession, isAutoActive } from "../auto-runtime-state.ts";
import { postUnitPreVerification } from "../auto-post-unit.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";
import { resetToolCallLoopGuard } from "../bootstrap/tool-call-loop-guard.ts";
import { resetLoopGuardAbortGuard } from "../bootstrap/loop-guard-abort.ts";
import { closeDatabase, openDatabase } from "../gsd-db.ts";
import { readOpenAutoPause } from "../db/writers/auto-pauses.ts";
import { readUnitHarnessAbort } from "../unit-runtime.ts";
import { makeTempRepo } from "./test-utils.ts";

type Handler = (event: any, ctx?: any) => Promise<any> | any;

// pauseAuto anchors the process cwd to the paused base path. Captured at
// module load, before any test can move it, so cleanup always has a directory
// that exists to chdir back to.
const initialCwd = process.cwd();

// agent_end reads the write gate, and that read opens the project database of
// `cwd`. A test that asserts on database rows after agent_end passes its own
// base, so a database in the process working directory cannot replace its own.
function makeHookHarness(cwd: string = process.cwd(), ctxExtra: Record<string, unknown> = {}): {
  emitToolCall: (toolName: string, input: Record<string, unknown>) => Promise<any>;
  emitMessageStart: (role?: string) => Promise<void>;
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
    cwd,
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    ...ctxExtra,
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
    async emitMessageStart(role: string = "assistant"): Promise<void> {
      // A new conversation message started. Only ASSISTANT messages advance
      // the loop guard's escalation streak (#2877) — tool-result messages
      // (role "toolResult") are emitted between the calls of one response's
      // sequential batch and must not.
      for (const handler of handlers.get("message_start") ?? []) {
        await handler({ message: { role } }, ctx);
      }
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
  // The harness abort is a database row. Without an open database nothing is
  // recorded, and a "no abort recorded" assertion would prove nothing.
  openDatabase(":memory:");
  return base;
}

test.after(() => closeDatabase());

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

  const { emitAgentEnd, emitToolExecutionEnd } = makeHookHarness(base);
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

  const { emitAgentEnd } = makeHookHarness(base);
  await emitAgentEnd({
    abortOrigin: "auto-context",
    messages: [{ stopReason: "stop" }],
  });

  const abort = readUnitHarnessAbort(base, "gate-evaluate", "M001/S01/gates+Q3", startedAt);
  assert.equal(abort, null);
});

// ─── #2877: post-cap consecutive blocks escalate to the sanctioned pause ───

test("register-hooks escalates the second consecutive loop-guard block to a sanctioned auto pause (#2877)", async (t) => {
  const base = makeTempRepo("gsd-loop-guard-abort-");
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  const startedAt = Date.now();
  const abortCalls: string[] = [];
  autoSession.reset();
  resetToolCallLoopGuard();
  resetLoopGuardAbortGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  // complete-milestone owns gsd_complete_milestone in its Tool Contract, so
  // the scope guard passes it and only the loop guard can block these calls.
  autoSession.currentUnit = { type: "complete-milestone", id: "M001", startedAt };
  t.after(() => {
    closeDatabase();
    autoSession.reset();
    resetToolCallLoopGuard();
    resetLoopGuardAbortGuard();
    process.chdir(initialCwd);
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolCall, emitMessageStart } = makeHookHarness(base, {
    isIdle: () => false,
    abort: () => abortCalls.push("abort"),
    sessionManager: { getSessionFile: () => null },
  });

  // Calls 1-6 are allowed: legitimate varied-arg calls keep working.
  for (let i = 0; i < 6; i += 1) {
    const allowed = await emitToolCall("gsd_complete_milestone", { milestone: `M${i}` });
    assert.equal(allowed?.block ?? false, false, `call ${i} should pass the loop guard`);
  }

  // Call 7: the FIRST block stays a plain error toolResult and must not touch
  // auto-mode state — the model gets its explicit signal first.
  const firstBlock = await emitToolCall("gsd_complete_milestone", { milestone: "M6" });
  assert.equal(firstBlock?.block, true);
  assert.match(firstBlock.reason, /Tool loop detected \(repeated tool\): gsd_complete_milestone/);
  assert.match(firstBlock.reason, /Do not re-issue this blocked tool/);
  assert.equal(isAutoActive(), true, "the first block must not pause auto-mode");
  assert.equal(abortCalls.length, 0, "the first block must not abort the turn");

  // Same-response blocks never escalate: an adjacent retry inside one model
  // response proves only that the batch blew the cap — the model has not seen
  // any block yet (codex batch repro, #2877). Sequential execution emits each
  // tool result as its own (role "toolResult") message_start between the
  // calls; those must not advance the response boundary either.
  await emitMessageStart("toolResult");
  const sameResponseBlock = await emitToolCall("gsd_complete_milestone", { milestone: "M6b" });
  assert.equal(sameResponseBlock?.block, true);
  await emitMessageStart("toolResult");
  const sameResponseBlock2 = await emitToolCall("gsd_complete_milestone", { milestone: "M6c" });
  assert.equal(sameResponseBlock2?.block, true);
  assert.equal(isAutoActive(), true, "a same-response block must not pause auto-mode");
  assert.equal(abortCalls.length, 0);

  // The model responds (new message_start) and re-issues the blocked tool
  // anyway — the second post-response block escalates through pauseAuto (the
  // sanctioned interrupt: turn aborted, unit closed into the pause/repair
  // state, reason carried).
  await emitMessageStart();
  const escalated = await emitToolCall("gsd_complete_milestone", { milestone: "M7" });
  assert.equal(escalated?.block, true);
  assert.match(escalated.reason, /Auto-mode paused/);
  assert.match(escalated.reason, /Tool loop detected \(repeated tool\): gsd_complete_milestone/,
    "the abort result must carry the guard's reason");
  assert.equal(isAutoActive(), false, "auto-mode must be paused through pauseAuto");
  assert.equal(autoSession.paused, true);
  assert.equal(autoSession.currentUnit, null, "the unit must be closed into the pause/repair state");
  assert.equal(abortCalls.length, 1, "the active turn must be aborted exactly once");

  // The pause row is the durable repair state: it must carry the machine
  // blocker, the unit identity, and the guard's reason classified as a
  // deterministic-policy stop (repair before resume, not an automatic retry).
  const pauseRow = readOpenAutoPause();
  assert.equal(pauseRow?.blockerKind, "machine_fixable");
  assert.equal(pauseRow?.unitType, "complete-milestone");
  assert.equal(pauseRow?.unitId, "M001");
  assert.match(pauseRow?.pauseReason ?? "", /recovery:deterministic-policy\/stop/);
  assert.match(pauseRow?.pauseReason ?? "", /Tool loop guard escalation: "gsd_complete_milestone"/);
  assert.match(pauseRow?.pauseReason ?? "", /Tool loop detected \(repeated tool\)/,
    "the row must carry the underlying guard reason");

  // A post-pause retry of the blocked tool must stay a plain error result:
  // auto is inactive, so the escalation can neither double-abort the turn
  // nor re-pause the already-paused session (codex review, #2877).
  await emitMessageStart();
  const postPause = await emitToolCall("gsd_complete_milestone", { milestone: "M8" });
  assert.equal(postPause?.block, true);
  assert.doesNotMatch(postPause.reason, /Auto-mode paused/, "no second pause after the first");
  assert.equal(abortCalls.length, 1, "the turn must never be aborted twice");
});

test("loop-guard blocks stay error results without escalation outside auto-mode (#2877)", async (t) => {
  autoSession.reset();
  resetToolCallLoopGuard();
  resetLoopGuardAbortGuard();
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    resetLoopGuardAbortGuard();
  });

  const abortCalls: string[] = [];
  const { emitToolCall, emitMessageStart } = makeHookHarness(process.cwd(), {
    isIdle: () => false,
    abort: () => abortCalls.push("abort"),
    sessionManager: { getSessionFile: () => null },
  });

  // Interactive sessions have no unit to land in a repair state, so every
  // block stays a plain error toolResult. The model responds between the
  // blocks (assistant message_start), so the guard's escalation flag DOES
  // fire — what keeps the turn alive is the auto-active veto, which is the
  // behavior under test here (codex review, #2877).
  for (let i = 0; i < 9; i += 1) {
    if (i >= 6) await emitMessageStart();
    const result = await emitToolCall("gsd_complete_milestone", { milestone: `M${i}` });
    if (i < 6) {
      assert.equal(result?.block ?? false, false);
    } else {
      assert.equal(result?.block, true, `call ${i} should be blocked`);
      assert.match(result.reason, /respond to the user in text/);
      assert.doesNotMatch(result.reason, /Auto-mode paused/);
    }
  }
  assert.equal(abortCalls.length, 0, "interactive sessions must never abort via the auto pause path");
});

test("a throwing turn-abort still completes the sanctioned pause (#2877 codex review)", async (t) => {
  const base = makeTempRepo("gsd-loop-guard-abort-throw-");
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  resetLoopGuardAbortGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "complete-milestone", id: "M001", startedAt };
  t.after(() => {
    closeDatabase();
    autoSession.reset();
    resetToolCallLoopGuard();
    resetLoopGuardAbortGuard();
    process.chdir(initialCwd);
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolCall, emitMessageStart } = makeHookHarness(base, {
    isIdle: () => false,
    // The engine abort call fails (dead transport). pauseAuto flags the pause
    // BEFORE aborting, so a throw here must not strand the half-paused state:
    // cancellation resolution, pause row, and unit closeout still run.
    abort: () => {
      throw new Error("abort transport dead");
    },
    sessionManager: { getSessionFile: () => null },
  });

  for (let i = 0; i < 6; i += 1) {
    await emitToolCall("gsd_complete_milestone", { milestone: `M${i}` });
  }
  await emitToolCall("gsd_complete_milestone", { milestone: "M6" });
  await emitMessageStart();
  const escalated = await emitToolCall("gsd_complete_milestone", { milestone: "M7" });

  // The pause itself completed: durable row, unit closed into repair state.
  assert.equal(autoSession.paused, true, "the pause must complete despite the abort failure");
  assert.equal(autoSession.currentUnit, null, "the unit must not stay dispatched");
  const pauseRow = readOpenAutoPause();
  assert.equal(pauseRow?.blockerKind, "machine_fixable");
  assert.match(pauseRow?.pauseReason ?? "", /Tool loop guard escalation: "gsd_complete_milestone"/);
  assert.match(escalated.reason, /Auto-mode paused/,
    "the escalation result must still report the sanctioned pause");
  assert.equal(isAutoActive(), false);
});

test("exempt read-only query tools never reach the auto escalation (#2877, #2753)", async (t) => {
  const base = makeRuntimeBase();
  autoSession.reset();
  resetToolCallLoopGuard();
  resetLoopGuardAbortGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "plan-milestone", id: "M001", startedAt: Date.now() };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    resetLoopGuardAbortGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const abortCalls: string[] = [];
  const { emitToolCall } = makeHookHarness(base, {
    isIdle: () => false,
    abort: () => abortCalls.push("abort"),
  });

  // The #2753 pattern: a planning turn legitimately looks up many different
  // decisions. Exempt tools skip Guard 2 entirely, so no block — and no
  // escalation — ever fires.
  for (let i = 0; i < 30; i += 1) {
    const result = await emitToolCall("gsd_decision_get", { id: `D${i}` });
    assert.equal(result?.block ?? false, false, `exempt lookup ${i} must not be blocked`);
  }
  assert.equal(isAutoActive(), true, "exempt lookups must not pause auto-mode");
  assert.equal(abortCalls.length, 0);
});
