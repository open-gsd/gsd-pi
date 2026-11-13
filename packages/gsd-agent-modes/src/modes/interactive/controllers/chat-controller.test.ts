// gsd-pi — chat-controller activity indicator and leading-edge render tests.

import assert from "node:assert/strict";
import test from "node:test";
import { Container, TUI, Terminal } from "@gsd/pi-tui";

import { handleAgentEvent, startActivityIndicator, stopActivityIndicator } from "./chat-controller.js";
import stripAnsi from "strip-ansi";
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
		setProgress() {},
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

// Dispatch must refresh the real components created by the streaming walker,
// not just components registered directly by a test helper.
for (const reverse of [false, true]) {
	for (const explicitPurpose of [false, true]) {
		test(`streamed sibling dispatch refreshes authoritative args (reverse=${reverse}, purpose=${explicitPurpose})`, async () => {
			const ui = new TUI(makeTerminal());
			ui.requestRender = () => {};
			const host = makeActivityHost(new Container(), ui);
			const partialArgs = Object.freeze({});
			const argsA = Object.freeze({ runtime: "node", script: "console.log('A')", ...(explicitPurpose ? { purpose: "Observe sibling A" } : {}) });
			const argsB = Object.freeze({ runtime: "node", script: "console.log('B')", purpose: "Observe sibling B" });
			const argsUat = Object.freeze({ milestoneId: "M029", sliceId: "S01", checkId: "UAT-01", intent: "uat-runtime-check", runtime: "python" });
			const argsRead = Object.freeze({ path: "guide.md", purpose: "Not an exec purpose" });
			const blocks = [
				{ type: "toolCall", id: "sibling-A", name: "gsd_exec", arguments: partialArgs },
				{ type: "toolCall", id: "sibling-B", name: "gsd_exec", arguments: argsB },
				{ type: "toolCall", id: "uat", name: "gsd_uat_exec", arguments: partialArgs },
				{ type: "toolCall", id: "read", name: "read", arguments: partialArgs },
			];
			const snapshots = structuredClone([partialArgs, argsA, argsB, argsUat, argsRead, blocks]);
			const send = (event: any) => handleAgentEvent(host, event);
			try {
				await send({ type: "message_start", message: { role: "assistant", content: [] } });
				for (let count = 1; count <= blocks.length; count++) {
					await send({ type: "message_update", message: { role: "assistant", content: blocks.slice(0, count) }, assistantMessageEvent: { type: "toolcall_delta", contentIndex: count - 1 } });
				}
				const components = blocks.map((block) => host.pendingTools.get(block.id));
				assert.equal(new Set(components).size, blocks.length);
				const segments = [...host.streamingRenderState.renderedSegments];
				const order = reverse ? [1, 0, 3, 2] : [0, 1, 2, 3];
				const args = [argsA, argsB, argsUat, argsRead];
				for (const index of order) {
					const block = blocks[index];
					const event = { type: "tool_execution_start", toolCallId: block.id, toolName: block.name, args: args[index] };
					await send(event);
					await send(event); // Duplicate starts must not duplicate identity, rows or counts.
					assert.equal(host.pendingTools.get(block.id), components[index]);
				}
				assert.deepEqual([...host.pendingTools.keys()], blocks.map((block) => block.id));
				assert.deepEqual(host.activeToolInvocations, new Set(blocks.map((block) => block.id)));
				assert.deepEqual(host.streamingRenderState.renderedSegments, segments);
				const running = components.map((component) => stripAnsi(component.render(180).join("\n")));
				assert.match(running[0], explicitPurpose ? /Observe sibling A/ : /Run a Node\.js script/);
				assert.doesNotMatch(running[0], /Bash|Observe sibling B/);
				assert.match(running[1], /Observe sibling B/);
				assert.match(running[2], /M029\/S01\/UAT-01/);
				assert.match(running[3], /guide\.md/);
				assert.doesNotMatch(running[3], /Not an exec purpose/);
				for (const text of running) assert.match(text, /running/);
				let remaining = blocks.length;
				for (const index of [...order].reverse()) {
					await send({ type: "tool_execution_end", toolCallId: blocks[index].id, toolName: blocks[index].name, result: { content: [{ type: "text", text: "done" }] }, isError: false });
					assert.equal(host.activeToolInvocations.size, --remaining);
				}
				assert.deepEqual([partialArgs, argsA, argsB, argsUat, argsRead, blocks], snapshots);
			} finally {
				stopActivityIndicator(host);
				host.loadingAnimation?.stop();
				for (const component of host.pendingTools.values()) component.markHistoricalNoResult();
			}
		});
	}
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
