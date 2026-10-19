import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context, Message, Model } from "@gsd/pi-ai";
import { agentLoop } from "@gsd/pi-agent-core";
import type { AgentEvent, AgentMessage } from "@gsd/pi-agent-core";
import {
	buildCursorAgentRunPlan,
	buildCursorPrompt,
	buildCursorSpawnInvocation,
	parseCursorAgentLine,
	streamViaCursorAgent,
	unsupportedCursorGsdToolError,
} from "../stream-adapter.ts";

const model = {
	id: "composer-2.5",
	name: "Composer 2.5",
	api: "cursor-stream-json",
	provider: "cursor-agent",
	baseUrl: "local://cursor-agent",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
} as Model<string>;

const context = {
	systemPrompt: "Be concise.",
	messages: [{ role: "user", content: "Hello" }],
	tools: [{ name: "gsd_plan_slice" }],
} as Context;

test("buildCursorAgentRunPlan invokes cursor-agent in stream-json prompt mode", () => {
	const plan = buildCursorAgentRunPlan("composer-2.5", "Prompt", "/tmp/project", "linux");
	assert.equal(plan.command, "cursor-agent");
	assert.deepEqual(plan.args, ["-p", "Prompt", "--output-format", "stream-json", "--model", "composer-2.5", "--workspace", "/tmp/project", "--trust"]);
});

test("buildCursorSpawnInvocation uses cmd /c on Windows", () => {
	assert.deepEqual(buildCursorSpawnInvocation("cursor-agent", ["--version"], "win32"), {
		command: "cmd",
		args: ["/c", "cursor-agent", "--version"],
	});
});

test("buildCursorPrompt preserves system, message, and tool context", () => {
	const prompt = buildCursorPrompt(context);
	assert.match(prompt, /System instructions:\nBe concise\./);
	assert.match(prompt, /User:\nHello/);
	assert.match(prompt, /Requested GSD tools: gsd_plan_slice/);
	assert.match(prompt, /GSD lifecycle tools bridged to the local host: \(none\)/);
});

test("buildCursorPrompt explains the local GSD lifecycle bridge (#1764)", () => {
	const prompt = buildCursorPrompt({
		...context,
		tools: [
			{ name: "gsd_task_complete" },
			{ name: "gsd_task_recovery_resume" },
			{ name: "gsd_plan_slice" },
		],
	} as Context);
	assert.match(prompt, /GSD lifecycle tools bridged to the local host: gsd_task_complete, gsd_task_recovery_resume/);
	assert.match(prompt, /<gsd_tool_call>\{"name":"gsd_task_complete","arguments":\{\.\.\.\}\}<\/gsd_tool_call>/);
	assert.match(prompt, /Requested GSD tools: gsd_task_complete, gsd_task_recovery_resume, gsd_plan_slice/);
});

test("parseCursorAgentLine maps text, legacy tool, result, usage, and errors", () => {
	assert.deepEqual(parseCursorAgentLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}'), {
		type: "text",
		text: "hi",
	});
	assert.deepEqual(parseCursorAgentLine('{"type":"tool_call","id":"tool_1","name":"edit","input":{"path":"a"}}'), {
		type: "tool_call",
		toolCall: { type: "toolCall", id: "tool_1", name: "edit", arguments: { path: "a" } },
	});
	assert.deepEqual(parseCursorAgentLine('{"type":"tool_result","tool_call_id":"tool_1","content":"ok","is_error":false}'), {
		type: "tool_result",
		toolCallId: "tool_1",
		result: { content: [{ type: "text", text: "ok" }], isError: false },
	});
	assert.deepEqual(parseCursorAgentLine('{"type":"result","usage":{"input_tokens":3,"output_tokens":4}}'), {
		type: "usage",
		usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
	});
	assert.deepEqual(parseCursorAgentLine('{"type":"error","message":"boom"}'), { type: "error", message: "boom" });
});

test("parseCursorAgentLine ignores the echoed prompt and thinking events (not assistant text)", () => {
	// Real shapes captured from cursor-agent 2026.07.23 stream-json output.
	const promptEcho =
		'{"type":"user","message":{"role":"user","content":[{"type":"text","text":"System instructions:\\nYou are an expert coding assistant."}]},"session_id":"s1"}';
	assert.deepEqual(parseCursorAgentLine(promptEcho), { type: "ignore" });

	assert.deepEqual(
		parseCursorAgentLine('{"type":"thinking","subtype":"delta","text":"The user requested","session_id":"s1"}'),
		{ type: "ignore" },
	);
	assert.deepEqual(
		parseCursorAgentLine('{"type":"thinking","subtype":"completed","session_id":"s1"}'),
		{ type: "ignore" },
	);

	// Role-tagged non-assistant message events must not leak either, whatever the type label.
	assert.deepEqual(
		parseCursorAgentLine('{"type":"message","message":{"role":"user","content":[{"type":"text","text":"echo"}]}}'),
		{ type: "ignore" },
	);
});

test("streamViaCursorAgent does not prepend the prompt echo to assistant text", async () => {
	const lines = [
		'{"type":"system","subtype":"init","session_id":"s1","model":"Composer 2.5"}',
		'{"type":"user","message":{"role":"user","content":[{"type":"text","text":"System instructions:\\nYou are an expert coding assistant.\\n\\nUser:\\nSay hi."}]},"session_id":"s1"}',
		'{"type":"thinking","subtype":"delta","text":"The user requested a reply.","session_id":"s1"}',
		'{"type":"thinking","subtype":"completed","session_id":"s1"}',
		'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"session_id":"s1"}',
		'{"type":"result","subtype":"success","is_error":false,"result":"hi","session_id":"s1","usage":{"inputTokens":3,"outputTokens":4}}',
	];
	const stream = streamViaCursorAgent(model, context, {
		_cursorAgentRunnerForTest: async () => ({ stdout: `${lines.join("\n")}\n`, stderr: "", code: 0, signal: null }),
	});

	const events = [];
	for await (const event of stream) events.push(event);

	const deltas = events.filter((event) => event.type === "text_delta").map((event) => event.delta);
	assert.deepEqual(deltas, ["hi"], "only assistant text may stream as text_delta");

	const done = events.find((event) => event.type === "done");
	assert.ok(done && done.type === "done");
	assert.equal(done.message.content[0].type, "text");
	assert.equal(done.message.content[0].text, "hi");
});

test("RPC v2 message_update/message_end expose only assistant text from cursor-agent", async () => {
	// Drives the real agent loop, which is the producer of the RPC v2 protocol events the
	// bug report observed: streamed `message_update.assistantMessageEvent.text_delta` and the
	// final `message_end.message.content`.
	const lines = [
		'{"type":"system","subtype":"init","session_id":"s1","model":"Composer 2.5"}',
		'{"type":"user","message":{"role":"user","content":[{"type":"text","text":"System instructions:\\nBe concise.\\n\\nUser:\\nSay hi."}]},"session_id":"s1"}',
		'{"type":"thinking","subtype":"delta","text":"The user requested a reply.","session_id":"s1"}',
		'{"type":"thinking","subtype":"completed","session_id":"s1"}',
		'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"session_id":"s1"}',
		'{"type":"result","subtype":"success","is_error":false,"result":"hi","session_id":"s1","usage":{"input_tokens":3,"output_tokens":4}}',
	];
	const prompt: AgentMessage = { role: "user", content: "Say hi.", timestamp: Date.now() };
	const stream = agentLoop(
		[prompt],
		{ systemPrompt: "Be concise.", messages: [] },
		{ model, convertToLlm: (messages) => messages as Message[] },
		undefined,
		(_model, llmContext) =>
			streamViaCursorAgent(model, llmContext, {
				_cursorAgentRunnerForTest: async () => ({
					stdout: `${lines.join("\n")}\n`,
					stderr: "",
					code: 0,
					signal: null,
				}),
			}),
	);

	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);

	const updates = events.filter(
		(event): event is Extract<AgentEvent, { type: "message_update" }> => event.type === "message_update",
	);
	const deltas = updates
		.map((event) => event.assistantMessageEvent)
		.filter((ame) => ame.type === "text_delta")
		.map((ame) => (ame as { delta: string }).delta);
	assert.deepEqual(deltas, ["hi"], "message_update text_delta must carry only assistant text");
	assert.ok(
		!updates.some((event) => event.assistantMessageEvent.type.startsWith("thinking")),
		"cursor-agent thinking events must not surface as RPC v2 reasoning deltas",
	);

	const assistantEnd = events
		.filter((event): event is Extract<AgentEvent, { type: "message_end" }> => event.type === "message_end")
		.find((event) => event.message.role === "assistant");
	assert.ok(assistantEnd, "expected a final assistant message_end");
	const finalMessage = assistantEnd.message;
	const finalText = finalMessage.role !== "assistant"
		? ""
		: finalMessage.content
			.filter((block) => block.type === "text")
			.map((block) => (block as { text: string }).text)
			.join("");
	assert.equal(finalText, "hi", "message_end content must carry only assistant text");
});

test("parseCursorAgentLine ignores Cursor-owned nested tool events so GSD does not redispatch them", () => {
	const started = parseCursorAgentLine(
		'{"type":"tool_call","subtype":"started","call_id":"tool_1","tool_call":{"readToolCall":{"args":{"path":"a.ts"}}}}',
	);

	assert.deepEqual(started, { type: "ignore" });

	const completed = parseCursorAgentLine(
		'{"type":"tool_call","subtype":"completed","call_id":"tool_1","tool_call":{"readToolCall":{"args":{"path":"a.ts"}}},"result":{"content":"ok"}}',
	);

	assert.deepEqual(completed, { type: "ignore" });
});

test("streamViaCursorAgent does not surface Cursor-owned nested tool events as local tool calls", async () => {
	const lines = [
		'{"type":"assistant","message":{"content":[{"type":"text","text":"I will inspect the file."}]}}',
		'{"type":"tool_call","subtype":"started","call_id":"tool_1","tool_call":{"readToolCall":{"args":{"path":"a.ts"}}}}',
		'{"type":"tool_call","subtype":"completed","call_id":"tool_1","tool_call":{"readToolCall":{"args":{"path":"a.ts"}}},"result":{"content":"ok"}}',
		'{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}',
	];
	const stream = streamViaCursorAgent(model, context, {
		_cursorAgentRunnerForTest: async () => ({ stdout: `${lines.join("\n")}\n`, stderr: "", code: 0, signal: null }),
	});

	const events = [];
	for await (const event of stream) events.push(event);

	const done = events.find((event) => event.type === "done");
	assert.ok(done && done.type === "done");
	assert.ok(
		!done.message.content.some((block) => block.type === "toolCall"),
		"Cursor-owned internal tool events must not become local GSD tool calls",
	);
	assert.ok(!events.some((event) => event.type === "toolcall_start"));
});

test("streamViaCursorAgent emits complete stdout lines before cursor-agent exits", async () => {
	let releaseRunner: (() => void) | undefined;
	const stream = streamViaCursorAgent(model, context, {
		_cursorAgentRunnerForTest: async (_plan, _options, onLine) => {
			onLine('{"type":"assistant","message":{"content":[{"type":"text","text":"Live"}]}}');
			await new Promise<void>((resolve) => { releaseRunner = resolve; });
			return { stdout: "", stderr: "", code: 0, signal: null };
		},
	});

	const iterator = stream[Symbol.asyncIterator]();
	const firstDelta = (async () => {
		for (;;) {
			const next = await iterator.next();
			if (next.done) return undefined;
			if (next.value.type === "text_delta") return next.value;
		}
	})();

	const event = await Promise.race([
		firstDelta,
		new Promise<undefined>((resolve) => setTimeout(resolve, 100)),
	]);
	assert.ok(event, "expected streamed text before runner completed");
	assert.equal(event.type, "text_delta");
	assert.equal(event.delta, "Live");

	releaseRunner?.();
	for (;;) {
		const next = await iterator.next();
		if (next.done) break;
	}
});

test("streamViaCursorAgent turns NDJSON into assistant events with external tool results", async () => {
	const lines = [
		'{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}',
		'{"type":"tool_call","id":"tool_1","name":"edit","input":{"path":"a"}}',
		'{"type":"tool_result","tool_call_id":"tool_1","content":"ok","is_error":false}',
		'{"type":"result","usage":{"input_tokens":3,"output_tokens":4}}',
	];
	const stream = streamViaCursorAgent(model, context, {
		_cursorAgentRunnerForTest: async () => ({ stdout: `${lines.join("\n")}\n`, stderr: "", code: 0, signal: null }),
	});

	const events = [];
	for await (const event of stream) events.push(event);

	const done = events.find((event) => event.type === "done");
	assert.ok(done && done.type === "done");
	assert.equal(done.message.content[0].type, "text");
	assert.equal(done.message.content[0].text, "Hi");
	const toolCall = done.message.content.find((block) => block.type === "toolCall");
	assert.ok(toolCall && toolCall.type === "toolCall");
	assert.deepEqual(toolCall.externalResult, { content: [{ type: "text", text: "ok" }], isError: false });
	assert.equal(done.message.usage.input, 3);
	assert.equal(done.message.usage.output, 4);
});

// ---------------------------------------------------------------------------
// Projection write guard — cursor-agent executes Write/Edit/Bash itself and
// the stream-json protocol has no pre-execution hook, so the adapter cannot
// block. The detect-and-report mirror marks the executed call's result with
// the projection refusal and the save tool that owns the file.
// ---------------------------------------------------------------------------

async function streamToolLines(lines: string[]) {
	const stream = streamViaCursorAgent(model, context, {
		_cursorAgentRunnerForTest: async () => ({ stdout: `${lines.join("\n")}\n`, stderr: "", code: 0, signal: null }),
	});
	const events = [];
	for await (const event of stream) events.push(event);
	const done = events.find((event) => event.type === "done");
	assert.ok(done && done.type === "done");
	return done.message.content.filter((block) => block.type === "toolCall");
}

function resultText(result: unknown): string {
	if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) return "";
	return (result as { content: unknown[] }).content
		.map((part) => typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
			? (part as { text: string }).text
			: "")
		.join("");
}

test("cursor adapter reports a write to a managed projection as a refused tool result", async () => {
	const toolCalls = await streamToolLines([
		'{"type":"tool_call","id":"tool_w","name":"write","input":{"path":"/tmp/project/.gsd/STATE.md","content":"x"}}',
		'{"type":"tool_result","tool_call_id":"tool_w","content":"ok","is_error":false}',
	]);
	assert.equal(toolCalls.length, 1);
	const result = toolCalls[0].externalResult;
	assert.ok(result && result.isError === true, "the executed write must be reported as an error");
	assert.match(resultText(result), /gsd_task_complete/);
	assert.match(resultText(result), /cursor-agent executed this tool before GSD could refuse it/);
});

test("cursor adapter names the save tool for an edit to a rendered projection and a bash write", async () => {
	const editCalls = await streamToolLines([
		'{"type":"tool_call","id":"tool_e","name":"Edit","input":{"file_path":"/tmp/project/.gsd/milestones/M001/M001-ROADMAP.md","old_string":"a","new_string":"b"}}',
	]);
	assert.equal(editCalls.length, 1);
	const editResult = editCalls[0].externalResult;
	assert.ok(editResult && editResult.isError === true);
	assert.match(resultText(editResult), /gsd_plan_milestone/);

	const bashCalls = await streamToolLines([
		'{"type":"tool_call","id":"tool_b","name":"bash","input":{"command":"echo x >> .gsd/DECISIONS.md"}}',
		'{"type":"tool_result","tool_call_id":"tool_b","content":"ok","is_error":false}',
	]);
	const bashResult = bashCalls[0].externalResult;
	assert.ok(bashResult && bashResult.isError === true);
	assert.match(resultText(bashResult), /gsd_decision_save/);
});

test("cursor adapter keeps the executed result for writes outside the managed projections", async () => {
	const toolCalls = await streamToolLines([
		'{"type":"tool_call","id":"tool_src","name":"write","input":{"path":"/tmp/project/src/app.ts","content":"x"}}',
		'{"type":"tool_result","tool_call_id":"tool_src","content":"ok","is_error":false}',
		'{"type":"tool_call","id":"tool_doc","name":"write","input":{"path":"/tmp/project/.gsd/milestones/M001/M001-LEARNINGS.md","content":"x"}}',
		'{"type":"tool_result","tool_call_id":"tool_doc","content":"ok","is_error":false}',
	]);
	assert.equal(toolCalls.length, 2);
	for (const call of toolCalls) {
		assert.deepEqual(call.externalResult, { content: [{ type: "text", text: "ok" }], isError: false });
	}
});

test("cursor adapter bridges a streamed gsd_task_complete envelope for local host execution (#1764)", async () => {
	const lines = [
		'{"type":"assistant","message":{"content":[{"type":"text","text":"Implemented and verified.\\n<gsd_tool_"}]}}',
		'{"type":"assistant","message":{"content":[{"type":"text","text":"call>{\\"name\\":\\"gsd_task_complete\\",\\"arguments\\":{\\"milestoneId\\":\\"M001\\",\\"sliceId\\":\\"S01\\",\\"taskId\\":\\"T03\\"}}</gsd_tool_call>"}]}}',
	];
	const stream = streamViaCursorAgent(model, context, {
		_cursorAgentRunnerForTest: async () => ({ stdout: `${lines.join("\n")}\n`, stderr: "", code: 0, signal: null }),
	});
	const events = [];
	for await (const event of stream) events.push(event);
	const done = events.find((event) => event.type === "done");
	assert.ok(done && done.type === "done");
	const toolCall = done.message.content.find((block) => block.type === "toolCall");
	assert.ok(toolCall && toolCall.type === "toolCall");
	assert.equal(toolCall.name, "gsd_task_complete");
	assert.deepEqual(toolCall.arguments, { milestoneId: "M001", sliceId: "S01", taskId: "T03" });
	assert.equal(toolCall.externalResult, undefined);
	const finalText = done.message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	assert.equal(finalText, "Implemented and verified.\n");
	assert.doesNotMatch(finalText, /gsd_tool_call/);
});

test("cursor adapter bridges gsd_task_recovery_resume envelopes (#1764)", async () => {
	const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"<gsd_tool_call>{\\"name\\":\\"gsd_task_recovery_resume\\",\\"arguments\\":{\\"recoveryActionId\\":\\"R001\\",\\"repairSummary\\":\\"Fixed\\",\\"evidence\\":{\\"tests\\":[\\"pass\\"]}}}</gsd_tool_call>"}]}}';
	const stream = streamViaCursorAgent(model, context, {
		_cursorAgentRunnerForTest: async () => ({ stdout: `${line}\n`, stderr: "", code: 0, signal: null }),
	});
	const events = [];
	for await (const event of stream) events.push(event);
	const done = events.find((event) => event.type === "done");
	assert.ok(done && done.type === "done");
	const toolCall = done.message.content.find((block) => block.type === "toolCall");
	assert.ok(toolCall && toolCall.type === "toolCall");
	assert.equal(toolCall.name, "gsd_task_recovery_resume");
});

test("cursor lifecycle envelope executes gsd_task_complete through the host agent loop (#1764)", async () => {
	let executedArgs: Record<string, unknown> | undefined;
	const completionTool = {
		name: "gsd_task_complete",
		label: "Complete task",
		description: "Complete the active task",
		parameters: {
			type: "object",
			properties: {
				milestoneId: { type: "string" },
				sliceId: { type: "string" },
				taskId: { type: "string" },
			},
			required: ["milestoneId", "sliceId", "taskId"],
		},
		async execute(_toolCallId: string, args: Record<string, unknown>) {
			executedArgs = args;
			return {
				content: [{ type: "text", text: "Staged task T03; awaiting host verification" }],
				details: {},
				terminate: true,
			};
		},
	};
	const prompt: AgentMessage = { role: "user", content: "Implement T03.", timestamp: Date.now() };
	const stream = agentLoop(
		[prompt],
		{ systemPrompt: "Complete the task.", messages: [], tools: [completionTool as any] },
		{ model, convertToLlm: (messages) => messages as Message[] },
		undefined,
		(_model, llmContext) => streamViaCursorAgent(model, llmContext, {
			_cursorAgentRunnerForTest: async () => ({
				stdout: '{"type":"assistant","message":{"content":[{"type":"text","text":"<gsd_tool_call>{\\"name\\":\\"gsd_task_complete\\",\\"arguments\\":{\\"milestoneId\\":\\"M001\\",\\"sliceId\\":\\"S01\\",\\"taskId\\":\\"T03\\"}}</gsd_tool_call>"}]}}\n',
				stderr: "",
				code: 0,
				signal: null,
			}),
		}),
	);

	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	assert.deepEqual(executedArgs, { milestoneId: "M001", sliceId: "S01", taskId: "T03" });
	assert.ok(events.some((event) => event.type === "tool_execution_end" && event.toolName === "gsd_task_complete"));
});

test("cursor adapter refuses unbridged GSD tool calls (#1764)", async () => {
	const lines = [
		'{"type":"tool_call","id":"tool_1","name":"gsd_exec","input":{"command":"ls"}}',
	];
	const stream = streamViaCursorAgent(model, context, {
		_cursorAgentRunnerForTest: async () => ({ stdout: `${lines.join("\n")}\n`, stderr: "", code: 0, signal: null }),
	});
	const events = [];
	for await (const event of stream) events.push(event);
	const error = events.find((event) => event.type === "error");
	assert.ok(error && error.type === "error");
	assert.match(error.error.errorMessage ?? "", /tool unsupported under cursor-agent: gsd_exec/);
	assert.equal(unsupportedCursorGsdToolError("gsd_exec"), "tool unsupported under cursor-agent: gsd_exec");
});
