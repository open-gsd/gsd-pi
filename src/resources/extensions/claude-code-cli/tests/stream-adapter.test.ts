// gsd-pi - Claude Code stream adapter regression tests
import { describe, mock, test } from "node:test";
import { clearGuidedUnitContext, setGuidedUnitContext } from "../../gsd/guided-unit-context.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
	streamViaClaudeCode,
	makeStreamExhaustedErrorMessage,
	isClaudeCodeAbortErrorMessage,
	resolveClaudeCodeAbortedMessageText,
	getResultErrorMessage,
	makeAbortedMessage,
	mergePendingToolCalls,
	buildFinalAssistantContent,
	handleClaudeCodePartialStreamEvent,
	resolveClaudePermissionMode,
	buildPromptFromContext,
	buildSdkQueryPrompt,
	buildSdkOptions,
	CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS_ENV,
	resolveClaudeCodeCwd,
	createClaudeCodeCanUseToolHandler,
	buildBashPermissionPattern,
	buildBashPermissionPatternOptions,
	bashCommandMatchesSavedRules,
	createClaudeCodeElicitationHandler,
	extractImageBlocksFromContext,
	extractToolResultsFromSdkUserMessage,
	serverToolUseToToolCallLike,
	getClaudeLookupCommand,
	parseAskUserQuestionsElicitation,
	parseTextInputElicitation,
	parseClaudeLookupOutput,
	resolveBundledClaudeCliPath,
	normalizeClaudePathForSdk,
	isClaudeCodeSdkProcessArgv,
	findConcurrentClaudeCodeProcesses,
	buildConcurrentClaudeCodeProcessWarning,
	roundResultToElicitationContent,
	autoInitClaudeCodeWorkflowMcp,
	inferGsdPhaseFromContext,
	resolveGsdPhaseForSdk,
	resolveClaudeCodeToolSurfaceReadinessError,
	resolveClaudeCodeToolSurfaceReadinessRetryDelayMs,
	shouldRetryClaudeCodeToolSurfaceReadiness,
	buildWorkflowMcpReadinessProgressMessage,
	pushWorkflowMcpReadinessProgressEvent,
	resolveWorkflowMcpPreflightServerConfig,
	CLAUDE_CODE_INTERVIEW_FORM_TIMEOUT_MS,
} from "../stream-adapter.ts";
import { CLAUDE_CODE_MODELS } from "../models.ts";
import type { AssistantMessage, Context, Message } from "@gsd/pi-ai";
import type { SDKUserMessage } from "../sdk-types.ts";
import { _setAutoActiveForTest } from "../../gsd/auto.ts";
import { autoSession } from "../../gsd/auto-runtime-state.ts";
import { getInFlightToolCount, hasInteractiveToolInFlight, clearInFlightTools, isInteractiveElicitationInFlight } from "../../gsd/auto-tool-tracking.ts";
import { clearMcpConfigCache } from "../../mcp-client/manager.ts";
import { UNIT_TOOL_CONTRACTS } from "../../gsd/unit-tool-contracts.ts";

// ---------------------------------------------------------------------------
// Env helpers — `GSD_WORKFLOW_MCP_*` save/restore
//
// The naive pattern `process.env.X = prev.X` breaks when `prev.X` is
// undefined: Node coerces the assignment to the literal string
// "undefined", which then pollutes subsequent tests that read the var
// and assume it's absent. Issue #4808 documents the resulting bleed.
//
// `setWorkflowMcpEnv` returns a `restore()` closure that either
// re-assigns the previous string value OR `delete`s the key when the
// original was absent. Call in a try/finally; restore in the finally.
// ---------------------------------------------------------------------------

const WORKFLOW_MCP_ENV_KEYS = [
	"GSD_WORKFLOW_MCP_COMMAND",
	"GSD_WORKFLOW_MCP_NAME",
	"GSD_WORKFLOW_MCP_ARGS",
	"GSD_WORKFLOW_MCP_ENV",
	"GSD_WORKFLOW_MCP_CWD",
	"GSD_WORKFLOW_MCP_STRUCTURED_QUESTIONS",
	"GSD_PROJECT_ROOT",
	"GSD_WORKFLOW_PROJECT_ROOT",
] as const;

type WorkflowMcpEnvKey = (typeof WORKFLOW_MCP_ENV_KEYS)[number];

function setWorkflowMcpEnv(
	values: Partial<Record<WorkflowMcpEnvKey, string>>,
): () => void {
	const prev: Partial<Record<WorkflowMcpEnvKey, string | undefined>> = {};
	for (const key of WORKFLOW_MCP_ENV_KEYS) {
		prev[key] = process.env[key];
		// Clear all managed keys so tests run in a clean env state.
		// Keys present in `values` are set to the desired test value below.
		delete process.env[key];
	}
	for (const [key, value] of Object.entries(values)) {
		process.env[key] = value;
	}
	return function restore() {
		for (const key of WORKFLOW_MCP_ENV_KEYS) {
			const previous = prev[key];
			if (previous === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = previous;
			}
		}
	};
}

// ---------------------------------------------------------------------------
// Shared MCP elicitation fixture — a representative ask_user_questions
// elicitation request. Used both by the external-tool-results interview
// lifecycle tests and by the MCP elicitation bridge tests, so it lives at
// module scope.
// ---------------------------------------------------------------------------

const askUserQuestionsRequest = {
	serverName: "gsd-workflow",
	message: "Please answer the following question(s).",
	mode: "form" as const,
	requestedSchema: {
		type: "object" as const,
		properties: {
			storage_scope: {
				type: "string",
				title: "Storage",
				description: "Does this app need to sync across devices?",
				oneOf: [
					{ const: "Local-only (Recommended)", title: "Local-only (Recommended)" },
					{ const: "Cloud-synced", title: "Cloud-synced" },
					{ const: "None of the above", title: "None of the above" },
				],
			},
			storage_scope__note: {
				type: "string",
				title: "Storage Note",
				description: "Optional note for None of the above.",
			},
			platform: {
				type: "array",
				title: "Platform",
				description: "Where should it run?",
				items: {
					anyOf: [
						{ const: "Web", title: "Web" },
						{ const: "Desktop", title: "Desktop" },
						{ const: "Mobile", title: "Mobile" },
					],
				},
			},
		},
	},
};

function makeSdkSuccessResult(result = "done") {
	return {
		type: "result",
		subtype: "success",
		uuid: "result-1",
		session_id: "session-1",
		duration_ms: 1,
		duration_api_ms: 1,
		is_error: false,
		num_turns: 1,
		result,
		stop_reason: "end_turn",
		total_cost_usd: 0,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
	};
}

// ---------------------------------------------------------------------------
// Existing tests — exhausted stream fallback (#2575)
// ---------------------------------------------------------------------------

describe("stream-adapter — exhausted stream fallback (#2575)", () => {
	test("generator exhaustion becomes an error message instead of clean completion", () => {
		const message = makeStreamExhaustedErrorMessage("claude-sonnet-4-20250514", "partial answer");

		assert.equal(message.stopReason, "error");
		assert.equal(message.errorMessage, "stream_exhausted_without_result");
		assert.deepEqual(message.content, [{ type: "text", text: "partial answer" }]);
	});

	test("generator exhaustion without prior text still exposes a classifiable error", () => {
		const message = makeStreamExhaustedErrorMessage("claude-sonnet-4-20250514", "");

		assert.equal(message.stopReason, "error");
		assert.equal(message.errorMessage, "stream_exhausted_without_result");
		assert.match(String((message.content[0] as any)?.text ?? ""), /Claude Code error: stream_exhausted_without_result/);
	});
});

describe("stream-adapter — result error text (#3776)", () => {
	test("prefers SDK result text when an error arrives with subtype success", () => {
		const message = getResultErrorMessage({
			type: "result",
			subtype: "success",
			uuid: "uuid-1",
			session_id: "session-1",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: true,
			num_turns: 1,
			result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		});

		assert.match(message, /API Error: 529/);
		assert.doesNotMatch(message, /^success$/i);
	});

	test("falls back to a stable classifier when success errors have no text", () => {
		const message = getResultErrorMessage({
			type: "result",
			subtype: "success",
			uuid: "uuid-2",
			session_id: "session-2",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: true,
			num_turns: 1,
			result: "   ",
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		});

		assert.equal(message, "claude_code_request_failed");
	});
});

describe("stream-adapter — Claude Code internal sub-turns (#337)", () => {
	test("repeated SDK message_start events keep one growing partial message", () => {
		let builder: Parameters<typeof handleClaudeCodePartialStreamEvent>[0] = null;
		const contentLengths: number[] = [];

		for (const event of [
			{ type: "message_start", message: { model: "claude-opus-4-8" } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "First internal turn." } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Still same SDK message." } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_start", message: { model: "claude-opus-4-8" } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Second internal turn." } },
			{ type: "content_block_stop", index: 0 },
		]) {
			const result = handleClaudeCodePartialStreamEvent(builder, event as any, "claude-opus-4-8");
			builder = result.builder;
			// builder.message is the local AssistantMessage accumulator (not event.partial)
			if (builder && result.assistantEvent) {
				contentLengths.push(builder.message.content.length);
			}
		}

		assert.ok(builder);
		assert.deepEqual(
			builder.message.content.map((block: any) => block.text),
			["First internal turn.", "Still same SDK message.", "Second internal turn."],
		);
		assert.deepEqual(contentLengths, [1, 1, 1, 2, 2, 2, 3, 3, 3]);
	});
});

// ---------------------------------------------------------------------------
// Bug #2859 — stateless provider regression tests
// ---------------------------------------------------------------------------

describe("stream-adapter — full context prompt (#2859)", () => {
	test("buildPromptFromContext includes all user and assistant messages, not just the last user message", () => {
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "What is 2+2?" } as Message,
				{
					role: "assistant",
					content: [{ type: "text", text: "4" }],
					api: "anthropic-messages",
					provider: "claude-code",
					model: "claude-sonnet-4-20250514",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				} as Message,
				{ role: "user", content: "Now multiply that by 3" } as Message,
			],
		};

		const prompt = buildPromptFromContext(context);

		// Must contain content from BOTH user messages, not just the last
		assert.ok(prompt.includes("2+2"), "prompt must include first user message");
		assert.ok(prompt.includes("multiply"), "prompt must include second user message");
		// Must contain assistant response for continuity
		assert.ok(prompt.includes("4"), "prompt must include assistant reply for context");
	});

	test("buildPromptFromContext includes system prompt when present", () => {
		const context: Context = {
			systemPrompt: "You are a coding assistant.",
			messages: [
				{ role: "user", content: "Write a function" } as Message,
			],
		};

		const prompt = buildPromptFromContext(context);
		assert.ok(prompt.includes("coding assistant"), "prompt must include system prompt");
	});

	test("buildPromptFromContext handles array content parts in user messages", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "First part" },
						{ type: "text", text: "Second part" },
					],
				} as Message,
				{ role: "user", content: "Follow-up" } as Message,
			],
		};

		const prompt = buildPromptFromContext(context);
		assert.ok(prompt.includes("First part"), "prompt must include array content parts");
		assert.ok(prompt.includes("Second part"), "prompt must include all text parts");
		assert.ok(prompt.includes("Follow-up"), "prompt must include follow-up message");
	});

	test("buildPromptFromContext returns empty string for empty messages", () => {
		const context: Context = { messages: [] };
		const prompt = buildPromptFromContext(context);
		assert.equal(prompt, "");
	});
});

describe("stream-adapter — image prompt forwarding (#4183)", () => {
	test("extractImageBlocksFromContext maps user image parts to Anthropic base64 image blocks", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{
							type: "image",
							data: "data:image/png;base64,abc123",
							mimeType: "image/png",
						},
					],
				} as Message,
			],
		};

		const imageBlocks = extractImageBlocksFromContext(context);
		assert.deepEqual(imageBlocks, [
			{
				type: "image",
				source: {
					type: "base64",
					media_type: "image/png",
					data: "abc123",
				},
			},
		]);
	});

	test("extractImageBlocksFromContext deduplicates byte-identical image parts", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							data: "data:image/png;base64,abc123",
							mimeType: "image/png",
						},
						{
							type: "image",
							data: "abc123",
							mimeType: "image/png",
						},
						{
							type: "image",
							data: "def456",
							mimeType: "image/png",
						},
					],
				} as Message,
			],
		};

		const imageBlocks = extractImageBlocksFromContext(context);
		assert.deepEqual(imageBlocks, [
			{
				type: "image",
				source: {
					type: "base64",
					media_type: "image/png",
					data: "abc123",
				},
			},
			{
				type: "image",
				source: {
					type: "base64",
					media_type: "image/png",
					data: "def456",
				},
			},
		]);
	});

	test("buildSdkQueryPrompt returns plain string when no images exist in context", () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello" } as Message],
		};
		const textPrompt = buildPromptFromContext(context);

		const prompt = buildSdkQueryPrompt(context, textPrompt);
		assert.equal(typeof prompt, "string");
		assert.equal(prompt, textPrompt);
	});

	test("buildSdkQueryPrompt wraps images and prompt text in an SDK user message iterable", async () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", data: "ZmFrZQ==", mimeType: "image/jpeg" },
						{ type: "text", text: "What is in this image?" },
					],
				} as Message,
			],
		};
		const textPrompt = buildPromptFromContext(context);

		const prompt = buildSdkQueryPrompt(context, textPrompt);
		assert.notEqual(typeof prompt, "string");
		assert.ok(prompt && typeof (prompt as any)[Symbol.asyncIterator] === "function");

		const messages: any[] = [];
		for await (const item of prompt as AsyncIterable<any>) {
			messages.push(item);
		}
		assert.equal(messages.length, 1);
		assert.deepEqual(messages[0], {
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/jpeg",
							data: "ZmFrZQ==",
						},
					},
					{ type: "text", text: textPrompt },
				],
			},
			parent_tool_use_id: null,
		});
	});

	test("buildSdkQueryPrompt image iterable can be consumed for each SDK retry", async () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", data: "ZmFrZQ==", mimeType: "image/jpeg" },
						{ type: "text", text: "Retry with this image." },
					],
				} as Message,
			],
		};
		const textPrompt = buildPromptFromContext(context);
		const prompt = buildSdkQueryPrompt(context, textPrompt);

		const firstAttempt = [];
		for await (const item of prompt as AsyncIterable<any>) {
			firstAttempt.push(item);
		}

		const retryAttempt = [];
		for await (const item of prompt as AsyncIterable<any>) {
			retryAttempt.push(item);
		}

		assert.equal(firstAttempt.length, 1);
		assert.deepEqual(retryAttempt, firstAttempt);
	});

	test("SDK readiness retries do not leak partial content into the next attempt", async () => {
		let queryCalls = 0;
		const cwd = mkdtempSync(join(tmpdir(), "claude-sdk-retry-state-"));
		const context: Context = {
			systemPrompt: "UNIT: Run UAT",
			messages: [{ role: "user", content: "Run UAT." } as Message],
		};
		// The test requires a resolved GSD phase so the readiness gate fires.
		// Auto-mode with a currentUnit provides the authoritative phase signal.
		_setAutoActiveForTest(true);
		autoSession.currentUnit = { type: "run-uat", id: "M001/S001", startedAt: 0, workspaceRoot: cwd } as never;
		try {
			const stream = streamViaClaudeCode(
				{ id: "claude-sonnet-4-6" } as any,
				context,
				{
					cwd,
					_skipWorkflowMcpPreflightForTest: true,
					async *_sdkQueryForTest() {
						queryCalls += 1;
						if (queryCalls === 1) {
							yield {
								type: "stream_event",
								event: { type: "message_start", message: { model: "claude-sonnet-4-6" } },
								parent_tool_use_id: null,
								uuid: "partial-1",
								session_id: "session-1",
							};
							yield {
								type: "stream_event",
								event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
								parent_tool_use_id: null,
								uuid: "partial-1",
								session_id: "session-1",
							};
							yield {
								type: "stream_event",
								event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "stale retry text" } },
								parent_tool_use_id: null,
								uuid: "partial-1",
								session_id: "session-1",
							};
							yield {
								type: "system",
								subtype: "init",
								tools: ["Read"],
								mcp_servers: [{ name: "gsd-workflow", status: "connected" }],
							};
							return;
						}

						yield {
							type: "result",
							subtype: "success",
							uuid: "result-2",
							session_id: "session-2",
							duration_ms: 1,
							duration_api_ms: 1,
							is_error: false,
							num_turns: 1,
							result: "fresh retry result",
							stop_reason: "end_turn",
							total_cost_usd: 0,
							usage: {
								input_tokens: 0,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						};
					},
				} as any,
			);

			const message = await stream.result();

			assert.equal(queryCalls, 2);
			assert.deepEqual(message.content, [{ type: "text", text: "fresh retry result" }]);
		} finally {
			autoSession.currentUnit = null;
			_setAutoActiveForTest(false);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Bug #4102 — transcript fabrication regression tests
// ---------------------------------------------------------------------------

describe("stream-adapter — no transcript fabrication (#4102)", () => {
	test("buildPromptFromContext never emits forbidden [User]/[Assistant] bracket headers", () => {
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "First" } as Message,
				{
					role: "assistant",
					content: [{ type: "text", text: "Second" }],
					api: "anthropic-messages",
					provider: "claude-code",
					model: "claude-sonnet-4-20250514",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				} as Message,
				{ role: "user", content: "Third" } as Message,
			],
		};

		const prompt = buildPromptFromContext(context);

		assert.ok(!prompt.includes("[User]"), "prompt must not include literal [User] bracket header");
		assert.ok(!prompt.includes("[Assistant]"), "prompt must not include literal [Assistant] bracket header");
		assert.ok(!prompt.includes("[System]"), "prompt must not include literal [System] bracket header");
	});

	test("buildPromptFromContext wraps history in XML-tag structure", () => {
		const context: Context = {
			systemPrompt: "You are helpful.",
			messages: [
				{ role: "user", content: "Hello" } as Message,
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi there" }],
					api: "anthropic-messages",
					provider: "claude-code",
					model: "claude-sonnet-4-20250514",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				} as Message,
			],
		};

		const prompt = buildPromptFromContext(context);

		assert.ok(prompt.includes("<conversation_history>"), "prompt must wrap history in <conversation_history>");
		assert.ok(prompt.includes("</conversation_history>"), "prompt must close <conversation_history>");
		assert.ok(prompt.includes("<user_message>\nHello\n</user_message>"), "user turn must use <user_message> tags");
		assert.ok(prompt.includes("<assistant_message>\nHi there\n</assistant_message>"), "assistant turn must use <assistant_message> tags");
		assert.ok(prompt.includes("<prior_system_context>\nYou are helpful.\n</prior_system_context>"), "system prompt must use <prior_system_context> tags");
	});

	test("buildPromptFromContext includes a do-not-echo-tags directive as primary instruction", () => {
		const context: Context = {
			messages: [{ role: "user", content: "Anything" } as Message],
		};

		const prompt = buildPromptFromContext(context);

		assert.ok(
			prompt.startsWith("Respond only to the final user message"),
			"primary directive must lead the prompt",
		);
		assert.ok(prompt.includes("Do not emit <user_message>"), "directive must forbid emitting user_message tag");
		assert.ok(prompt.includes("<assistant_message>"), "directive must mention assistant_message tag");
	});

	test("buildPromptFromContext omits <conversation_history> when there are no messages but a system prompt", () => {
		const context: Context = {
			systemPrompt: "Seed",
			messages: [],
		};

		const prompt = buildPromptFromContext(context);

		assert.ok(prompt.includes("<prior_system_context>"), "system prompt must still render");
		assert.ok(!prompt.includes("<conversation_history>"), "no history wrapper when messages are empty");
	});

	test("buildPromptFromContext still returns empty string when context is entirely empty", () => {
		const context: Context = { messages: [] };
		const prompt = buildPromptFromContext(context);
		assert.equal(prompt, "", "empty context must not emit a bare directive");
	});

	test("buildPromptFromContext uses the active workflow MCP server name", () => {
		const context: Context = {
			messages: [{ role: "user", content: "Check status" } as Message],
		};

		const prompt = buildPromptFromContext(context, { workflowMcpServerName: "custom-workflow" });

		assert.ok(prompt.includes("mcp__custom-workflow__<tool_name>"));
		assert.ok(prompt.includes("mcp__custom-workflow__gsd_exec"));
		assert.ok(!prompt.includes("mcp__gsd-workflow__<tool_name>"));
	});

	test("buildPromptFromContext remaps structured user input to the workflow MCP question tool", () => {
		const context: Context = {
			systemPrompt: "Use ask_user_questions for structured user input.",
			messages: [{ role: "user", content: "Ask the user what comes next" } as Message],
		};

		const prompt = buildPromptFromContext(context, { workflowMcpServerName: "gsd-workflow" });

		assert.ok(prompt.includes("mcp__gsd-workflow__ask_user_questions"));
		assert.ok(prompt.includes("Do not call bare ask_user_questions"));
		assert.ok(prompt.includes("Do not call native AskUserQuestion"));
	});

	test("buildPromptFromContext allows ToolSearch only for deferred workflow MCP hydration", () => {
		const context: Context = {
			messages: [{ role: "user", content: "Plan the slice" } as Message],
		};

		const prompt = buildPromptFromContext(context, { workflowMcpServerName: "gsd-workflow" });

		assert.ok(prompt.includes("ToolSearch is available only for Claude Code deferred workflow MCP hydration"));
		assert.ok(prompt.includes("use ToolSearch with select:mcp__gsd-workflow__<tool_name> or the base tool name"));
		assert.ok(prompt.includes("then call the returned MCP tool directly"));
		assert.ok(prompt.includes("Do not use ToolSearch for browser_* tools or general discovery"));
		assert.ok(!prompt.includes("ToolSearch is NOT available"));
	});

	test("buildPromptFromContext does not advertise workflow MCP tools when unavailable", () => {
		const context: Context = {
			messages: [{ role: "user", content: "Check status" } as Message],
		};

		const prompt = buildPromptFromContext(context);

		assert.ok(prompt.includes("GSD workflow MCP tools are unavailable"));
		assert.ok(!prompt.includes("mcp__gsd-workflow__<tool_name>"));
		assert.ok(!prompt.includes("mcp__gsd-workflow__gsd_exec"));
	});

	test("buildPromptFromContext remaps pi-native browser tools for Claude Code", () => {
		const context: Context = {
			systemPrompt: "Browser verification: use browser_find and browser_navigate.",
			messages: [{ role: "user", content: "Verify the app" } as Message],
		};

		const prompt = buildPromptFromContext(context, { workflowMcpServerName: "gsd-workflow" });

		assert.ok(prompt.includes("browser_navigate"), "remap should name stale browser tool examples");
		assert.ok(prompt.includes("not Claude Code tools"), "remap should explain browser_* is unavailable in Claude Code");
		assert.ok(prompt.includes("Never use ToolSearch to select browser_* tools"));
		assert.ok(prompt.includes("Bash to run a local Playwright/Node check"));
	});

	test("buildPromptFromContext advertises gsd-browser MCP when available", () => {
		const context: Context = {
			systemPrompt: "Browser verification: use browser_find and browser_navigate.",
			messages: [{ role: "user", content: "Verify the app" } as Message],
		};

		const prompt = buildPromptFromContext(context, {
			workflowMcpServerName: "gsd-workflow",
			browserMcpServerName: "gsd-browser",
		});

		assert.ok(prompt.includes("Browser verification uses gsd-browser MCP by default"));
		assert.ok(prompt.includes("mcp__gsd-browser__browser_snapshot_refs"));
		assert.ok(prompt.includes("mcp__gsd-browser__browser_assert"));
		assert.ok(!prompt.includes("Bash to run a local Playwright/Node check"));
	});
});

describe("stream-adapter — Claude Code external tool results", () => {
	test("emits one synthetic completion per tool when SDK sends consecutive user result messages (#1153)", async () => {
		// Capture synthetic completions through onExternalToolResult, which the
		// adapter invokes exactly once per tool at emission time. Filtering the
		// collected toolcall_end events afterwards is unreliable here: the streaming
		// toolcall_end (content_block_stop) and the synthetic completion reference
		// the SAME tool-call block, and attachExternalResultsToToolBlocks mutates
		// that block later, so a post-hoc `event.toolCall.externalResult` check also
		// matches the earlier streaming ends and double-counts each tool.
		const syntheticCompletions: Array<{ id: string; text: string | undefined }> = [];
		const stream = streamViaClaudeCode(
			{ id: "claude-sonnet-4-6" } as any,
			{ messages: [{ role: "user", content: "Read and grep." } as Message] },
			{
				_skipWorkflowMcpPreflightForTest: true,
				onExternalToolResult(event: {
					toolCall: { id: string };
					result: { content?: Array<{ text?: string }> };
				}) {
					syntheticCompletions.push({
						id: event.toolCall.id,
						text: event.result.content?.[0]?.text,
					});
				},
				async *_sdkQueryForTest() {
					yield {
						type: "stream_event",
						event: { type: "message_start", message: { model: "claude-sonnet-4-6" } },
						parent_tool_use_id: null,
						uuid: "partial-1",
						session_id: "session-1",
					};
					yield {
						type: "stream_event",
						event: {
							type: "content_block_start",
							index: 0,
							content_block: { type: "tool_use", id: "tool-read-1", name: "Read", input: {} },
						},
						parent_tool_use_id: null,
						uuid: "partial-1",
						session_id: "session-1",
					};
					yield {
						type: "stream_event",
						event: {
							type: "content_block_delta",
							index: 0,
							delta: { type: "input_json_delta", partial_json: "{\"file_path\":\"a.txt\"}" },
						},
						parent_tool_use_id: null,
						uuid: "partial-1",
						session_id: "session-1",
					};
					yield {
						type: "stream_event",
						event: { type: "content_block_stop", index: 0 },
						parent_tool_use_id: null,
						uuid: "partial-1",
						session_id: "session-1",
					};
					yield {
						type: "stream_event",
						event: {
							type: "content_block_start",
							index: 1,
							content_block: { type: "tool_use", id: "tool-grep-1", name: "Grep", input: {} },
						},
						parent_tool_use_id: null,
						uuid: "partial-1",
						session_id: "session-1",
					};
					yield {
						type: "stream_event",
						event: {
							type: "content_block_delta",
							index: 1,
							delta: { type: "input_json_delta", partial_json: "{\"pattern\":\"needle\"}" },
						},
						parent_tool_use_id: null,
						uuid: "partial-1",
						session_id: "session-1",
					};
					yield {
						type: "stream_event",
						event: { type: "content_block_stop", index: 1 },
						parent_tool_use_id: null,
						uuid: "partial-1",
						session_id: "session-1",
					};
					yield {
						type: "user",
						uuid: "user-result-1",
						session_id: "session-1",
						parent_tool_use_id: "tool-read-1",
						message: {
							role: "user",
							content: [{
								type: "tool_result",
								tool_use_id: "tool-read-1",
								content: "read result",
								is_error: false,
							}],
						},
					};
					yield {
						type: "user",
						uuid: "user-result-2",
						session_id: "session-1",
						parent_tool_use_id: "tool-grep-1",
						message: {
							role: "user",
							content: [{
								type: "tool_result",
								tool_use_id: "tool-grep-1",
								content: "grep result",
								is_error: false,
							}],
						},
					};
					yield {
						type: "result",
						subtype: "success",
						uuid: "result-1",
						session_id: "session-1",
						duration_ms: 1,
						duration_api_ms: 1,
						is_error: false,
						num_turns: 1,
						result: "done",
						stop_reason: "end_turn",
						total_cost_usd: 0,
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					};
				},
			} as any,
		);

		// Drain the stream so the adapter processes every SDK message and fires
		// onExternalToolResult for each synthetic completion.
		const events: any[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		assert.deepEqual(
			syntheticCompletions.map((completion) => completion.id),
			["tool-read-1", "tool-grep-1"],
		);
		assert.deepEqual(
			syntheticCompletions.map((completion) => completion.text),
			["read result", "grep result"],
		);
	});

	test("closes an in-flight interview when ask_user_questions reports timed_out first", async (t) => {
		const notifications: Array<{ message: string; type?: string }> = [];
		let elicitationPromise: Promise<unknown> | undefined;
		let elicitationSignalController: AbortController | undefined;
		let customOpened = false;
		const ui = {
			custom: async (factory: any) => new Promise((resolve) => {
				customOpened = true;
				factory({ requestRender() {} } as any, {} as any, {} as any, resolve);
			}),
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
		};
		t.after(() => {
			elicitationSignalController?.abort();
		});

		const stream = streamViaClaudeCode(
			{ id: "claude-sonnet-4-6" } as any,
			{ messages: [{ role: "user", content: "Ask me." } as Message] },
			{
				extensionUIContext: ui as any,
				_skipWorkflowMcpPreflightForTest: true,
				async *_sdkQueryForTest(args: {
					prompt: string | AsyncIterable<unknown>;
					options?: Record<string, unknown>;
				}) {
					const onElicitation = args.options?.onElicitation as
						| ((request: unknown, options: { signal: AbortSignal }) => Promise<unknown>)
						| undefined;
					assert.equal(typeof onElicitation, "function");
					elicitationSignalController = new AbortController();
					elicitationPromise = onElicitation!(askUserQuestionsRequest, {
						signal: elicitationSignalController.signal,
					});
					assert.equal(customOpened, true, "interview overlay should be open before the tool result arrives");

					// The adapter only assembles tool-call blocks after a
					// message_start has created the partial-message builder. Real
					// SDK streams always emit it before a tool_use content block;
					// without it the timed_out result is never matched to the
					// in-flight ask_user_questions block, so the interview would
					// never be closed.
					yield {
						type: "stream_event",
						event: { type: "message_start", message: { model: "claude-sonnet-4-6" } },
						parent_tool_use_id: null,
						uuid: "partial-1",
						session_id: "session-1",
					};
					yield {
						type: "stream_event",
						event: {
							type: "content_block_start",
							index: 0,
							content_block: {
								type: "tool_use",
								id: "ask-1",
								name: "mcp__gsd-workflow__ask_user_questions",
								input: {},
							},
						},
						parent_tool_use_id: null,
						uuid: "partial-1",
						session_id: "session-1",
					};
					yield {
						type: "user",
						uuid: "user-result-1",
						session_id: "session-1",
						parent_tool_use_id: "ask-1",
						message: {
							role: "user",
							content: [{
								type: "mcp_tool_result",
								tool_use_id: "ask-1",
								content: [{ type: "text", text: "timed out" }],
								structuredContent: { timed_out: true },
								is_error: false,
							}],
						},
					};
					yield {
						type: "result",
						subtype: "success",
						uuid: "result-1",
						session_id: "session-1",
						duration_ms: 1,
						duration_api_ms: 1,
						is_error: false,
						num_turns: 1,
						result: "done",
						stop_reason: "end_turn",
						total_cost_usd: 0,
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					};
				},
			} as any,
		);

		await stream.result();
		assert.ok(elicitationPromise);
		let guard: ReturnType<typeof setTimeout> | undefined;
		const elicitationResult = await Promise.race([
			elicitationPromise,
			new Promise<never>((_, reject) => {
				guard = setTimeout(
					() => reject(new Error("timed out waiting for in-flight interview to close")),
					250,
				);
			}),
		]).finally(() => {
			if (guard) clearTimeout(guard);
		});

		assert.deepEqual(elicitationResult, { action: "decline" });
		assert.deepEqual(notifications, [{
			message: "Question expired before you answered - the form was closed and no answers were sent.",
			type: "warning",
		}]);
	});

	test("serverToolUseToToolCallLike preserves object input for extension tool_result routing", () => {
		const toolCall = serverToolUseToToolCallLike({
			id: "srv-1",
			name: "workflow_gate",
			input: { gateId: "Q3", verdict: "pass" },
		});

		assert.deepEqual(toolCall, {
			type: "toolCall",
			id: "srv-1",
			name: "workflow_gate",
			arguments: { gateId: "Q3", verdict: "pass" },
		});
	});

	test("serverToolUseToToolCallLike wraps non-object input under input key", () => {
		const toolCall = serverToolUseToToolCallLike({
			id: "srv-2",
			name: "workflow_gate",
			input: "raw-value",
		});

		assert.deepEqual(toolCall, {
			type: "toolCall",
			id: "srv-2",
			name: "workflow_gate",
			arguments: { input: "raw-value" },
		});
	});

	test("extractToolResultsFromSdkUserMessage maps tool_result content to tool payloads", () => {
		const message: SDKUserMessage = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tool-bash-1",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-bash-1",
						content: "line 1\nline 2",
						is_error: false,
					},
				],
			},
		};

		const results = extractToolResultsFromSdkUserMessage(message);
		assert.deepEqual(results, [
			{
				toolUseId: "tool-bash-1",
				result: {
					content: [{ type: "text", text: "line 1\nline 2" }],
					// extractStructuredDetailsFromBlock returns undefined when no
					// structured payload exists, restoring the pre-#4477 nullable
					// contract (#4477 review feedback).
					details: undefined,
					isError: false,
				},
			},
		]);
	});

	test("extractToolResultsFromSdkUserMessage reads structuredContent as a sibling field (#4472)", () => {
		const message: SDKUserMessage = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tool-mcp-1",
			message: {
				role: "user",
				content: [
					{
						type: "mcp_tool_result",
						tool_use_id: "tool-mcp-1",
						content: [{ type: "text", text: "Gate Q3 result saved: verdict=pass" }],
						is_error: false,
						structuredContent: { gateId: "Q3", verdict: "pass" },
					} as unknown as Record<string, unknown>,
				],
			},
		};

		const results = extractToolResultsFromSdkUserMessage(message);
		assert.deepEqual(results[0].result.details, { gateId: "Q3", verdict: "pass" });
	});

	test("extractToolResultsFromSdkUserMessage reads structuredContent from a content sub-block (#4472)", () => {
		const message: SDKUserMessage = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tool-mcp-2",
			message: {
				role: "user",
				content: [
					{
						type: "mcp_tool_result",
						tool_use_id: "tool-mcp-2",
						content: [
							{ type: "text", text: "Gate Q4 result saved: verdict=flag" },
							{ type: "structuredContent", structuredContent: { gateId: "Q4", verdict: "flag" } },
						],
						is_error: false,
					} as unknown as Record<string, unknown>,
				],
			},
		};

		const results = extractToolResultsFromSdkUserMessage(message);
		assert.deepEqual(results[0].result.details, { gateId: "Q4", verdict: "flag" });
	});

	test("#4477 extractToolResultsFromSdkUserMessage does NOT leak structuredContent pseudo-blocks into visible content", () => {
		// Regression: when a content sub-block carries `type: "structuredContent"`,
		// it carries the structured payload (extracted separately into `details`)
		// and must NOT appear in the visible `content` array — otherwise the
		// renderer stringifies the JSON pseudo-block and shows it next to the
		// actual tool output. See PR #4477 review (post-fix-round).
		const message: SDKUserMessage = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tool-mcp-strip",
			message: {
				role: "user",
				content: [
					{
						type: "mcp_tool_result",
						tool_use_id: "tool-mcp-strip",
						content: [
							{ type: "text", text: "Gate Q5 result saved: verdict=pass" },
							{ type: "structuredContent", structuredContent: { gateId: "Q5", verdict: "pass" } },
							{ type: "text", text: "second visible line" },
							// snake_case variant — also a pseudo-block; also must be stripped
							{ type: "structured_content", structured_content: { extra: "data" } },
						],
						is_error: false,
					} as unknown as Record<string, unknown>,
				],
			},
		};

		const results = extractToolResultsFromSdkUserMessage(message);
		assert.equal(results.length, 1, "should extract one result");
		const result = results[0].result;

		// The structured payload IS extracted to `details`.
		assert.deepEqual(result.details, { gateId: "Q5", verdict: "pass" });

		// The visible content has the two text blocks but NEITHER pseudo-block.
		const visibleTexts = result.content.map((c: any) => c.text);
		assert.deepEqual(
			visibleTexts,
			["Gate Q5 result saved: verdict=pass", "second visible line"],
			"visible content must include only the two text blocks; both structuredContent variants must be stripped",
		);

		// Belt-and-suspenders: assert no rendered text shows the JSON serialization
		// of a pseudo-block. We don't check for bare keys like "gateId" or "verdict"
		// because those are legitimate words in the gate-result message text. The
		// regression signature would be a JSON-shaped substring that could only
		// appear via stringification.
		const allText = visibleTexts.join("\n");
		assert.ok(
			!allText.includes('"structuredContent"'),
			"rendered content must not include the pseudo-block type marker as JSON text",
		);
		assert.ok(
			!allText.includes('"structured_content"'),
			"rendered content must not include the snake_case pseudo-block type marker as JSON text",
		);
	});

	test("extractToolResultsFromSdkUserMessage accepts snake_case structured_content defensively (#4472)", () => {
		const message: SDKUserMessage = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tool-mcp-3",
			message: {
				role: "user",
				content: [
					{
						type: "mcp_tool_result",
						tool_use_id: "tool-mcp-3",
						content: [{ type: "text", text: "ok" }],
						structured_content: { operation: "save_gate_result" },
					} as unknown as Record<string, unknown>,
				],
			},
		};

		const results = extractToolResultsFromSdkUserMessage(message);
		assert.deepEqual(results[0].result.details, { operation: "save_gate_result" });
	});

	test("extractToolResultsFromSdkUserMessage falls back to tool_use_result", () => {
		const message: SDKUserMessage = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tool-read-1",
			message: { role: "user", content: [] },
			tool_use_result: {
				tool_use_id: "tool-read-1",
				content: "file contents",
				is_error: true,
			},
		};

		const results = extractToolResultsFromSdkUserMessage(message);
		assert.deepEqual(results, [
			{
				toolUseId: "tool-read-1",
				result: {
					content: [{ type: "text", text: "file contents" }],
					// undefined (not {}) per the restored nullable contract — see
					// the analogous assertion in the tool_result test above.
					details: undefined,
					isError: true,
				},
			},
		]);
	});

	test("buildFinalAssistantContent preserves intermediate tool calls with attached external results", () => {
		const finalContent = buildFinalAssistantContent({
			intermediateToolBlocks: [
				{
					type: "toolCall",
					id: "tool-bash-1",
					name: "bash",
					arguments: { command: "echo hi" },
				} as any,
			],
			pendingContent: [{ type: "text", text: "All done." }],
			toolResultsById: new Map([
				[
					"tool-bash-1",
					{
						content: [{ type: "text", text: "hi\n" }],
						details: { source: "claude-code" },
						isError: false,
					},
				],
			]),
		});

		assert.equal(finalContent[0]?.type, "toolCall");
		assert.deepEqual((finalContent[0] as any).externalResult, {
			content: [{ type: "text", text: "hi\n" }],
			details: { source: "claude-code" },
			isError: false,
		});
		assert.deepEqual(finalContent[1], { type: "text", text: "All done." });
	});

	test("buildFinalAssistantContent suppresses duplicate empty MCP tool-unavailable failures after same-turn success", () => {
		const finalContent = buildFinalAssistantContent({
			intermediateToolBlocks: [
				{
					type: "toolCall",
					id: "tool-empty-uat",
					name: "gsd_uat_exec",
					arguments: {},
					mcpServer: "gsd-workflow",
				} as any,
				{
					type: "toolCall",
					id: "tool-real-uat",
					name: "gsd_uat_exec",
					arguments: {
						milestoneId: "M004",
						sliceId: "S01",
						checkId: "S01-UAT-01-smoke",
						intent: "uat-runtime-check",
						script: "npx playwright test e2e/priority.spec.js --reporter=line",
					},
					mcpServer: "gsd-workflow",
				} as any,
			],
			pendingContent: [{ type: "text", text: "UAT S01 complete." }],
			toolResultsById: new Map([
				[
					"tool-empty-uat",
					{
						content: [{
							type: "text",
							text: "<tool_use_error>Error: No such tool available: mcp__gsd-workflow__gsd_uat_exec</tool_use_error>",
						}],
						isError: true,
					},
				],
				[
					"tool-real-uat",
					{
						content: [{ type: "text", text: "{\"operation\":\"gsd_uat_exec\",\"exit_code\":0}" }],
						isError: false,
					},
				],
			]),
		});

		assert.equal(finalContent.length, 2);
		assert.equal((finalContent[0] as any).id, "tool-real-uat");
		assert.deepEqual((finalContent[0] as any).externalResult, {
			content: [{ type: "text", text: "{\"operation\":\"gsd_uat_exec\",\"exit_code\":0}" }],
			isError: false,
		});
		assert.deepEqual(finalContent[1], { type: "text", text: "UAT S01 complete." });
	});

	test("buildFinalAssistantContent keeps lone MCP tool-unavailable failures", () => {
		const finalContent = buildFinalAssistantContent({
			intermediateToolBlocks: [
				{
					type: "toolCall",
					id: "tool-empty-uat",
					name: "gsd_uat_exec",
					arguments: {},
					mcpServer: "gsd-workflow",
				} as any,
			],
			toolResultsById: new Map([
				[
					"tool-empty-uat",
					{
						content: [{
							type: "text",
							text: "<tool_use_error>Error: No such tool available: mcp__gsd-workflow__gsd_uat_exec</tool_use_error>",
						}],
						isError: true,
					},
				],
			]),
		});

		assert.equal(finalContent.length, 1);
		assert.equal((finalContent[0] as any).id, "tool-empty-uat");
		assert.equal((finalContent[0] as any).externalResult.isError, true);
	});

	test("buildFinalAssistantContent keeps final-turn tool calls when result arrives without a synthetic user boundary", () => {
		const finalContent = buildFinalAssistantContent({
			intermediateToolBlocks: [],
			pendingContent: [
				{
					type: "toolCall",
					id: "tool-read-1",
					name: "read",
					arguments: { path: "README.md" },
				} as any,
				{ type: "text", text: "Read complete." },
			],
			toolResultsById: new Map([
				[
					"tool-read-1",
					{
						content: [{ type: "text", text: "file contents" }],
						details: { path: "README.md" },
						isError: false,
					},
				],
			]),
		});

		assert.equal(finalContent[0]?.type, "toolCall");
		assert.deepEqual((finalContent[0] as any).externalResult, {
			content: [{ type: "text", text: "file contents" }],
			details: { path: "README.md" },
			isError: false,
		});
		assert.deepEqual(finalContent[1], { type: "text", text: "Read complete." });
	});

	test("buildFinalAssistantContent keeps every prose segment across successive elicitation boundaries (#1284)", () => {
		// A multi-question /gsd discuss turn: [prose A][Q1][prose B][Q2][prose C].
		// Prose A and B are committed at synthetic-user boundaries (intermediate),
		// prose C is still in the builder (pending) when `result` arrives.
		const finalContent = buildFinalAssistantContent({
			intermediateToolBlocks: [
				{ type: "toolCall", id: "q1", name: "ask_user_questions", arguments: {} } as any,
				{ type: "toolCall", id: "q2", name: "ask_user_questions", arguments: {} } as any,
			],
			intermediateTextBlocks: [
				{ type: "text", text: "prose A" },
				{ type: "text", text: "prose B" },
			],
			pendingContent: [{ type: "text", text: "prose C" }],
			toolResultsById: new Map(),
		});

		const textBlocks = finalContent.filter((b) => b.type === "text").map((b) => (b as any).text);
		assert.deepEqual(textBlocks, ["prose A", "prose B", "prose C"]);
	});

	test("buildFinalAssistantContent does not duplicate the last prose when the turn ends on an elicitation (#1284)", () => {
		// [prose A][Q1][prose B][Q2] — builder was reset at the final boundary, so
		// pendingContent is empty and lastTextContent still holds "prose B".
		const finalContent = buildFinalAssistantContent({
			intermediateToolBlocks: [
				{ type: "toolCall", id: "q1", name: "ask_user_questions", arguments: {} } as any,
				{ type: "toolCall", id: "q2", name: "ask_user_questions", arguments: {} } as any,
			],
			intermediateTextBlocks: [
				{ type: "text", text: "prose A" },
				{ type: "text", text: "prose B" },
			],
			toolResultsById: new Map(),
			lastTextContent: "prose B",
		});

		const textBlocks = finalContent.filter((b) => b.type === "text").map((b) => (b as any).text);
		assert.deepEqual(textBlocks, ["prose A", "prose B"]);
	});

	test("buildFinalAssistantContent emits scalar fallback prose/thinking not captured in the accumulator", () => {
		// A non-streaming `assistant` SDK message sets lastText/lastThinkingContent
		// only (never pushed to intermediateTextBlocks). With pendingContent empty
		// and intermediate blocks present, the fallback must still be emitted.
		const finalContent = buildFinalAssistantContent({
			intermediateToolBlocks: [
				{ type: "toolCall", id: "q1", name: "ask_user_questions", arguments: {} } as any,
			],
			intermediateTextBlocks: [{ type: "text", text: "prose A" }],
			toolResultsById: new Map(),
			lastThinkingContent: "final thinking",
			lastTextContent: "final prose",
		});

		const textBlocks = finalContent.filter((b) => b.type === "text").map((b) => (b as any).text);
		const thinkingBlocks = finalContent.filter((b) => b.type === "thinking").map((b) => (b as any).thinking);
		assert.deepEqual(textBlocks, ["prose A", "final prose"]);
		assert.deepEqual(thinkingBlocks, ["final thinking"]);
	});
});

describe("claude-code-cli — Claude Fable 5 Opus-tier support", () => {
	test("Fable 5 is exposed in the Claude Code model picker list", () => {
		const fable = CLAUDE_CODE_MODELS.find((m) => m.id === "claude-fable-5");
		assert.ok(fable, "claude-fable-5 must appear in CLAUDE_CODE_MODELS");
		assert.equal(fable!.reasoning, true);
		assert.equal(fable!.contextWindow, 1_000_000);
		assert.equal(fable!.maxTokens, 128_000);
	});

	test("Fable 5 gets Opus-tier gates: xhigh effort, adaptive thinking, 1M-context beta", () => {
		const options = buildSdkOptions("claude-fable-5", "test prompt", undefined, { reasoning: "xhigh" });
		assert.equal(options.effort, "xhigh", "xhigh must pass through natively for Fable 5");
		assert.deepEqual(options.thinking, { type: "adaptive" }, "Fable 5 must use adaptive thinking");
		assert.ok(
			Array.isArray(options.betas) && (options.betas as string[]).includes("context-1m-2025-08-07"),
			"Fable 5 must enable the 1M-context beta",
		);
	});

	test("non-Opus models do not receive Fable 5's Opus-tier gates", () => {
		// Failure/contrast path: Haiku supports adaptive thinking but is not xhigh/1M-tier.
		const options = buildSdkOptions("claude-haiku-4-5", "test prompt", undefined, { reasoning: "xhigh" });
		assert.equal(options.effort, "high", "xhigh must clamp to high for non-Opus-tier models");
		assert.deepEqual(options.betas, [], "Haiku must not enable the 1M-context beta");
	});
});

describe("stream-adapter — print bg wait ceiling (#1855)", () => {
	function withCeilingEnv(value: string | undefined): () => void {
		const previous = process.env[CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS_ENV];
		if (value === undefined) {
			delete process.env[CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS_ENV];
		} else {
			process.env[CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS_ENV] = value;
		}
		return () => {
			if (previous === undefined) {
				delete process.env[CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS_ENV];
			} else {
				process.env[CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS_ENV] = previous;
			}
		};
	}

	test("buildSdkOptions includes CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 unless already set", () => {
		const restore = withCeilingEnv(undefined);
		try {
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test prompt");
			const env = options.env as NodeJS.ProcessEnv | undefined;
			assert.equal(env?.[CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS_ENV], "0");
			assert.equal(typeof options.stderr, "function");
		} finally {
			restore();
		}
	});

	test("buildSdkOptions preserves an existing CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS", () => {
		const restore = withCeilingEnv("20000");
		try {
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test prompt");
			const env = options.env as NodeJS.ProcessEnv | undefined;
			assert.equal(env?.[CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS_ENV], "20000");
		} finally {
			restore();
		}
	});

	test("buildSdkOptions stderr sink logs the CLI print wind-down warning", () => {
		const options = buildSdkOptions("claude-sonnet-4-20250514", "test prompt");
		const stderr = options.stderr as (data: unknown) => void;
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
		try {
			stderr("Background tasks still running after 600s; terminating.\nSet CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.\n");
			stderr("unrelated cli chatter\n");
			assert.equal(warnings.length, 1);
			assert.match(warnings[0]!, /\[claude-code\].*Background tasks still running after 600s/);
		} finally {
			console.warn = originalWarn;
		}
	});

	test("query options keep the print bg wait ceiling after observation-token injection", async () => {
		const restore = withCeilingEnv(undefined);
		const cwd = mkdtempSync(join(tmpdir(), "claude-sdk-bg-wait-"));
		let capturedEnv: NodeJS.ProcessEnv | undefined;
		let capturedStderr: unknown;
		try {
			const stream = streamViaClaudeCode(
				{ id: "claude-sonnet-4-6" } as any,
				{ messages: [{ role: "user", content: "Continue." } as Message] },
				{
					cwd,
					_skipWorkflowMcpPreflightForTest: true,
					async *_sdkQueryForTest(args: {
						prompt: string | AsyncIterable<unknown>;
						options?: Record<string, unknown>;
					}) {
						capturedEnv = args.options?.env as NodeJS.ProcessEnv | undefined;
						capturedStderr = args.options?.stderr;
						yield makeSdkSuccessResult("finished");
					},
				} as any,
			);
			await stream.result();
			assert.equal(capturedEnv?.[CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS_ENV], "0");
			assert.equal(typeof capturedStderr, "function");
		} finally {
			restore();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("stream-adapter — session persistence (#2859)", () => {
	test("buildSdkOptions enables persistSession by default", () => {
		const options = buildSdkOptions("claude-sonnet-4-20250514", "test prompt");
		assert.equal(options.persistSession, true, "persistSession must default to true");
	});

	test("buildSdkOptions loads user, project, and local settings so approved Claude Code config is active", () => {
		const options = buildSdkOptions("claude-sonnet-4-20250514", "test prompt");
		assert.deepEqual(options.settingSources, ["user", "project", "local"]);
	});

	test("buildSdkOptions sets model and prompt correctly", () => {
		const options = buildSdkOptions("claude-sonnet-4-20250514", "hello world");
		assert.equal(options.model, "claude-sonnet-4-20250514");
	});

	test("buildSdkOptions prefers explicit cwd over process cwd for local SDK execution", () => {
		const explicitCwd = "/tmp/gsd-session-root";
		const options = buildSdkOptions("claude-sonnet-4-20250514", "hello world", undefined, { cwd: explicitCwd });
		assert.equal(options.cwd, explicitCwd);
	});

	test("buildSdkOptions uses explicit cwd when auto-detecting workflow MCP launch config", () => {
		const explicitCwd = realpathSync(mkdtempSync(join(tmpdir(), "claude-sdk-cwd-")));
		const restore = setWorkflowMcpEnv({});
		try {
			delete process.env.GSD_WORKFLOW_MCP_COMMAND;
			delete process.env.GSD_WORKFLOW_MCP_NAME;
			delete process.env.GSD_WORKFLOW_MCP_ARGS;
			delete process.env.GSD_WORKFLOW_MCP_ENV;
			delete process.env.GSD_WORKFLOW_MCP_CWD;

			const distDir = join(explicitCwd, "packages", "mcp-server", "dist");
			mkdirSync(distDir, { recursive: true });
			writeFileSync(join(distDir, "cli.js"), "#!/usr/bin/env node\n");

			const options = buildSdkOptions("claude-sonnet-4-20250514", "hello world", undefined, { cwd: explicitCwd });
			const mcpServers = options.mcpServers as Record<string, any>;
			assert.equal(mcpServers["gsd-workflow"].cwd, explicitCwd);
			assert.equal(mcpServers["gsd-workflow"].env.GSD_WORKFLOW_PROJECT_ROOT, explicitCwd);
		} finally {
			restore();
			rmSync(explicitCwd, { recursive: true, force: true });
		}
	});

	test("autoInitClaudeCodeWorkflowMcp writes and approves project GSD MCP config", () => {
		const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "claude-sdk-auto-init-")));
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["server.js"]),
			GSD_WORKFLOW_MCP_CWD: projectRoot,
		});

		try {
			autoInitClaudeCodeWorkflowMcp(projectRoot);
			assert.equal(existsSync(join(projectRoot, ".mcp.json")), true);

			const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf-8")) as {
				enabledMcpjsonServers?: string[];
			};
			assert.deepEqual(settings.enabledMcpjsonServers, ["gsd-workflow", "gsd-browser"]);
		} finally {
			restore();
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	test("resolveClaudeCodeCwd falls back to process cwd when no stream cwd is provided", () => {
		assert.equal(resolveClaudeCodeCwd(), process.cwd());
		assert.equal(resolveClaudeCodeCwd({ cwd: "   " }), process.cwd());
	});

	test("resolveClaudeCodeCwd returns stream cwd when provided", () => {
		assert.equal(resolveClaudeCodeCwd({ cwd: "/tmp/current-session" }), "/tmp/current-session");
	});

	test("buildSdkOptions enables betas for sonnet models", () => {
		const sonnetOpts = buildSdkOptions("claude-sonnet-4-20250514", "test");
		assert.ok(
			Array.isArray(sonnetOpts.betas) && sonnetOpts.betas.length > 0,
			"sonnet models should have betas enabled",
		);

		const opusOpts = buildSdkOptions("claude-opus-4-20250514", "test");
		assert.ok(
			Array.isArray(opusOpts.betas) && opusOpts.betas.length === 0,
			"non-sonnet models should have empty betas",
		);
	});

	test("buildSdkOptions enables context-1m beta for opus-4-7 (#4348)", () => {
		const opts = buildSdkOptions("claude-opus-4-7", "test");
		assert.ok(
			Array.isArray(opts.betas) && opts.betas.includes("context-1m-2025-08-07"),
			"claude-opus-4-7 should have context-1m beta enabled for 1M token context window",
		);
	});

	test("buildSdkOptions maps reasoning to effort for adaptive Claude Code models (#3917)", () => {
		const options = buildSdkOptions("claude-sonnet-4-6", "test", undefined, { reasoning: "high" });
		assert.equal(options.effort, "high");
	});

	test("buildSdkOptions upgrades xhigh reasoning to max for opus 4.6 (#3917)", () => {
		const options = buildSdkOptions("claude-opus-4-6", "test", undefined, { reasoning: "xhigh" });
		assert.equal(options.effort, "max");
	});

	test("buildSdkOptions maps reasoning to effort for opus-4-7 (#4348)", () => {
		const options = buildSdkOptions("claude-opus-4-7", "test", undefined, { reasoning: "high" });
		assert.equal(options.effort, "high");
	});

	test("buildSdkOptions passes xhigh reasoning natively for opus-4-7 (#4348)", () => {
		const options = buildSdkOptions("claude-opus-4-7", "test", undefined, { reasoning: "xhigh" });
		assert.equal(options.effort, "xhigh");
	});

	test("buildSdkOptions enables context-1m beta for opus-4-8", () => {
		const opts = buildSdkOptions("claude-opus-4-8", "test");
		assert.ok(
			Array.isArray(opts.betas) && opts.betas.includes("context-1m-2025-08-07"),
			"claude-opus-4-8 should have context-1m beta enabled for 1M token context window",
		);
	});

	test("buildSdkOptions passes xhigh reasoning natively for opus-4-8", () => {
		const options = buildSdkOptions("claude-opus-4-8", "test", undefined, { reasoning: "xhigh" });
		assert.equal(options.effort, "xhigh");
	});

	test("buildSdkOptions omits effort when reasoning is undefined (#3917)", () => {
		const options = buildSdkOptions("claude-sonnet-4-6", "test");
		assert.equal("effort" in options, false);
	});

	test("buildSdkOptions omits effort for non-adaptive Claude models (#3917)", () => {
		const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, { reasoning: "high" });
		assert.equal("effort" in options, false);
	});

	// --- Bug fixes #4392: thinking field & model coverage ---

	test("buildSdkOptions sets thinking disabled when reasoning is undefined on adaptive model (#4392)", () => {
		// Bug C: thinkingLevel="off" means reasoning===undefined; SDK needs thinking:{type:"disabled"}
		const options = buildSdkOptions("claude-sonnet-4-6", "test", undefined, {});
		assert.deepEqual(
			(options as any).thinking,
			{ type: "disabled" },
			"thinking must be {type:'disabled'} when reasoning is undefined so SDK stops adaptive thinking",
		);
	});

	test("buildSdkOptions omits effort when reasoning is undefined (thinking disabled) (#4392)", () => {
		// Bug C corollary: no effort when thinking is off
		const options = buildSdkOptions("claude-sonnet-4-6", "test", undefined, {});
		assert.equal("effort" in options, false, "effort must not be set when reasoning is undefined");
	});

	test("buildSdkOptions sets thinking adaptive when reasoning is provided (#4392)", () => {
		// Bug B: when effort is set, thinking:{type:"adaptive"} must also be present
		const options = buildSdkOptions("claude-opus-4-6", "test", undefined, { reasoning: "high" });
		assert.deepEqual(
			(options as any).thinking,
			{ type: "adaptive" },
			"thinking must be {type:'adaptive'} alongside effort when reasoning is set",
		);
	});

	test("buildSdkOptions includes both effort and thinking.type=adaptive when reasoning is set (#4392)", () => {
		// Bug B: both fields must be present together
		const options = buildSdkOptions("claude-opus-4-6", "test", undefined, { reasoning: "high" });
		assert.equal(options.effort, "high", "effort must be set");
		assert.deepEqual((options as any).thinking, { type: "adaptive" }, "thinking must be adaptive");
	});

	test("buildSdkOptions maps reasoning to effort for sonnet-4-7 (modelSupportsAdaptiveThinking #4392)", () => {
		// Bug D: sonnet-4-7 was missing from modelSupportsAdaptiveThinking
		const options = buildSdkOptions("claude-sonnet-4-7", "test", undefined, { reasoning: "high" });
		assert.equal(options.effort, "high", "sonnet-4-7 must support adaptive thinking and map effort");
	});

	test("buildSdkOptions maps reasoning to effort for haiku-4-5 (modelSupportsAdaptiveThinking #4392)", () => {
		// Bug D: haiku-4-5 was missing from modelSupportsAdaptiveThinking
		const options = buildSdkOptions("claude-haiku-4-5", "test", undefined, { reasoning: "high" });
		assert.equal(options.effort, "high", "haiku-4-5 must support adaptive thinking and map effort");
	});

	test("buildSdkOptions maps reasoning to effort for sonnet-4.7 dot-form (modelSupportsAdaptiveThinking #4392)", () => {
		// Dot-form aliases (e.g. claude-sonnet-4.7) must also be recognised
		const options = buildSdkOptions("claude-sonnet-4.7", "test", undefined, { reasoning: "high" });
		assert.equal(options.effort, "high", "claude-sonnet-4.7 must support adaptive thinking and map effort");
	});

	test("buildSdkOptions maps reasoning to effort for haiku-4.5 dot-form (modelSupportsAdaptiveThinking #4392)", () => {
		// Dot-form aliases (e.g. claude-haiku-4.5) must also be recognised
		const options = buildSdkOptions("claude-haiku-4.5", "test", undefined, { reasoning: "high" });
		assert.equal(options.effort, "high", "claude-haiku-4.5 must support adaptive thinking and map effort");
	});

	test("buildSdkOptions does not set thinking field for non-adaptive model when reasoning is undefined (#4392)", () => {
		// Non-adaptive models (e.g. claude-sonnet-4-20250514) don't use the thinking API at all;
		// no thinking field should be set when reasoning is undefined
		const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, {});
		assert.equal("thinking" in options, false, "non-adaptive models must not receive a thinking field");
	});

	test("buildSdkOptions prefers workflow MCP question tools over native AskUserQuestion", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
		});
		const originalCwd = process.cwd();
		const emptyDir = mkdtempSync(join(tmpdir(), "claude-mcp-inject-"));
		try {
			process.chdir(emptyDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			const mcpServers = options.mcpServers as Record<string, any>;
			assert.ok(mcpServers?.["gsd-workflow"], "expected gsd-workflow server config");
			assert.ok(mcpServers?.["gsd-browser"], "expected gsd-browser server config");
			const srv = mcpServers["gsd-workflow"];
			assert.equal(srv.command, "node");
			assert.deepEqual(srv.args, ["packages/mcp-server/dist/cli.js"]);
			assert.equal(srv.cwd, "/tmp/project");
			assert.equal(srv.env.GSD_CLI_PATH, "/tmp/gsd");
			assert.equal(srv.env.GSD_PERSIST_WRITE_GATE_STATE, "1");
			assert.equal(srv.env.GSD_WORKFLOW_PROJECT_ROOT, "/tmp/project");
			assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
			assert.deepEqual(options.allowedTools, [
				"Read",
				"Write",
				"Edit",
				"Glob",
				"Grep",
				"Bash",
				"Agent",
				"WebFetch",
				"WebSearch",
				"mcp__gsd-workflow__*",
				"mcp__gsd-browser__*",
			]);
		} finally {
			process.chdir(originalCwd);
			rmSync(emptyDir, { recursive: true, force: true });
			restore();
		}
	});

	test("buildSdkOptions can disable workflow MCP ask_user_questions explicitly", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
			GSD_WORKFLOW_MCP_STRUCTURED_QUESTIONS: "0",
		});
		const originalCwd = process.cwd();
		const emptyDir = mkdtempSync(join(tmpdir(), "claude-mcp-ask-disabled-"));
		try {
			process.chdir(emptyDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			assert.ok(
				(options.disallowedTools as string[]).includes("mcp__gsd-workflow__ask_user_questions"),
				"explicit opt-out must block the MCP question tool even when workflow wildcard is allowed",
			);
			assert.ok((options.disallowedTools as string[]).includes("AskUserQuestion"));
		} finally {
			process.chdir(originalCwd);
			rmSync(emptyDir, { recursive: true, force: true });
			restore();
		}
	});

	test("buildSdkOptions scopes run-uat to exact workflow MCP tools", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
		});
		const originalCwd = process.cwd();
		const emptyDir = mkdtempSync(join(tmpdir(), "claude-mcp-uat-"));
		try {
			process.chdir(emptyDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, { gsdPhase: "run-uat" });
			const allowedTools = options.allowedTools as string[];
			const disallowedTools = options.disallowedTools as string[];

			assert.deepEqual(allowedTools, [
				"Read",
				"Glob",
				"Grep",
				"mcp__gsd-workflow__gsd_uat_exec",
				"mcp__gsd-workflow__gsd_uat_result_save",
				"mcp__gsd-workflow__gsd_resume",
				"mcp__gsd-workflow__gsd_milestone_status",
				"mcp__gsd-workflow__gsd_journal_query",
				"mcp__gsd-browser__*",
			]);
			assert.ok(!allowedTools.includes("Bash"));
			assert.ok(!allowedTools.includes("Write"));
			assert.ok(!allowedTools.includes("Edit"));
			assert.ok(!allowedTools.includes("WebSearch"));
			assert.ok(!allowedTools.includes("mcp__gsd-workflow__*"));
			assert.ok(disallowedTools.includes("Bash"));
			assert.ok(disallowedTools.includes("Write"));
			assert.ok(disallowedTools.includes("Edit"));
			assert.ok(disallowedTools.includes("WebSearch"));
			assert.ok(disallowedTools.includes("mcp__gsd-workflow__gsd_exec"));
			assert.ok(disallowedTools.includes("mcp__gsd-workflow__gsd_summary_save"));
			assert.ok(disallowedTools.includes("mcp__gsd-workflow__gsd_save_gate_result"));
			assert.equal(options.strictMcpConfig, true);
			assert.deepEqual(options.settingSources, []);
			assert.ok((options.mcpServers as Record<string, unknown>)?.["gsd-workflow"]);
			assert.ok((options.mcpServers as Record<string, unknown>)?.["gsd-browser"]);
		} finally {
			process.chdir(originalCwd);
			rmSync(emptyDir, { recursive: true, force: true });
			restore();
		}
	});

	test("buildSdkOptions presents exact required workflow MCP tools for non-UAT GSD phases", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
		});
		const originalCwd = process.cwd();
		const emptyDir = mkdtempSync(join(tmpdir(), "claude-mcp-plan-"));
		try {
			process.chdir(emptyDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, { gsdPhase: "plan-milestone" });
			const allowedTools = options.allowedTools as string[];

			assert.ok(
				allowedTools.includes("mcp__gsd-workflow__gsd_plan_milestone"),
				"plan-milestone must expose exact planning tool",
			);
			assert.ok(
				allowedTools.includes("mcp__gsd-workflow__gsd_milestone_status"),
				"plan-milestone must expose exact milestone status helper before ToolSearch is needed",
			);
			assert.ok(
				!allowedTools.includes("mcp__gsd-workflow__*"),
				"strict GSD phases must not rely on a workflow wildcard that can mask missing exact tools",
			);
			assert.ok((options.disallowedTools as string[]).includes("AskUserQuestion"));
			assert.equal(options.strictMcpConfig, true);
			assert.ok((options.mcpServers as Record<string, unknown>)?.["gsd-workflow"]);
		} finally {
			process.chdir(originalCwd);
			rmSync(emptyDir, { recursive: true, force: true });
			restore();
		}
	});

	test("buildSdkOptions leaves ToolSearch available for complete-milestone workflow MCP hydration", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
		});
		const originalCwd = process.cwd();
		const emptyDir = mkdtempSync(join(tmpdir(), "claude-mcp-complete-milestone-"));
		try {
			process.chdir(emptyDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, { gsdPhase: "complete-milestone" });
			const disallowedTools = options.disallowedTools as string[];

			assert.ok(!disallowedTools.includes("ToolSearch"));
			assert.ok(disallowedTools.includes("Skill"));
			assert.ok(disallowedTools.includes("AskUserQuestion"));
			assert.equal(options.strictMcpConfig, true);
		} finally {
			process.chdir(originalCwd);
			rmSync(emptyDir, { recursive: true, force: true });
			restore();
		}
	});

	test("buildSdkOptions scopes complete-slice away from native write and shell tools", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
		});
		const originalCwd = process.cwd();
		const emptyDir = mkdtempSync(join(tmpdir(), "claude-mcp-complete-slice-"));
		try {
			process.chdir(emptyDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, { gsdPhase: "complete-slice" });
			const allowedTools = options.allowedTools as string[];

			assert.ok(allowedTools.includes("Read"));
			assert.ok(allowedTools.includes("Glob"));
			assert.ok(allowedTools.includes("Grep"));
			assert.ok(allowedTools.includes("mcp__gsd-workflow__gsd_exec"));
			assert.ok(allowedTools.includes("mcp__gsd-workflow__gsd_slice_complete"));
			assert.ok(!allowedTools.includes("Bash"));
			assert.ok(!allowedTools.includes("Write"));
			assert.ok(!allowedTools.includes("Edit"));
			assert.ok(!allowedTools.includes("mcp__gsd-workflow__*"));
		} finally {
			process.chdir(originalCwd);
			rmSync(emptyDir, { recursive: true, force: true });
			restore();
		}
	});

	test("buildSdkOptions blocks native Skill tool during GSD phases", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
		});
		const originalCwd = process.cwd();
		const emptyDir = mkdtempSync(join(tmpdir(), "claude-mcp-no-native-skill-"));
		try {
			process.chdir(emptyDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, { gsdPhase: "complete-slice" });
			const allowedTools = options.allowedTools as string[];
			const disallowedTools = options.disallowedTools as string[];

			assert.ok(!allowedTools.includes("Skill"));
			assert.ok(disallowedTools.includes("Skill"));
		} finally {
			process.chdir(originalCwd);
			rmSync(emptyDir, { recursive: true, force: true });
			restore();
		}
	});

	test("buildSdkOptions presents every unit's required workflow MCP tools", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
		});
		const originalCwd = process.cwd();
		const emptyDir = mkdtempSync(join(tmpdir(), "claude-mcp-all-units-"));
		try {
			process.chdir(emptyDir);
			for (const [unitType, contract] of Object.entries(UNIT_TOOL_CONTRACTS)) {
				const requiredTools = contract.requiredWorkflowTools.filter(
					(tool) => tool.startsWith("gsd_") || tool === "ask_user_questions",
				);
				if (requiredTools.length === 0) continue;

				const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, { gsdPhase: unitType });
				const allowedTools = options.allowedTools as string[];
				for (const toolName of requiredTools) {
					assert.ok(
						allowedTools.includes(`mcp__gsd-workflow__${toolName}`) || allowedTools.includes("mcp__gsd-workflow__*"),
						`${unitType} must allow ${toolName}; allowed=${JSON.stringify(allowedTools)}`,
					);
				}
			}
		} finally {
			process.chdir(originalCwd);
			rmSync(emptyDir, { recursive: true, force: true });
			restore();
		}
	});

	test("inferGsdPhaseFromContext recognizes non-UAT unit prompts", () => {
		const context = {
			messages: [
				{ role: "user", content: "## UNIT: Plan Milestone M002 (\"Plan by Priority\")" },
			],
		} as Context;

		assert.equal(inferGsdPhaseFromContext(context), "plan-milestone");
	});

	test("inferGsdPhaseFromContext recognizes the refine-slice UNIT header", () => {
		const refineSlice = {
			messages: [{ role: "user", content: "## UNIT: Refine Slice S001 (\"Auth\") - Milestone M001" }],
		} as Context;

		assert.equal(inferGsdPhaseFromContext(refineSlice), "refine-slice");
	});

	test("inferGsdPhaseFromContext ignores bare phase slugs and prose (only the UNIT header counts)", () => {
		// Prose mentioning a phase must NOT classify the turn — this was the leak
		// that stripped tools the moment a user said "slice" or "UAT".
		const prose = {
			messages: [{ role: "user", content: "Can you discuss the slice S001 and then run UAT for me?" }],
		} as Context;
		const bareSlug = {
			messages: [{ role: "user", content: "I edited e2e/m039-s05-comparison-legibility.spec.ts (plan-slice, run-uat)" }],
		} as Context;

		assert.equal(inferGsdPhaseFromContext(prose), undefined);
		assert.equal(inferGsdPhaseFromContext(bareSlug), undefined);
	});

	test("inferGsdPhaseFromContext does not match a UNIT header buried in scrollback", () => {
		// A UNIT header from a prior turn (e.g. a SUMMARY the agent read) must not
		// re-classify later ad-hoc turns. Only the system prompt + latest user
		// message are scanned.
		const context = {
			messages: [
				{ role: "user", content: "## UNIT: Run UAT — M001/S001" },
				{ role: "assistant", content: "Done." },
				{ role: "user", content: "Thanks, now what files changed?" },
			],
		} as Context;

		assert.equal(inferGsdPhaseFromContext(context), undefined);
	});

	test("resolveGsdPhaseForSdk prefers guided unit context over prompt inference", () => {
		const projectRoot = "/tmp/gsd-guided-phase-project";
		clearGuidedUnitContext();
		setGuidedUnitContext(projectRoot, "discuss-slice");
		try {
			const context = {
				messages: [{ role: "user", content: "Generic workflow task with no phase slug." }],
			} as Context;
			assert.equal(resolveGsdPhaseForSdk(context, projectRoot), "discuss-slice");
		} finally {
			clearGuidedUnitContext(projectRoot);
		}
	});

	test("resolveGsdPhaseForSdk matches guided context across milestone worktrees", () => {
		const projectRoot = "/tmp/gsd-guided-phase-root";
		const worktreeRoot = `${projectRoot}/.gsd/worktrees/m001-wt`;
		clearGuidedUnitContext();
		setGuidedUnitContext(worktreeRoot, "refine-slice");
		try {
			const context = { messages: [{ role: "user", content: "No UNIT header here." }] } as Context;
			assert.equal(resolveGsdPhaseForSdk(context, projectRoot), "refine-slice");
		} finally {
			clearGuidedUnitContext(worktreeRoot);
		}
	});

	test("resolveGsdPhaseForSdk returns undefined for ad-hoc turns (no guided context, auto inactive)", () => {
		// The core bug: an ad-hoc turn must keep the full tool surface even when
		// its text contains a UNIT header (e.g. pasted from a prior unit). No
		// guided context + auto inactive => no phase, no preflight, no stripping.
		clearGuidedUnitContext();
		_setAutoActiveForTest(false);
		try {
			const context = {
				messages: [{ role: "user", content: "## UNIT: Run UAT — M001/S001 (pasted from earlier)" }],
			} as Context;
			assert.equal(resolveGsdPhaseForSdk(context, "/tmp/unrelated-project"), undefined);
		} finally {
			_setAutoActiveForTest(false);
		}
	});

	test("resolveGsdPhaseForSdk uses the authoritative auto currentUnit, even with no UNIT header in the prompt", () => {
		// gate-evaluate / validate-milestone dispatch prompts have no `UNIT:`
		// header, so header inference alone would drop their phase (and their
		// workflow-MCP preflight). The dispatched unit type is authoritative.
		clearGuidedUnitContext();
		_setAutoActiveForTest(true);
		autoSession.currentUnit = { type: "gate-evaluate", id: "M001/S001", startedAt: 0, workspaceRoot: "/tmp/p" } as never;
		try {
			const context = {
				messages: [{ role: "user", content: "Quality Gate Evaluation — Parallel Dispatch. Call gsd_save_gate_result." }],
			} as Context;
			assert.equal(resolveGsdPhaseForSdk(context, "/tmp/p"), "gate-evaluate");
		} finally {
			autoSession.currentUnit = null;
			_setAutoActiveForTest(false);
		}
	});

	test("resolveGsdPhaseForSdk ignores hook/* pseudo-units from currentUnit", () => {
		clearGuidedUnitContext();
		_setAutoActiveForTest(true);
		autoSession.currentUnit = { type: "hook/agent-end", id: "x", startedAt: 0, workspaceRoot: "/tmp/p" } as never;
		try {
			const context = { messages: [{ role: "user", content: "no phase here" }] } as Context;
			assert.equal(resolveGsdPhaseForSdk(context, "/tmp/p"), undefined);
		} finally {
			autoSession.currentUnit = null;
			_setAutoActiveForTest(false);
		}
	});

	test("resolveGsdPhaseForSdk infers from the UNIT header only while auto-mode is active and no currentUnit is recorded", () => {
		// Last-resort fallback: auto running but currentUnit unexpectedly absent.
		// Classifies from the `UNIT:` dispatch header only.
		clearGuidedUnitContext();
		_setAutoActiveForTest(true);
		autoSession.currentUnit = null;
		try {
			const context = {
				messages: [{ role: "user", content: "## UNIT: Run UAT — M001/S001" }],
			} as Context;
			assert.equal(resolveGsdPhaseForSdk(context, "/tmp/unrelated-project"), "run-uat");
		} finally {
			_setAutoActiveForTest(false);
		}
	});

	test("buildSdkOptions presents ask_user_questions for discuss phases", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
		});
		const originalCwd = process.cwd();
		const emptyDir = mkdtempSync(join(tmpdir(), "claude-mcp-discuss-"));
		try {
			process.chdir(emptyDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, { gsdPhase: "discuss-milestone" });
			const allowedTools = options.allowedTools as string[];
			const disallowedTools = options.disallowedTools as string[];

			assert.ok(
				allowedTools.includes("mcp__gsd-workflow__ask_user_questions"),
				"discuss phases must expose the exact workflow MCP question tool",
			);
			assert.ok(disallowedTools.includes("AskUserQuestion"));
			assert.ok(
				!disallowedTools.includes("mcp__gsd-workflow__ask_user_questions"),
				"workflow MCP ask_user_questions should remain enabled by default",
			);
		} finally {
			process.chdir(originalCwd);
			rmSync(emptyDir, { recursive: true, force: true });
			restore();
		}
	});

	test("buildSdkOptions prefers custom workflow MCP question tools over native AskUserQuestion", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "custom-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
		});
		const originalCwd = process.cwd();
		const emptyDir = mkdtempSync(join(tmpdir(), "claude-mcp-custom-inject-"));
		try {
			process.chdir(emptyDir);

			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			const mcpServers = options.mcpServers as Record<string, any>;
			assert.ok(mcpServers?.["custom-workflow"], "expected custom workflow server config");
			assert.ok(mcpServers?.["gsd-browser"], "expected gsd-browser server config");
			assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
			assert.deepEqual(options.allowedTools, [
				"Read",
				"Write",
				"Edit",
				"Glob",
				"Grep",
				"Bash",
				"Agent",
				"WebFetch",
				"WebSearch",
				"mcp__custom-workflow__*",
				"mcp__gsd-browser__*",
			]);
		} finally {
			process.chdir(originalCwd);
			rmSync(emptyDir, { recursive: true, force: true });
			restore();
		}
	});

	test("buildSdkOptions auto-discovers bundled MCP server even without env hints", () => {
		// Use setWorkflowMcpEnv with no values to save current state;
		// restore() in finally will put it back correctly (including
		// deleting any keys that started as undefined — the #4808 bug
		// the naive `process.env.X = prev.X` pattern introduced).
		const restore = setWorkflowMcpEnv({});
		try {
			delete process.env.GSD_WORKFLOW_MCP_COMMAND;
			delete process.env.GSD_WORKFLOW_MCP_NAME;
			delete process.env.GSD_WORKFLOW_MCP_ARGS;
			delete process.env.GSD_WORKFLOW_MCP_ENV;
			delete process.env.GSD_WORKFLOW_MCP_CWD;

			const originalCwd = process.cwd();
			const emptyDir = mkdtempSync(join(tmpdir(), "claude-mcp-none-"));
			process.chdir(emptyDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			process.chdir(originalCwd);
			// The bundled CLI may or may not be discoverable depending on
			// whether the build output exists relative to import.meta.url.
			// Either outcome is valid — the key invariant is no crash.
			const mcpServers = (options as any).mcpServers;
			if (mcpServers) {
				assert.ok(mcpServers["gsd-workflow"], "if present, must include gsd-workflow");
				assert.ok(mcpServers["gsd-browser"], "if present, must include gsd-browser");
				assert.deepEqual((options as any).disallowedTools, ["AskUserQuestion"]);
			} else {
				assert.deepEqual((options as any).disallowedTools, ["ToolSearch"]);
			}
			rmSync(emptyDir, { recursive: true, force: true });
		} finally {
			restore();
		}
	});

	test("buildSdkOptions auto-detects local workflow MCP dist CLI when present", () => {
		// GSD_CLI_PATH isn't in WORKFLOW_MCP_ENV_KEYS, so save+restore it
		// manually around setWorkflowMcpEnv which handles the MCP keys.
		const prevCliPath = process.env.GSD_CLI_PATH;
		const restore = setWorkflowMcpEnv({});
		const originalCwd = process.cwd();
		const repoDir = mkdtempSync(join(tmpdir(), "claude-mcp-detect-"));
		try {
			delete process.env.GSD_WORKFLOW_MCP_COMMAND;
			delete process.env.GSD_WORKFLOW_MCP_NAME;
			delete process.env.GSD_WORKFLOW_MCP_ARGS;
			delete process.env.GSD_WORKFLOW_MCP_ENV;
			delete process.env.GSD_WORKFLOW_MCP_CWD;
			process.env.GSD_CLI_PATH = "/tmp/gsd";

			const distDir = join(repoDir, "packages", "mcp-server", "dist");
			mkdirSync(distDir, { recursive: true });
			writeFileSync(join(distDir, "cli.js"), "#!/usr/bin/env node\n");
			process.chdir(repoDir);
			const resolvedRepoDir = realpathSync(repoDir);

			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			const mcpServers = options.mcpServers as Record<string, any>;
			assert.ok(mcpServers?.["gsd-workflow"], "expected gsd-workflow server config");
			assert.ok(mcpServers?.["gsd-browser"], "expected gsd-browser server config");
			const srv = mcpServers["gsd-workflow"];
			assert.equal(srv.command, process.execPath);
			assert.deepEqual(srv.args, [realpathSync(resolve(repoDir, "packages", "mcp-server", "dist", "cli.js"))]);
			assert.equal(srv.cwd, resolvedRepoDir);
			assert.equal(srv.env.GSD_CLI_PATH, "/tmp/gsd");
			assert.equal(srv.env.GSD_PERSIST_WRITE_GATE_STATE, "1");
			assert.equal(srv.env.GSD_WORKFLOW_PROJECT_ROOT, resolvedRepoDir);
			assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
		} finally {
			process.chdir(originalCwd);
			rmSync(repoDir, { recursive: true, force: true });
			restore();
			// GSD_CLI_PATH isn't in setWorkflowMcpEnv's scope — restore it here.
			if (prevCliPath === undefined) {
				delete process.env.GSD_CLI_PATH;
			} else {
				process.env.GSD_CLI_PATH = prevCliPath;
			}
		}
	});

	test("buildSdkOptions discovers project .mcp.json when session cwd is a milestone worktree", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
		});
		const originalCwd = process.cwd();
		const projectDir = mkdtempSync(join(tmpdir(), "claude-mcp-worktree-"));
		const worktreeDir = join(projectDir, ".gsd", "worktrees", "M002-test");
		try {
			mkdirSync(worktreeDir, { recursive: true });
			writeFileSync(
				join(projectDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { "gsd-workflow": { command: "node", args: ["cli.js"] } } }),
			);
			process.chdir(projectDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, { cwd: worktreeDir });
			const mcpServers = options.mcpServers as Record<string, any>;
			assert.deepEqual(Object.keys(mcpServers), ["gsd-browser"], "should inject only browser when project root already declares workflow MCP");
			const allowedTools = options.allowedTools as string[];
			assert.ok(allowedTools.includes("mcp__gsd-workflow__*"), "worktree cwd must still allow workflow MCP tools from project config");
			assert.ok(allowedTools.includes("mcp__gsd-browser__*"), "worktree cwd must allow default browser MCP tools");
		} finally {
			process.chdir(originalCwd);
			rmSync(projectDir, { recursive: true, force: true });
			restore();
		}
	});

	test("buildSdkOptions force-inlines workflow MCP for GSD phases when project .mcp.json already declares it", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
		});
		const originalCwd = process.cwd();
		const projectDir = mkdtempSync(join(tmpdir(), "claude-mcp-inline-project-"));
		try {
			writeFileSync(
				join(projectDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { "gsd-workflow": { command: "node", args: ["old-cli.js"] }, "other-mcp": { command: "npx", args: ["other"] } } }),
			);
			process.chdir(projectDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, { gsdPhase: "plan-milestone" });

			assert.equal(options.strictMcpConfig, true);
			assert.deepEqual(options.settingSources, []);
			assert.deepEqual(options.mcpServers, {
				"gsd-workflow": { command: "node", args: ["old-cli.js"] },
			});
			const allowedTools = options.allowedTools as string[];
			assert.ok(allowedTools.includes("mcp__gsd-workflow__gsd_plan_milestone"));
			assert.ok(allowedTools.includes("mcp__gsd-workflow__gsd_milestone_status"));
			assert.ok(!allowedTools.includes("mcp__gsd-workflow__*"));
		} finally {
			process.chdir(originalCwd);
			rmSync(projectDir, { recursive: true, force: true });
			restore();
		}
	});

	test("buildSdkOptions does not inject workflow MCP when already declared in project .mcp.json outside GSD phases", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
		});
		const originalCwd = process.cwd();
		const projectDir = mkdtempSync(join(tmpdir(), "claude-mcp-dup-"));
		try {
			// Simulate a project that already has gsd-workflow in its .mcp.json
			writeFileSync(
				join(projectDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { "gsd-workflow": { command: "node", args: ["old-cli.js"] }, "other-mcp": { command: "npx", args: ["other"] } } }),
			);
			process.chdir(projectDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			// Should NOT inject gsd-workflow via mcpServers (project already has it)
			const mcpServers = options.mcpServers as Record<string, any>;
			assert.deepEqual(Object.keys(mcpServers), ["gsd-browser"], "mcpServers should inject only browser when workflow already in .mcp.json");
			// But allowedTools should still include the workflow pattern
			const allowedTools = options.allowedTools as string[];
			assert.ok(allowedTools.includes("mcp__gsd-workflow__*"), "allowedTools must include workflow pattern even when not injected");
			assert.ok(allowedTools.includes("mcp__gsd-browser__*"), "allowedTools must include browser pattern for default UAT");
			// AskUserQuestion should be disallowed (workflow is available via project config)
			const disallowedTools = options.disallowedTools as string[];
			assert.ok(disallowedTools.includes("AskUserQuestion"), "AskUserQuestion should be suppressed when workflow is available");
		} finally {
			process.chdir(originalCwd);
			rmSync(projectDir, { recursive: true, force: true });
			restore();
		}
	});

	test("buildSdkOptions uses project-declared custom workflow MCP namespace", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
		});
		const originalCwd = process.cwd();
		const projectDir = mkdtempSync(join(tmpdir(), "claude-mcp-custom-project-"));
		try {
			writeFileSync(
				join(projectDir, ".mcp.json"),
				JSON.stringify({
					mcpServers: {
						"custom-workflow": {
							command: "node",
							args: ["custom-cli.js"],
							env: { GSD_WORKFLOW_PROJECT_ROOT: projectDir },
						},
					},
				}),
			);
			process.chdir(projectDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			const mcpServers = options.mcpServers as Record<string, any>;
			assert.deepEqual(Object.keys(mcpServers), ["gsd-browser"], "should inject only browser when project declares a workflow server");
			const allowedTools = options.allowedTools as string[];
			assert.ok(allowedTools.includes("mcp__custom-workflow__*"), "allowedTools must use the project workflow namespace");
			assert.ok(allowedTools.includes("mcp__gsd-browser__*"), "allowedTools must include default browser namespace");
			assert.ok(!allowedTools.includes("mcp__gsd-workflow__*"), "allowedTools must not advertise the absent default namespace");
			const disallowedTools = options.disallowedTools as string[];
			assert.ok(disallowedTools.includes("AskUserQuestion"), "AskUserQuestion should be suppressed when workflow is available");

			const phaseOptions = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, { gsdPhase: "plan-milestone" });
			assert.equal(phaseOptions.strictMcpConfig, true);
			assert.deepEqual(phaseOptions.settingSources, []);
			assert.deepEqual(phaseOptions.mcpServers, {
				"custom-workflow": {
					command: "node",
					args: ["custom-cli.js"],
					env: { GSD_WORKFLOW_PROJECT_ROOT: projectDir },
				},
			});
			const phaseAllowedTools = phaseOptions.allowedTools as string[];
			assert.ok(phaseAllowedTools.includes("mcp__custom-workflow__gsd_plan_milestone"));
			assert.ok(phaseAllowedTools.includes("mcp__custom-workflow__gsd_milestone_status"));
			assert.ok(!phaseAllowedTools.includes("mcp__gsd-workflow__*"));
		} finally {
			process.chdir(originalCwd);
			rmSync(projectDir, { recursive: true, force: true });
			restore();
		}
	});

	test("buildSdkOptions preserves runtime callbacks such as onElicitation", () => {
		const restore = setWorkflowMcpEnv({});
		const onElicitation = async () => ({ action: "decline" as const });
		try {
			delete process.env.GSD_WORKFLOW_MCP_COMMAND;
			delete process.env.GSD_WORKFLOW_MCP_NAME;
			delete process.env.GSD_WORKFLOW_MCP_ARGS;
			delete process.env.GSD_WORKFLOW_MCP_ENV;
			delete process.env.GSD_WORKFLOW_MCP_CWD;
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, { onElicitation });
			assert.equal(options.onElicitation, onElicitation);
		} finally {
			restore();
		}
	});
});

describe("stream-adapter — workflow MCP readiness", () => {
	test("strict slice phase prompt omits workflow MCP question guidance when allowedTools omit it", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "claude-sdk-strict-question-prompt-")));
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: process.execPath,
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["-e", ""]),
			GSD_WORKFLOW_MCP_CWD: cwd,
		});
		const phases = [
			{ type: "research-slice", label: "Research Slice", expectedTool: "mcp__gsd-workflow__gsd_summary_save" },
			{ type: "plan-slice", label: "Plan Slice", expectedTool: "mcp__gsd-workflow__gsd_plan_slice" },
			{ type: "refine-slice", label: "Refine Slice", expectedTool: "mcp__gsd-workflow__gsd_plan_slice" },
		] as const;
		clearGuidedUnitContext();
		_setAutoActiveForTest(true);
		try {
			for (const phase of phases) {
				let capturedPrompt: unknown;
				let capturedAllowedTools: string[] | undefined;
				autoSession.currentUnit = { type: phase.type, id: "M001/S001", startedAt: 0, workspaceRoot: cwd } as never;
				const stream = streamViaClaudeCode(
					{ id: "claude-sonnet-4-6" } as any,
					{
						systemPrompt: `UNIT: ${phase.label}`,
						messages: [{ role: "user", content: "Complete the strict slice phase." } as Message],
					},
					{
						cwd,
						_skipWorkflowMcpPreflightForTest: true,
						async *_sdkQueryForTest(args: {
							prompt: string | AsyncIterable<unknown>;
							options?: Record<string, unknown>;
						}) {
							capturedPrompt = args.prompt;
							capturedAllowedTools = args.options?.allowedTools as string[] | undefined;
							yield {
								type: "result",
								subtype: "success",
								uuid: `result-${phase.type}`,
								session_id: `session-${phase.type}`,
								duration_ms: 1,
								duration_api_ms: 1,
								is_error: false,
								num_turns: 1,
								result: "completed",
								stop_reason: "end_turn",
								total_cost_usd: 0,
								usage: {
									input_tokens: 0,
									output_tokens: 0,
									cache_read_input_tokens: 0,
									cache_creation_input_tokens: 0,
								},
							};
						},
					} as any,
				);

				await stream.result();

				assert.equal(typeof capturedPrompt, "string", phase.type);
				const prompt = capturedPrompt as string;
				assert.ok(capturedAllowedTools?.includes(phase.expectedTool), phase.type);
				assert.ok(!capturedAllowedTools?.includes("mcp__gsd-workflow__ask_user_questions"), phase.type);
				assert.ok(!prompt.includes("mcp__gsd-workflow__ask_user_questions"), phase.type);
				assert.ok(!prompt.includes("Do not call bare ask_user_questions"), phase.type);
				assert.ok(
					prompt.includes("ToolSearch is available only for Claude Code deferred workflow MCP hydration"),
					phase.type,
				);
			}
		} finally {
			autoSession.currentUnit = null;
			_setAutoActiveForTest(false);
			restore();
			rmSync(cwd, { recursive: true, force: true });
			clearMcpConfigCache();
		}
	});

	test("resolves the workflow MCP preflight config from SDK mcpServers", () => {
		const workflowConfig = { command: "node", args: ["workflow-server.js"] };
		const browserConfig = { command: "gsd-browser" };

		assert.equal(
			resolveWorkflowMcpPreflightServerConfig(
				{ "gsd-workflow": workflowConfig, "gsd-browser": browserConfig },
				"gsd-workflow",
			),
			workflowConfig,
		);
		assert.equal(resolveWorkflowMcpPreflightServerConfig({ "gsd-workflow": "invalid" }, "gsd-workflow"), undefined);
		assert.equal(resolveWorkflowMcpPreflightServerConfig({ "gsd-workflow": workflowConfig }, undefined), undefined);
	});

	test("workflow MCP preflight uses the same inline config passed to the SDK", async () => {
		const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "claude-sdk-inline-preflight-")));
		const restore = setWorkflowMcpEnv({});
		let queryCalls = 0;
		try {
			const require = createRequire(import.meta.url);
			const mcpModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
			const stdioModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
			const serverPath = join(projectRoot, "fake-workflow-mcp-server.mjs");
			writeFileSync(
				serverPath,
				[
					`const { McpServer } = await import(${JSON.stringify(mcpModuleUrl)});`,
					`const { StdioServerTransport } = await import(${JSON.stringify(stdioModuleUrl)});`,
					'const server = new McpServer({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });',
					'server.tool("gsd_plan_slice", "Plan slice", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));',
					'server.tool("gsd_reassess_roadmap", "Reassess roadmap", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));',
					'await server.connect(new StdioServerTransport());',
				].join("\n"),
				"utf-8",
			);
			process.env.GSD_WORKFLOW_MCP_COMMAND = process.execPath;
			process.env.GSD_WORKFLOW_MCP_ARGS = JSON.stringify([serverPath]);
			process.env.GSD_WORKFLOW_MCP_NAME = "gsd-workflow";

			const stream = streamViaClaudeCode(
				{ id: "claude-sonnet-4-6" } as any,
				{
					systemPrompt: "UNIT: Plan Slice",
					messages: [{ role: "user", content: "Plan the next slice." } as Message],
				},
				{
					cwd: projectRoot,
					async *_sdkQueryForTest() {
						queryCalls += 1;
						yield {
							type: "result",
							subtype: "success",
							uuid: "result-1",
							session_id: "session-1",
							duration_ms: 1,
							duration_api_ms: 1,
							is_error: false,
							num_turns: 1,
							result: "planned",
							stop_reason: "end_turn",
							total_cost_usd: 0,
							usage: {
								input_tokens: 0,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						};
					},
				} as any,
			);

			const message = await stream.result();

			assert.equal(queryCalls, 1);
			assert.deepEqual(message.content, [{ type: "text", text: "planned" }]);
		} finally {
			restore();
			rmSync(projectRoot, { recursive: true, force: true });
			clearMcpConfigCache();
		}
	});

	test("emits visible progress text before workflow MCP readiness waits", () => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "claude-code",
			model: "claude-sonnet-4-6",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const events: any[] = [];
		const state = {};
		const message = buildWorkflowMcpReadinessProgressMessage({
			unitType: "complete-milestone",
			workflowServerName: "gsd-workflow",
			stage: "preflight",
		});

		pushWorkflowMcpReadinessProgressEvent({
			stream: { push: (event: any) => events.push(event) } as any,
			partial,
			state,
			message,
		});
		const retryMessage = buildWorkflowMcpReadinessProgressMessage({
			unitType: "complete-milestone",
			workflowServerName: "gsd-workflow",
			stage: "retry",
			attempt: 1,
			delayMs: 1_000,
		});
		pushWorkflowMcpReadinessProgressEvent({
			stream: { push: (event: any) => events.push(event) } as any,
			partial,
			state,
			message: retryMessage,
		});

		assert.deepEqual(events.map((event) => event.type), ["text_start", "text_delta", "text_delta"]);
		assert.match(events[1].delta, /Starting gsd-workflow MCP/);
		assert.match(events[1].delta, /complete-milestone/);
		assert.match(events[2].delta, /Still waiting for gsd-workflow MCP tools/);
		assert.match(events[2].delta, /Retrying in 1s/);
		assert.deepEqual(partial.content, [{ type: "text", text: `${message}\n${retryMessage}` }]);
	});

	test("execute-task requires gsd_exec before the model follows verification guidance", async () => {
		const error = await resolveClaudeCodeToolSurfaceReadinessError({
			unitType: "execute-task",
			workflowServerName: "gsd-workflow",
			observation: {
				tools: [
					"Read",
					"Bash",
					"mcp__gsd-workflow__gsd_task_complete",
					"mcp__gsd-workflow__gsd_exec_search",
					"mcp__gsd-workflow__gsd_resume",
					"mcp__gsd-workflow__gsd_capture_thought",
				],
				mcpServers: [{ name: "gsd-workflow", status: "connected" }],
			},
		});

		assert.match(error ?? "", /gsd_exec/);
	});

	test("complete-slice requires gsd_exec before the model follows closeout verification guidance", async () => {
		const error = await resolveClaudeCodeToolSurfaceReadinessError({
			unitType: "complete-slice",
			workflowServerName: "gsd-workflow",
			observation: {
				tools: [
					"Read",
					"mcp__gsd-workflow__gsd_slice_complete",
					"mcp__gsd-workflow__gsd_task_reopen",
					"mcp__gsd-workflow__gsd_replan_slice",
					"mcp__gsd-workflow__gsd_requirement_update",
					"mcp__gsd-workflow__gsd_summary_save",
					"mcp__gsd-workflow__gsd_capture_thought",
					"mcp__gsd-workflow__gsd_exec_search",
				],
				mcpServers: [{ name: "gsd-workflow", status: "connected" }],
			},
		});

		assert.match(error ?? "", /gsd_exec/);
	});

	test("complete-slice requires workflow MCP memory capture before closeout guidance can use it", async () => {
		const error = await resolveClaudeCodeToolSurfaceReadinessError({
			unitType: "complete-slice",
			workflowServerName: "gsd-workflow",
			observation: {
				tools: [
					"Read",
					"capture_thought",
					"mcp__gsd-workflow__gsd_exec",
					"mcp__gsd-workflow__gsd_slice_complete",
					"mcp__gsd-workflow__gsd_task_reopen",
					"mcp__gsd-workflow__gsd_replan_slice",
					"mcp__gsd-workflow__gsd_requirement_update",
					"mcp__gsd-workflow__gsd_summary_save",
				],
				mcpServers: [{ name: "gsd-workflow", status: "connected" }],
			},
		});

		assert.match(error ?? "", /gsd_capture_thought/);
	});

	test("terminal init surface remains not ready even when configured workflow MCP probes available", async () => {
		const previousGsdHome = process.env.GSD_HOME;
		const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "claude-sdk-mcp-pending-ready-")));
		const gsdHomeDir = realpathSync(mkdtempSync(join(tmpdir(), "claude-sdk-mcp-pending-home-")));
		try {
			process.env.GSD_HOME = gsdHomeDir;

			const require = createRequire(import.meta.url);
			const mcpModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
			const stdioModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
			const serverPath = join(projectRoot, "fake-workflow-mcp-server.mjs");
			writeFileSync(
				serverPath,
				[
					`const { McpServer } = await import(${JSON.stringify(mcpModuleUrl)});`,
					`const { StdioServerTransport } = await import(${JSON.stringify(stdioModuleUrl)});`,
					'const server = new McpServer({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });',
					'server.tool("gsd_plan_slice", "Plan slice", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));',
					'server.tool("gsd_reassess_roadmap", "Reassess roadmap", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));',
					'await server.connect(new StdioServerTransport());',
				].join("\n"),
				"utf-8",
			);
			writeFileSync(
				join(projectRoot, ".mcp.json"),
				JSON.stringify({ mcpServers: { "gsd-workflow": { command: process.execPath, args: [serverPath] } } }),
				"utf-8",
			);

			const error = await resolveClaudeCodeToolSurfaceReadinessError({
				unitType: "plan-slice",
				workflowServerName: "gsd-workflow",
				observation: {
					tools: ["Read", "Bash"],
					mcpServers: [{ name: "gsd-workflow", status: "failed" }],
				},
			});

			assert.match(error ?? "", /status is "failed"/);
			assert.match(error ?? "", /gsd_plan_slice/);
		} finally {
			if (previousGsdHome === undefined) {
				delete process.env.GSD_HOME;
			} else {
				process.env.GSD_HOME = previousGsdHome;
			}
			rmSync(projectRoot, { recursive: true, force: true });
			rmSync(gsdHomeDir, { recursive: true, force: true });
			clearMcpConfigCache();
		}
	});

	test("pending init surface is not accepted until the live Claude session exposes plan-slice tools", async () => {
		const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "claude-sdk-mcp-plan-pending-")));
		try {
			const require = createRequire(import.meta.url);
			const mcpModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
			const stdioModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
			const serverPath = join(projectRoot, "fake-workflow-mcp-server.mjs");
			writeFileSync(
				serverPath,
				[
					`const { McpServer } = await import(${JSON.stringify(mcpModuleUrl)});`,
					`const { StdioServerTransport } = await import(${JSON.stringify(stdioModuleUrl)});`,
					'const server = new McpServer({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });',
					'server.tool("gsd_plan_slice", "Plan slice", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));',
					'server.tool("gsd_reassess_roadmap", "Reassess roadmap", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));',
					'await server.connect(new StdioServerTransport());',
				].join("\n"),
				"utf-8",
			);
			writeFileSync(
				join(projectRoot, ".mcp.json"),
				JSON.stringify({ mcpServers: { "gsd-workflow": { command: process.execPath, args: [serverPath] } } }),
				"utf-8",
			);

			const error = await resolveClaudeCodeToolSurfaceReadinessError({
				unitType: "plan-slice",
				workflowServerName: "gsd-workflow",
				projectRoot,
				observation: {
					tools: ["Read", "Bash"],
					mcpServers: [{ name: "gsd-workflow", status: "pending" }],
				},
			});

			assert.match(error ?? "", /status is "pending"/);
			assert.match(error ?? "", /gsd_plan_slice/);
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
			clearMcpConfigCache();
		}
	});

	test("pending init surface can be deferred to Claude Code ToolSearch hydration", async () => {
		const error = await resolveClaudeCodeToolSurfaceReadinessError({
			unitType: "plan-slice",
			workflowServerName: "gsd-workflow",
			allowPendingToolSearchHydration: true,
			observation: {
				tools: ["Read", "Bash"],
				mcpServers: [{ name: "gsd-workflow", status: "pending" }],
			},
		});

		assert.equal(error, null);
	});

	test("complete-milestone pending init surface defers to Claude Code ToolSearch hydration", async () => {
		const error = await resolveClaudeCodeToolSurfaceReadinessError({
			unitType: "complete-milestone",
			workflowServerName: "gsd-workflow",
			allowPendingToolSearchHydration: true,
			observation: {
				tools: ["Read", "Bash"],
				mcpServers: [{ name: "gsd-workflow", status: "pending" }],
			},
		});

		assert.equal(error, null);
	});

	test("retries transient readiness errors internally but not terminal MCP failures", () => {
		const pendingError =
			'workflow tool surface not ready for run-uat: MCP server "gsd-workflow" status is "pending" (not yet connected): gsd_uat_exec';
		const partialError =
			'workflow tool surface not ready for run-uat: MCP server "gsd-workflow" is connected but has not registered: gsd_uat_exec';
		const terminalError =
			'workflow tool surface not ready for run-uat: MCP server "gsd-workflow" status is "failed" (terminal) — cannot register: gsd_uat_exec';

		assert.equal(shouldRetryClaudeCodeToolSurfaceReadiness(pendingError), true);
		assert.equal(shouldRetryClaudeCodeToolSurfaceReadiness(partialError), true);
		assert.equal(shouldRetryClaudeCodeToolSurfaceReadiness(terminalError), false);
		assert.equal(
			resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(pendingError, 0),
			500,
		);
		assert.equal(
			resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(pendingError, 1),
			1_000,
		);
		assert.equal(
			resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(partialError, 2),
			2_000,
		);
		assert.equal(resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(pendingError, 3), 4_000);
		assert.equal(resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(pendingError, 4), 8_000);
		assert.equal(resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(pendingError, 5), 15_000);
		assert.equal(resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(pendingError, 6), 15_000);
		assert.equal(resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(pendingError, 7), 15_000);
		assert.equal(resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(pendingError, 8), null);
		assert.equal(resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(pendingError, 0, true), 1_000);
		assert.equal(resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(pendingError, 9, true), 15_000);
		assert.equal(resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(pendingError, 10, true), null);
		assert.equal(resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(terminalError, 0), null);
	});
});

describe("stream-adapter — MCP elicitation bridge", () => {
	test("parseAskUserQuestionsElicitation rebuilds interview questions from the MCP schema", () => {
		const questions = parseAskUserQuestionsElicitation(askUserQuestionsRequest);
		assert.deepEqual(questions, [
			{
				id: "storage_scope",
				header: "Storage",
				question: "Does this app need to sync across devices?",
				options: [
					{ label: "Local-only (Recommended)", description: "" },
					{ label: "Cloud-synced", description: "" },
				],
				noteFieldId: "storage_scope__note",
			},
			{
				id: "platform",
				header: "Platform",
				question: "Where should it run?",
				options: [
					{ label: "Web", description: "" },
					{ label: "Desktop", description: "" },
					{ label: "Mobile", description: "" },
				],
				allowMultiple: true,
			},
		]);
	});

	test("roundResultToElicitationContent preserves notes for None of the above", () => {
		const questions = parseAskUserQuestionsElicitation(askUserQuestionsRequest);
		assert.ok(questions);

		const content = roundResultToElicitationContent(questions, {
			endInterview: false,
			answers: {
				storage_scope: {
					selected: "None of the above",
					notes: "Needs selective sync later",
				},
				platform: {
					selected: ["Web", "Desktop"],
					notes: "",
				},
			},
		});

		assert.deepEqual(content, {
			storage_scope: "None of the above",
			storage_scope__note: "Needs selective sync later",
			platform: ["Web", "Desktop"],
		});
	});

	test("createClaudeCodeElicitationHandler accepts interview-style answers from custom UI", async () => {
		const handler = createClaudeCodeElicitationHandler({
			custom: async (_factory: any) => ({
				endInterview: false,
				answers: {
					storage_scope: {
						selected: "Cloud-synced",
						notes: "",
					},
					platform: {
						selected: ["Web", "Mobile"],
						notes: "",
					},
				},
			}),
		} as any);

		assert.ok(handler);
		const result = await handler!(askUserQuestionsRequest, { signal: new AbortController().signal });
		assert.deepEqual(result, {
			action: "accept",
			content: {
				storage_scope: "Cloud-synced",
				platform: ["Web", "Mobile"],
			},
		});
	});

	test("createClaudeCodeElicitationHandler applies headless answers before UI prompts", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "gsd-headless-answers-"));
		const previous = process.env.GSD_HEADLESS_ANSWERS_PATH;
		try {
			const answersPath = join(tmp, "answers.json");
			writeFileSync(answersPath, JSON.stringify({
				questions: {
					storage_scope: "Cloud-synced",
					platform: ["Desktop", "Mobile"],
				},
				defaults: { strategy: "first_option" },
			}));
			process.env.GSD_HEADLESS_ANSWERS_PATH = answersPath;

			let customCalls = 0;
			const handler = createClaudeCodeElicitationHandler({
				custom: async () => {
					customCalls++;
					return undefined;
				},
				select: async () => {
					throw new Error("select should not be called when headless answers match");
				},
			} as any);
			assert.ok(handler);

			const result = await handler!(askUserQuestionsRequest, { signal: new AbortController().signal });
			assert.equal(customCalls, 0);
			assert.deepEqual(result, {
				action: "accept",
				content: {
					storage_scope: "Cloud-synced",
					platform: ["Desktop", "Mobile"],
				},
			});
		} finally {
			if (previous === undefined) delete process.env.GSD_HEADLESS_ANSWERS_PATH;
			else process.env.GSD_HEADLESS_ANSWERS_PATH = previous;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("createClaudeCodeElicitationHandler defaults dynamic depth gate IDs to the first option", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "gsd-headless-gate-answers-"));
		const previous = process.env.GSD_HEADLESS_ANSWERS_PATH;
		try {
			const answersPath = join(tmp, "answers.json");
			writeFileSync(answersPath, JSON.stringify({
				questions: {
					depth_verification_M001: "Proceed with planning (Recommended)",
				},
				defaults: { strategy: "first_option" },
			}));
			process.env.GSD_HEADLESS_ANSWERS_PATH = answersPath;

			const handler = createClaudeCodeElicitationHandler({ custom: async () => undefined } as any);
			assert.ok(handler);
			const result = await handler!({
				serverName: "gsd-workflow",
				message: "Please answer the following question(s).",
				mode: "form" as const,
				requestedSchema: {
					type: "object" as const,
					properties: {
						depth_verification_m001_confirm: {
							type: "string",
							title: "Depth",
							description: "Proceed with this headless milestone plan?",
							oneOf: [
								{ const: "Yes, you got it (Recommended)", title: "Yes, you got it (Recommended)" },
								{ const: "Not yet", title: "Not yet" },
							],
						},
					},
				},
			}, { signal: new AbortController().signal });

			assert.deepEqual(result, {
				action: "accept",
				content: {
					depth_verification_m001_confirm: "Yes, you got it (Recommended)",
				},
			});
		} finally {
			if (previous === undefined) delete process.env.GSD_HEADLESS_ANSWERS_PATH;
			else process.env.GSD_HEADLESS_ANSWERS_PATH = previous;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("createClaudeCodeElicitationHandler falls back to dialog prompts when custom UI is unavailable", async () => {
		const ui = {
			custom: async () => undefined,
			select: async (_title: string, options: string[], opts?: { allowMultiple?: boolean }) => {
				if (opts?.allowMultiple) return ["Desktop", "Mobile"];
				return options.includes("None of the above") ? "None of the above" : options[0];
			},
			input: async () => "CLI-only deployment target",
		};
		const handler = createClaudeCodeElicitationHandler(ui as any);
		assert.ok(handler);

		const result = await handler!(askUserQuestionsRequest, { signal: new AbortController().signal });
		assert.deepEqual(result, {
			action: "accept",
			content: {
				storage_scope: "None of the above",
				storage_scope__note: "CLI-only deployment target",
				platform: ["Desktop", "Mobile"],
			},
		});
	});

	test("createClaudeCodeElicitationHandler returns cancel when custom UI is dismissed", async () => {
		let selectCalls = 0;
		const handler = createClaudeCodeElicitationHandler({
			custom: async () => ({
				endInterview: false,
				answers: {},
			}),
			select: async () => {
				selectCalls++;
				return "Cloud-synced";
			},
		} as any);
		assert.ok(handler);

		const result = await handler!(askUserQuestionsRequest, { signal: new AbortController().signal });

		assert.deepEqual(result, { action: "cancel" });
		assert.equal(selectCalls, 0, "dismissed custom question must not re-open dialog fallback");
	});

	test("parseTextInputElicitation recognizes secure free-text MCP forms", () => {
		const request = {
			serverName: "gsd-workflow",
			message: "Enter values for environment variables.",
			mode: "form" as const,
			requestedSchema: {
				type: "object" as const,
				properties: {
					TEST_PASSWORD: {
						type: "string",
						title: "TEST_PASSWORD",
						description: "Format: min 8 characters\nLeave empty to skip.",
					},
					PROJECT_NAME: {
						type: "string",
						title: "PROJECT_NAME",
						description: "Human-readable project name.",
					},
				},
			},
		};

		const parsed = parseTextInputElicitation(request as any);
		assert.deepEqual(parsed, [
			{
				id: "TEST_PASSWORD",
				title: "TEST_PASSWORD",
				description: "Format: min 8 characters\nLeave empty to skip.",
				required: false,
				secure: true,
			},
			{
				id: "PROJECT_NAME",
				title: "PROJECT_NAME",
				description: "Human-readable project name.",
				required: false,
				secure: false,
			},
		]);
	});

	test("parseTextInputElicitation accepts legacy keys schema and skips unsupported fields", () => {
		const request = {
			serverName: "gsd-workflow",
			message: "Enter secure values",
			mode: "form" as const,
			requestedSchema: {
				type: "object" as const,
				keys: {
					API_TOKEN: {
						type: "string",
						title: "API_TOKEN",
						description: "Leave empty to skip.",
					},
					META: {
						type: "object",
						title: "metadata",
					},
				},
			},
		};

		const parsed = parseTextInputElicitation(request as any);
		assert.deepEqual(parsed, [
			{
				id: "API_TOKEN",
				title: "API_TOKEN",
				description: "Leave empty to skip.",
				required: false,
				secure: true,
			},
		]);
	});

	test("createClaudeCodeElicitationHandler collects secure_env_collect fields through input dialogs", async () => {
		const secureRequest = {
			serverName: "gsd-workflow",
			message: "Enter values for environment variables.",
			mode: "form" as const,
			requestedSchema: {
				type: "object" as const,
				properties: {
					TEST_SECURE_FIELD: {
						type: "string",
						title: "TEST_SECURE_FIELD",
						description: "Format: Your secure testing password\nLeave empty to skip.",
					},
				},
			},
		};

		const secureValue = "ui-collected-value";
		const inputCalls: Array<{ opts?: { secure?: boolean } }> = [];
		const handler = createClaudeCodeElicitationHandler({
			input: async (_title: string, _placeholder?: string, opts?: { secure?: boolean }) => {
				inputCalls.push({ opts });
				return secureValue;
			},
		} as any);
		assert.ok(handler);

		const result = await handler!(secureRequest as any, { signal: new AbortController().signal });
		assert.deepEqual(result, {
			action: "accept",
			content: {
				TEST_SECURE_FIELD: secureValue,
			},
		});
		assert.equal(inputCalls.length, 1);
		assert.equal(inputCalls[0]?.opts?.secure, true, "secure_env_collect fields should request secure input");
	});

	// -- self-cancel loop fix (#2676 / claude-code-cli) ----------------------
	//
	// Under claude-code-cli, ask_user_questions arrives as an SDK elicitation,
	// not an MCP tool dispatch, so the auto-mode watchdogs never saw an in-flight
	// tool during the human wait and re-dispatched/aborted the turn hosting the
	// question (the "self-cancel loop"). The fix brackets the human wait with the
	// interactive-tool guard and disambiguates a system-teardown abort (decline)
	// from a deliberate user dismissal (cancel).

	test("makes the SDK elicitation visible to the interactive-tool guard during the human wait", async () => {
		_setAutoActiveForTest(true);
		clearInFlightTools();
		try {
			let countDuringWait = -1;
			let interactiveDuringWait = false;
			const handler = createClaudeCodeElicitationHandler({
				custom: async () => {
					// Observe the in-flight guard state WHILE the question is open —
					// this is the window where the watchdogs previously saw 0 tools.
					countDuringWait = getInFlightToolCount();
					interactiveDuringWait = hasInteractiveToolInFlight();
					return {
						endInterview: false,
						answers: { storage_scope: { selected: "Cloud-synced", notes: "" }, platform: { selected: ["Web"], notes: "" } },
					};
				},
			} as any);
			assert.ok(handler);

			const result = await handler!(askUserQuestionsRequest, { signal: new AbortController().signal });

			assert.equal(countDuringWait, 1, "elicitation must register as an in-flight tool during the human wait");
			assert.equal(interactiveDuringWait, true, "elicitation must be recognized as an interactive tool during the wait");
			assert.equal(result.action, "accept");
			assert.equal(getInFlightToolCount(), 0, "in-flight tool must be cleared after the elicitation resolves");
		} finally {
			_setAutoActiveForTest(false);
			clearInFlightTools();
		}
	});

	test("clears the in-flight tool even when the interview UI throws (finally)", async () => {
		_setAutoActiveForTest(true);
		clearInFlightTools();
		try {
			const handler = createClaudeCodeElicitationHandler({
				// custom throws -> showInterviewRound rejects -> handler falls back
				// to dialogs; the in-flight entry must still be cleared via finally.
				custom: async () => {
					throw new Error("simulated UI failure");
				},
				select: async (_title: string, options: string[], opts?: { allowMultiple?: boolean }) => {
					if (opts?.allowMultiple) return ["Web"];
					return options[0];
				},
				input: async () => "note",
			} as any);
			assert.ok(handler);

			await handler!(askUserQuestionsRequest, { signal: new AbortController().signal });
			assert.equal(getInFlightToolCount(), 0, "in-flight tool must be cleared even when the UI throws");
		} finally {
			_setAutoActiveForTest(false);
			clearInFlightTools();
		}
	});

	test("returns decline (not cancel) when an interrupt empties the answers", async () => {
		// A system/host teardown that aborts the signal mid-wait surfaces as
		// interrupted:true -> the handler must return decline so the model does
		// not re-ask against a clean user-declined cancel (the re-ask amplifier).
		const handler = createClaudeCodeElicitationHandler({
			custom: async () => ({ endInterview: false, answers: {}, interrupted: true }),
			select: async () => {
				throw new Error("interrupted elicitation must not re-open dialogs");
			},
		} as any);
		assert.ok(handler);

		const result = await handler!(askUserQuestionsRequest, { signal: new AbortController().signal });
		assert.deepEqual(result, { action: "decline" });
	});

	test("expires the interview overlay before the MCP elicitation response is dropped", async (t) => {
		mock.timers.enable({ apis: ["setTimeout"] });
		t.after(() => {
			mock.timers.reset();
		});

		const notifications: Array<{ message: string; type?: string }> = [];
		let customOpened = false;
		const handler = createClaudeCodeElicitationHandler({
			custom: async (factory: any) => new Promise((resolve) => {
				customOpened = true;
				factory({ requestRender() {} } as any, {} as any, {} as any, resolve);
			}),
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			select: async () => {
				throw new Error("expired interview must not re-open dialog fallback");
			},
		} as any);
		assert.ok(handler);

		const resultPromise = handler!(askUserQuestionsRequest, { signal: new AbortController().signal });
		await Promise.resolve();
		assert.equal(customOpened, true);

		mock.timers.tick(CLAUDE_CODE_INTERVIEW_FORM_TIMEOUT_MS);
		const result = await resultPromise;

		assert.deepEqual(result, { action: "decline" });
		assert.deepEqual(notifications, [{
			message: "Question expired before you answered - the form was closed and no answers were sent.",
			type: "warning",
		}]);
		assert.equal(isInteractiveElicitationInFlight(), false, "marker must clear after deadline expiry");
	});

	test("returns cancel (today's semantics) when the user genuinely dismisses", async () => {
		const handler = createClaudeCodeElicitationHandler({
			custom: async () => ({ endInterview: false, answers: {} }),
		} as any);
		assert.ok(handler);

		const result = await handler!(askUserQuestionsRequest, { signal: new AbortController().signal });
		assert.deepEqual(result, { action: "cancel" });
	});

	test("does not register an in-flight tool outside auto-mode (wrapper self-gates)", async () => {
		_setAutoActiveForTest(false);
		clearInFlightTools();
		let countDuringWait = -1;
		const handler = createClaudeCodeElicitationHandler({
			custom: async () => {
				countDuringWait = getInFlightToolCount();
				return { endInterview: false, answers: { storage_scope: { selected: "Cloud-synced", notes: "" }, platform: { selected: ["Web"], notes: "" } } };
			},
		} as any);
		assert.ok(handler);

		await handler!(askUserQuestionsRequest, { signal: new AbortController().signal });
		assert.equal(countDuringWait, 0, "foreground/non-auto elicitation must not touch the in-flight guard");
	});

	// The FOREGROUND self-cancel regression guard: the s.active-gated in-flight
	// guard above is a no-op in foreground, so the foreground approval-gate pause
	// path needs a SEPARATE, ungated signal to see the elicitation as the active
	// human boundary. isInteractiveElicitationInFlight() must be true DURING the
	// wait and false after, even with auto inactive (#cc-elicitation-self-cancel).
	test("sets the ungated interactive-elicitation marker in FOREGROUND (auto inactive)", async () => {
		_setAutoActiveForTest(false);
		clearInFlightTools();
		try {
			let markerDuringWait = false;
			let countDuringWait = -1;
			const handler = createClaudeCodeElicitationHandler({
				custom: async () => {
					markerDuringWait = isInteractiveElicitationInFlight();
					countDuringWait = getInFlightToolCount();
					return {
						endInterview: false,
						answers: { storage_scope: { selected: "Cloud-synced", notes: "" }, platform: { selected: ["Web"], notes: "" } },
					};
				},
			} as any);
			assert.ok(handler);

			const result = await handler!(askUserQuestionsRequest, { signal: new AbortController().signal });

			assert.equal(markerDuringWait, true, "ungated marker must be true during the foreground human wait");
			assert.equal(countDuringWait, 0, "the separate marker must NOT touch the in-flight tool count in foreground");
			assert.equal(result.action, "accept");
			assert.equal(isInteractiveElicitationInFlight(), false, "marker must clear after the elicitation resolves");
		} finally {
			clearInFlightTools();
		}
	});

	test("clears the ungated marker even when the interview UI throws in FOREGROUND (finally)", async () => {
		_setAutoActiveForTest(false);
		clearInFlightTools();
		try {
			const handler = createClaudeCodeElicitationHandler({
				custom: async () => {
					throw new Error("ui exploded");
				},
			} as any);
			assert.ok(handler);
			await handler!(askUserQuestionsRequest, { signal: new AbortController().signal }).catch(() => undefined);
			assert.equal(isInteractiveElicitationInFlight(), false, "marker must clear via finally on throw");
		} finally {
			clearInFlightTools();
		}
	});
});

// ---------------------------------------------------------------------------
// F2 — abort vs stream-exhausted classification
// ---------------------------------------------------------------------------

describe("stream-adapter — abort classification (F2)", () => {
	test("recognizes Claude Code SDK abort exceptions", () => {
		assert.equal(isClaudeCodeAbortErrorMessage("Claude Code process aborted by user"), true);
		assert.equal(isClaudeCodeAbortErrorMessage("Request aborted by user"), true);
		assert.equal(isClaudeCodeAbortErrorMessage("AbortError: The operation was aborted"), true);
		assert.equal(isClaudeCodeAbortErrorMessage("rate limit exceeded"), false);
	});

	test("does not misclassify non-user abort contexts", () => {
		assert.equal(isClaudeCodeAbortErrorMessage("Job aborted due to timeout"), false);
		assert.equal(isClaudeCodeAbortErrorMessage("Operation aborted: disk full"), false);
		assert.equal(isClaudeCodeAbortErrorMessage("aborted by system cleanup"), false);
		assert.equal(isClaudeCodeAbortErrorMessage("Database transaction aborted due to constraint violation"), false);
		assert.equal(isClaudeCodeAbortErrorMessage("Connection aborted unexpectedly"), false);
	});

	test("makeAbortedMessage sets stopReason to 'aborted', not 'error'", () => {
		const message = makeAbortedMessage("claude-sonnet-4-6", "");
		assert.equal(message.stopReason, "aborted");
		assert.equal(message.errorMessage, undefined);
	});

	test("makeAbortedMessage preserves last-seen text content", () => {
		const message = makeAbortedMessage("claude-sonnet-4-6", "partial mid-stream text");
		assert.deepEqual(message.content, [{ type: "text", text: "partial mid-stream text" }]);
	});

	test("aborted message is distinguishable from stream-exhausted error", () => {
		const aborted = makeAbortedMessage("claude-sonnet-4-6", "");
		const exhausted = makeStreamExhaustedErrorMessage("claude-sonnet-4-6", "");
		assert.notEqual(aborted.stopReason, exhausted.stopReason);
		assert.equal(exhausted.errorMessage, "stream_exhausted_without_result");
	});

	test("abort catch preserves SDK diagnostic text instead of partial output", () => {
		const text = resolveClaudeCodeAbortedMessageText(
			"Request aborted by user\nAPI Error: 529 overloaded",
			"partial mid-stream text",
		);

		assert.equal(text, "Request aborted by user\nAPI Error: 529 overloaded");
	});

	test("abort catch falls back to partial output for bare abort markers", () => {
		const text = resolveClaudeCodeAbortedMessageText(
			"Request aborted by user",
			"partial mid-stream text",
		);

		assert.equal(text, "partial mid-stream text");
	});
});

// ---------------------------------------------------------------------------
// F3 — final-turn tool calls not dropped
// ---------------------------------------------------------------------------

describe("stream-adapter — final-turn tool-call merge (F3)", () => {
	function toolCall(id: string, name = "bash"): AssistantMessage["content"][number] {
		return { type: "toolCall", id, name, arguments: {} };
	}

	test("mergePendingToolCalls appends tool calls not already in intermediate", () => {
		const intermediate: AssistantMessage["content"] = [toolCall("tool-1")];
		const pending: AssistantMessage["content"] = [
			toolCall("tool-2"),
			{ type: "text", text: "trailing text" },
		];
		const merged = mergePendingToolCalls(intermediate, pending);
		assert.equal(merged.length, 2);
		assert.equal((merged[0] as any).id, "tool-1");
		assert.equal((merged[1] as any).id, "tool-2");
	});

	test("mergePendingToolCalls is idempotent across duplicate ids", () => {
		const intermediate: AssistantMessage["content"] = [toolCall("tool-1")];
		const pending: AssistantMessage["content"] = [toolCall("tool-1"), toolCall("tool-2")];
		const merged = mergePendingToolCalls(intermediate, pending);
		assert.equal(merged.length, 2);
		assert.deepEqual(
			merged.map((b) => (b as any).id),
			["tool-1", "tool-2"],
		);
	});

	test("mergePendingToolCalls ignores non-toolCall blocks from pending", () => {
		const intermediate: AssistantMessage["content"] = [];
		const pending: AssistantMessage["content"] = [
			{ type: "text", text: "hello" },
			{ type: "thinking", thinking: "pondering" },
			toolCall("tool-1"),
		];
		const merged = mergePendingToolCalls(intermediate, pending);
		assert.equal(merged.length, 1);
		assert.equal((merged[0] as any).id, "tool-1");
	});
});

// ---------------------------------------------------------------------------
// F10 — permission mode is configurable
// ---------------------------------------------------------------------------

describe("stream-adapter — permission mode (F10)", () => {
	// Earlier tests in this file set GSD_WORKFLOW_MCP_* env vars and restore
	// them by reassigning from `prev.*`. When `prev.*` was undefined, node
	// coerces the assignment to the literal string "undefined", which then
	// fails JSON.parse inside buildWorkflowMcpServers. Clear the relevant
	// slots before each permission-mode test so buildSdkOptions doesn't throw.
	function clearWorkflowMcpEnv(): void {
		for (const key of [
			"GSD_WORKFLOW_MCP_COMMAND",
			"GSD_WORKFLOW_MCP_NAME",
			"GSD_WORKFLOW_MCP_ARGS",
			"GSD_WORKFLOW_MCP_ENV",
			"GSD_WORKFLOW_MCP_CWD",
		]) {
			if (process.env[key] === undefined || process.env[key] === "undefined") {
				delete process.env[key];
			}
		}
	}

	test("buildSdkOptions defaults to bypassPermissions (globally unblocks all tools)", () => {
		clearWorkflowMcpEnv();
		const opts = buildSdkOptions("claude-sonnet-4-6", "test");
		assert.equal(opts.permissionMode, "bypassPermissions");
		assert.equal(
			opts.allowDangerouslySkipPermissions,
			true,
			"allowDangerouslySkipPermissions must be true when permissionMode is bypassPermissions",
		);
	});

	test("buildSdkOptions respects explicit acceptEdits override", () => {
		clearWorkflowMcpEnv();
		const opts = buildSdkOptions("claude-sonnet-4-6", "test", { permissionMode: "acceptEdits" });
		assert.equal(opts.permissionMode, "acceptEdits");
		assert.equal(
			opts.allowDangerouslySkipPermissions,
			false,
			"allowDangerouslySkipPermissions must be false for non-bypass modes",
		);
	});

	test("resolveClaudePermissionMode defaults to bypassPermissions when no env var is set (globally unblocks all tools)", async () => {
		const mode = await resolveClaudePermissionMode({});
		assert.equal(mode, "bypassPermissions");
	});

	test("resolveClaudePermissionMode honours the GSD_CLAUDE_CODE_PERMISSION_MODE env override", async () => {
		const env = { GSD_CLAUDE_CODE_PERMISSION_MODE: "acceptEdits" } as NodeJS.ProcessEnv;
		const mode = await resolveClaudePermissionMode(env);
		assert.equal(mode, "acceptEdits");
	});

	test("resolveClaudePermissionMode rejects unknown override values (fallback path)", async () => {
		const env = { GSD_CLAUDE_CODE_PERMISSION_MODE: "nonsense" } as NodeJS.ProcessEnv;
		const mode = await resolveClaudePermissionMode(env);
		// Unknown override falls back to auto-detect → either bypass or acceptEdits
		assert.ok(
			mode === "bypassPermissions" || mode === "acceptEdits",
			`expected bypass or acceptEdits, got ${mode}`,
		);
	});

	test("resolveClaudePermissionMode flips to bypassPermissions when GSD_HEADLESS=1 (#4657)", async () => {
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			const env = { GSD_HEADLESS: "1" } as NodeJS.ProcessEnv;
			const mode = await resolveClaudePermissionMode(env);
			assert.equal(mode, "bypassPermissions");
		} finally {
			console.warn = originalWarn;
		}
	});

	test("resolveClaudePermissionMode: explicit override wins over GSD_HEADLESS=1", async () => {
		const env = {
			GSD_HEADLESS: "1",
			GSD_CLAUDE_CODE_PERMISSION_MODE: "acceptEdits",
		} as NodeJS.ProcessEnv;
		const mode = await resolveClaudePermissionMode(env);
		assert.equal(mode, "acceptEdits");
	});
});

describe("stream-adapter — Windows Claude path lookup (#3770)", () => {
	test("getClaudeLookupCommand uses where on Windows", () => {
		assert.equal(getClaudeLookupCommand("win32"), "where claude");
	});

	test("getClaudeLookupCommand uses which on non-Windows platforms", () => {
		assert.equal(getClaudeLookupCommand("darwin"), "which claude");
		assert.equal(getClaudeLookupCommand("linux"), "which claude");
	});

	test("parseClaudeLookupOutput prefers .exe on win32 when where output includes shims", () => {
		const output = [
			"C:\\Users\\djeff\\AppData\\Roaming\\npm\\claude",
			"C:\\Users\\djeff\\AppData\\Roaming\\npm\\claude.cmd",
			"C:\\Program Files\\Claude\\claude.exe",
		].join("\r\n");
		assert.equal(parseClaudeLookupOutput(output, "win32"), "C:\\Program Files\\Claude\\claude.exe");
	});

	test("parseClaudeLookupOutput keeps first line on non-win32 platforms", () => {
		const output = "/usr/local/bin/claude\n/opt/homebrew/bin/claude\n";
		assert.equal(parseClaudeLookupOutput(output, "darwin"), "/usr/local/bin/claude");
	});

	test("normalizeClaudePathForSdk swaps Windows shim paths to bundled cli.js", () => {
		const shimPath = "C:\\Users\\djeff\\AppData\\Roaming\\npm\\claude";
		const bundled = "C:\\repo\\node_modules\\@anthropic-ai\\claude-agent-sdk\\cli.js";
		assert.equal(normalizeClaudePathForSdk(shimPath, "win32", bundled), "C:/repo/node_modules/@anthropic-ai/claude-agent-sdk/cli.js");
		assert.equal(normalizeClaudePathForSdk("C:\\Program Files\\Claude\\claude.exe", "win32", bundled), "C:/Program Files/Claude/claude.exe");
	});

	test("resolveBundledClaudeCliPath returns a .js path when SDK package is present", () => {
		const resolved = resolveBundledClaudeCliPath();
		assert.ok(resolved, "expected sdk cli.js to be resolvable in test workspace");
		assert.match(resolved!, /[\\/]@anthropic-ai[\\/]claude-agent-sdk[\\/]cli\.js$/);
	});
});

describe("stream-adapter — concurrent Claude Code process warning (#1464)", () => {
	test("identifies Claude Code SDK stream-json command lines", () => {
		assert.equal(
			isClaudeCodeSdkProcessArgv(["claude", "--output-format", "stream-json", "--input-format", "stream-json"]),
			true,
		);
		assert.equal(
			isClaudeCodeSdkProcessArgv(["node", "/repo/node_modules/@anthropic-ai/claude-agent-sdk/cli.js", "--output-format=stream-json", "--input-format=stream-json"]),
			true,
		);
		assert.equal(isClaudeCodeSdkProcessArgv(["claude", "--version"]), false);
	});

	test("finds only other SDK processes in the same cwd from proc entries", () => {
		const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "claude-sdk-concurrent-project-")));
		const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), "claude-sdk-concurrent-other-")));
		const procRoot = mkdtempSync(join(tmpdir(), "claude-sdk-proc-"));

		function writeProc(pid: number, cwd: string, argv: string[]): void {
			const dir = join(procRoot, String(pid));
			mkdirSync(dir, { recursive: true });
			symlinkSync(cwd, join(dir, "cwd"), process.platform === "win32" ? "junction" : "dir");
			writeFileSync(join(dir, "cmdline"), `${argv.join("\0")}\0`, "utf-8");
		}

		try {
			writeProc(100, projectRoot, ["claude", "--output-format", "stream-json", "--input-format", "stream-json"]);
			writeProc(101, projectRoot, ["claude", "--version"]);
			writeProc(102, otherRoot, ["claude", "--output-format", "stream-json", "--input-format", "stream-json"]);
			writeProc(200, projectRoot, ["claude", "--output-format", "stream-json", "--input-format", "stream-json"]);

			const matches = findConcurrentClaudeCodeProcesses(projectRoot, { procRoot, currentPid: 200 });

			assert.deepEqual(matches.map((processInfo) => processInfo.pid), [100]);
			assert.equal(matches[0]?.cwd, projectRoot);
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
			rmSync(otherRoot, { recursive: true, force: true });
			rmSync(procRoot, { recursive: true, force: true });
		}
	});

	test("emits a visible startup warning before continuing the SDK session", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "claude-sdk-concurrent-warning-")));
		const events: any[] = [];
		const notifications: Array<{ message: string; type?: string }> = [];

		try {
			const stream = streamViaClaudeCode(
				{ id: "claude-sonnet-4-6" } as any,
				{ messages: [{ role: "user", content: "Continue." } as Message] },
				{
					cwd,
					extensionUIContext: {
						notify(message: string, type?: string) {
							notifications.push({ message, type });
						},
					},
					_findConcurrentClaudeCodeProcessesForTest: () => [{
						pid: 1234,
						cwd,
						command: "claude --output-format stream-json --input-format stream-json",
					}],
					async *_sdkQueryForTest() {
						yield makeSdkSuccessResult("finished");
					},
				} as any,
			);

			for await (const event of stream) {
				events.push(event);
			}

			const warningText = events
				.filter((event) => event.type === "text_delta")
				.map((event) => event.delta)
				.join("\n");
			assert.match(warningText, /Another Claude Code SDK process is already running/);
			assert.match(warningText, /PID 1234/);
			assert.match(warningText, /TaskList\/TaskGet\/TaskOutput/);
			assert.deepEqual(notifications, [{
				message: buildConcurrentClaudeCodeProcessWarning(cwd, [{
					pid: 1234,
					cwd,
					command: "claude --output-format stream-json --input-format stream-json",
				}]),
				type: "warning",
			}]);
			const done = events.find((event) => event.type === "done");
			assert.deepEqual(done?.message.content, [{ type: "text", text: "finished" }]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// canUseTool handler (#4383)
// ---------------------------------------------------------------------------

describe("stream-adapter — canUseTool handler", () => {
	function makeOptions(overrides: Partial<{ signal: AbortSignal; suggestions: Array<Record<string, unknown>>; title: string; description: string; toolUseID: string }> = {}) {
		return {
			signal: overrides.signal ?? new AbortController().signal,
			toolUseID: overrides.toolUseID ?? "toolu_test123",
			...(overrides.title !== undefined ? { title: overrides.title } : {}),
			...(overrides.description !== undefined ? { description: overrides.description } : {}),
			...(overrides.suggestions !== undefined ? { suggestions: overrides.suggestions } : {}),
		};
	}

	// Point process.cwd() at an empty temp dir so the real repo's
	// .claude/settings.local.json (which may already contain rules like
	// "Bash(gh pr list:*)") does not short-circuit the permission flow.
	// Returns a cleanup function that restores cwd and removes the temp dir.
	// biome-ignore lint/suspicious/noExplicitAny: test-only monkey-patch
	function withIsolatedCwd(): () => void {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-canusetool-")));
		const orig = process.cwd;
		process.cwd = () => dir;
		return () => {
			process.cwd = orig;
			rmSync(dir, { recursive: true, force: true });
		};
	}

	test("returns undefined when no UI context is provided", () => {
		const handler = createClaudeCodeCanUseToolHandler(undefined);
		assert.equal(handler, undefined);
	});

	test("shows select dialog with Allow/Always Allow/Deny and returns allow", async () => {
		let selectPrompt = "";
		let selectOptions: string[] = [];
		const ui = {
			select: async (prompt: string, options: string[]) => {
				selectPrompt = prompt;
				selectOptions = options;
				return "Allow";
			},
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		assert.ok(handler);

		const input = { command: "ls -la" };
		const result = await handler!("Bash", input, makeOptions({
			title: "Claude wants to run: ls -la",
			description: "List directory contents",
		}));

		assert.equal(result.behavior, "allow");
		assert.deepEqual((result as any).updatedInput, input);
		assert.equal((result as any).toolUseID, "toolu_test123");
		// Allow (one-time) should NOT include updatedPermissions
		assert.equal((result as any).updatedPermissions, undefined);
		assert.deepEqual(selectOptions, ["Allow", "Always Allow", "Deny"]);
		// Prompt includes title and input summary
		assert.ok(selectPrompt.includes("Claude wants to run: ls -la"));
		assert.ok(selectPrompt.includes("ls -la"));
	});

	test("returns deny when user selects Deny", async () => {
		const ui = {
			select: async () => "Deny",
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("Bash", { command: "rm -rf /" }, makeOptions());

		assert.equal(result.behavior, "deny");
		assert.equal((result as any).message, "User denied");
		assert.equal((result as any).toolUseID, "toolu_test123");
	});

	test("returns deny when user dismisses dialog (undefined)", async () => {
		const ui = {
			select: async () => undefined,
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("Bash", { command: "echo hi" }, makeOptions());

		assert.equal(result.behavior, "deny");
		assert.equal((result as any).message, "User denied");
	});

	test("Always Allow for Bash patches SDK suggestions with smart ruleContent", async () => {
		const notified: string[] = [];
		const ui = { select: async (_p: string, opts: string[]) => opts.find((o) => o.startsWith("Always Allow"))!, notify: (msg: string) => notified.push(msg) };
		const suggestions = [{
			type: "addRules",
			rules: [{ toolName: "Bash", ruleContent: "ls -la /tmp" }],
			behavior: "allow",
			destination: "localSettings",
		}];

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("Bash", { command: "ls -la /tmp" }, makeOptions({ suggestions }));

		assert.equal(result.behavior, "allow");
		// Should patch ruleContent with our smart pattern, preserving SDK structure
		assert.deepEqual((result as any).updatedPermissions, [{
			type: "addRules",
			rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
			behavior: "allow",
			destination: "localSettings",
		}]);
		assert.equal(notified.length, 1);
		assert.ok(notified[0].includes("Saved:") && notified[0].includes("Bash(ls:*)"));
	});

	test("Always Allow for Bash with subcommand-sensitive CLI captures verb", async () => {
		const cleanup = withIsolatedCwd();
		try {
			const notified: string[] = [];
			// First select call: pick "Always Allow ..."; second call (level
			// picker): pick the "git push" granularity explicitly.
			let selectCall = 0;
			const ui = {
				select: async (_p: string, opts: string[]) => {
					selectCall++;
					if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"))!;
					return "Bash(git push:*)";
				},
				notify: (msg: string) => notified.push(msg),
			};
			const suggestions = [{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: "git push origin main" }],
				behavior: "allow",
				destination: "localSettings",
			}];

			const handler = createClaudeCodeCanUseToolHandler(ui as any);
			const result = await handler!("Bash", { command: "git push origin main" }, makeOptions({ suggestions }));

			assert.equal(result.behavior, "allow");
			assert.deepEqual((result as any).updatedPermissions, [{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: "git push:*" }],
				behavior: "allow",
				destination: "localSettings",
			}]);
			assert.ok(notified[0].includes("Saved:") && notified[0].includes("Bash(git push:*)"));
		} finally {
			cleanup();
		}
	});

	test("Always Allow for Bash without suggestions builds proper PermissionUpdate", async () => {
		const cleanup = withIsolatedCwd();
		try {
			const notified: string[] = [];
			let selectCall = 0;
			const ui = {
				select: async (_p: string, opts: string[]) => {
					selectCall++;
					if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"))!;
					return "Bash(gh pr list:*)";
				},
				notify: (msg: string) => notified.push(msg),
			};

			const handler = createClaudeCodeCanUseToolHandler(ui as any);
			const result = await handler!("Bash", { command: "gh pr list" }, makeOptions());

			assert.equal(result.behavior, "allow");
			// No SDK suggestions → builds PermissionUpdate from scratch
			assert.deepEqual((result as any).updatedPermissions, [{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: "gh pr list:*" }],
				behavior: "allow",
				destination: "localSettings",
			}]);
			assert.ok(notified[0].includes("Saved:") && notified[0].includes("Bash(gh pr list:*)"));
		} finally {
			cleanup();
		}
	});

	test("Always Allow for non-Bash tools passes SDK suggestions through", async () => {
		const notified: string[] = [];
		const ui = { select: async (_p: string, opts: string[]) => opts.find((o) => o.startsWith("Always Allow"))!, notify: (msg: string) => notified.push(msg) };
		const suggestions = [{
			type: "addRules",
			rules: [{ toolName: "Write" }],
			behavior: "allow",
			destination: "localSettings",
		}];

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("Write", { file_path: "/tmp/test.txt" }, makeOptions({ suggestions }));

		assert.equal(result.behavior, "allow");
		assert.deepEqual((result as any).updatedPermissions, suggestions);
		// Non-Bash tools don't emit a post-selection notification (only Bash runs the level picker)
		assert.equal(notified.length, 0);
	});

	test("Always Allow for non-Bash without suggestions builds tool-name-only fallback rule", async () => {
		const notified: string[] = [];
		const ui = { select: async (_p: string, opts: string[]) => opts.find((o) => o.startsWith("Always Allow"))!, notify: (msg: string) => notified.push(msg) };

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("AskUserQuestion", { questions: [{ question: "?", header: "h", multiSelect: false, options: [] }] }, makeOptions());

		assert.equal(result.behavior, "allow");
		assert.deepEqual((result as any).updatedPermissions, [{
			type: "addRules",
			rules: [{ toolName: "AskUserQuestion" }],
			behavior: "allow",
			destination: "localSettings",
		}]);
		assert.equal(notified.length, 1);
		assert.match(notified[0], /AskUserQuestion/);
	});

	test("Always Allow for non-Bash with empty suggestions array builds tool-name-only fallback rule", async () => {
		const notified: string[] = [];
		const ui = { select: async (_p: string, opts: string[]) => opts.find((o) => o.startsWith("Always Allow"))!, notify: (msg: string) => notified.push(msg) };

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("AskUserQuestion", { questions: [{ question: "?", header: "h", multiSelect: false, options: [] }] }, makeOptions({ suggestions: [] }));

		assert.equal(result.behavior, "allow");
		assert.deepEqual((result as any).updatedPermissions, [{
			type: "addRules",
			rules: [{ toolName: "AskUserQuestion" }],
			behavior: "allow",
			destination: "localSettings",
		}]);
		assert.equal(notified.length, 1);
		assert.match(notified[0], /AskUserQuestion/);
	});

	test("prompt includes command text for Bash tools", async () => {
		let selectPrompt = "";
		const ui = {
			select: async (prompt: string) => {
				selectPrompt = prompt;
				return "Allow";
			},
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		await handler!("Bash", { command: "git status" }, makeOptions());
		assert.ok(selectPrompt.includes("git status"), `prompt should include command: ${selectPrompt}`);
	});

	test("prompt includes file_path for file tools", async () => {
		let selectPrompt = "";
		const ui = {
			select: async (prompt: string) => {
				selectPrompt = prompt;
				return "Allow";
			},
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		await handler!("Write", { file_path: "/tmp/test.txt", content: "hello" }, makeOptions());
		assert.ok(selectPrompt.includes("/tmp/test.txt"), `prompt should include file path: ${selectPrompt}`);
	});

	test("uses title from options when available", async () => {
		let selectPrompt = "";
		const ui = {
			select: async (prompt: string) => {
				selectPrompt = prompt;
				return "Allow";
			},
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		await handler!("WebFetch", {}, makeOptions({ title: "Claude wants to fetch: https://example.com" }));
		assert.ok(selectPrompt.includes("Claude wants to fetch: https://example.com"));
	});

	test("falls back to default title when options.title is missing", async () => {
		let selectPrompt = "";
		const ui = {
			select: async (prompt: string) => {
				selectPrompt = prompt;
				return "Allow";
			},
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		await handler!("WebFetch", { url: "https://example.com" }, makeOptions());
		assert.ok(selectPrompt.includes("Allow Claude Code to use: WebFetch?"));
	});

	test("returns deny when signal is already aborted", async () => {
		const ui = {
			select: async () => { throw new Error("should not be called"); },
		};

		const controller = new AbortController();
		controller.abort();

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("Bash", {}, makeOptions({ signal: controller.signal }));

		assert.equal(result.behavior, "deny");
		assert.equal((result as any).message, "Aborted");
	});

	test("returns deny when ui.select throws", async () => {
		const ui = {
			select: async () => { throw new Error("dialog crashed"); },
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("Bash", {}, makeOptions());

		assert.equal(result.behavior, "deny");
		assert.equal((result as any).message, "Aborted");
	});

	test("buildSdkOptions passes canUseTool through extraOptions", () => {
		const canUseTool = async () => ({ behavior: "allow" as const, updatedInput: {}, toolUseID: "test" });
		const opts = buildSdkOptions("claude-sonnet-4-6", "test", undefined, { canUseTool });
		assert.equal(opts.canUseTool, canUseTool);
	});

	test("Always Allow shows level picker and user broadens to base command", async () => {
		const cleanup = withIsolatedCwd();
		try {
			const prompts: string[] = [];
			const levelOpts: string[][] = [];
			let selectCall = 0;
			const ui = {
				select: async (prompt: string, opts: string[]) => {
					prompts.push(prompt);
					selectCall++;
					if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"))!;
					levelOpts.push(opts);
					return "Bash(gh:*)";
				},
				notify: () => {},
			};

			const handler = createClaudeCodeCanUseToolHandler(ui as any);
			const result = await handler!("Bash", { command: "gh pr list" }, makeOptions());

			assert.equal(result.behavior, "allow");
			assert.deepEqual((result as any).updatedPermissions, [{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: "gh:*" }],
				behavior: "allow",
				destination: "localSettings",
			}]);
			// Second dialog offered every granularity level
			assert.deepEqual(levelOpts[0], [
				"Bash(gh:*)",
				"Bash(gh pr:*)",
				"Bash(gh pr list:*)",
			]);
			assert.ok(prompts[1].includes("Save permission at which level?"));
		} finally {
			cleanup();
		}
	});

	test("Always Allow narrows to mid-level pattern when user picks Bash(gh pr:*)", async () => {
		const cleanup = withIsolatedCwd();
		try {
			let selectCall = 0;
			const ui = {
				select: async (_p: string, opts: string[]) => {
					selectCall++;
					if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"))!;
					return "Bash(gh pr:*)";
				},
				notify: () => {},
			};

			const handler = createClaudeCodeCanUseToolHandler(ui as any);
			const result = await handler!("Bash", { command: "gh pr list --limit 5" }, makeOptions());

			assert.equal(result.behavior, "allow");
			assert.deepEqual((result as any).updatedPermissions, [{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: "gh pr:*" }],
				behavior: "allow",
				destination: "localSettings",
			}]);
		} finally {
			cleanup();
		}
	});

	test("Always Allow skips level picker when only one pattern is available", async () => {
		const cleanup = withIsolatedCwd();
		try {
			const prompts: string[] = [];
			const ui = {
				select: async (prompt: string, opts: string[]) => {
					prompts.push(prompt);
					return opts.find((o) => o.startsWith("Always Allow"))!;
				},
				notify: () => {},
			};

			const handler = createClaudeCodeCanUseToolHandler(ui as any);
			const result = await handler!("Bash", { command: "ls -la /tmp" }, makeOptions());

			assert.equal(result.behavior, "allow");
			// "ls" has no subcommand tokens before the flag → single-option path
			assert.equal(prompts.length, 1, "should not show a second dialog");
			assert.deepEqual((result as any).updatedPermissions, [{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
				behavior: "allow",
				destination: "localSettings",
			}]);
		} finally {
			cleanup();
		}
	});

	test("Always Allow denies the tool when level picker is dismissed", async () => {
		const cleanup = withIsolatedCwd();
		try {
			const notified: string[] = [];
			let selectCall = 0;
			const ui = {
				select: async (_p: string, opts: string[]) => {
					selectCall++;
					if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"))!;
					return undefined; // user dismissed level picker
				},
				notify: (msg: string) => notified.push(msg),
			};

			const handler = createClaudeCodeCanUseToolHandler(ui as any);
			const result = await handler!("Bash", { command: "gh pr list" }, makeOptions());

			// Dismissing the level picker cancels the tool use — a one-time allow
			// would leave the spawned agent running even though the user bailed.
			assert.equal(result.behavior, "deny");
			assert.equal((result as any).updatedPermissions, undefined);
			assert.equal(notified.length, 0, "no 'Saved:' notification when nothing was saved");
		} finally {
			cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// buildBashPermissionPattern — smart permission granularity
// ---------------------------------------------------------------------------

describe("buildBashPermissionPattern", () => {
	test("simple command wildcards all args", () => {
		assert.equal(buildBashPermissionPattern("ping -n 4 localhost"), "Bash(ping:*)");
		assert.equal(buildBashPermissionPattern("echo hello world"), "Bash(echo:*)");
		assert.equal(buildBashPermissionPattern("ls -la /tmp"), "Bash(ls:*)");
		assert.equal(buildBashPermissionPattern("node server.js"), "Bash(node:*)");
	});

	test("git captures one subcommand", () => {
		assert.equal(buildBashPermissionPattern("git push origin main"), "Bash(git push:*)");
		assert.equal(buildBashPermissionPattern("git log --oneline"), "Bash(git log:*)");
		assert.equal(buildBashPermissionPattern("git status"), "Bash(git status:*)");
	});

	test("gh captures two subcommands", () => {
		assert.equal(buildBashPermissionPattern("gh pr list"), "Bash(gh pr list:*)");
		assert.equal(buildBashPermissionPattern("gh pr create --title foo"), "Bash(gh pr create:*)");
		assert.equal(buildBashPermissionPattern("gh issue view 123"), "Bash(gh issue view:*)");
	});

	test("npm captures one subcommand", () => {
		assert.equal(buildBashPermissionPattern("npm install lodash"), "Bash(npm install:*)");
		assert.equal(buildBashPermissionPattern("npm publish"), "Bash(npm publish:*)");
		assert.equal(buildBashPermissionPattern("npm run test"), "Bash(npm run:*)");
	});

	test("npx captures package name", () => {
		assert.equal(buildBashPermissionPattern("npx vitest run"), "Bash(npx vitest:*)");
		assert.equal(buildBashPermissionPattern("npx --version"), "Bash(npx --version:*)");
	});

	test("docker captures one subcommand", () => {
		assert.equal(buildBashPermissionPattern("docker ps -a"), "Bash(docker ps:*)");
		assert.equal(buildBashPermissionPattern("docker rm container1"), "Bash(docker rm:*)");
	});

	test("aws captures two subcommands", () => {
		assert.equal(buildBashPermissionPattern("aws s3 cp file.txt s3://bucket/"), "Bash(aws s3 cp:*)");
		assert.equal(buildBashPermissionPattern("aws ec2 describe-instances"), "Bash(aws ec2 describe-instances:*)");
	});

	test("skips sudo wrapper", () => {
		assert.equal(buildBashPermissionPattern("sudo ping localhost"), "Bash(ping:*)");
		assert.equal(buildBashPermissionPattern("sudo git push"), "Bash(git push:*)");
	});

	test("skips env wrapper and VAR=val assignments", () => {
		assert.equal(buildBashPermissionPattern("env NODE_ENV=prod node server.js"), "Bash(node:*)");
		assert.equal(buildBashPermissionPattern("NODE_ENV=prod node server.js"), "Bash(node:*)");
		assert.equal(buildBashPermissionPattern("FOO=bar BAZ=qux git push"), "Bash(git push:*)");
	});

	test("strips path from executable", () => {
		assert.equal(buildBashPermissionPattern("/usr/bin/git push"), "Bash(git push:*)");
		assert.equal(buildBashPermissionPattern("C:\\Windows\\ping.exe localhost"), "Bash(ping:*)");
	});

	test("empty or whitespace-only command", () => {
		assert.equal(buildBashPermissionPattern(""), "Bash(*)");
		assert.equal(buildBashPermissionPattern("   "), "Bash(*)");
	});

	test("chained commands — extracts pattern from the meaningful segment", () => {
		assert.equal(buildBashPermissionPattern("cd /foo && gh pr list --limit 5"), "Bash(gh pr list:*)");
		assert.equal(buildBashPermissionPattern("cd C:/Users/djeff/repos/gsd-pi && gh pr list --limit 5"), "Bash(gh pr list:*)");
		assert.equal(buildBashPermissionPattern("cd /tmp && git push origin main"), "Bash(git push:*)");
		assert.equal(buildBashPermissionPattern("export FOO=1 && npm install lodash"), "Bash(npm install:*)");
		assert.equal(buildBashPermissionPattern("mkdir -p out; docker ps -a"), "Bash(docker ps:*)");
		assert.equal(buildBashPermissionPattern("echo start || ping localhost"), "Bash(ping:*)");
	});

	test("skips trailing || true / || : error suppressors", () => {
		assert.equal(
			buildBashPermissionPattern("cd C:/Users/djeff/repos/gsd-pi && gh pr create --dry-run --title \"test\" --body \"test\" 2>&1 || true"),
			"Bash(gh pr create:*)",
		);
		assert.equal(buildBashPermissionPattern("gh pr list || true"), "Bash(gh pr list:*)");
		assert.equal(buildBashPermissionPattern("git push || :"), "Bash(git push:*)");
		assert.equal(buildBashPermissionPattern("cd /tmp && npm install || echo failed"), "Bash(npm install:*)");
	});

	test("single command is unaffected by chain extraction", () => {
		assert.equal(buildBashPermissionPattern("gh pr list"), "Bash(gh pr list:*)");
		assert.equal(buildBashPermissionPattern("git push origin main"), "Bash(git push:*)");
	});
});

// ---------------------------------------------------------------------------
// buildBashPermissionPatternOptions — granularity level menu
// ---------------------------------------------------------------------------

describe("buildBashPermissionPatternOptions", () => {
	test("offers every prefix from base to full subcommand chain", () => {
		assert.deepEqual(buildBashPermissionPatternOptions("gh pr list"), [
			"Bash(gh:*)",
			"Bash(gh pr:*)",
			"Bash(gh pr list:*)",
		]);
		assert.deepEqual(buildBashPermissionPatternOptions("git push origin main"), [
			"Bash(git:*)",
			"Bash(git push:*)",
			"Bash(git push origin:*)",
			"Bash(git push origin main:*)",
		]);
	});

	test("stops at first flag — flags are args, not verbs", () => {
		assert.deepEqual(buildBashPermissionPatternOptions("gh pr create --title foo"), [
			"Bash(gh:*)",
			"Bash(gh pr:*)",
			"Bash(gh pr create:*)",
		]);
		assert.deepEqual(buildBashPermissionPatternOptions("git log --oneline"), [
			"Bash(git:*)",
			"Bash(git log:*)",
		]);
	});

	test("single-option when there is no subcommand to choose from", () => {
		assert.deepEqual(buildBashPermissionPatternOptions("ls -la /tmp"), ["Bash(ls:*)"]);
		assert.deepEqual(buildBashPermissionPatternOptions("ping -n 4 localhost"), ["Bash(ping:*)"]);
		assert.deepEqual(buildBashPermissionPatternOptions("node"), ["Bash(node:*)"]);
	});

	test("extracts meaningful segment from compound commands", () => {
		assert.deepEqual(buildBashPermissionPatternOptions("cd /foo && gh pr list"), [
			"Bash(gh:*)",
			"Bash(gh pr:*)",
			"Bash(gh pr list:*)",
		]);
		assert.deepEqual(buildBashPermissionPatternOptions("gh pr create --dry-run || true"), [
			"Bash(gh:*)",
			"Bash(gh pr:*)",
			"Bash(gh pr create:*)",
		]);
	});

	test("caps at three subcommand tokens to keep the menu short", () => {
		const result = buildBashPermissionPatternOptions("foo bar baz qux quux corge");
		// base + 3 sub tokens = 4 patterns max
		assert.equal(result.length, 4);
		assert.deepEqual(result, [
			"Bash(foo:*)",
			"Bash(foo bar:*)",
			"Bash(foo bar baz:*)",
			"Bash(foo bar baz qux:*)",
		]);
	});

	test("skips sudo/env wrappers like the single-pattern variant", () => {
		assert.deepEqual(buildBashPermissionPatternOptions("sudo git push origin"), [
			"Bash(git:*)",
			"Bash(git push:*)",
			"Bash(git push origin:*)",
		]);
		assert.deepEqual(buildBashPermissionPatternOptions("NODE_ENV=prod node server.js"), [
			"Bash(node:*)",
			"Bash(node server.js:*)",
		]);
	});

	test("empty command returns the catch-all pattern", () => {
		assert.deepEqual(buildBashPermissionPatternOptions(""), ["Bash(*)"]);
		assert.deepEqual(buildBashPermissionPatternOptions("   "), ["Bash(*)"]);
	});
});

// ---------------------------------------------------------------------------
// bashCommandMatchesSavedRules — compound command bypass for saved rules
// ---------------------------------------------------------------------------

describe("bashCommandMatchesSavedRules — compound command bypass", () => {
	let tempDir: string;
	let originalCwd: string;

	// Create a temp project directory with .claude/settings.local.json
	function setupSettings(allow: string[]): void {
		const claudeDir = join(tempDir, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.local.json"),
			JSON.stringify({ permissions: { allow } }),
		);
	}

	// biome-ignore lint/suspicious/noExplicitAny: test-only monkey-patch
	let origCwd: any;

	// Monkey-patch process.cwd() to point at our temp dir
	function setCwd(dir: string): void {
		origCwd = process.cwd;
		process.cwd = () => dir;
	}
	function restoreCwd(): void {
		if (origCwd) process.cwd = origCwd;
	}

	test("matches cd-prefixed compound command against saved prefix rule", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(gh pr list:*)"]);
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules("cd /some/path && gh pr list --limit 5"),
				true,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("matches cd-prefixed compound command with exact subcommand", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(gh pr list:*)"]);
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules("cd C:/Users/foo/repos/bar && gh pr list"),
				true,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("rejects when leading segment is not cd", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(gh pr list:*)"]);
			setCwd(tempDir);
			// "rm -rf /tmp" is not a cd command — should not auto-approve
			assert.equal(
				bashCommandMatchesSavedRules("rm -rf /tmp && gh pr list"),
				false,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("rejects when meaningful segment does not match any rule", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(gh pr list:*)"]);
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules("cd /path && gh issue create --title foo"),
				false,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("matches simple (non-compound) commands against on-disk rules", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(gh pr list:*)"]);
			setCwd(tempDir);
			// Simple commands must also be checked — the SDK's in-memory cache
			// may be stale if the rule was added mid-session via "Always Allow"
			assert.equal(bashCommandMatchesSavedRules("gh pr list --limit 5"), true);
			assert.equal(bashCommandMatchesSavedRules("gh pr list"), true);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("returns false for simple commands with no matching rule", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(gh pr list:*)"]);
			setCwd(tempDir);
			assert.equal(bashCommandMatchesSavedRules("gh issue list --limit 5"), false);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("returns false when no settings file exists", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			// No .claude/settings.local.json created
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules("cd /path && gh pr list"),
				false,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("matches exact rule (non-prefix)", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(ping -n 4 localhost)"]);
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules("cd /path && ping -n 4 localhost"),
				true,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("handles multiple cd segments before the meaningful command", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(npm install:*)"]);
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules("cd /home && cd project && npm install lodash"),
				true,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("matches compound command with trailing || true suppressor", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(gh pr create:*)"]);
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules('cd C:/Users/djeff/repos/gsd-pi && gh pr create --dry-run --title "test" --body "test" 2>&1 || true'),
				true,
			);
			assert.equal(
				bashCommandMatchesSavedRules("gh pr create --dry-run || true"),
				true,
			);
			assert.equal(
				bashCommandMatchesSavedRules("cd /tmp && git push || :"),
				false, // rule is for gh pr create, not git push
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("reads rules from settings.json as well as settings.local.json", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			const claudeDir = join(tempDir, ".claude");
			mkdirSync(claudeDir, { recursive: true });
			writeFileSync(
				join(claudeDir, "settings.json"),
				JSON.stringify({ permissions: { allow: ["Bash(git push:*)"] } }),
			);
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules("cd /repo && git push origin main"),
				true,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
