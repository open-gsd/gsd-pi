// Project/App: gsd-pi
// File Purpose: Regression tests: one compaction draws one summary card.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { Container } from "@gsd/pi-tui";
import stripAnsi from "strip-ansi";

import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";
import { handleAgentEvent } from "./controllers/chat-controller.js";
import { addMessageToChat, rebuildChatFromMessages } from "./interactive-chat-render.js";
import { executeCompaction } from "./interactive-command-handlers.js";
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";
import { setToolsExpanded } from "./interactive-key-handlers.js";

initTheme("dark", false);

const SUMMARY = "SUMMARY-MARKER";
const KEPT_REPLY = "KEPT-REPLY-MARKER";

function sessionMessages() {
	return [
		{ role: "compactionSummary", summary: SUMMARY, tokensBefore: 1234, timestamp: 1 },
		{ role: "user", timestamp: 2, content: [{ type: "text", text: "kept question" }] },
		{
			role: "assistant",
			provider: "test",
			model: "test-model",
			timestamp: 3,
			content: [{ type: "text", text: KEPT_REPLY }],
		},
	];
}

/** Real chat container and render path; only the session and terminal are stubbed. */
function createHost(): InteractiveModeDelegateHost {
	const host = {
		isInitialized: true,
		chatContainer: new Container(),
		pinnedMessageContainer: new Container(),
		statusContainer: new Container(),
		pendingTools: new Map(),
		activeToolInvocations: new Set(),
		toolOutputExpanded: false,
		hideThinkingBlock: true,
		keybindings: { getKeys: () => ["escape"] },
		defaultEditor: {},
		editor: {},
		settingsManager: {
			getTimestampFormat: () => "date-time-iso",
			getShowImages: () => false,
		},
		sessionManager: { buildSessionContext: () => ({ messages: sessionMessages() }) },
		session: {
			retryAttempt: 0,
			compact: async () => ({ summary: SUMMARY, tokensBefore: 1234 }),
		},
		footer: { invalidate() {} },
		ui: { requestRender() {} },
		getMarkdownThemeWithSettings: () => undefined,
		getRegisteredToolDefinition: () => undefined,
		formatWebSearchResult: () => "",
		updateEditorBorderColor() {},
		flushCompactionQueue: async () => {},
		showStatus() {},
		showError(message: string) {
			throw new Error(message);
		},
		addMessageToChat(message: unknown, options?: unknown) {
			addMessageToChat(host as never, message as never, options as never);
		},
		rebuildChatFromMessages(...args: unknown[]) {
			(rebuildChatFromMessages as (...a: unknown[]) => void)(host, ...args);
		},
		setToolsExpanded(expanded: boolean) {
			setToolsExpanded(host as never, expanded);
		},
	};
	return host as unknown as InteractiveModeDelegateHost;
}

const cards = (host: InteractiveModeDelegateHost) =>
	host.chatContainer.children.filter((child) => child instanceof CompactionSummaryMessageComponent);

const chatText = (host: InteractiveModeDelegateHost) =>
	host.chatContainer.children.flatMap((child) => child.render(80)).map((line) => stripAnsi(line)).join("\n");

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

const paths: Array<[string, (host: InteractiveModeDelegateHost) => Promise<unknown>]> = [
	["/compact", (host) => executeCompaction(host)],
	[
		"auto-compaction",
		(host) =>
			handleAgentEvent(host as never, {
				type: "auto_compaction_end",
				reason: "threshold",
				result: { summary: SUMMARY, tokensBefore: 1234 },
				aborted: false,
				willRetry: false,
			} as never),
	],
];

describe("one compaction draws one summary card", () => {
	for (const [name, compact] of paths) {
		test(`${name}: a single card, below the kept messages`, async () => {
			const host = createHost();
			await compact(host);

			assert.equal(cards(host).length, 1);
			assert.equal(host.chatContainer.children.at(-1), cards(host)[0]);
			assert.ok(chatText(host).includes(KEPT_REPLY), "kept messages must still render");
		});

		test(`${name}: ctrl-o expands the summary once`, async () => {
			const host = createHost();
			await compact(host);

			setToolsExpanded(host, true);

			assert.equal(occurrences(chatText(host), SUMMARY), 1);
		});
	}

	test("a plain rebuild still shows the session's compaction card", () => {
		const host = createHost();

		rebuildChatFromMessages(host);

		assert.equal(cards(host).length, 1);
		assert.equal(host.chatContainer.children.indexOf(cards(host)[0]) < host.chatContainer.children.length - 1, true);
	});

	test("the card keeps the new compaction's token count", async () => {
		const host = createHost();
		host.session.compact = async () => ({ summary: SUMMARY, tokensBefore: 98765 });

		await executeCompaction(host);

		// toLocaleString is locale-dependent (98,765 vs 98.765) — match the grouping loosely.
		assert.match(chatText(host), /98[,.\u00a0 ]?765 tokens/);
	});

	test("repeated auto-compactions keep one card per turn, never accumulating", async () => {
		const host = createHost();

		for (const tokensBefore of [111, 222]) {
			handleAgentEvent(host as never, {
				type: "auto_compaction_end",
				reason: "threshold",
				result: { summary: SUMMARY, tokensBefore },
				aborted: false,
				willRetry: false,
			} as never);
		}

		assert.equal(cards(host).length, 1, "two compactions must leave exactly one card");
		assert.equal(host.chatContainer.children.at(-1), cards(host)[0]);
	});
});
