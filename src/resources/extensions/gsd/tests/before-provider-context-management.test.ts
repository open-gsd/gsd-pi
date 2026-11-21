import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _setAutoActiveForTest } from "../auto.ts";
import { autoSession } from "../auto-runtime-state.js";
import { registerHooks } from "../bootstrap/register-hooks.ts";

type HookHandler = (event: any, ctx?: any) => Promise<any> | any;

function createHookHandlers(): Map<string, HookHandler[]> {
  const handlers = new Map<string, HookHandler[]>();
  const pi = {
    on(event: string, handler: HookHandler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  };

  registerHooks(pi as any, []);
  return handlers;
}

function requireHook(handlers: Map<string, HookHandler[]>, event: string): HookHandler {
  const handler = handlers.get(event)?.[0];
  assert.ok(handler, `${event} hook should be registered`);
  return handler;
}

test("before_provider_request truncates tool results outside auto-mode", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-before-provider-context-"));
  const gsdHome = join(dir, "home");
  const project = join(dir, "project");
  const previousCwd = process.cwd();
  const previousGsdHome = process.env.GSD_HOME;

  mkdirSync(join(project, ".gsd"), { recursive: true });
  mkdirSync(gsdHome, { recursive: true });
  writeFileSync(
    join(project, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "version: 1",
      "context_management:",
      "  tool_result_max_chars: 200",
      "  observation_mask_turns: 1",
      "---",
      "",
    ].join("\n"),
    "utf-8",
  );

  process.env.GSD_HOME = gsdHome;
  process.chdir(project);
  _setAutoActiveForTest(false);

  t.after(() => {
    _setAutoActiveForTest(false);
    process.chdir(previousCwd);
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const beforeProviderRequest = requireHook(createHookHandlers(), "before_provider_request");
  const messageText = "m".repeat(250);
  const responsesOutput = "r".repeat(250);
  const payload = {
    messages: [
      { role: "user", content: [{ type: "text", text: "keep me" }] },
      {
        role: "toolResult",
        toolCallId: "toolu_test",
        toolName: "Read",
        isError: false,
        content: [{ type: "text", text: messageText }],
      },
    ],
    input: [
      { role: "user", content: [{ type: "input_text", text: "keep me" }] },
      { type: "function_call_output", call_id: "call_test", output: responsesOutput },
    ],
  };

  await beforeProviderRequest({ payload });

  const truncatedMessage = (payload.messages[1]?.content as Array<{ text?: string }>)[0]?.text ?? "";
  const truncatedResponsesOutput = String(payload.input[1]?.output ?? "");

  assert.match(truncatedMessage, /\[truncated\]/);
  assert.match(truncatedResponsesOutput, /\[truncated\]/);
  assert.ok(truncatedMessage.length < messageText.length);
  assert.ok(truncatedResponsesOutput.length < responsesOutput.length);
  assert.doesNotMatch(truncatedMessage, /result masked/);
  assert.doesNotMatch(truncatedResponsesOutput, /result masked/);
});

test("successful shell result clears source context before provider injection", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-before-provider-source-"));
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "app.ts"), "export const value = 'before';\n");

  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = project;
  autoSession.setCurrentUnit({
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt: 123,
    workspaceRoot: project,
  });
  autoSession.sourceObservations.observeRead({ path: "app.ts" });

  t.after(() => {
    autoSession.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.match(autoSession.sourceObservations.renderActiveBlock() ?? "", /before/);

  const handlers = createHookHandlers();
  const toolResult = requireHook(handlers, "tool_result");
  const beforeProviderRequest = requireHook(handlers, "before_provider_request");

  await toolResult({
    toolCallId: "toolu_bash",
    toolName: "bash",
    input: { command: "printf after > app.ts" },
    isError: false,
    result: "ok",
  }, { cwd: project });

  const payload = {
    messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
  };
  await beforeProviderRequest({ payload });

  assert.equal(autoSession.sourceObservations.renderActiveBlock(), null);
  assert.equal(payload.messages.length, 1);
  assert.doesNotMatch(payload.messages[0].content[0].text, /Source Context Block/);
});

function fiveTurnMessages(): any[] {
  const sentinel = "[GSD Context Injection]";
  const contextInjection = (turn: number) => ({
    role: "user",
    content: [{ type: "text", text: `${sentinel}\n[MEMORY] turn=${turn}` }],
  });
  return [
    { role: "user", content: [{ type: "text", text: "turn 1" }] },
    contextInjection(1),
    { role: "assistant", content: [{ type: "text", text: "r1" }] },
    { role: "user", content: [{ type: "text", text: "turn 2" }] },
    contextInjection(2),
    { role: "assistant", content: [{ type: "text", text: "r2" }] },
    { role: "user", content: [{ type: "text", text: "turn 3" }] },
    contextInjection(3),
    { role: "assistant", content: [{ type: "text", text: "r3" }] },
    { role: "user", content: [{ type: "text", text: "turn 4" }] },
    contextInjection(4),
    { role: "assistant", content: [{ type: "text", text: "r4" }] },
    { role: "user", content: [{ type: "text", text: "turn 5" }] },
    contextInjection(5),
  ];
}

function setupSession(dir: string): { project: string; gsdHome: string } {
  const gsdHome = join(dir, "home");
  const project = join(dir, "project");
  mkdirSync(join(project, ".gsd"), { recursive: true });
  mkdirSync(gsdHome, { recursive: true });
  process.env.GSD_HOME = gsdHome;
  process.chdir(project);
  _setAutoActiveForTest(false);
  return { project, gsdHome };
}

test("before_provider_request keeps all GSD context injections by default (append-only prefix-cache stability)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-before-provider-injections-keep-"));
  const previousCwd = process.cwd();
  const previousGsdHome = process.env.GSD_HOME;
  setupSession(dir);

  t.after(() => {
    _setAutoActiveForTest(false);
    process.chdir(previousCwd);
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const sentinel = "[GSD Context Injection]";
  const beforeProviderRequest = requireHook(createHookHandlers(), "before_provider_request");
  const payload = { messages: fiveTurnMessages() };

  await beforeProviderRequest({ payload });

  const survivors = (payload.messages as any[]).filter((m) => (m.content?.[0]?.text ?? "").startsWith(sentinel));
  assert.equal(survivors.length, 5);
  assert.match(survivors[0].content[0].text, /turn=1/);
  assert.match(survivors[survivors.length - 1].content[0].text, /turn=5/);
});

test("before_provider_request with superseded_injections: drop keeps only the latest GSD context injection", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-before-provider-injections-drop-"));
  const previousCwd = process.cwd();
  const previousGsdHome = process.env.GSD_HOME;
  const { project } = setupSession(dir);
  writeFileSync(
    join(project, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "version: 1",
      "context_management:",
      "  superseded_injections: drop",
      "---",
      "",
    ].join("\n"),
  );

  t.after(() => {
    _setAutoActiveForTest(false);
    process.chdir(previousCwd);
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const sentinel = "[GSD Context Injection]";
  const beforeProviderRequest = requireHook(createHookHandlers(), "before_provider_request");
  const payload = { messages: fiveTurnMessages() };

  await beforeProviderRequest({ payload });

  const survivors = (payload.messages as any[]).filter((m) => (m.content?.[0]?.text ?? "").startsWith(sentinel));
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].content[0].text, /turn=5/);
});
