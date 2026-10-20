// gsd-pi — chat-controller activity indicator and leading-edge render tests.

import assert from "node:assert/strict";
import test from "node:test";
import { Container, TUI, Terminal } from "@gsd/pi-tui";

import { startActivityIndicator, stopActivityIndicator } from "./chat-controller.js";
import { createStreamingRenderState } from "../streaming-render-state.js";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";

// Initialize theme for Loader components used by activity indicator tests
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

function makeActivityHost(
	statusContainer: Container,
	ui: TUI,
	extra: Record<string, unknown> = {},
) {
	return {
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
		pendingTools: new Map(),
		activeToolInvocations: new Set(),
		pendingMessagesContainer: { clear() {} },
		statusContainer,
		pinnedMessageContainer: new Container(),
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
		getMarkdownThemeWithSettings() { return undefined; },
		getRegisteredToolDefinition() { return undefined; },
		formatWebSearchResult() { return ""; },
		...extra,
	} as any;
}

// ── activity indicator tests ─────────────────────────────────────────

test("startActivityIndicator: creates Loader and adds to statusContainer", () => {
	const statusContainer = new Container();
	const renderCalls: number[] = [];
	const ui = new TUI(makeTerminal());
	ui.requestRender = () => renderCalls.push(1);
	const host = makeActivityHost(statusContainer, ui);

	startActivityIndicator(host, "Processing…");

	assert.ok(host.activityLoader, "activityLoader must be set");
	assert.equal(statusContainer.children.length, 1, "statusContainer must have one child");
	assert.ok(renderCalls.length > 0, "requestRender must be called");
});

test("startActivityIndicator: uses default message when no message provided", () => {
	const statusContainer = new Container();
	const ui = new TUI(makeTerminal());
	const host = makeActivityHost(statusContainer, ui);

	startActivityIndicator(host);

	assert.ok(host.activityLoader, "activityLoader must be set");
});

test("startActivityIndicator: picks up phase from gsdProgressState", () => {
	const statusContainer = new Container();
	const ui = new TUI(makeTerminal());
	const host = makeActivityHost(statusContainer, ui, {
		gsdProgressState: { phase: "Running tests…" },
	});

	startActivityIndicator(host);

	assert.ok(host.activityLoader, "activityLoader must be set");
});

test("stopActivityIndicator: stops loader and clears statusContainer when no other loaders", () => {
	const statusContainer = new Container();
	const ui = new TUI(makeTerminal());
	const host = makeActivityHost(statusContainer, ui);

	startActivityIndicator(host, "Working…");
	assert.equal(statusContainer.children.length, 1);

	stopActivityIndicator(host);

	assert.equal(host.activityLoader, undefined, "activityLoader must be cleared");
	assert.equal(statusContainer.children.length, 0, "statusContainer must be cleared");
});

test("stopActivityIndicator: does NOT clear statusContainer when other loaders are active", () => {
	const statusContainer = new Container();
	const ui = new TUI(makeTerminal());
	const host = makeActivityHost(statusContainer, ui);

	startActivityIndicator(host, "Activity…");
	host.loadingAnimation = { stop() {} } as any; // Simulate a loading animation is present

	stopActivityIndicator(host);

	assert.equal(host.activityLoader, undefined, "activityLoader must be cleared");
	assert.equal(statusContainer.children.length, 1, "statusContainer must NOT be cleared when other loaders exist");
});

test("stopActivityIndicator: no-op when activityLoader is not set", () => {
	const statusContainer = new Container();
	const ui = new TUI(makeTerminal());
	const host = makeActivityHost(statusContainer, ui);

	// Should not throw
	stopActivityIndicator(host);

	assert.equal(host.activityLoader, undefined);
});

// ── leading-edge render test ─────────────────────────────────────────

test("leading-edge render: message_update triggers immediate requestRender (not debounced)", async () => {
	let renderCount = 0;
	const statusContainer = new Container();
	const ui = new TUI(makeTerminal());
	ui.requestRender = () => {
		renderCount++;
	};
	const host = makeActivityHost(statusContainer, ui);

	const { handleAgentEvent } = await import("./chat-controller.js");

	// message_start to initialize streaming state
	await handleAgentEvent(
		host as any,
		{
			type: "message_start",
			message: { role: "assistant", content: [] },
		} as any,
	);

	// Simulate multiple rapid message_update events
	for (let i = 0; i < 3; i++) {
		await handleAgentEvent(
			host as any,
			{
				type: "message_update",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `delta ${i}` }],
				},
				assistantMessageEvent: { type: "text" },
			} as any,
		);
	}

	// Each message_update must trigger an immediate requestRender (leading-edge).
	// Before the fix, these would be debounced and only fire once after the window.
	assert.ok(
		renderCount >= 3,
		`Each message_update must trigger immediate requestRender (got ${renderCount}, expected >= 3)`,
	);
});
