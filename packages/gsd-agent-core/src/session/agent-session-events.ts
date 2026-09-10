import type { AgentEvent, AgentMessage } from "@gsd/pi-agent-core";
import type { AssistantMessage, Message, TextContent } from "@gsd/pi-ai";
import { cleanupSessionResources } from "@gsd/pi-ai";
import type {
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@gsd/pi-coding-agent/core/extensions/index.js";
import type { AgentSessionEvent, AgentSessionEventListener } from "./agent-session-types.js";
import type { AgentSessionHost } from "./agent-session-host.js";

export class AgentSessionEventsModule {
	constructor(readonly host: AgentSessionHost) {}

	emit(event: AgentSessionEvent): void {
		for (const l of this.host._eventListeners) {
			l(event);
		}
	}

	emitQueueUpdate(): void {
		this.emit({
			type: "queue_update",
			steering: [...this.host._steeringMessages],
			followUp: [...this.host._followUpMessages],
		});
	}

	handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this.host._overflowRecoveryAttempted = false;
			const messageText = this.getUserMessageText(event.message);
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this.host._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this.host._steeringMessages.splice(steeringIndex, 1);
					this.emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this.host._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this.host._followUpMessages.splice(followUpIndex, 1);
						this.emitQueueUpdate();
					}
				}
			}
		}

		const agentEndWillRetry = event.type === "agent_end" ? this.willRetryAfterAgentEnd(event) : undefined;

		// Emit to extensions first
		await this.emitExtensionEvent(event, agentEndWillRetry);

		// Notify all listeners
		this.emit(event.type === "agent_end" ? { ...event, willRetry: agentEndWillRetry ?? false } : event);

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.host.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.host.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this.host._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				this.host._lastTurnCost = assistantMsg.usage?.cost?.total ?? 0;
				if (assistantMsg.stopReason !== "error") {
					this.host._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this.host._retryAttempt > 0) {
					this.emit({
						type: "auto_retry_end",
						success: true,
						attempt: this.host._retryAttempt,
					});
					this.host._retryAttempt = 0;
				}
			}
		}
	};

	willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.host.settingsManager.getRetrySettings();
		if (!settings.enabled || this.host._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this.host.canPrepareRetry(message as AssistantMessage);
			}
		}
		return false;
	}

	getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter((c) => c.type === "text");
		return textBlocks.map((c) => (c as TextContent).text).join("");
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.host.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	async emitExtensionEvent(event: AgentEvent, agentEndWillRetry?: boolean): Promise<void> {
		if (event.type === "agent_start") {
			this.host._turnIndex = 0;
			await this.host._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this.host._extensionRunner.emit({
				type: "agent_end",
				messages: event.messages,
				willRetry: agentEndWillRetry ?? false,
				...(event.abortOrigin ? { abortOrigin: event.abortOrigin } : {}),
			});
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this.host._turnIndex,
				timestamp: Date.now(),
			};
			await this.host._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this.host._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this.host._extensionRunner.emit(extensionEvent);
			this.host._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this.host._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this.host._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this.host._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				this.replaceMessageInPlace(event.message, replacement);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this.host._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this.host._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this.host._extensionRunner.emit(extensionEvent);
		}
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.host._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this.host._eventListeners.indexOf(listener);
			if (index !== -1) {
				this.host._eventListeners.splice(index, 1);
			}
		};
	}

	disconnectFromAgent(): void {
		if (this.host._unsubscribeAgent) {
			this.host._unsubscribeAgent();
			this.host._unsubscribeAgent = undefined;
		}
	}

	reconnectToAgent(): void {
		if (this.host._unsubscribeAgent) return; // Already connected
		this.host._unsubscribeAgent = this.host.agent.subscribe(this.handleAgentEvent);
	}

	dispose(): void {
		this.host._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this.disconnectFromAgent();
		this.host._eventListeners = [];
		cleanupSessionResources(this.host.sessionId);
	}
}
