import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ThinkingLevel } from "@gsd/pi-agent-core";
import type { AssistantMessage } from "@gsd/pi-ai";
import { resolvePath } from "@gsd/pi-coding-agent/utils/paths.js";
import { DEFAULT_THINKING_LEVEL } from "@gsd/pi-coding-agent/core/defaults.js";
import type { ContextUsage } from "@gsd/pi-coding-agent/core/extensions/index.js";
import type {
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	TreePreparation,
} from "@gsd/pi-coding-agent/core/extensions/index.js";
import type { BranchSummaryEntry, SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader } from "@gsd/pi-coding-agent/core/session-manager.js";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import {
	calculateContextTokens,
	collectEntriesForBranchSummary,
	estimateContextTokens,
	generateBranchSummary,
} from "../compaction/index.js";
import { exportSessionToHtml, type ToolHtmlRenderer } from "../export-html/index.js";
import { createToolHtmlRenderer } from "../export-html/tool-renderer.js";
import type { SessionStats } from "./agent-session-types.js";
import type { AgentSessionHost } from "./agent-session-host.js";

export class AgentSessionNavigationModule {
	constructor(readonly host: AgentSessionHost) {}

	setSessionName(name: string): void {
		this.host.sessionManager.appendSessionInfo(name);
		this.host.emit({ type: "session_info_changed", name: this.host.sessionManager.getSessionName() });
	}

	async settleCurrentTurnForSessionTransition(): Promise<void> {
		if (!this.host.agent.state.isStreaming) {
			this.host.abortRetry();
			await this.host.agent.waitForIdle();
			return;
		}
		// Carry the programmatic origin so the terminal agent_end classifies this
		// teardown as an internal transition abort, not a user cancellation.
		await this.host.abort("programmatic");
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		workspaceRoot?: string;
		abortSignal?: AbortSignal;
	}): Promise<boolean> {
		const previousSessionFile = this.host.sessionFile;

		if (this.host._extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.host._extensionRunner.emit({
				type: "session_before_switch",
				reason: "new",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		await this.settleCurrentTurnForSessionTransition();

		if (options?.abortSignal?.aborted) {
			return false;
		}

		this.host.disconnectFromAgent();
		this.host.agent.reset();

		const previousCwd = this.host._cwd;
		this.host._cwd = options?.workspaceRoot ?? process.cwd();

		this.host.sessionManager.newSession({
			cwd: this.host._cwd,
			parentSession: options?.parentSession,
		});
		this.host.agent.sessionId = this.host.sessionManager.getSessionId();
		this.host._steeringMessages = [];
		this.host._followUpMessages = [];
		this.host._pendingNextTurnMessages = [];

		this.host.sessionManager.appendThinkingLevelChange(this.host.thinkingLevel);

		if (this.host._cwd !== previousCwd) {
			this.host.buildRuntime({
				activeToolNames: this.host.getActiveToolNames(),
				includeAllExtensionTools: true,
			});
		} else {
			this.host.refreshToolRegistry({
				activeToolNames: this.host.getActiveToolNames(),
				includeAllExtensionTools: true,
			});
		}

		if (options?.setup) {
			await options.setup(this.host.sessionManager);
			const sessionContext = this.host.sessionManager.buildSessionContext();
			this.host.agent.state.messages = sessionContext.messages;
		}

		this.host.reconnectToAgent();

		if (this.host._extensionRunner) {
			await this.host.emitSessionStartWithLegacySwitch({
				type: "session_start",
				reason: "new",
				previousSessionFile,
			});
		}

		return true;
	}

	async switchSession(sessionPath: string): Promise<boolean> {
		const previousSessionFile = this.host.sessionManager.getSessionFile();

		if (this.host._extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.host._extensionRunner.emit({
				type: "session_before_switch",
				reason: "resume",
				targetSessionFile: sessionPath,
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		await this.settleCurrentTurnForSessionTransition();
		this.host.disconnectFromAgent();

		this.host._steeringMessages = [];
		this.host._followUpMessages = [];
		this.host._pendingNextTurnMessages = [];

		this.host.sessionManager.setSessionFile(sessionPath);
		this.host.agent.sessionId = this.host.sessionManager.getSessionId();

		const sessionContext = this.host.sessionManager.buildSessionContext();
		this.host.agent.state.messages = sessionContext.messages;

		if (sessionContext.model) {
			const previousModel = this.host.model;
			const availableModels = await this.host.modelRegistry.getAvailable();
			const match = availableModels.find(
				(m) => m.provider === sessionContext.model!.provider && m.id === sessionContext.model!.modelId,
			);
			if (match) {
				this.host.agent.state.model = match;
				await this.host.emitModelSelect(match, previousModel, "restore");
			}
		}

		const hasThinkingEntry = this.host.sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");
		const defaultThinkingLevel = this.host.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;

		if (hasThinkingEntry) {
			this.host.setThinkingLevel(sessionContext.thinkingLevel as ThinkingLevel);
		} else {
			const availableLevels = this.host.getAvailableThinkingLevels();
			const effectiveLevel = availableLevels.includes(defaultThinkingLevel)
				? defaultThinkingLevel
				: this.host.clampThinkingLevel(defaultThinkingLevel, availableLevels);
			this.host.agent.state.thinkingLevel = effectiveLevel;
			this.host.sessionManager.appendThinkingLevelChange(effectiveLevel);
		}

		if (this.host._extensionRunner) {
			await this.host.emitSessionStartWithLegacySwitch({
				type: "session_start",
				reason: "resume",
				previousSessionFile,
			});
		}

		this.host.reconnectToAgent();
		return true;
	}

	async fork(entryId: string): Promise<{ selectedText: string; cancelled: boolean }> {
		const previousSessionFile = this.host.sessionFile;
		const selectedEntry = this.host.sessionManager.getEntry(entryId);

		if (!selectedEntry || selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for forking");
		}

		const selectedText = this.extractUserMessageText(selectedEntry.message.content);

		let skipConversationRestore = false;

		if (this.host._extensionRunner?.hasHandlers("session_before_fork")) {
			const result = (await this.host._extensionRunner.emit({
				type: "session_before_fork",
				entryId,
				position: "at",
			})) as SessionBeforeForkResult | undefined;

			if (result?.cancel) {
				return { selectedText, cancelled: true };
			}
			skipConversationRestore = result?.skipConversationRestore ?? false;
		}

		this.host._pendingNextTurnMessages = [];

		if (!selectedEntry.parentId) {
			this.host.sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			this.host.sessionManager.createBranchedSession(selectedEntry.parentId);
		}
		this.host.agent.sessionId = this.host.sessionManager.getSessionId();

		const sessionContext = this.host.sessionManager.buildSessionContext();

		if (this.host._extensionRunner) {
			await this.host._extensionRunner.emit({
				type: "session_start",
				reason: "fork",
				previousSessionFile,
			});
		}

		if (!skipConversationRestore) {
			this.host.agent.state.messages = sessionContext.messages;
		}

		return { selectedText, cancelled: false };
	}

	getLastTurnCost(): number {
		return this.host._lastTurnCost;
	}

	get editMode(): "standard" | "hashline" {
		return this.host.settingsManager.getEditMode();
	}

	setEditMode(mode: "standard" | "hashline"): void {
		this.host.settingsManager.setEditMode(mode);
	}

	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.host.sessionManager.getLeafId();

		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		if (options.summarize && !this.host.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.host.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.host.sessionManager,
			oldLeafId,
			targetId,
		);

		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		this.host._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			if (this.host._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this.host._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this.host._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			let summaryText: string | undefined;
			let summaryDetails: unknown;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.host.model!;
				const { apiKey, headers } = await this.host.getRequiredRequestAuth(model);
				const branchSummarySettings = this.host.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					signal: this.host._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				newLeafId = targetEntry.parentId;
				editorText = this.extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				newLeafId = targetId;
			}

			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				const summaryId = this.host.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.host.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				if (label) {
					this.host.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				this.host.sessionManager.resetLeaf();
			} else {
				this.host.sessionManager.branch(newLeafId);
			}

			if (label && !summaryText) {
				this.host.sessionManager.appendLabelChange(targetId, label);
			}

			const sessionContext = this.host.sessionManager.buildSessionContext();
			this.host.agent.state.messages = sessionContext.messages;

			await this.host._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.host.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this.host._branchSummaryAbortController = undefined;
		}
	}

	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.host.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this.extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	getSessionStats(): SessionStats {
		const state = this.host.state;
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
		const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		return {
			sessionFile: this.host.sessionFile,
			sessionId: this.host.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.host.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.host.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
						}
						break;
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.host.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = this.host.settingsManager.getTheme();

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.host.getToolDefinition(name),
			theme,
			cwd: this.host.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.host.sessionManager, this.host.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.host.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.host.sessionManager.getCwd(),
		};

		const branchEntries = this.host.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	getLastAssistantText(): string | undefined {
		const lastAssistant = this.host.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

}
