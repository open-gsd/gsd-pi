/**
 * Tests for chunked compaction fallback when messages exceed model context window.
 * Regression test for #2932.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import type { AgentMessage } from "@gsd/pi-agent-core";
import type { Model, AssistantMessage } from "@gsd/pi-ai";

import {
	compact,
	generateSummary,
	estimateTokens,
	chunkMessages,
	isDegenerateSummary,
	CompactionInvalidInputError,
	CompactionProducedNoSummaryError,
	calculateContextTokens,
	type CompactionPreparation,
} from "./compaction.js";
import { estimateSerializedTokens } from "./utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a user message with approximately `tokenCount` tokens (chars = tokens * 4). */
function makeUserMessage(tokenCount: number): AgentMessage {
	const text = "x".repeat(tokenCount * 4);
	return { role: "user", content: text } as unknown as AgentMessage;
}

/**
 * Create a tool-result message of approximately `rawTokenCount` uncapped tokens.
 * Post-truncation, this estimates to ~500 tokens (TOOL_RESULT_MAX_CHARS / 4).
 *
 * Used to exercise the #4665 regression: before the fix, chunkMessages used
 * estimateTokens (pre-truncation), so a 100K-token tool result forced its own
 * chunk even though it serialized to ~500 tokens. After the fix, many tool
 * results coalesce into a single chunk.
 */
function makeToolResultMessage(rawTokenCount: number): AgentMessage {
	const text = "y".repeat(rawTokenCount * 4);
	return {
		role: "toolResult",
		toolCallId: `call_${rawTokenCount}`,
		content: [{ type: "text", text }],
	} as unknown as AgentMessage;
}

/**
 * Create a branch-summary message with a specific summary length. Summary
 * messages are intentionally NOT truncated by the serializer (they're already
 * concise), so this is the right tool to force chunking post-fix.
 */
function makeBranchSummaryMessage(approxTokens: number): AgentMessage {
	const summary = "z".repeat(approxTokens * 4);
	return {
		role: "branchSummary",
		summary,
		fromId: "test",
		timestamp: 0,
	} as unknown as AgentMessage;
}

/** Create a mock model with a given context window. */
function makeModel(contextWindow: number): Model<any> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 4096,
	} as Model<any>;
}

function makeFakeResponse(text: string): AssistantMessage {
	return {
		content: [{ type: "text", text }],
		stopReason: "end_turn",
	} as unknown as AssistantMessage;
}

// ---------------------------------------------------------------------------
// chunkMessages tests
// ---------------------------------------------------------------------------

describe("chunkMessages", () => {
	it("returns a single chunk when messages fit in budget", () => {
		const messages: AgentMessage[] = [
			makeUserMessage(1_000),
			makeUserMessage(1_000),
		];
		const chunks = chunkMessages(messages, 100_000);
		assert.equal(chunks.length, 1);
		assert.equal(chunks[0].length, 2);
	});

	it("splits messages into multiple chunks when they exceed budget", () => {
		// Branch summaries are now token-estimated from their serialized form,
		// so use a realistic small budget that still forces multiple chunks.
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(50_000),
			makeBranchSummaryMessage(50_000),
			makeBranchSummaryMessage(50_000),
		];
		const chunks = chunkMessages(messages, 800);
		assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);
		const totalMessages = chunks.reduce((sum, c) => sum + c.length, 0);
		assert.equal(totalMessages, 3);
	});

	it("puts a single oversized message in its own chunk", () => {
		// Use branchSummary — not truncated by the serializer — to force the
		// oversized-single-message path. A user message with the same raw size
		// would cap to ~500 tokens and fit in any reasonable budget.
		const messages: AgentMessage[] = [makeBranchSummaryMessage(200_000)];
		const chunks = chunkMessages(messages, 80_000);
		assert.equal(chunks.length, 1);
		assert.equal(chunks[0].length, 1);
	});

	it("preserves message order across chunks", () => {
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(30_000),
			makeBranchSummaryMessage(30_000),
			makeBranchSummaryMessage(30_000),
			makeBranchSummaryMessage(30_000),
		];
		const chunks = chunkMessages(messages, 50_000);
		const flat = chunks.flat();
		assert.equal(flat.length, 4);
		for (let i = 0; i < flat.length; i++) {
			assert.strictEqual(flat[i], messages[i], `Message ${i} should be in order`);
		}
	});

	// ---------------------------------------------------------------------------
	// #4665 regression: token estimation must reflect serializer truncation
	// ---------------------------------------------------------------------------

	it("(#4665) does not over-split when tool results dominate — they serialize to ~500 tokens", () => {
		// Ten 100K-token tool results. Under the old pre-truncation estimator
		// this would estimate to ~1M tokens and force 10+ tiny chunks. Under
		// the new estimator each caps to ~500 tokens (TOOL_RESULT_MAX_CHARS/4),
		// so 10 of them total ~5K tokens and fit in a single generous budget.
		const messages: AgentMessage[] = Array.from({ length: 10 }, () =>
			makeToolResultMessage(100_000),
		);
		const chunks = chunkMessages(messages, 50_000);
		assert.equal(
			chunks.length,
			1,
			"ten 100K-token tool results should coalesce into one chunk (cap=2000 chars → ~500 tokens each)",
		);
		assert.equal(chunks[0].length, 10);
	});

	it("(#4665) estimateSerializedTokens caps toolResult at TOOL_RESULT_MAX_CHARS/4", () => {
		const huge = makeToolResultMessage(100_000);
		const serialized = estimateSerializedTokens(huge);
		const raw = estimateTokens(huge);
		assert.ok(raw > 50_000, `raw estimator should report the real size, got ${raw}`);
		assert.ok(
			serialized < 1_000,
			`serialized estimator should cap at ~500 tokens, got ${serialized}`,
		);
	});

	it("(#4665) estimateSerializedTokens also caps large user content and assistant thinking", () => {
		const hugeUser = makeUserMessage(50_000);
		assert.ok(
			estimateSerializedTokens(hugeUser) < 1_000,
			"user content > cap must be truncated in the estimator",
		);

		// Assistant with a huge thinking block + huge text block
		const hugeAssistant: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "t".repeat(100_000) },
				{ type: "text", text: "r".repeat(100_000) },
			],
		} as unknown as AgentMessage;
		assert.ok(
			estimateSerializedTokens(hugeAssistant) < 2_000,
			"assistant thinking + text must each cap; total under 2x TOOL_RESULT_MAX_CHARS/4",
		);
	});
});

describe("calculateContextTokens", () => {
	it("excludes cumulative output for claude-code totalTokens (de-cumulated live context)", () => {
		// claude-code adapter reports totalTokens = input + output + cacheWrite
		// (65 + 39_846 + 243_452), deliberately excluding the turn-cumulative
		// cacheRead. Subtracting output yields input + cacheWrite = 243_517, the
		// de-cumulated live-context proxy — not the inflated 283_363 nor the
		// cumulative component sum.
		const usage = {
			input: 65,
			output: 39_846,
			cacheRead: 2_945_563,
			cacheWrite: 243_452,
			totalTokens: 283_363,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		assert.equal(calculateContextTokens(usage), 243_517);
	});

	it("subtracts output for direct-API totalTokens (behavior-preserving vs. the component sum)", () => {
		// Direct-API providers report a per-request totalTokens =
		// input + output + cacheRead + cacheWrite (component-consistent), so
		// totalTokens - output === input + cacheRead + cacheWrite exactly.
		const usage = {
			input: 65,
			output: 39_846,
			cacheRead: 2_945_563,
			cacheWrite: 243_452,
			totalTokens: 3_228_926,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		assert.equal(calculateContextTokens(usage), 3_189_080);
	});

	it("falls back to component context tokens when totalTokens is not available", () => {
		const usage = {
			input: 65,
			output: 39_846,
			cacheRead: 2_945_563,
			cacheWrite: 243_452,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		assert.equal(calculateContextTokens(usage), 3_189_080);
	});
});

// ---------------------------------------------------------------------------
// generateSummary chunked fallback tests
// ---------------------------------------------------------------------------

describe("generateSummary — chunked fallback (#2932)", () => {
	it("calls _completeFn multiple times when messages exceed model context window", async () => {
		// Serialized summaries are compact now, so use a small synthetic window
		// to force the chunked path through generateSummary().
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(1_000);
		const reserveTokens = 200;

		// Verify our test setup: messages really do exceed the model window.
		// Use estimateSerializedTokens because that's what generateSummary uses
		// for its "does this fit?" decision post-#4665.
		let totalTokens = 0;
		for (const m of messages) totalTokens += estimateSerializedTokens(m);
		assert.ok(
			totalTokens > model.contextWindow,
			`Test setup: ${totalTokens} tokens should exceed ${model.contextWindow} context window`,
		);

		// Track calls
		const calls: string[] = [];
		const mockComplete = mock.fn(async (_model: any, context: any, _options: any) => {
			const userMsg = context.messages?.[0];
			const text =
				typeof userMsg?.content === "string"
					? userMsg.content
					: userMsg?.content?.[0]?.text ?? "";

			if (text.includes("<previous-summary>")) {
				calls.push("update");
			} else {
				calls.push("initial");
			}
			// Return a non-degenerate summary (>100 chars). Short responses like
			// "Summary of chunk" would trip the #4665 degenerate-output guard,
			// which is exactly what we don't want to test here.
			return makeFakeResponse(
				"## Goal\nDetailed summary of this chunk describing the work completed, files touched, and decisions made. At least 100 characters so the degenerate guard does not trip.",
			);
		});

		const summary = await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined, // apiKey
			undefined, // signal
			undefined, // customInstructions
			undefined, // previousSummary
			mockComplete, // _completeFn override for testing
		);

		// Assert: should have called completeSimple more than once (chunked)
		assert.ok(
			mockComplete.mock.callCount() > 1,
			`Expected multiple calls for chunked summarization, got ${mockComplete.mock.callCount()}`,
		);

		// First call should be an initial summary, subsequent should be updates
		assert.equal(calls[0], "initial", "First chunk should use initial summarization prompt");
		for (let i = 1; i < calls.length; i++) {
			assert.equal(calls[i], "update", `Chunk ${i + 1} should use update summarization prompt`);
		}

		// Should return a non-empty summary
		assert.ok(summary.length > 0, "Summary should not be empty");
	});

	it("uses single-pass when messages fit within model context window", async () => {
		const messages: AgentMessage[] = [
			makeUserMessage(10_000),
			makeUserMessage(10_000),
		];
		const model = makeModel(200_000);
		const reserveTokens = 16_384;

		// Verify test setup
		let totalTokens = 0;
		for (const m of messages) totalTokens += estimateTokens(m);
		assert.ok(
			totalTokens < model.contextWindow,
			`Test setup: ${totalTokens} tokens should fit in ${model.contextWindow} context window`,
		);

		const mockComplete = mock.fn(async () => makeFakeResponse("Single pass summary"));

		await generateSummary(messages, model, reserveTokens, undefined, undefined, undefined, undefined, mockComplete);

		assert.equal(
			mockComplete.mock.callCount(),
			1,
			"Should use single-pass summarization when messages fit in context window",
		);
	});

	it("passes previousSummary through chunked summarization", async () => {
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(1_000);
		const reserveTokens = 200;
		const previousSummary =
			"Previous session summary content — intentionally verbose enough to clear the degenerate-summary threshold so this test exercises the actual propagation path.";

		const prompts: string[] = [];
		const mockComplete = mock.fn(async (_model: any, context: any) => {
			const userMsg = context.messages?.[0];
			const text =
				typeof userMsg?.content === "string"
					? userMsg.content
					: userMsg?.content?.[0]?.text ?? "";
			prompts.push(text);
			return makeFakeResponse(
				"Chunk summary with sufficient length to clear the #4665 degenerate-output guard threshold of 100 characters — this must be longer.",
			);
		});

		await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined,
			undefined,
			undefined,
			previousSummary,
			mockComplete,
		);

		// First chunk should include the previousSummary
		assert.ok(
			prompts[0].includes(previousSummary),
			"First chunk should incorporate the previousSummary",
		);
	});
});

// ---------------------------------------------------------------------------
// #4665 regression — iterative chain must not propagate degenerate summaries
// ---------------------------------------------------------------------------

describe("(#4665) degenerate summary guard", () => {
	it("isDegenerateSummary detects the known failure patterns", () => {
		assert.equal(isDegenerateSummary(undefined), false);
		assert.equal(isDegenerateSummary(""), true, "empty string is degenerate");
		assert.equal(isDegenerateSummary("too short"), true, "short output is degenerate");
		assert.equal(
			isDegenerateSummary("The user asked me to summarize an empty conversation"),
			true,
			"known failure phrase 'empty conversation' is degenerate",
		);
		assert.equal(
			isDegenerateSummary("No conversation to summarize"),
			true,
			"'no conversation to summarize' is degenerate",
		);
		assert.equal(
			isDegenerateSummary(
				"The conversation block you've handed me is empty: there's nothing between the <conversation> tags to summarize.",
			),
			true,
			"known issue #109 refusal is degenerate",
		);
		assert.equal(
			isDegenerateSummary(
				"## Goal\nRefactor the compaction pipeline.\n## Done\n- Updated utils.ts\n- Added tests for #4665 regression path",
			),
			false,
			"a real multi-section summary over 100 chars is not degenerate",
		);
	});

	it("(#109) compact refuses empty prepared input before summarization", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-1",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 42,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		};

		await assert.rejects(
			() => compact(preparation, makeModel(200_000), undefined),
			(err: unknown) => err instanceof CompactionInvalidInputError,
		);
	});

	it("(#109) compact refuses degenerate single-pass summaries", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-2",
			messagesToSummarize: [makeUserMessage(10)],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		};
		const refusal =
			"The conversation block you've handed me is empty: there's nothing between the <conversation> tags to summarize.";
		const complete = mock.fn(async () => makeFakeResponse(refusal));

		await assert.rejects(
			() => compact(preparation, makeModel(200_000), undefined, undefined, undefined, complete as any),
			(err: unknown) => err instanceof CompactionProducedNoSummaryError,
		);
	});

	it("does not propagate a degenerate first-chunk summary forward (no 'preserve nothing' chain)", async () => {
		// Force the chunked path with a small synthetic context window.
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(1_000);
		const reserveTokens = 200;

		// Responses: chunk 0 returns degenerate ("empty conversation"). Chunks
		// 1 and 2 return real summaries. Pre-fix behavior: the chunk-0 output
		// is fed into UPDATE_SUMMARIZATION_PROMPT for chunks 1+, which says
		// "PRESERVE all existing information" — so emptiness is preserved.
		// Post-fix: the degenerate chunk-0 output must not become runningSummary.
		let callIndex = 0;
		const responses = [
			"The user asked me to summarize an empty conversation.",
			"## Done\n- Refactored the serializer to head+tail truncation.\n- Updated chunker to use post-serialization token estimate.",
			"## Done\n- Added regression tests for #4665 including this propagation guard.\n- Verified isDegenerateSummary handles known failure patterns.",
		];
		const seenPrompts: string[] = [];
		const mockComplete = mock.fn(async (_model: any, context: any) => {
			const userMsg = context.messages?.[0];
			const text =
				typeof userMsg?.content === "string"
					? userMsg.content
					: userMsg?.content?.[0]?.text ?? "";
			seenPrompts.push(text);
			const response = responses[Math.min(callIndex, responses.length - 1)];
			callIndex++;
			return makeFakeResponse(response);
		});

		const summary = await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined,
			undefined,
			undefined,
			undefined,
			mockComplete,
		);

		// The returned summary must be one of the real chunk summaries — not
		// the degenerate "empty conversation" output, and not an empty string.
		assert.ok(
			!isDegenerateSummary(summary),
			`final summary should not be degenerate. got: ${JSON.stringify(summary)}`,
		);
		assert.ok(
			summary.includes("Refactored") || summary.includes("regression tests"),
			"final summary should carry real information from chunks 1 or 2",
		);
	});

	it("retries the first chunk once with the initial prompt if the first pass is degenerate", async () => {
		// Force chunked path with a single large chunk. Mock returns degenerate
		// on the first call and a real summary on the retry.
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(1_000);
		const reserveTokens = 200;

		const responses = [
			"", // first attempt: empty string → degenerate
			"## Goal\nReal summary produced on the retry pass after the initial pass came back empty — this should land as the running summary.",
			"## Done\n- Added retry-on-degenerate-first-chunk behavior to the iterative summarizer so empty outputs don't poison the chain.",
		];
		let callIndex = 0;
		const mockComplete = mock.fn(async () => {
			const response = responses[Math.min(callIndex, responses.length - 1)];
			callIndex++;
			return makeFakeResponse(response);
		});

		const summary = await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined,
			undefined,
			undefined,
			undefined,
			mockComplete,
		);

		assert.ok(
			!isDegenerateSummary(summary),
			"final summary must not be degenerate after the retry took effect",
		);
		assert.ok(
			mockComplete.mock.callCount() >= 3,
			`expected at least 3 calls (first attempt, retry, second chunk), got ${mockComplete.mock.callCount()}`,
		);
	});

	// -------------------------------------------------------------------------
	// R1 — retry non-first chunks too + observable log when both attempts fail
	// -------------------------------------------------------------------------

	it("(R1) retries a degenerate NON-FIRST chunk before silently dropping it", async () => {
		// Use a small model window to force exactly 2 chunks from 2 messages.
		// Chunk 0 ok, chunk 1 degenerate on first try then real on retry.
		// Chunk 1's recovered content must reach the final summary.
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(1_000);
		const reserveTokens = 200;

		const CHUNK0_SUMMARY = "## Done\n- Chunk 0 real summary with enough length to clear the degenerate threshold of 100 characters — easily.";
		const CHUNK1_RETRY_SUMMARY = "## Done\n- Chunk 1 recovered on retry — its content must appear in the final summary or the R1 fix regressed for non-first chunks.";

		let callIndex = 0;
		const responses = [
			CHUNK0_SUMMARY,           // chunk 0
			"empty conversation",     // chunk 1 first try → degenerate
			CHUNK1_RETRY_SUMMARY,     // chunk 1 retry → real
		];
		const mockComplete = mock.fn(async () => {
			const r = responses[Math.min(callIndex, responses.length - 1)];
			callIndex++;
			return makeFakeResponse(r);
		});

		const summary = await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined,
			undefined,
			undefined,
			undefined,
			mockComplete,
		);

		assert.equal(
			mockComplete.mock.callCount(),
			3,
			"expected 3 calls: chunk 0 + chunk 1 initial + chunk 1 retry",
		);
		assert.ok(
			summary.includes("recovered on retry"),
			`final summary must include chunk 1's retry content (R1: non-first chunks must also retry), got: ${JSON.stringify(summary)}`,
		);
	});

	// -------------------------------------------------------------------------
	// R6 — empty output must not be silently written as a compaction entry
	// -------------------------------------------------------------------------

	it("(R6) throws CompactionProducedNoSummaryError when every chunk is degenerate AND no previousSummary", async () => {
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(1_000);
		const reserveTokens = 200;

		// Every response is degenerate, both initial and retry attempts.
		const mockComplete = mock.fn(async () => makeFakeResponse("empty conversation"));

		await assert.rejects(
			() => generateSummary(
				messages,
				model,
				reserveTokens,
				undefined,
				undefined,
				undefined,
				undefined, // no previousSummary
				mockComplete,
			),
			(err: unknown) => err instanceof CompactionProducedNoSummaryError,
			"expected CompactionProducedNoSummaryError when all chunks degenerate and no previousSummary",
		);
	});

	it("(R6) falls back to previousSummary when every chunk is degenerate", async () => {
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(1_000);
		const reserveTokens = 200;
		const previousSummary =
			"Previously-computed summary from the last compaction — deliberately long enough to clear the degenerate-output threshold.";

		const mockComplete = mock.fn(async () => makeFakeResponse("empty conversation"));

		const result = await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined,
			undefined,
			undefined,
			previousSummary,
			mockComplete,
		);

		assert.equal(
			result,
			previousSummary,
			"when all chunks degenerate, must fall back to previousSummary rather than return empty string",
		);
	});
});

// ---------------------------------------------------------------------------
// (#038) cheap compaction summarization
// ---------------------------------------------------------------------------

describe("(#038) summarization options cap reasoning at low", () => {
	function makeReasoningModel(contextWindow: number): Model<any> {
		return { ...makeModel(contextWindow), reasoning: true };
	}

	it("caps a high session thinking level down to low on a reasoning model", async () => {
		const model = makeReasoningModel(200_000);
		const messages = [makeUserMessage(10)];
		let seenOptions: any;
		const mockComplete = mock.fn(async (_model: any, _context: any, options: any) => {
			seenOptions = options;
			return makeFakeResponse(
				"## Done\n- Real summary well over one hundred characters long so the degenerate check passes cleanly here.",
			);
		});

		await generateSummary(
			messages,
			model,
			16_384,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"high",
			undefined,
			mockComplete,
		);

		assert.equal(seenOptions.reasoning, "low");
	});

	it("does not set reasoning when session thinking level is off", async () => {
		const model = makeReasoningModel(200_000);
		const messages = [makeUserMessage(10)];
		let seenOptions: any;
		const mockComplete = mock.fn(async (_model: any, _context: any, options: any) => {
			seenOptions = options;
			return makeFakeResponse(
				"## Done\n- Real summary well over one hundred characters long so the degenerate check passes cleanly here.",
			);
		});

		await generateSummary(
			messages,
			model,
			16_384,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
			undefined,
			mockComplete,
		);

		assert.equal(seenOptions.reasoning, undefined);
	});

	it("does not set reasoning on a non-reasoning model", async () => {
		const model = makeModel(200_000); // reasoning: false
		const messages = [makeUserMessage(10)];
		let seenOptions: any;
		const mockComplete = mock.fn(async (_model: any, _context: any, options: any) => {
			seenOptions = options;
			return makeFakeResponse(
				"## Done\n- Real summary well over one hundred characters long so the degenerate check passes cleanly here.",
			);
		});

		await generateSummary(
			messages,
			model,
			16_384,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"high",
			undefined,
			mockComplete,
		);

		assert.equal(seenOptions.reasoning, undefined);
	});
});

describe("(#038) degenerate-chunk retry is bounded per compaction", () => {
	it("retries at most once total across a run with multiple degenerate chunks", async () => {
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(1_000);
		const reserveTokens = 200;

		// Every response is degenerate — old behavior retried every chunk once
		// (6 calls for 3 chunks); bounded behavior spends the single retry
		// budget on the first chunk and gives up thereafter (4 calls).
		const mockComplete = mock.fn(async () => makeFakeResponse("empty conversation"));

		await assert.rejects(
			() =>
				generateSummary(
					messages,
					model,
					reserveTokens,
					undefined,
					undefined,
					undefined,
					undefined,
					mockComplete,
				),
			(err: unknown) => err instanceof CompactionProducedNoSummaryError,
		);

		assert.equal(
			mockComplete.mock.callCount(),
			4,
			"expected exactly 4 calls: chunk0 + one retry + chunk1 + chunk2 (no further retries)",
		);
	});

	it("skips the retry when the degenerate chunk's serialized input is itself tiny", async () => {
		// Chunk 0 is a single tiny user message (serializes to well under the
		// 100-char degenerate threshold); chunk 1 is a branch summary. Branch
		// summary content is capped by the serializer's per-block truncation
		// (~500 tokens), so a small context window is needed to force the two
		// onto separate chunks: tiny(~1 token) + capped-branch(~500 tokens)
		// exceeds a 340-token chunk budget, so chunkMessages splits them.
		const messages: AgentMessage[] = [makeUserMessage(1), makeBranchSummaryMessage(80_000)];
		const model = makeModel(700);
		const reserveTokens = 200;

		const responses = [
			"", // chunk 0 (tiny input) → degenerate, must NOT retry
			"## Done\n- Real summary for chunk one well over one hundred characters long, clearing the degenerate threshold.",
		];
		let callIndex = 0;
		const mockComplete = mock.fn(async () => {
			const response = responses[Math.min(callIndex, responses.length - 1)];
			callIndex++;
			return makeFakeResponse(response);
		});

		await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined,
			undefined,
			undefined,
			undefined,
			mockComplete,
		);

		assert.equal(
			mockComplete.mock.callCount(),
			2,
			"expected exactly 2 calls: chunk0 (no retry, tiny input) + chunk1",
		);
	});
});

// ---------------------------------------------------------------------------
// Degenerate middle-chunk handling — must not drop the tail or leave a hole
// ---------------------------------------------------------------------------

describe("degenerate middle-chunk handling", () => {
	it("keeps summarizing later chunks when a middle chunk degenerates against a non-degenerate previousSummary", async () => {
		// Bug: the previous mitigation broke out of the loop as soon as a middle
		// chunk degenerated while summaryBeforeChunk was non-degenerate. But when
		// runningSummary is still just the carried-in previousSummary (no chunk in
		// THIS run folded in yet), that break dropped every remaining chunk, so
		// newer history never reached the briefing.
		const messages: AgentMessage[] = [
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
			makeBranchSummaryMessage(80_000),
		];
		const model = makeModel(1_000);
		const reserveTokens = 200;
		const previousSummary =
			"Prior compaction briefing carried in from the last run — long enough to clear the degenerate-output threshold so it stands in as summaryBeforeChunk.";

		// chunk0 + its single retry degenerate, chunk1 degenerate (retry budget
		// spent), chunk2 produces the only real summary. The tail chunk must be
		// summarized, so TAIL_CONTENT must survive into the final briefing.
		let callIndex = 0;
		const responses = [
			"empty conversation", // chunk0 initial → degenerate
			"empty conversation", // chunk0 retry → degenerate (spends the one retry)
			"empty conversation", // chunk1 → degenerate, no retry left
			"## Done\n- TAIL_CONTENT: recovered the final chunk's history even though an earlier chunk degenerated — proves no early break.",
		];
		const mockComplete = mock.fn(async () => {
			const r = responses[Math.min(callIndex, responses.length - 1)];
			callIndex++;
			return makeFakeResponse(r);
		});

		const summary = await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined,
			undefined,
			undefined,
			previousSummary,
			mockComplete,
		);

		assert.equal(
			mockComplete.mock.callCount(),
			4,
			"expected 4 calls: chunk0 + one retry + chunk1 + chunk2 (no early break)",
		);
		assert.ok(
			summary.includes("TAIL_CONTENT"),
			`final summary must include the tail chunk's content (no early break), got: ${JSON.stringify(summary)}`,
		);
		assert.ok(!isDegenerateSummary(summary), "final summary must not be degenerate");
	});

	it("carries a degenerate chunk's messages into the next chunk, bounded by the per-chunk budget", async () => {
		// Chunk0 = [a, b] fills the budget; chunk1 = [c] leaves headroom. When
		// chunk0 degenerates, its messages are carried into chunk1's input up to
		// the budget: the oldest (a) is dropped to avoid overflow, but the newest
		// (b) is folded into chunk1's summarization so its content is not lost.
		// estimateSerializedTokens caps user content at 2000 chars and returns
		// ceil(chars/4), so 1600 chars → 400 tokens and 1000 chars → 250 tokens.
		const a = { role: "user", content: `AAA_DROPPED${"x".repeat(1589)}` } as unknown as AgentMessage; // 400 tokens
		const b = { role: "user", content: `CARRIED_B${"y".repeat(1591)}` } as unknown as AgentMessage; // 400 tokens
		const c = { role: "user", content: `CCC${"z".repeat(997)}` } as unknown as AgentMessage; // 250 tokens
		const messages: AgentMessage[] = [a, b, c];
		// contextWindow - reserve - maxTokens(=0.8*reserve capped at model.maxTokens)
		// = 1160 - 200 - 160 = 800-token chunk budget. a+b = 800 fill chunk0;
		// c = 250 is chunk1 with 550 tokens of headroom. Carrying [a,b] (800) into
		// chunk1 overflows, so a (oldest, 400) is dropped and b (400) is kept:
		// 400 + 250 = 650 ≤ 800.
		const model = makeModel(1_160);
		const reserveTokens = 200;

		const seenPrompts: string[] = [];
		let callIndex = 0;
		const responses = [
			"", // chunk0 initial → degenerate
			"", // chunk0 retry → degenerate (input is substantial, so it retries once)
			"## Done\n- Real summary for the second chunk, comfortably over the hundred character degenerate threshold so it lands.",
		];
		const mockComplete = mock.fn(async (_model: any, context: any) => {
			const userMsg = context.messages?.[0];
			const text =
				typeof userMsg?.content === "string" ? userMsg.content : userMsg?.content?.[0]?.text ?? "";
			seenPrompts.push(text);
			const r = responses[Math.min(callIndex, responses.length - 1)];
			callIndex++;
			return makeFakeResponse(r);
		});

		const summary = await generateSummary(
			messages,
			model,
			reserveTokens,
			undefined,
			undefined,
			undefined,
			undefined,
			mockComplete,
		);

		assert.equal(
			mockComplete.mock.callCount(),
			3,
			"expected 3 calls: chunk0 + one retry + chunk1 (carrying b forward)",
		);
		const chunk1Prompt = seenPrompts[2] ?? "";
		assert.ok(
			chunk1Prompt.includes("CARRIED_B"),
			"chunk1 summarization must include the carried-forward message b from the degenerate chunk0",
		);
		assert.ok(
			!chunk1Prompt.includes("AAA_DROPPED"),
			"the oldest carried message must be dropped to keep the merged input within the chunk budget",
		);
		assert.ok(!isDegenerateSummary(summary), "final summary must not be degenerate");
	});
});
