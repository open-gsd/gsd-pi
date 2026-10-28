import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@gsd/pi-tui";

import { handleAgentEvent } from "./controllers/chat-controller.js";
import { StreamingRenderState, createStreamingRenderState } from "./streaming-render-state.js";

function makeMinimalHost(chatContainer: Container, streamingRenderState = createStreamingRenderState()) {
	return {
		isInitialized: true,
		streamingRenderState,
		footer: { invalidate() {} },
		settingsManager: {
			getTimestampFormat() {
				return "date-time-iso";
			},
			getShowImages() {
				return false;
			},
		},
		getMarkdownThemeWithSettings() {
			return undefined;
		},
		getRegisteredToolDefinition() {
			return undefined;
		},
		formatWebSearchResult() {
			return "";
		},
		session: { messages: [], retryAttempt: 0 },
		chatContainer,
		pendingTools: new Map(),
		activeToolInvocations: new Set(),
		pendingMessagesContainer: { clear() {} },
		pinnedMessageContainer: new Container(),
		statusContainer: new Container(),
		hideThinkingBlock: true,
		toolOutputExpanded: false,
		defaultWorkingMessage: "Working...",
		clearBlockingError() {},
		compactionQueuedMessages: [],
		ui: {
			terminal: { rows: 60, columns: 100 },
			requestRender() {},
		},
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
	};
}

test("StreamingRenderState: two InteractiveMode hosts do not share segment state", async () => {
	const stateA = createStreamingRenderState();
	const stateB = createStreamingRenderState();
	const hostA = makeMinimalHost(new Container(), stateA);
	const hostB = makeMinimalHost(new Container(), stateB);

	const assistantStart = {
		type: "message_start",
		message: { role: "assistant", content: [] },
	} as const;

	await handleAgentEvent(hostA as any, assistantStart as any);
	stateA.renderedSegments.push({
		kind: "text-run",
		startIndex: 0,
		endIndex: 0,
		contentType: "text",
		component: {} as any,
	});

	await handleAgentEvent(hostB as any, assistantStart as any);

	assert.equal(stateA.renderedSegments.length, 1);
	assert.equal(stateB.renderedSegments.length, 0);
	assert.equal(stateA.lastProcessedContentIndex, 0);
	assert.equal(stateB.lastProcessedContentIndex, 0);
});

test("golden: message_start assistant resets streaming state for new turn", async () => {
	const rs = createStreamingRenderState();
	rs.lastProcessedContentIndex = 5;
	rs.renderedSegments.push({
		kind: "text-run",
		startIndex: 0,
		endIndex: 0,
		contentType: "text",
		component: {} as any,
	});

	const host = makeMinimalHost(new Container(), rs);
	await handleAgentEvent(host as any, {
		type: "message_start",
		message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
	} as any);

	assert.equal(rs.renderedSegments.length, 0);
	assert.equal(rs.lastProcessedContentIndex, 0);
	assert.equal(rs.lastContentLength, 0);
});

test("StreamingRenderState: scheduleDebouncedRender no longer exists (debounce removed)", () => {
	const rs = createStreamingRenderState();
	// The debounce system was removed to fix streaming render starvation (#1686).
	// scheduleDebouncedRender, cancelDebouncedRender, and renderDebounceTimer must not exist.
	assert.equal(
		typeof (rs as any).scheduleDebouncedRender,
		"undefined",
		"scheduleDebouncedRender must be removed",
	);
	assert.equal(
		typeof (rs as any).cancelDebouncedRender,
		"undefined",
		"cancelDebouncedRender must be removed",
	);
	assert.equal(
		(rs as any).renderDebounceTimer,
		undefined,
		"renderDebounceTimer property must not exist",
	);
});

test("StreamingRenderState: flushPendingStreamingWork calls ui.requestRender directly", async () => {
	let renderCalled = false;
	const rs = createStreamingRenderState();

	// Seed some state so we know flush is operating on real data
	rs.lastProcessedContentIndex = 3;
	rs.renderedSegments.push({
		kind: "text-run",
		startIndex: 0,
		endIndex: 2,
		contentType: "text",
		component: {} as any,
	});

	await rs.flushPendingStreamingWork({
		requestRender() {
			renderCalled = true;
		},
	} as any);

	assert.equal(renderCalled, true, "flushPendingStreamingWork must call ui.requestRender()");
	// State should remain intact after flush (it only triggers render, doesn't reset)
	assert.equal(rs.lastProcessedContentIndex, 3);
	assert.equal(rs.renderedSegments.length, 1);
});

test("StreamingRenderState: resetForSessionChange resets all state", () => {
	const rs = createStreamingRenderState();
	// Seed state
	rs.lastProcessedContentIndex = 5;
	rs.lastContentLength = 100;
	rs.renderedSegments.push({
		kind: "tool",
		contentIndex: 0,
		component: {} as any,
	});
	rs.orphanedSegments.push({
		kind: "text-run",
		startIndex: 0,
		endIndex: 0,
		contentType: "thinking",
		component: {} as any,
	});
	rs.hasToolsInTurn = true;
	rs.lastPinnedText = "pinned";

	rs.resetForSessionChange();

	assert.equal(rs.lastProcessedContentIndex, 0);
	assert.equal(rs.lastContentLength, 0);
	assert.equal(rs.renderedSegments.length, 0);
	assert.equal(rs.orphanedSegments.length, 0);
	assert.equal(rs.hasToolsInTurn, false);
	assert.equal(rs.lastPinnedText, "");
});

test("StreamingRenderState: resetPinnedZone clears pinned zone state", () => {
	const rs = createStreamingRenderState();
	rs.hasToolsInTurn = true;
	rs.lastPinnedText = "some text";
	rs.pinnedZoneNeedsViewportRealign = true;

	rs.resetPinnedZone();

	assert.equal(rs.hasToolsInTurn, false);
	assert.equal(rs.lastPinnedText, "");
	assert.equal(rs.pinnedZoneNeedsViewportRealign, false);
});

test("StreamingRenderState: resetForNewAssistantMessage resets both segments and pinned zone", () => {
	const rs = createStreamingRenderState();
	// Seed segment state
	rs.lastProcessedContentIndex = 4;
	rs.renderedSegments.push({
		kind: "text-run",
		startIndex: 0,
		endIndex: 3,
		contentType: "text",
		component: {} as any,
	});
	// Seed pinned state
	rs.lastPinnedText = "pinned";
	rs.hasToolsInTurn = true;

	rs.resetForNewAssistantMessage();

	assert.equal(rs.lastProcessedContentIndex, 0);
	assert.equal(rs.renderedSegments.length, 0);
	assert.equal(rs.lastPinnedText, "");
	assert.equal(rs.hasToolsInTurn, false);
});
