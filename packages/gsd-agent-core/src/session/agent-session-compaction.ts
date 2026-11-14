import type { AssistantMessage } from "@gsd/pi-ai";
import { isContextOverflow, streamSimple } from "@gsd/pi-ai";
import { formatNoModelSelectedMessage } from "@gsd/pi-coding-agent/core/auth-guidance.js";
import type { CompactionEntry } from "@gsd/pi-coding-agent/core/session-manager.js";
import { getLatestCompactionEntry } from "@gsd/pi-coding-agent/core/session-manager.js";
import type { SessionBeforeCompactResult } from "@gsd/pi-coding-agent/core/extensions/index.js";
import type { AgentMessage } from "@gsd/pi-agent-core";
import {
	type CompactionResult,
	calculateContextTokens,
	compact,
	estimateContextTokens,
	prepareCompaction,
	shouldCompact,
} from "../compaction/index.js";
import type { AgentSessionHost } from "./agent-session-host.js";

export function resolveThresholdContextTokens(assistantMessage: AssistantMessage, messages: AgentMessage[]): number {
	const estimate = estimateContextTokens(messages);
	return Math.max(calculateContextTokens(assistantMessage.usage), estimate.tokens);
}

export class AgentSessionCompactionModule {
	constructor(readonly host: AgentSessionHost) {}

	private removeTrailingAssistantMessages(): void {
		const messages = this.host.agent.state.messages;
		let keepCount = messages.length;
		while (keepCount > 0 && messages[keepCount - 1]?.role === "assistant") {
			keepCount--;
		}
		if (keepCount !== messages.length) {
			this.host.agent.state.messages = messages.slice(0, keepCount);
		}
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		this.host.disconnectFromAgent();
		await this.host.abort();
		this.host._compactionAbortController = new AbortController();
		this.host.emit({ type: "compaction_start", reason: "manual" });

		try {
			if (!this.host.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { apiKey, headers } = await this.host.getCompactionRequestAuth(this.host.model);

			const pathEntries = this.host.sessionManager.getBranch();
			const settings = this.host.settingsManager.getCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this.host._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this.host._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: this.host._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const result = await compact(
					preparation,
					this.host.model,
					apiKey,
					headers,
					customInstructions,
					this.host._compactionAbortController.signal,
					this.host.thinkingLevel,
					this.host.agent.streamFn,
					undefined,
					{
						systemPrompt: this.host.agent.state.systemPrompt,
						sessionId: this.host.agent.sessionId,
						cacheRetention: this.host.agent.cacheRetention,
					},
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
			}

			if (this.host._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.host.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this.host.sessionManager.getEntries();
			const sessionContext = this.host.sessionManager.buildSessionContext();
			this.host.agent.state.messages = sessionContext.messages;

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.host._extensionRunner && savedCompactionEntry) {
				await this.host._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const compactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
			};
			this.host.emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this.host.emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this.host._compactionAbortController = undefined;
			this.host.reconnectToAgent();
		}
	}

	abortCompaction(): void {
		this.host._compactionAbortController?.abort();
		this.host._autoCompactionAbortController?.abort();
	}

	abortBranchSummary(): void {
		this.host._branchSummaryAbortController?.abort();
	}

	async checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.host.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.host.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.host.model && assistantMessage.provider === this.host.model.provider && assistantMessage.model === this.host.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.host.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Case 1: Overflow - LLM returned context overflow error
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			if (this.host._overflowRecoveryAttempted) {
				this.host.emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			this.host._overflowRecoveryAttempted = true;
			this.removeTrailingAssistantMessages();
			return await this.runAutoCompaction("overflow", true);
		}

		// Case 2: Threshold - context is getting large.
		// Use the same session estimate as the footer so trailing tool/custom
		// messages after the last provider usage can still trigger compaction.
		// For error messages (no usage data), estimate from last successful response.
		// This ensures sessions that hit persistent API errors (e.g. 529) can still compact.
		let contextTokens: number;
		if (assistantMessage.stopReason === "error") {
			const messages = this.host.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false; // No usage data at all
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = resolveThresholdContextTokens(assistantMessage, this.host.agent.state.messages);
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this.runAutoCompaction("threshold", false);
		}
		return false;
	}

	async runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const settings = this.host.settingsManager.getCompactionSettings();

		this.host.emit({ type: "compaction_start", reason });
		this.host._autoCompactionAbortController = new AbortController();

		try {
			if (!this.host.model) {
				this.host.emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
				});
				return false;
			}

			let apiKey: string | undefined;
			let headers: Record<string, string> | undefined;
			if (this.host.agent.streamFn === streamSimple) {
				const authResult = await this.host.modelRegistry.getApiKeyAndHeaders(this.host.model);
				if (!authResult.ok || !authResult.apiKey) {
					this.host.emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: false,
						willRetry: false,
					});
					return false;
				}
				apiKey = authResult.apiKey;
				headers = authResult.headers;
			} else {
				({ apiKey, headers } = await this.host.getCompactionRequestAuth(this.host.model));
			}

			const pathEntries = this.host.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				this.host.emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
				});
				return false;
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this.host._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this.host._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: this.host._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this.host.emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry,
					});
					if (willRetry) {
						this.removeTrailingAssistantMessages();
						return true;
					}
					return this.host.agent.hasQueuedMessages();
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const compactResult = await compact(
					preparation,
					this.host.model,
					apiKey,
					headers,
					undefined,
					this.host._autoCompactionAbortController.signal,
					this.host.thinkingLevel,
					this.host.agent.streamFn,
					undefined,
					{
						systemPrompt: this.host.agent.state.systemPrompt,
						sessionId: this.host.agent.sessionId,
						cacheRetention: this.host.agent.cacheRetention,
					},
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
			}

			if (this.host._autoCompactionAbortController.signal.aborted) {
				this.host.emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}

			this.host.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this.host.sessionManager.getEntries();
			const sessionContext = this.host.sessionManager.buildSessionContext();
			this.host.agent.state.messages = sessionContext.messages;

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.host._extensionRunner && savedCompactionEntry) {
				await this.host._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
			};
			this.host.emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				this.removeTrailingAssistantMessages();
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.host.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			this.host.emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
			});
			return false;
		} finally {
			this.host._autoCompactionAbortController = undefined;
		}
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		this.host.settingsManager.setCompactionEnabled(enabled);
	}

	get autoCompactionEnabled(): boolean {
		return this.host.settingsManager.getCompactionEnabled();
	}

}
