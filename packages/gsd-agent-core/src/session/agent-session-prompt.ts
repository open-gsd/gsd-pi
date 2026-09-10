import type { AgentAbortOrigin, AgentMessage, ThinkingLevel } from "@gsd/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@gsd/pi-ai";
import { isContextOverflow } from "@gsd/pi-ai";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "@gsd/pi-coding-agent/core/auth-guidance.js";
import { expandPromptTemplate } from "@gsd/pi-coding-agent/core/prompt-templates.js";
import type { CustomMessage } from "@gsd/pi-coding-agent/core/messages.js";
import { readFileSync } from "node:fs";
import { stripFrontmatter } from "@gsd/pi-coding-agent/utils/frontmatter.js";
import { sleep } from "@gsd/pi-coding-agent/utils/sleep.js";
import type { PromptOptions } from "./agent-session-types.js";
import type { AgentSessionHost } from "./agent-session-host.js";

type NoProgressTerminalRetryFingerprint = {
	errorKind: "terminated" | "timeout";
	contextMessageCount: number;
	lastContextMessage: AgentMessage | undefined;
};

export class AgentSessionPromptModule {
	private lastNoProgressTerminalRetry: NoProgressTerminalRetryFingerprint | undefined;

	constructor(readonly host: AgentSessionHost) {}

	async runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		const previousLatencyMark = this.host.agent.latencyMark;
		this.host.agent.latencyMark = (phase, data) => {
			previousLatencyMark?.(phase, data);
			if (phase === "agent_loop.first_stream_activity") {
				this.host.markFirstStreamActivity(String(data?.eventType ?? "unknown"), data);
			} else {
				this.host.markTurnLatency(phase, data);
			}
		};
		try {
			await this.host.agent.prompt(messages);
			while (await this.handlePostAgentRun()) {
				await this.host.agent.continue();
			}
		} finally {
			this.host.agent.latencyMark = previousLatencyMark;
			this.host.flushPendingBashMessages();
		}
	}

	async handlePostAgentRun(): Promise<boolean> {
		const msg = this.host._lastAssistantMessage;
		this.host._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (this.canPrepareRetry(msg) && (await this.prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this.host._retryAttempt > 0) {
			this.host.emit({
				type: "auto_retry_end",
				success: false,
				attempt: this.host._retryAttempt,
				finalError: msg.errorMessage,
			});
			this.host._retryAttempt = 0;
		}

		return await this.host.checkCompaction(msg);
	}

	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const source = options?.source ?? "interactive";
		const latency = this.host.beginTurnLatency({ source, trigger: "session.prompt" });
		let latencyStatus: "completed" | "queued" | "handled" | "error" = "completed";
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			this.host.markTurnLatency("session.prompt.enter", {
				source,
				hasImages: !!options?.images?.length,
				expandPromptTemplates,
			});
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				this.host.markTurnLatency("session.extension_command.start");
				const handled = await this.tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					this.host.markTurnLatency("session.extension_command.handled");
					latencyStatus = "handled";
					preflightResult?.(true);
					return;
				}
				this.host.markTurnLatency("session.extension_command.miss");
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this.host._extensionRunner.hasHandlers("input")) {
				this.host.markTurnLatency("session.input_handlers.start");
				const inputResult = await this.host._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
				);
				if (inputResult.action === "handled") {
					this.host.markTurnLatency("session.input_handlers.handled");
					latencyStatus = "handled";
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
				this.host.markTurnLatency("session.input_handlers.end", { action: inputResult.action });
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				this.host.markTurnLatency("session.prompt_expansion.start");
				expandedText = this.expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.host.promptTemplates]);
				this.host.markTurnLatency("session.prompt_expansion.end", {
					changed: expandedText !== currentText,
				});
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.host.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this.queueFollowUp(expandedText, currentImages);
				} else {
					await this.queueSteer(expandedText, currentImages);
				}
				this.host.markTurnLatency("session.prompt.queued", { mode: options.streamingBehavior });
				latencyStatus = "queued";
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this.host.flushPendingBashMessages();
			this.host.markTurnLatency("session.pending_bash_flushed");

			// Validate model
			this.host.markTurnLatency("session.model_auth_check.start");
			if (!this.host.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			if (!this.host.modelRegistry.hasConfiguredAuth(this.host.model)) {
				const isOAuth = this.host.modelRegistry.isUsingOAuth(this.host.model);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.host.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.host.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.host.model.provider));
			}
			this.host.markTurnLatency("session.model_auth_check.end", {
				provider: this.host.model.provider,
				model: this.host.model.id,
			});

			// Check if we need to compact before sending (catches aborted responses)
			const lastAssistant = this.host.findLastAssistantMessage();
			this.host.markTurnLatency("session.compaction_check.start", { hasLastAssistant: !!lastAssistant });
			if (lastAssistant && (await this.host.checkCompaction(lastAssistant, false))) {
				try {
					this.host.markTurnLatency("session.compaction_continue.start");
					await this.host.agent.continue();
					while (await this.handlePostAgentRun()) {
						await this.host.agent.continue();
					}
					this.host.markTurnLatency("session.compaction_continue.end");
				} finally {
					this.host.flushPendingBashMessages();
				}
			}
			this.host.markTurnLatency("session.compaction_check.end");

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this.host._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this.host._pendingNextTurnMessages = [];

			// Emit before_agent_start extension event
			this.host.markTurnLatency("session.before_agent_start.start");
			const result = await this.host._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this.host._baseSystemPrompt,
				this.host._baseSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						content: msg.content,
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt) {
				this.host.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this.host.agent.state.systemPrompt = this.host._baseSystemPrompt;
			}
			this.host.markTurnLatency("session.before_agent_start.end", {
				customMessages: result?.messages?.length ?? 0,
				systemPromptChanged: !!result?.systemPrompt,
			});
		} catch (error) {
			latencyStatus = "error";
			preflightResult?.(false);
			throw error;
		} finally {
			if (latencyStatus !== "completed" || !messages) {
				this.host.finishTurnLatency(latencyStatus);
			}
		}

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		try {
			this.host.markTurnLatency("session.agent_run.start", { messages: messages.length });
			await this.runAgentPrompt(messages);
			this.host.markTurnLatency("session.agent_run.end");
		} catch (error) {
			latencyStatus = "error";
			this.host.markTurnLatency("session.agent_run.error", {
				error: error instanceof Error ? error.name : typeof error,
			});
			throw error;
		} finally {
			this.host.finishTurnLatency(latencyStatus);
		}
	}

	async tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this.host._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this.host._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this.host._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.host.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this.host._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this.throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this.expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.host.promptTemplates]);

		await this.queueSteer(expandedText, images);
	}

	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this.throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this.expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.host.promptTemplates]);

		await this.queueFollowUp(expandedText, images);
	}

	async queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this.host._steeringMessages.push(text);
		this.host.emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.host.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	async queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this.host._followUpMessages.push(text);
		this.host.emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.host.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this.host._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this.host._pendingNextTurnMessages.push(appMessage);
		} else if (this.host.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.host.agent.followUp(appMessage);
			} else {
				this.host.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this.runAgentPrompt(appMessage);
		} else {
			this.host.agent.state.messages.push(appMessage);
			this.host.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this.host.emit({ type: "message_start", message: appMessage });
			this.host.emit({ type: "message_end", message: appMessage });
		}
	}

	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.host.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this.host._steeringMessages];
		const followUp = [...this.host._followUpMessages];
		this.host._steeringMessages = [];
		this.host._followUpMessages = [];
		this.host.agent.clearAllQueues();
		this.host.emitQueueUpdate();
		return { steering, followUp };
	}

	getSteeringMessages(): readonly string[] {
		return this.host._steeringMessages;
	}

	getFollowUpMessages(): readonly string[] {
		return this.host._followUpMessages;
	}

	async abort(origin?: AgentAbortOrigin): Promise<void> {
		this.abortRetry();
		this.host.agent.abort(origin);
		await this.host.agent.waitForIdle();
	}

	isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;
		if (message.errorMessage.startsWith("[length-halt]")) return false;

		// Context overflow is handled by compaction, not retry
		const contextWindow = this.host.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		const err = message.errorMessage;
		// Match: overloaded_error, provider returned error, rate limit, 429, 500, 502, 503, 504, service unavailable, network/connection errors (including connection lost), WebSocket transport closes/errors, fetch failed, premature stream endings, HTTP/2 closed before response, terminated, retry delay exceeded
		return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i.test(
			err,
		);
	}

	canPrepareRetry(message: AssistantMessage): boolean {
		const settings = this.host.settingsManager.getRetrySettings();
		if (!settings.enabled || this.host._retryAttempt >= settings.maxRetries) {
			return false;
		}
		if (!this.isRetryableError(message)) {
			return false;
		}
		return !this.isRepeatedNoProgressTerminalRetry(message);
	}

	async prepareRetry(message: AssistantMessage): Promise<boolean> {
		if (!this.canPrepareRetry(message)) {
			return false;
		}

		const settings = this.host.settingsManager.getRetrySettings();
		const retryFingerprint = this.getNoProgressTerminalRetryFingerprint(message);
		this.host._retryAttempt++;

		if (this.host._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this.host._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this.host._retryAttempt - 1);

		this.host.emit({
			type: "auto_retry_start",
			attempt: this.host._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.host.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.host.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this.host._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this.host._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this.host._retryAttempt;
			this.host._retryAttempt = 0;
			this.host.emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this.host._retryAbortController = undefined;
		}

		// Only record a fingerprint when the current failure is a terminal kind (terminated/timeout).
		// Unconditionally assigning retryFingerprint would clear the stored fingerprint for other
		// retryable errors (e.g. overloaded_error), allowing a later identical terminated/timeout
		// failure to bypass the no-progress guard.
		if (retryFingerprint !== undefined) {
			this.lastNoProgressTerminalRetry = retryFingerprint;
		}
		return true;
	}

	private isRepeatedNoProgressTerminalRetry(message: AssistantMessage): boolean {
		if (this.host._retryAttempt === 0) {
			return false;
		}
		const previous = this.lastNoProgressTerminalRetry;
		const current = this.getNoProgressTerminalRetryFingerprint(message);
		return (
			previous !== undefined &&
			current !== undefined &&
			previous.errorKind === current.errorKind &&
			previous.contextMessageCount === current.contextMessageCount &&
			previous.lastContextMessage === current.lastContextMessage
		);
	}

	private getNoProgressTerminalRetryFingerprint(
		message: AssistantMessage,
	): NoProgressTerminalRetryFingerprint | undefined {
		const errorKind = this.getNoProgressTerminalRetryErrorKind(message.errorMessage);
		if (!errorKind) {
			return undefined;
		}

		const messages = this.host.agent.state.messages;
		const hasTrailingAssistant = messages.length > 0 && messages[messages.length - 1].role === "assistant";
		const contextMessageCount = messages.length - (hasTrailingAssistant ? 1 : 0);
		return {
			errorKind,
			contextMessageCount,
			lastContextMessage: messages[contextMessageCount - 1],
		};
	}

	private getNoProgressTerminalRetryErrorKind(errorMessage: string | undefined): "terminated" | "timeout" | undefined {
		if (!errorMessage) {
			return undefined;
		}
		if (/terminated/i.test(errorMessage)) {
			return "terminated";
		}
		if (/timed? out|timeout/i.test(errorMessage)) {
			return "timeout";
		}
		return undefined;
	}

	abortRetry(): void {
		this.host._retryAbortController?.abort();
	}

	get isRetrying(): boolean {
		return this.host._retryAbortController !== undefined;
	}

	get autoRetryEnabled(): boolean {
		return this.host.settingsManager.getRetryEnabled();
	}

	setAutoRetryEnabled(enabled: boolean): void {
		this.host.settingsManager.setRetryEnabled(enabled);
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.host.agent.steeringMode = mode;
		this.host.settingsManager.setSteeringMode(mode);
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.host.agent.followUpMode = mode;
		this.host.settingsManager.setFollowUpMode(mode);
	}

}
