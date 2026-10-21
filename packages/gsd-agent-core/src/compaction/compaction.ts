/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@gsd/pi-agent-core";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@gsd/pi-ai";
import { completeSimple } from "@gsd/pi-ai";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "@gsd/pi-coding-agent/core/messages.js";
import { buildSessionContext, type CompactionEntry, type SessionEntry } from "@gsd/pi-coding-agent/core/session-manager.js";
import {
	computeFileLists,
	createFileOps,
	estimateSerializedTokens,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.js";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	thresholdPercent?: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate prompt-side context tokens from usage.
 *
 * Providers can normalize cumulative SDK usage into `totalTokens`, so prefer it
 * when present. Completion/output tokens are not part of the reusable
 * conversation context, so they are excluded — `totalTokens` includes them
 * (direct-API providers report `input + output + cacheRead + cacheWrite`; the
 * claude-code adapter reports `input + output + cacheWrite`), hence the
 * subtraction. When `totalTokens` is unavailable, fall back to the prompt-side
 * component sum.
 *
 * - Direct-API: `totalTokens - output === input + cacheRead + cacheWrite`
 *   (behavior-preserving, token-for-token, vs. the fallback).
 * - claude-code: `totalTokens - output === input + cacheWrite`, the
 *   de-cumulated live-context proxy (the cumulative `cacheRead` is excluded).
 */
export function calculateContextTokens(usage: Usage): number {
	if (usage.totalTokens > 0) return Math.max(0, usage.totalTokens - usage.output);
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	if (
		settings.thresholdPercent !== undefined &&
		Number.isFinite(settings.thresholdPercent) &&
		settings.thresholdPercent > 0 &&
		settings.thresholdPercent < 1
	) {
		return contextTokens > contextWindow * settings.thresholdPercent;
	}
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// Cut point detection
// ============================================================================

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				chars = content.length;
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						chars += block.text.length;
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			if (typeof message.content === "string") {
				chars = message.content.length;
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) {
						chars += block.text.length;
					}
					if (block.type === "image") {
						chars += 4800; // Estimate images as 4000 chars, or 1200 tokens
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
				break;
		}

		// branch_summary and custom_message are user-role messages, valid cut points
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		// branch_summary and custom_message are user-role messages, can start a turn
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		const message = getMessageFromEntryForCompaction(entry);
		if (!message) continue;

		// Estimate this message's size
		const messageTokens = estimateTokens(message);
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Find the closest valid cut point at or after this entry
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	// Scan backwards from cutIndex to include any non-message entries (bash, settings, etc.)
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at session header or compaction boundaries
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			// Stop if we hit any message
			break;
		}
		// Include this non-message entry (bash, settings change, etc.)
		cutIndex--;
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const isUserMessage =
		(cutEntry.type === "message" && cutEntry.message.role === "user") ||
		cutEntry.type === "branch_summary" ||
		cutEntry.type === "custom_message";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = `The messages above are a conversation to hand off. Write a briefing that gets a successor productive in 30 seconds. This is a STATE SNAPSHOT, not a conversation summary — capture where things ARE, not the story of how they got there.

If the conversation shifted direction (e.g., started on problem A, pivoted to problem B), lead with the CURRENT direction. Resolved problems are background, not headline.

Use this EXACT format:

## Current Direction
[What is actively being worked on RIGHT NOW. This may differ from the original request — if so, state the current focus, not the original ask. Be specific: name the task, the approach being taken, and where in that approach we are.]

## Next Action
[The single most immediate thing to do when resuming. Be concrete — "run the test suite for X" not "continue working."]

## Decided
- **[Decision]**: [rationale in one line]
[Only decisions that constrain future work. Skip deliberation, just verdicts.]

## Done
- [x] [Completed work, especially file paths modified and what changed in them]
[Include resolved problems briefly so they are not re-investigated.]

## Failed Approaches
- [Approaches tried that did NOT work and why — so the successor does not retry them]
- [Or "(none)" if all approaches succeeded]

## Constraints & Preferences
- [Requirements, preferences, or rules the user stated]
- [Or "(none)" if none were mentioned]

## Background
- [Context from earlier in the conversation that is still load-bearing for the current direction]
- [Omit anything fully resolved that does not affect current work]

Preserve exact file paths, function names, and error messages. Be concise — every line should help the successor act, not just understand history.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages. Update the existing briefing (in <previous-summary> tags) to reflect the CURRENT state of the work.

This is a living state snapshot, not an append-only log. RULES:
- UPDATE "Current Direction" to reflect where the work is NOW — if the direction shifted, the new direction leads
- UPDATE "Next Action" to the most immediate next step based on latest progress
- MOVE completed work to "Done" — add newly completed items, keep previous ones
- ADD new decisions to "Decided"
- ADD failed approaches to "Failed Approaches" so they are not retried
- DEMOTE or DROP information from the previous briefing that is no longer relevant to active work — do not preserve resolved context that does not affect the current direction
- PRESERVE exact file paths, function names, and error messages

Use this EXACT format:

## Current Direction
[Update to reflect the current focus — may have shifted from previous briefing]

## Next Action
[The single most immediate thing to do now]

## Decided
- **[Decision]**: [rationale in one line]
[Preserve previous decisions that still constrain work, add new ones]

## Done
- [x] [All completed work — previous and new]

## Failed Approaches
- [Preserve previous, add any new failed approaches from these messages]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Background
- [Only context that is still load-bearing for the current direction — drop resolved items]

Preserve exact file paths, function names, and error messages. Be concise.`;

type SummaryCompleteFn = (
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
) => AssistantMessage | Promise<AssistantMessage>;

export class CompactionInvalidInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CompactionInvalidInputError";
	}
}

export class CompactionProducedNoSummaryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CompactionProducedNoSummaryError";
	}
}

export function isDegenerateSummary(summary: string | undefined): boolean {
	if (summary === undefined) return false;
	const normalized = summary.trim().toLowerCase();
	if (normalized.length === 0 || normalized.length < 100) return true;
	return (
		normalized.includes("empty conversation") ||
		normalized.includes("no conversation to summarize") ||
		normalized.includes("nothing between the <conversation> tags")
	);
}

export function chunkMessages(messages: AgentMessage[], maxChunkTokens: number): AgentMessage[][] {
	const chunks: AgentMessage[][] = [];
	let currentChunk: AgentMessage[] = [];
	let currentTokens = 0;
	const budget = Math.max(1, maxChunkTokens);

	for (const message of messages) {
		const messageTokens = estimateSerializedTokens(message);
		if (currentChunk.length > 0 && currentTokens + messageTokens > budget) {
			chunks.push(currentChunk);
			currentChunk = [];
			currentTokens = 0;
		}
		currentChunk.push(message);
		currentTokens += messageTokens;
	}

	if (currentChunk.length > 0) {
		chunks.push(currentChunk);
	}

	return chunks;
}

function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		// Summarization is a mechanical template-fill; extended reasoning adds
		// cost, not quality. Cap at "low" regardless of session thinking level.
		options.reasoning = "low";
	}
	return options;
}

async function completeSummarization(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	completeFn?: SummaryCompleteFn,
): Promise<AssistantMessage> {
	if (completeFn) {
		return completeFn(model, context, options);
	}
	if (!streamFn) {
		return completeSimple(model, context, options);
	}
	const stream = await streamFn(model, context, options);
	return stream.result();
}

function summaryText(response: AssistantMessage): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function buildSummarizationPrompt(
	messages: AgentMessage[],
	customInstructions: string | undefined,
	previousSummary: string | undefined,
): string {
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	return promptText + basePrompt;
}

async function summarizeOnce(
	messages: AgentMessage[],
	model: Model<any>,
	options: SimpleStreamOptions,
	customInstructions: string | undefined,
	previousSummary: string | undefined,
	streamFn: StreamFn | undefined,
	completeFn: SummaryCompleteFn | undefined,
): Promise<string> {
	const promptText = buildSummarizationPrompt(messages, customInstructions, previousSummary);
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await completeSummarization(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		options,
		streamFn,
		completeFn,
	);

	if (response.stopReason === "error") {
		throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	return summaryText(response);
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string | SummaryCompleteFn,
	thinkingLevel?: ThinkingLevel | SummaryCompleteFn,
	streamFn?: StreamFn,
	completeFn?: SummaryCompleteFn,
): Promise<string> {
	if (typeof previousSummary === "function") {
		completeFn = previousSummary as SummaryCompleteFn;
		previousSummary = customInstructions;
		customInstructions = undefined;
	}
	if (typeof thinkingLevel === "function") {
		completeFn = thinkingLevel as SummaryCompleteFn;
		thinkingLevel = undefined;
	}

	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	const completionOptions = createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel);
	const chunkBudget = Math.max(1, model.contextWindow - reserveTokens - maxTokens);
	const chunks = chunkMessages(currentMessages, chunkBudget);

	if (chunks.length <= 1) {
		return summarizeOnce(
			currentMessages,
			model,
			completionOptions,
			customInstructions,
			previousSummary,
			streamFn,
			completeFn,
		);
	}

	let runningSummary = previousSummary;
	let degenerateRetriesUsed = 0;
	// Messages from earlier chunks whose summarization came back degenerate and
	// were therefore never folded into runningSummary. They are carried into the
	// next chunk's input (bounded by the per-chunk budget) so their content still
	// reaches the briefing, instead of leaving a hole (silently dropping the
	// segment) or breaking out of the loop early (dropping every later chunk).
	let carriedForward: AgentMessage[] = [];
	for (const chunk of chunks) {
		// Prepend any carried-forward messages, dropping the oldest first if the
		// combined input would exceed the per-chunk budget: an oversized segment
		// that failed to summarize can't be merged forward without risking a
		// context-length error on the summarizer call.
		const chunkTokens = chunk.reduce((total, m) => total + estimateSerializedTokens(m), 0);
		let carriedTokens = carriedForward.reduce((total, m) => total + estimateSerializedTokens(m), 0);
		while (carriedForward.length > 0 && carriedTokens + chunkTokens > chunkBudget) {
			carriedTokens -= estimateSerializedTokens(carriedForward[0]!);
			carriedForward = carriedForward.slice(1);
		}
		const chunkInput = carriedForward.length > 0 ? [...carriedForward, ...chunk] : chunk;

		const summaryBeforeChunk = runningSummary;
		let chunkSummary = await summarizeOnce(
			chunkInput,
			model,
			completionOptions,
			customInstructions,
			summaryBeforeChunk,
			streamFn,
			completeFn,
		);

		// A tiny chunk legitimately yields a short summary — retrying won't help.
		// Cap retries at one per compaction run (not per chunk) so a large,
		// already-expensive chunked run can't double its cost per chunk.
		const chunkInputSize = serializeConversation(convertToLlm(chunkInput)).length;
		if (isDegenerateSummary(chunkSummary) && degenerateRetriesUsed < 1 && chunkInputSize >= 100) {
			degenerateRetriesUsed++;
			chunkSummary = await summarizeOnce(
				chunkInput,
				model,
				completionOptions,
				customInstructions,
				summaryBeforeChunk,
				streamFn,
				completeFn,
			);
		}

		if (!isDegenerateSummary(chunkSummary)) {
			runningSummary = chunkSummary;
			carriedForward = [];
		} else {
			// Keep the prior running summary and carry this segment's messages
			// into the next chunk so a later successful summarization folds them
			// in rather than silently dropping them.
			carriedForward = chunkInput;
		}
	}

	if (runningSummary && !isDegenerateSummary(runningSummary)) {
		return runningSummary;
	}
	if (previousSummary) {
		return previousSummary;
	}
	throw new CompactionProducedNoSummaryError("Summarization produced no usable summary");
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	// Get UUID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// Messages to summarize (will be discarded after summary)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// Messages for turn prefix summary (if splitting a turn)
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Write a brief state snapshot of the prefix so the retained suffix makes sense:

## What Was Requested
[The user's ask that started this turn — one sentence]

## Work Done in Prefix
- [Concrete actions taken and their outcomes, especially file paths modified]
- [Decisions made that affect the retained suffix]

## Failed Approaches
- [Anything tried in the prefix that failed — so it is not retried in the suffix]

Be concise. Only include what the successor needs to understand the kept suffix.`;

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal | SummaryCompleteFn,
	thinkingLevel?: ThinkingLevel | SummaryCompleteFn,
	streamFn?: StreamFn,
	completeFn?: SummaryCompleteFn,
): Promise<CompactionResult> {
	if (typeof signal === "function") {
		completeFn = signal as SummaryCompleteFn;
		signal = undefined;
	}
	if (typeof thinkingLevel === "function") {
		completeFn = thinkingLevel as SummaryCompleteFn;
		thinkingLevel = undefined;
	}

	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	if (messagesToSummarize.length === 0 && (!isSplitTurn || turnPrefixMessages.length === 0)) {
		throw new CompactionInvalidInputError("Compaction requires messages to summarize");
	}

	// Generate summaries (can be parallel if both needed) and merge into one
	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// Generate both summaries in parallel
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0
				? generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						headers,
						signal,
						customInstructions,
						previousSummary,
						thinkingLevel,
						streamFn,
						completeFn,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(
				turnPrefixMessages,
				model,
				settings.reserveTokens,
				apiKey,
				headers,
				signal,
				thinkingLevel,
				streamFn,
				completeFn,
			),
		]);
		// Merge into single summary
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else {
		// Just generate history summary
		summary = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			completeFn,
		);
	}

	if (isDegenerateSummary(summary)) {
		throw new CompactionProducedNoSummaryError("Compaction produced no usable summary");
	}

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	completeFn?: SummaryCompleteFn,
): Promise<string> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	); // Smaller budget for turn prefix
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await completeSummarization(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel),
		streamFn,
		completeFn,
	);

	if (response.stopReason === "error") {
		throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	return summaryText(response);
}
