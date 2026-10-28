// gsd-pi — active tool invocation tracking for the status widgets (#2925).
//
// pendingTools deliberately retains completed tool components for transcript
// reconstruction, so its size is not an active-execution count. These tests
// pin the separate invocation tracker: add on dispatch, idempotent remove on
// terminal events, cleared on turn/session terminals, never resurrected by a
// transcript replay.

import assert from "node:assert/strict";
import test from "node:test";
import { Container, TUI, Terminal } from "@gsd/pi-tui";

import { handleAgentEvent } from "./chat-controller.js";
import { scanNewContentBlocks } from "./chat-segment-walker.js";
import { renderSessionContext } from "../interactive-chat-render.js";
import { createStreamingRenderState } from "../streaming-render-state.js";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";

initTheme();

// ── helpers ──────────────────────────────────────────────────────────

function makeTerminal(): Terminal {
	return {
		isTTY: true,
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		drainInput: async () => {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
	};
}

function makeHost() {
	const ui = new TUI(makeTerminal());
	ui.requestRender = () => {};
	const host = {
		isInitialized: true,
		streamingRenderState: createStreamingRenderState(),
		footer: { invalidate() {} },
		settingsManager: {
			getTimestampFormat() {
				return "date-time-iso";
			},
			getShowImages() {
				return false;
			},
		},
		session: { messages: [], retryAttempt: 0 },
		chatContainer: new Container(),
		pendingTools: new Map<string, any>(),
		activeToolInvocations: new Set<string>(),
		pendingMessagesContainer: { clear() {} },
		pinnedMessageContainer: new Container(),
		statusContainer: new Container(),
		chatContainerChildren: [],
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		defaultWorkingMessage: "Working...",
		clearBlockingError() {},
		compactionQueuedMessages: [],
		ui,
		init: async () => {},
		addMessageToChat() {},
		checkShutdownRequested: async () => {},
		rebuildChatFromMessages() {},
		flushCompactionQueue: async () => {},
		showStatus() {},
		showError() {},
		updatePendingMessagesDisplay() {},
		updateTerminalTitle() {},
		updateEditorBorderColor() {},
		getMarkdownThemeWithSettings() {
			return undefined;
		},
		getRegisteredToolDefinition() {
			return undefined;
		},
		formatWebSearchResult() {
			return "";
		},
	};
	return host as any;
}

function toolStart(id: string, name = "bash", args: Record<string, unknown> = { command: "ls" }): any {
	return { type: "tool_execution_start", toolCallId: id, toolName: name, args };
}

function toolEnd(id: string, isError = false): any {
	return {
		type: "tool_execution_end",
		toolCallId: id,
		toolName: "bash",
		result: { content: [{ type: "text", text: isError ? "boom" : "ok" }] },
		isError,
	};
}

async function dispatch(host: any, ...events: any[]): Promise<void> {
	for (const event of events) {
		await handleAgentEvent(host, event);
	}
}

// ── dispatch/terminal accounting ─────────────────────────────────────

test("overlapping tools count independently and return to zero on success", async () => {
	const host = makeHost();

	await dispatch(host, toolStart("a"));
	assert.equal(host.activeToolInvocations.size, 1, "first dispatch must count");

	await dispatch(host, toolStart("b"));
	assert.equal(host.activeToolInvocations.size, 2, "overlapping tools count independently");

	await dispatch(host, toolEnd("a"));
	assert.equal(host.activeToolInvocations.size, 1, "completed tool stops counting while peer still runs");

	await dispatch(host, toolEnd("b"));
	assert.equal(host.activeToolInvocations.size, 0, "counter returns to zero after all tools end");
	assert.equal(
		host.pendingTools.size,
		2,
		"completed cards stay retained in pendingTools for transcript reconstruction",
	);
});

test("failure terminal returns the count to zero", async () => {
	const host = makeHost();

	await dispatch(host, toolStart("f"));
	assert.equal(host.activeToolInvocations.size, 1, "dispatch must count before the failure");

	await dispatch(host, toolEnd("f", true));

	assert.equal(host.activeToolInvocations.size, 0, "errored tool must stop counting");
	assert.equal(host.pendingTools.size, 1, "failed card stays retained");
});

test("turn abort clears the active count", async () => {
	const host = makeHost();

	await dispatch(host, toolStart("d"));
	assert.equal(host.activeToolInvocations.size, 1, "dispatch must count before the abort");

	await dispatch(
		host,
		{
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "aborted",
				content: [{ type: "toolCall", id: "d", name: "bash", arguments: {} }],
			},
		},
	);

	assert.equal(host.activeToolInvocations.size, 0, "abort must clear every active invocation");
	assert.equal(host.pendingTools.size, 0, "abort also clears retained cards (existing behavior)");
});

test("agent_end clears the active count", async () => {
	const host = makeHost();

	await dispatch(host, toolStart("e"));
	assert.equal(host.activeToolInvocations.size, 1);

	await dispatch(host, { type: "agent_end", messages: [] });
	assert.equal(host.activeToolInvocations.size, 0, "turn end must not leave active invocations");
});

test("duplicate completion is idempotent and does not decrement a successor", async () => {
	const host = makeHost();

	await dispatch(host, toolStart("g"), toolEnd("g"));
	assert.equal(host.activeToolInvocations.size, 0);

	await dispatch(host, toolEnd("g"));
	assert.equal(host.activeToolInvocations.size, 0, "duplicate terminal must be a no-op");

	await dispatch(host, toolStart("h"));
	assert.equal(host.activeToolInvocations.size, 1, "successor invocation still counts");
	await dispatch(host, toolEnd("g"));
	assert.equal(host.activeToolInvocations.size, 1, "late terminal for a finished id must not decrement the successor");
});

test("session switch clears the count; late terminal from the old session is a no-op", async () => {
	const host = makeHost();

	await dispatch(host, toolStart("old"));
	assert.equal(host.activeToolInvocations.size, 1);

	await dispatch(host, { type: "session_state_changed", reason: "switch_session" });
	assert.equal(host.activeToolInvocations.size, 0, "session switch resets activity");

	await dispatch(host, toolEnd("old"));
	assert.equal(host.activeToolInvocations.size, 0, "late terminal from the old session must not underflow");

	await dispatch(host, toolStart("new"));
	assert.equal(host.activeToolInvocations.size, 1);
	await dispatch(host, toolEnd("old"));
	assert.equal(host.activeToolInvocations.size, 1, "old session terminal must not decrement the new session");
});

test("retry re-dispatch counts through its own invocation id", async () => {
	const host = makeHost();

	await dispatch(host, toolStart("j", "bash", { command: "ls" }), toolEnd("j"));
	assert.equal(host.activeToolInvocations.size, 0);

	// Retry announces the same logical tool under a new toolCallId.
	await dispatch(host, toolStart("k", "bash", { command: "ls" }));
	assert.equal(host.activeToolInvocations.size, 1, "retried invocation counts as active");

	await dispatch(host, toolEnd("k"));
	assert.equal(host.activeToolInvocations.size, 0, "retry terminal returns the count to zero");
});

// ── provider-side tools (no dispatch events) ─────────────────────────

test("serverToolUse counts from block registration until its result block arrives", () => {
	const host = makeHost();
	const rs = host.streamingRenderState;
	const block = { type: "serverToolUse", id: "w1", name: "web_search", input: { query: "x" } };

	scanNewContentBlocks(host, rs, [block]);
	assert.equal(host.activeToolInvocations.size, 1, "provider-side tool counts while in flight");

	// Sub-turn shrink re-scans the same block — must not double count.
	scanNewContentBlocks(host, rs, [block]);
	assert.equal(host.activeToolInvocations.size, 1, "re-scanned block must not double count");

	scanNewContentBlocks(host, rs, [
		{ type: "webSearchResult", toolUseId: "w1", content: { type: "web_search_result", results: [] } },
	]);
	assert.equal(host.activeToolInvocations.size, 0, "result block is the terminal event");
});

test("serverToolUse completed via externalResult stops counting", async () => {
	const host = makeHost();
	const block = {
		type: "serverToolUse",
		id: "w2",
		name: "web_search",
		input: { query: "x" },
		externalResult: { content: [{ type: "text", text: "res" }], isError: false },
	};

	// Provider-side tool streams in — no native tool_execution_start/end exists.
	scanNewContentBlocks(host, host.streamingRenderState, [block]);
	assert.equal(host.activeToolInvocations.size, 1);

	// Claude Code completes it inline: toolcall/server_tool_use carries externalResult.
	await dispatch(host, {
		type: "message_update",
		message: { role: "assistant", content: [block] },
		assistantMessageEvent: { type: "server_tool_use", contentIndex: 0 },
	});

	assert.equal(
		host.activeToolInvocations.size,
		0,
		"inline external completion must stop the count without waiting for turn end",
	);
});

// ── presentation rebuilds vs lifecycle resets ────────────────────────

test("mid-stream transcript rebuild preserves live invocation counts", async () => {
	const host = makeHost();

	await dispatch(host, toolStart("live"));
	assert.equal(host.activeToolInvocations.size, 1);

	// toggleThinkingBlockVisibility rebuilds the transcript while streaming.
	renderSessionContext(host, {
		messages: [
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "toolCall", id: "done", name: "bash", arguments: { command: "ls" } }],
			},
			{
				role: "toolResult",
				toolCallId: "done",
				toolName: "bash",
				content: [{ type: "text", text: "out" }],
			},
		],
	} as any);

	assert.equal(host.activeToolInvocations.size, 1, "presentation rebuild must not erase live tracking");
	assert.equal(host.pendingTools.size, 0, "replay still leaves no retained card entries");
});

test("replay never resurrects counts from historical tool cards", () => {
	const host = makeHost();

	renderSessionContext(host, {
		messages: [
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }],
			},
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: [{ type: "text", text: "out" }],
			},
		],
	} as any);

	assert.equal(host.activeToolInvocations.size, 0, "historical cards must not count as active");
	assert.equal(host.pendingTools.size, 0, "replay must not leave entries that read as active");
});
