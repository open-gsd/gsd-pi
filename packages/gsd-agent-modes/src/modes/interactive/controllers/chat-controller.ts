// Project/App: gsd-pi
// File Purpose: Interactive TUI chat stream controller.
import { normalizeToolResultContent } from "@gsd/pi-ai";
import { Loader, Spacer, Text } from "@gsd/pi-tui";

import type { InteractiveModeEvent, InteractiveModeStateHost } from "../interactive-mode-state.js";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { AssistantMessageComponent } from "../components/assistant-message.js";
import { reconcileChatTurnConnections } from "../components/chat-turn-connect.js";
import { ToolExecutionComponent } from "../components/tool-execution.js";
import { appKey } from "../components/keybinding-hints.js";
import { markFirstVisibleAssistantOutput, markTuiLatency } from "./chat-controller-latency.js";
import {
	findLatestPinnableCandidates,
	findLatestPinnableText,
	tearDownPinnedZone,
	updatePinnedMessageZone,
} from "./chat-pinned-zone.js";
import {
	hasAssistantToolBlocks,
	hasVisibleAssistantContent,
	isProvisionalPreToolProse,
	isRedundantDiscussRestatement,
	priorAssistantTextFromSession,
	shouldSuppressEntireAssistantMessage,
	textInvitesUserReply,
} from "./chat-handoff-filter.js";
import {
	registerPendingToolComponent,
	replaceCompactToolRowsWithPhaseSummary,
} from "./chat-tool-rollup.js";
import {
	applySubTurnContentShrink,
	rebuildSegmentsOnMessageEnd,
	runSegmentWalker,
	scanNewContentBlocks,
} from "./chat-segment-walker.js";

export {
	findLatestPinnableCandidates,
	findLatestPinnableText,
	isProvisionalPreToolProse,
	isRedundantDiscussRestatement,
	priorAssistantTextFromSession,
	textInvitesUserReply,
};

function startLoadingAnimation(host: InteractiveModeStateHost): void {
	if (host.pendingWorkingMessage === null) {
		host.loadingAnimation = undefined;
		host.statusContainer.clear();
		startActivityIndicator(host);
		return;
	}

	host.loadingAnimation = new Loader(
		host.ui,
		(spinner) => theme.fg("accent", spinner),
		(text) => theme.fg("muted", text),
		host.defaultWorkingMessage,
	);
	host.statusContainer.addChild(host.loadingAnimation);
	if (host.pendingWorkingMessage !== undefined) {
		if (host.pendingWorkingMessage) {
			host.loadingAnimation?.setMessage?.(host.pendingWorkingMessage);
		}
		host.pendingWorkingMessage = undefined;
	}
}

/** Compact activity pulse used when extensions suppress the default working loader. */
export function startActivityIndicator(host: InteractiveModeStateHost, message?: string): void {
	stopActivityIndicator(host);
	const phase =
		message?.trim() ||
		(host as { gsdProgressState?: { phase?: string } }).gsdProgressState?.phase ||
		host.defaultWorkingMessage;
	host.activityLoader = new Loader(
		host.ui,
		(spinner) => theme.fg("accent", spinner),
		(text) => theme.fg("muted", text),
		phase,
	);
	host.statusContainer.addChild(host.activityLoader);
	host.ui.requestRender();
}

export function stopActivityIndicator(host: InteractiveModeStateHost): void {
	if (!host.activityLoader) return;
	host.activityLoader.stop();
	host.activityLoader = undefined;
	if (!host.loadingAnimation && !host.autoCompactionLoader && !host.retryLoader) {
		host.statusContainer.clear();
	}
}

export async function handleAgentEvent(host: InteractiveModeStateHost & {
	init: () => Promise<void>;
	getMarkdownThemeWithSettings: () => any;
	addMessageToChat: (message: any, options?: any) => void;
	formatWebSearchResult: (content: unknown) => string;
	getRegisteredToolDefinition: (toolName: string) => any;
	checkShutdownRequested: () => Promise<void>;
	rebuildChatFromMessages: () => void;
	flushCompactionQueue: (options?: { willRetry?: boolean }) => Promise<void>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	updatePendingMessagesDisplay: () => void;
	updateTerminalTitle: () => void;
	updateEditorBorderColor: () => void;
	pendingMessagesContainer: { clear: () => void };
}, event: InteractiveModeEvent): Promise<void> {
	if (!host.isInitialized) {
		await host.init();
	}

	host.footer.invalidate();
	const timestampFormat = host.settingsManager.getTimestampFormat();
	const rs = host.streamingRenderState;

	// Reset content index tracker and pinned state when a new assistant message starts
	if (event.type === "message_start" && event.message.role === "assistant") {
		rs.resetForNewAssistantMessage();
		tearDownPinnedZone(host);
	}

	switch (event.type) {
		case "session_state_changed":
			switch (event.reason) {
				case "new_session":
				case "switch_session":
				case "fork":
					host.streamingComponent = undefined;
					host.streamingMessage = undefined;
					host.pendingTools.clear();
					host.activeToolInvocations.clear();
					host.pendingMessagesContainer.clear();
					tearDownPinnedZone(host);
					rs.resetForSessionChange();
					host.compactionQueuedMessages = [];
					host.rebuildChatFromMessages();
					host.updatePendingMessagesDisplay();
					host.updateTerminalTitle();
					host.updateEditorBorderColor();
					host.ui.requestRender();
					return;
				case "set_session_name":
					host.updateTerminalTitle();
					host.ui.requestRender();
					return;
				case "set_model":
				case "set_thinking_level":
					host.updateEditorBorderColor();
					host.ui.requestRender();
					return;
				default:
					host.ui.requestRender();
					return;
			}
		case "agent_start":
			host.clearBlockingError();
			if (host.retryEscapeHandler) {
				host.defaultEditor.onEscape = host.retryEscapeHandler;
				host.retryEscapeHandler = undefined;
			}
			if (host.retryLoader) {
				host.retryLoader.stop();
				host.retryLoader = undefined;
			}
			if (host.loadingAnimation) {
				host.loadingAnimation.stop();
			}
			stopActivityIndicator(host);
			host.statusContainer.clear();
			startLoadingAnimation(host);
			markTuiLatency(host, "tui.loader_visible");
			host.ui.requestRender();
			break;

		case "message_start":
			if (event.message.role === "custom") {
				host.addMessageToChat(event.message);
				host.ui.requestRender();
			} else if (event.message.role === "user") {
				host.addMessageToChat(event.message);
				host.updatePendingMessagesDisplay();
				host.ui.requestRender();
			} else if (event.message.role === "assistant") {
				host.streamingMessage = event.message;
				// External-tool providers can stream multiple assistant turns through
				// one response. Delay component creation until visible assistant text
				// arrives so tool outputs keep chronological ordering.
				markTuiLatency(host, "tui.assistant_message_start", {
					provider: event.message.provider,
					model: event.message.model,
				});
				host.ui.requestRender();
			}
			break;

		case "message_update":
			if (event.message.role === "assistant") {
				host.streamingMessage = event.message;
				const innerEvent = event.assistantMessageEvent;

				let externalToolResult:
					| { toolCallId: string; content: ReturnType<typeof normalizeToolResultContent>; details: Record<string, unknown>; isError: boolean }
					| undefined;
				if (innerEvent.type === "toolcall_end" && innerEvent.toolCall) {
					const tc = innerEvent.toolCall as any;
					const ext = tc.externalResult;
					if (ext) {
						externalToolResult = {
							toolCallId: tc.id,
							content: normalizeToolResultContent(ext.content),
							// Preserve undefined when MCP omits structuredContent — an empty
							// object is truthy and makes ask_user_questions renderResult show
							// "Cancelled" despite a successful text payload (#cc-elicitation).
							details: ext.details,
							isError: ext.isError ?? false,
						};
					}
				} else if (innerEvent.type === "server_tool_use") {
					const idx = typeof innerEvent.contentIndex === "number" ? innerEvent.contentIndex : -1;
					const block = idx >= 0 ? (host.streamingMessage.content[idx] as any) : undefined;
					const ext = block?.externalResult;
					if (block?.id && ext) {
						externalToolResult = {
							toolCallId: block.id,
							content: normalizeToolResultContent(ext.content),
							details: ext.details,
							isError: ext.isError ?? false,
						};
					}
				}

				const contentBlocks = host.streamingMessage.content;
				// Some adapters (notably claude-code) reuse a single assistant
				// lifecycle while internally spanning multiple provider sub-turns.
				// When a new sub-turn starts, content[] length shrinks back to 0/1.
				// The scan loop needs its index reset, AND the segment walker's
				// rs.renderedSegments map must be cleared so existing text-run
				// components don't get overwritten in place with new sub-turn
				// content (#4144 regression). Prior sub-turn children stay in
				// chatContainer as frozen history; new segments append after them.
				applySubTurnContentShrink(rs, contentBlocks);
				scanNewContentBlocks(host, rs, contentBlocks);

				// When the stream adapter signals a completed tool call with an
				// external result (from Claude Code SDK), update the pending
				// ToolExecutionComponent immediately so output is visible in
				// real-time instead of waiting for the session to end.
				if (externalToolResult) {
					// The provider already finished this invocation and delivered the
					// result inline; serverToolUse blocks never see a native
					// tool_execution_end, so stop counting here (#2925). For regular
					// toolCalls the loop's paired start/end events re-claim and release
					// the id transiently at dispatch — net zero.
					host.activeToolInvocations.delete(externalToolResult.toolCallId);
					const component = host.pendingTools.get(externalToolResult.toolCallId);
					if (component) {
						component.updateResult({
							content: externalToolResult.content,
							details: externalToolResult.details,
							isError: externalToolResult.isError,
						});
						replaceCompactToolRowsWithPhaseSummary(host);
					}
				}

				// Run the segment walker synchronously on each delta so the TUI's
				// built-in render throttling (requestRender guard + 16ms interval)
				// naturally batches renders into 16ms windows. This produces
				// incremental, visible streaming instead of a single block at the
				// end of the microtask queue drain. The queueMicrotask() wrapper
				// was counterproductive: it batched all walker runs together before
				// any render could fire, making the user see nothing until the
				// entire microtask batch completed.
				runSegmentWalker(host, rs, timestampFormat);

				// Update index: fully processed blocks won't need re-scanning.
				// Keep the last block's index (it may still be accumulating data),
				// so we re-check it next time but skip all earlier ones.
				if (contentBlocks.length > 0) {
					rs.lastProcessedContentIndex = Math.max(0, contentBlocks.length - 1);
				}

				// Pinned message: mirror the latest assistant text above the editor
				// when tool executions push it out of the viewport.
				const { toreDownPinnedZone } = updatePinnedMessageZone(host, rs, contentBlocks);
				if (toreDownPinnedZone && !host.loadingAnimation) {
					host.statusContainer.clear();
					startLoadingAnimation(host);
				}

				// Leading-edge render: the first delta triggers an immediate
				// render so the beginning of the response is visible right away.
				// Subsequent deltas are throttled by the TUI's requestRender()
				// guard (no-op when a render is already pending) and the
				// 16ms minimum render interval — producing incremental streaming.
				host.ui.requestRender();
			}

			break;

		case "message_end":
			if (event.message.role === "user") break;
			if (event.message.role === "assistant") {
				host.streamingMessage = event.message;
				let errorMessage: string | undefined;
					if (host.streamingMessage.stopReason === "aborted") {
						const retryAttempt = host.session.retryAttempt;
						errorMessage = retryAttempt > 0
							? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
							: "Operation aborted";
						host.streamingMessage.errorMessage = errorMessage;
					}

					const shouldRenderAssistant =
						hasVisibleAssistantContent(host.streamingMessage, host.hideThinkingBlock) ||
						(
							(host.streamingMessage.stopReason === "aborted" || host.streamingMessage.stopReason === "error") &&
							!hasAssistantToolBlocks(host.streamingMessage)
						);
					const suppressRedundantHandoff = shouldSuppressEntireAssistantMessage(
						host.streamingMessage,
						host.session.messages,
						rs.orphanedSegments,
					);

					// The final message_end payload can contain additional text/thinking
					// blocks that never arrived via message_update (e.g. SDK result
					// aggregation). Rebuild this in-flight turn from final content so
					// ranges/components don't keep stale partial indices.
					rebuildSegmentsOnMessageEnd(host, rs, timestampFormat);

					if (!host.streamingComponent && shouldRenderAssistant && !suppressRedundantHandoff) {
						host.streamingComponent = new AssistantMessageComponent(
							undefined,
							host.hideThinkingBlock,
							host.getMarkdownThemeWithSettings(),
							timestampFormat,
							undefined,
						);
						host.chatContainer.addChild(host.streamingComponent);
						markFirstVisibleAssistantOutput(host, "message_end_only");
						reconcileChatTurnConnections(host.chatContainer.children);
						// Ensure the newly created component paints immediately.
						// flushPendingStreamingWork() runs later in this same
						// handler and calls requestRender() again, but an
						// explicit call here prevents a race where the component
						// has been added to the DOM but hasn't painted yet —
						// the user would see a blank space briefly before the
						// final render. Keeping this is safe because requestRender()
						// is a no-op when a render is already pending.
						host.ui.requestRender();
					}
					if (host.streamingComponent) {
						host.streamingComponent.setShowMetadata(true);
						host.streamingComponent.updateContent(host.streamingMessage);
					}

				if (host.streamingMessage.stopReason === "aborted" || host.streamingMessage.stopReason === "error") {
					if (!errorMessage) {
						errorMessage = host.streamingMessage.errorMessage || "Error";
					}
					const pendingComponents = Array.from(host.pendingTools.values());
					if (pendingComponents.length > 0) {
						const [first, ...rest] = pendingComponents;
						first.completeWithError(errorMessage);
						for (const component of rest) {
							component.completeWithError();
						}
					}
					host.pendingTools.clear();
					// Turn terminal: every invocation stops counting, including ones
					// whose paired tool_execution_end never arrived (abort/timeout).
					host.activeToolInvocations.clear();
				} else {
					for (const [, component] of host.pendingTools.entries()) {
						component.setArgsComplete();
					}
					replaceCompactToolRowsWithPhaseSummary(host);
				}
				host.streamingComponent = undefined;
				host.streamingMessage = undefined;
				rs.resetStreamingSegments();
				// Clear pinned output once the message is finalized in the chat
				// container — prevents duplicate display when the agent continues
				// (e.g. form elicitation) after the assistant message ends.
				tearDownPinnedZone(host, { realignViewport: true });
				host.footer.invalidate();
		}
		// Final state paints immediately: cancel any pending debounced
		// render from streaming and request one now.
		rs.flushPendingStreamingWork(host.ui);
		break;

		case "tool_execution_start": {
			// Count the invocation the moment the session dispatches it — keyed by
			// toolCallId, so duplicate start events are idempotent (#2925).
			host.activeToolInvocations.add(event.toolCallId);
			const { component, created } = registerPendingToolComponent(
				host,
				event.toolCallId,
				event.toolName,
				event.args,
				"standalone",
				() =>
					new ToolExecutionComponent(
						event.toolName,
						event.args,
						{ showImages: host.settingsManager.getShowImages() },
						host.getRegisteredToolDefinition(event.toolName),
						host.ui,
					),
			);
			if (created) {
				rs.renderedSegments.push({ kind: "tool", contentIndex: Number.MAX_SAFE_INTEGER, component });
			}
			host.ui.requestRender();
			break;
		}

		case "tool_execution_update": {
			const component = host.pendingTools.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.partialResult, isError: false }, true);
				host.ui.requestRender();
			}
			break;
		}

		case "tool_execution_end": {
			// Terminal event: stop counting before touching the component. Delete
			// is idempotent — duplicate terminals and late terminals for ids the
			// tracker no longer holds are no-ops, so the count can't go negative
			// or double-decrement (#2925). The component itself stays in
			// host.pendingTools — see the retention note below.
			host.activeToolInvocations.delete(event.toolCallId);
			const component = host.pendingTools.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.result, isError: event.isError });
				// NOTE: the component is intentionally left in host.pendingTools.
				// The message_end rebuild path relies on finding already-completed
				// components there to re-attach them; removing it here makes the
				// rebuild synthesize a fresh empty component that a turn-abort would
				// then mark errored. The real protection against downgrading a
				// finished tool lives in ToolExecutionComponent.completeWithError,
				// which no-ops on an already-successful result.
				replaceCompactToolRowsWithPhaseSummary(host);
				host.ui.requestRender();
			}
			break;
		}

		case "agent_end":
			if (host.loadingAnimation) {
				host.loadingAnimation.stop();
				host.loadingAnimation = undefined;
				host.statusContainer.clear();
			}
			stopActivityIndicator(host);
			if (host.streamingComponent && host.streamingMessage) {
				host.streamingComponent.setShowMetadata(true);
				host.streamingComponent.updateContent(host.streamingMessage);
			}
			for (const component of new Set(host.pendingTools.values())) {
				component.markHistoricalNoResult();
			}
			replaceCompactToolRowsWithPhaseSummary(host);
			host.streamingComponent = undefined;
			host.streamingMessage = undefined;
			rs.resetForSessionChange();
			host.pendingTools.clear();
			host.activeToolInvocations.clear();
			// Pinned output is only useful while work is actively streaming.
			// Keep chat history as the single source after completion.
			tearDownPinnedZone(host, { realignViewport: true });
			await host.checkShutdownRequested();
			rs.flushPendingStreamingWork(host.ui);
			break;

		case "auto_compaction_start":
			host.autoCompactionEscapeHandler = host.defaultEditor.onEscape;
			host.defaultEditor.onEscape = () => host.session.abortCompaction();
			host.statusContainer.clear();
			host.autoCompactionLoader = new Loader(
				host.ui,
				(spinner) => theme.fg("accent", spinner),
				(text) => theme.fg("muted", text),
				`${event.reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... (${appKey(host.keybindings, "interrupt")} to cancel)`,
			);
			host.statusContainer.addChild(host.autoCompactionLoader);
			host.ui.requestRender();
			break;

		case "auto_compaction_end":
			if (host.autoCompactionEscapeHandler) {
				host.defaultEditor.onEscape = host.autoCompactionEscapeHandler;
				host.autoCompactionEscapeHandler = undefined;
			}
			if (host.autoCompactionLoader) {
				host.autoCompactionLoader.stop();
				host.autoCompactionLoader = undefined;
				host.statusContainer.clear();
			}
			if (event.aborted) {
				host.showStatus("Auto-compaction cancelled");
			} else if (event.result) {
				host.chatContainer.clear();
				host.rebuildChatFromMessages();
				host.addMessageToChat({
					role: "compactionSummary",
					tokensBefore: event.result.tokensBefore,
					summary: event.result.summary,
					timestamp: Date.now(),
				});
				host.footer.invalidate();
			} else if (event.errorMessage) {
				host.chatContainer.addChild(new Spacer(1));
				host.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
			}
			void host.flushCompactionQueue({ willRetry: event.willRetry });
			host.ui.requestRender();
			break;

		case "auto_retry_start":
			host.retryEscapeHandler = host.defaultEditor.onEscape;
			host.defaultEditor.onEscape = () => host.session.abortRetry();
			host.statusContainer.clear();
			host.retryLoader = new Loader(
				host.ui,
				(spinner) => theme.fg("warning", spinner),
				(text) => theme.fg("muted", text),
				`Retrying (${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1000)}s... (${appKey(host.keybindings, "interrupt")} to cancel)`,
			);
			host.statusContainer.addChild(host.retryLoader);
			host.ui.requestRender();
			break;

		case "auto_retry_end":
			if (host.retryEscapeHandler) {
				host.defaultEditor.onEscape = host.retryEscapeHandler;
				host.retryEscapeHandler = undefined;
			}
			if (host.retryLoader) {
				host.retryLoader.stop();
				host.retryLoader = undefined;
				host.statusContainer.clear();
			}
			if (!event.success) {
				host.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
			}
			host.ui.requestRender();
			break;

		case "fallback_provider_switch":
			host.showStatus(`Switched from ${event.fromProvider} → ${event.toProvider} (${event.reason})`);
			host.ui.requestRender();
			break;

		case "fallback_provider_restored":
			host.showStatus(`Restored to ${event.provider}`);
			host.ui.requestRender();
			break;

		case "fallback_chain_exhausted":
			host.showError(`All fallback providers exhausted for ${event.model.name}: ${event.providers.join(", ")}`);
			host.ui.requestRender();
			break;

		case "image_overflow_recovery":
			host.showStatus(
				`Removed ${event.strippedCount} older image(s) to comply with API limits. Retrying...`,
			);
			host.ui.requestRender();
			break;
	}
}
