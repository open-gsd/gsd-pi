// Project/App: gsd-pi
// File Purpose: Regression tests for interactive chat transcript trimming.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@gsd/pi-agent-core";
import type { AssistantMessage } from "@gsd/pi-ai";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { findMostRecentSession, loadEntriesFromFile, SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { Container } from "@gsd/pi-tui";
import stripAnsi from "strip-ansi";

import { AssistantMessageComponent } from "./components/assistant-message.js";
import { MAX_CHAT_COMPONENTS } from "./interactive-mode-class-constants.js";
import { addMessageToChat, renderSessionContext } from "./interactive-chat-render.js";
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";

initTheme("dark", false);

function createHost(): InteractiveModeDelegateHost {
	return {
		chatContainer: new Container(),
		pendingTools: new Map(),
		settingsManager: {
			getTimestampFormat: () => "date-time-iso",
			getShowImages: () => false,
		},
		getMarkdownThemeWithSettings: () => undefined,
		getRegisteredToolDefinition: () => undefined,
		formatWebSearchResult: () => "",
		toolOutputExpanded: true,
		session: { retryAttempt: 0 },
		editor: {},
		footer: { invalidate() {} },
		updateEditorBorderColor() {},
		ui: { requestRender() {} },
	} as unknown as InteractiveModeDelegateHost;
}

function userMessage(index: number): AgentMessage {
	return {
		id: `u-${index}`,
		role: "user",
		timestamp: index,
		content: [{ type: "text", text: `User ${index}` }],
	} as unknown as AgentMessage;
}

function assistantMessage(index: number): AgentMessage {
	return {
		id: `a-${index}`,
		role: "assistant",
		provider: "test",
		model: "test-model",
		timestamp: index,
		content: [{ type: "text", text: `Assistant ${index}` }],
	} as unknown as AgentMessage;
}

function assistantWithTool(index: number): AssistantMessage {
	return {
		id: `a-tool-${index}`,
		role: "assistant",
		provider: "test",
		model: "test-model",
		timestamp: index,
		content: [
			{ type: "text", text: `Assistant ${index}` },
			{ type: "toolCall", id: `tool-${index}`, name: "read", arguments: { path: "README.md" } },
		],
	} as unknown as AssistantMessage;
}

function connectedToUser(_component: AssistantMessageComponent): boolean {
	return false;
}

describe("interactive chat trimming", () => {
	test("reconciles assistant connection flags after incremental trim removes the paired user turn", () => {
		const host = createHost();

		for (let i = 0; i <= MAX_CHAT_COMPONENTS; i++) {
			addMessageToChat(host, i % 2 === 0 ? userMessage(i) : assistantMessage(i));
		}

		const firstChild = host.chatContainer.children[0];
		assert.ok(firstChild instanceof AssistantMessageComponent);
		assert.equal(host.chatContainer.children.length, MAX_CHAT_COMPONENTS);
		assert.equal(connectedToUser(firstChild), false);
	});

	test("reconciles assistant connection flags after session replay trim removes the paired user turn", () => {
		const host = createHost();
		const messages: AgentMessage[] = [userMessage(0)];
		for (let i = 1; i <= MAX_CHAT_COMPONENTS / 2; i++) {
			messages.push(assistantWithTool(i) as unknown as AgentMessage);
		}

		renderSessionContext(host, { messages } as any);

		const firstChild = host.chatContainer.children[0];
		assert.ok(firstChild instanceof AssistantMessageComponent);
		assert.equal(host.chatContainer.children.length, MAX_CHAT_COMPONENTS);
		assert.equal(connectedToUser(firstChild), false);
	});
});

describe("interactive chat replay: aborted turns preserve completed tool results", () => {
	test("a tool that completed is rendered with its real result even though the turn aborted", () => {
		// On reload/replay, an aborted assistant turn carries its tool calls, and
		// each completed tool's result lives in a later `toolResult` message. The
		// replay must surface that real result instead of discarding it and
		// painting the row as "Operation aborted".
		const host = createHost();

		const assistant = {
			id: "a-abort",
			role: "assistant",
			provider: "test",
			model: "test-model",
			timestamp: 1,
			stopReason: "aborted",
			content: [
				{ type: "toolCall", id: "bg-1", name: "async_bash", arguments: { command: "echo hi" } },
			],
		} as unknown as AgentMessage;
		const toolResult = {
			id: "tr-1",
			role: "toolResult",
			toolCallId: "bg-1",
			toolName: "async_bash",
			timestamp: 2,
			content: [{ type: "text", text: "UNIQUE_RESULT_TOKEN" }],
			isError: false,
		} as unknown as AgentMessage;

		renderSessionContext(host, { messages: [assistant, toolResult] } as any);

		const rendered = stripAnsi(host.chatContainer.render(100).join("\n"));
		assert.match(rendered, /UNIQUE_RESULT_TOKEN/, "the completed tool's real result must survive replay");
		assert.doesNotMatch(
			rendered,
			/Operation aborted/,
			"a tool that actually completed must not be shown as aborted on replay",
		);
	});

	test("a tool with no result on an aborted turn is still shown as interrupted", () => {
		const host = createHost();

		const assistant = {
			id: "a-abort-2",
			role: "assistant",
			provider: "test",
			model: "test-model",
			timestamp: 1,
			stopReason: "aborted",
			content: [
				{ type: "toolCall", id: "await-1", name: "await_job", arguments: {} },
			],
		} as unknown as AgentMessage;

		renderSessionContext(host, { messages: [assistant] } as any);

		const rendered = stripAnsi(host.chatContainer.render(100).join("\n"));
		assert.match(
			rendered,
			/Operation aborted/,
			"a tool with no result on an aborted turn should render as interrupted",
		);
	});
});

describe("model attribution survives session persistence and replay (ADR-049)", () => {
	function routedAssistant(index: number, overrides: Record<string, unknown>): AgentMessage {
		return {
			id: `a-routed-${index}`,
			role: "assistant",
			provider: "openrouter",
			model: "openrouter/auto",
			timestamp: index,
			stopReason: "stop",
			content: [{ type: "text", text: `Routed answer ${index}` }],
			...overrides,
		} as unknown as AgentMessage;
	}

	function usage(): Record<string, unknown> {
		return {
			input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	test("each reopened message keeps its own original attribution across a later model change", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "model-routing-replay-"));
		try {
			const session = SessionManager.create(process.cwd(), tempDir);
			session.appendMessage(
				routedAssistant(1, {
					responseModel: "anthropic/claude-opus-4.7",
					modelRouting: { source: "gsd-dynamic", tier: "heavy", modelDowngraded: true },
				}) as AssistantMessage,
			);
			session.appendModelChange("openrouter", "gpt-5.6-luna");
			session.appendMessage(
				routedAssistant(2, {
					model: "gpt-5.6-luna",
					modelRouting: { source: "gsd-dynamic", tier: "light", modelDowngraded: false },
				}) as AssistantMessage,
			);

			const sessionFile = findMostRecentSession(tempDir);
			assert.ok(sessionFile, "session file must exist on disk");

			// No schema-version bump: the additive field rides the v3 format.
			const entries = loadEntriesFromFile(sessionFile);
			const header = entries.find((e) => e.type === "session") as { version?: number };
			assert.equal(header.version, 3);
			const stored = entries.filter((e) => e.type === "message").map((e) => (e as { message: AssistantMessage }).message);
			assert.deepEqual(stored[0].modelRouting, { source: "gsd-dynamic", tier: "heavy", modelDowngraded: true });
			assert.deepEqual(stored[1].modelRouting, { source: "gsd-dynamic", tier: "light", modelDowngraded: false });

			const reopened = SessionManager.open(sessionFile);
			const host = createHost();
			renderSessionContext(host, reopened.buildSessionContext());
			const rendered = stripAnsi(host.chatContainer.render(120).join("\n"));

			assert.match(rendered, /anthropic\/claude-opus-4\.7 ← openrouter\/auto \(dynamic\/heavy\)/);
			assert.match(rendered, /gpt-5\.6-luna \(dynamic\/light\)/);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("legacy v3 JSONL messages without modelRouting render unchanged", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "model-routing-legacy-"));
		try {
			const sessionFile = join(tempDir, "legacy.jsonl");
			const legacyMessage = {
				role: "assistant",
				content: [{ type: "text", text: "legacy answer" }],
				api: "openai-completions",
				provider: "openrouter",
				model: "openrouter/auto",
				usage: usage(),
				stopReason: "stop",
				timestamp: 1,
			};
			writeFileSync(
				sessionFile,
				'{"type":"session","version":3,"id":"legacy","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n' +
					`${JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: legacyMessage })}\n`,
			);
			assert.equal(readFileSync(sessionFile, "utf8").includes("modelRouting"), false);

			const entries = loadEntriesFromFile(sessionFile);
			const messages = entries.filter((e) => e.type === "message").map((e) => (e as { message: AgentMessage }).message);
			const host = createHost();
			renderSessionContext(host, { messages } as any);
			const rendered = stripAnsi(host.chatContainer.render(120).join("\n"));

			assert.match(rendered, /╭─ GSD · openrouter\/auto · /);
			assert.doesNotMatch(rendered, /←/);
			assert.doesNotMatch(rendered, /dynamic/);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
