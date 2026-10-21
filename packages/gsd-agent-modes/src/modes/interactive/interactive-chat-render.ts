// Project/App: gsd-pi
// File Purpose: Extracted from interactive-mode.ts (Phase E2 seam remediation).

import type { AgentMessage } from "@gsd/pi-agent-core";
import type { AssistantMessage, Message } from "@gsd/pi-ai";
import { parseSkillBlock } from "@gsd/agent-core";
import type { SessionContext } from "@gsd/pi-coding-agent/core/session-manager.js";
import type { TruncationResult } from "@gsd/pi-coding-agent/core/tools/truncate.js";
import { Container, Markdown, Spacer, Text } from "@gsd/pi-tui";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { reconcileChatTurnConnections } from "./components/chat-turn-connect.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.js";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";
import { CustomMessageComponent } from "./components/custom-message.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { UserMessageComponent } from "./components/user-message.js";
import { asServerToolUse, asWebSearchResult, isToolContentBlock } from "./gsd-content-blocks.js";
import { buildAssistantReplaySegments } from "./interactive-notify-render.js";
import { MAX_CHAT_COMPONENTS } from "./interactive-mode-class-constants.js";
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";

	/** Extract text content from a user message */
export function getUserMessageText(host: InteractiveModeDelegateHost, message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
export function showStatus(host: InteractiveModeDelegateHost, message: string, options?: { append?: boolean }): void {
		const append = options?.append ?? false;
		const children = host.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (!append && last && secondLast && last === host.lastStatusText && secondLast === host.lastStatusSpacer) {
			host.lastStatusText.setText(theme.fg("dim", message));
			host.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		host.chatContainer.addChild(spacer);
		host.chatContainer.addChild(text);
		host.lastStatusSpacer = spacer;
		host.lastStatusText = text;
		host.ui.requestRender();
	}

function addUserMessageComponent(host: InteractiveModeDelegateHost, userComponent: UserMessageComponent): void {
	host.chatContainer.addChild(userComponent);
}

function hasAssistantVisibleContent(content: Array<any>, hideThinkingBlock: boolean): boolean {
	return content.some((c: any) => {
		if (c?.type === "text" && typeof c.text === "string" && c.text.trim().length > 0) return true;
		if (!hideThinkingBlock && c?.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim().length > 0) return true;
		return false;
	});
}

function finalizeChatMutation(host: InteractiveModeDelegateHost): void {
	trimChatHistory(host);
	reconcileChatTurnConnections(host.chatContainer.children);
}

export function addMessageToChat(host: InteractiveModeDelegateHost, message: AgentMessage, options?: { populateHistory?: boolean }): void {
		const timestampFormat = host.settingsManager.getTimestampFormat();
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, host.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				host.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = host.session.extensionRunner?.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(message, renderer, host.getMarkdownThemeWithSettings());
					component.setExpanded(host.toolOutputExpanded);
					host.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				host.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, host.getMarkdownThemeWithSettings());
				component.setExpanded(host.toolOutputExpanded);
				host.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				host.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, host.getMarkdownThemeWithSettings());
				component.setExpanded(host.toolOutputExpanded);
				host.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = getUserMessageText(host, message);
				if (textContent) {
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						host.chatContainer.addChild(new Spacer(1));
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							host.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(host.toolOutputExpanded);
						host.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								host.getMarkdownThemeWithSettings(),
								message.timestamp,
								timestampFormat,
							);
							addUserMessageComponent(host, userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(textContent, host.getMarkdownThemeWithSettings(), message.timestamp, timestampFormat);
						addUserMessageComponent(host, userComponent);
					}
					if (options?.populateHistory) {
						host.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const hasToolBlocks = message.content.some((c: any) => isToolContentBlock(c));
				const isAbortOrError = message.stopReason === "aborted" || message.stopReason === "error";
				if (!hasAssistantVisibleContent(message.content, host.hideThinkingBlock) && !(isAbortOrError && !hasToolBlocks)) break;
				const assistantComponent = new AssistantMessageComponent(
					message,
					host.hideThinkingBlock,
					host.getMarkdownThemeWithSettings(),
					timestampFormat,
				);
				host.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
		finalizeChatMutation(host);
	}

	/**
	 * Remove oldest components when chat exceeds MAX_CHAT_COMPONENTS.
	 * Only render-components are removed — session data stays in SessionManager.
	 */
export function trimChatHistory(host: InteractiveModeDelegateHost): void {
		while (host.chatContainer.children.length > MAX_CHAT_COMPONENTS) {
			const oldest = host.chatContainer.children[0];
			host.chatContainer.removeChild(oldest);
		}
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
export function renderSessionContext(host: InteractiveModeDelegateHost, 
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		host.pendingTools.clear();
		// NOTE: intentionally does NOT touch host.activeToolInvocations. This
		// path rebuilds the transcript presentation (including mid-stream via
		// toggleThinkingBlockVisibility), so it must preserve live invocation
		// counts; replay itself never dispatches tools, so it cannot inflate
		// the counter either. Lifecycle resets clear the tracker in
		// chat-controller (session change, agent_end, abort) (#2925).
		const timestampFormat = host.settingsManager.getTimestampFormat();

		if (options.updateFooter) {
			host.footer.invalidate();
			host.updateEditorBorderColor();
		}

		for (const message of sessionContext.messages) {
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				const hasToolBlocks = message.content.some((c) => isToolContentBlock(c));
				if (!hasToolBlocks) {
					addMessageToChat(host, message);
					continue;
				}

				const assistantSegments: AssistantMessageComponent[] = [];
				const replaySegments = buildAssistantReplaySegments(message.content);

				for (const segment of replaySegments) {
					if (segment.kind === "assistant") {
						const segContent = message.content.slice(segment.startIndex, segment.endIndex + 1);
						if (!hasAssistantVisibleContent(segContent, host.hideThinkingBlock)) continue;
						const assistantComponent = new AssistantMessageComponent(
							message,
							host.hideThinkingBlock,
							host.getMarkdownThemeWithSettings(),
							timestampFormat,
							{ startIndex: segment.startIndex, endIndex: segment.endIndex },
						);
						host.chatContainer.addChild(assistantComponent);
						assistantSegments.push(assistantComponent);
						continue;
					}

					const content = message.content[segment.contentIndex];
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.arguments,
							{ showImages: host.settingsManager.getShowImages() },
							host.getRegisteredToolDefinition(content.name),
							host.ui,
						);
						component.setExpanded(host.toolOutputExpanded);
						host.chatContainer.addChild(component);

						// On an aborted/errored turn, only the tool calls that never
						// produced a result should render as interrupted. A tool that
						// actually completed has its result in a later `toolResult`
						// message (keyed by toolCallId) — register it as pending so the
						// normal toolResult handler below renders the TRUE result with
						// its real isError flag. Otherwise the successful result would be
						// silently discarded and the row shown red.
						const turnAbortedOrErrored =
							message.stopReason === "aborted" || message.stopReason === "error";
						const hasRealResult =
							turnAbortedOrErrored &&
							sessionContext.messages.some(
								(m) => m.role === "toolResult" && m.toolCallId === content.id,
							);

						if (turnAbortedOrErrored && !hasRealResult) {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = host.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							host.pendingTools.set(content.id, component);
						}
					} else {
						const serverTool = asServerToolUse(content);
						if (serverTool) {
						// Server-side tool (e.g., native web search)
						const component = new ToolExecutionComponent(
							serverTool.name,
							serverTool.input ?? {},
							{ showImages: host.settingsManager.getShowImages() },
							undefined,
							host.ui,
						);
						component.setExpanded(host.toolOutputExpanded);
						host.chatContainer.addChild(component);
						// Find matching webSearchResult in host message's content
						const resultBlock = message.content
							.map(asWebSearchResult)
							.find((block) => block && block.toolUseId === serverTool.id);
						if (resultBlock) {
							const searchContent = resultBlock.content;
							const isError = searchContent && typeof searchContent === "object" && "type" in (searchContent as any) && (searchContent as any).type === "web_search_tool_result_error";
							const resultText = host.formatWebSearchResult(searchContent);
							component.updateResult({
								content: [{ type: "text", text: resultText }],
								isError: !!isError,
							});
						} else {
							// No result yet (aborted stream?) — show as pending
							host.pendingTools.set(serverTool.id, component);
						}
						}
					}
				}

				// Match streaming-mode behavior: show metadata once on the final
				// assistant prose segment for host message.
				const lastAssistantSegment = assistantSegments[assistantSegments.length - 1];
				lastAssistantSegment?.setShowMetadata(true);
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = host.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					host.pendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				addMessageToChat(host, message, options);
			}
		}

		// Any pendingTools entries left over after replay are historical tool
		// calls whose results were squashed out of session context (commonly by
		// compaction). Mark them finished so the frame stops showing "Running".
		for (const component of host.pendingTools.values()) {
			component.markHistoricalNoResult();
		}
		host.pendingTools.clear();
		trimChatHistory(host);
		reconcileChatTurnConnections(host.chatContainer.children);
		host.ui.requestRender();
	}

export function renderInitialMessages(host: InteractiveModeDelegateHost): void {
		const context = host.sessionManager.buildSessionContext();
		renderSessionContext(host, context, {
			updateFooter: true,
			populateHistory: true,
		});
		populatePinnedFromMessages(host, context.messages);

		const allEntries = host.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e: { type: string }) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			showStatus(host, `Session compacted ${times}`);
		}
	}

export async function getUserInput(host: InteractiveModeDelegateHost): Promise<string> {
		return new Promise((resolve) => {
			host.onInputCallback = (text: string) => {
				host.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

export function rebuildChatFromMessages(host: InteractiveModeDelegateHost): void {
		host.chatContainer.clear();
		host.pinnedMessageContainer.clear();
		const context = host.sessionManager.buildSessionContext();
		renderSessionContext(host, context);
		// Pinned content NOT re-populated here — the streaming lifecycle in
		// chat-controller.ts manages the pinned zone during active work.
		// populatePinnedFromMessages() remains in renderInitialMessages()
		// for the session-resume case at startup.
	}

	/**
	 * After rebuilding chat from messages, pin the last assistant text above the
	 * editor if tool results would otherwise push it out of the viewport.
	 */
export function populatePinnedFromMessages(host: InteractiveModeDelegateHost, messages: AgentMessage[]): void {
		host.pinnedMessageContainer.clear();

		// Walk backwards to find the last assistant message
		let lastAssistant: AssistantMessage | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg && "role" in msg && msg.role === "assistant") {
				lastAssistant = msg as AssistantMessage;
				break;
			}
		}
		if (!lastAssistant) return;

		// Check if any tool calls follow the last text block
		const content = lastAssistant.content;
		let lastTextIndex = -1;
		let hasToolAfterText = false;
		for (let i = 0; i < content.length; i++) {
			if (content[i].type === "text") lastTextIndex = i;
		}
		if (lastTextIndex >= 0) {
			for (let i = lastTextIndex + 1; i < content.length; i++) {
				if (isToolContentBlock(content[i])) {
					hasToolAfterText = true;
					break;
				}
			}
		}
		if (!hasToolAfterText || lastTextIndex < 0) return;

		const textBlock = content[lastTextIndex] as { type: "text"; text: string };
		const text = textBlock.text?.trim();
		if (!text) return;

		host.pinnedMessageContainer.addChild(
			new DynamicBorder((str: string) => theme.fg("dim", str), "Latest Output"),
		);
		host.pinnedMessageContainer.addChild(
			new Markdown(text, 1, 0, host.getMarkdownThemeWithSettings()),
		);
	}
