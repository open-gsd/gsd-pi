import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";

function createErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "ollama",
		model: "qwen3.5:35b",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("isContextOverflow", () => {
	it("detects explicit Ollama prompt-too-long errors", () => {
		const message = createErrorMessage("400 `prompt too long; exceeded max context length by 100918 tokens`");
		expect(isContextOverflow(message, 32768)).toBe(true);
	});

	it("detects Together AI context length errors", () => {
		const message = createErrorMessage(
			"400 The input (516368 tokens) is longer than the model's context length (262144 tokens).",
		);
		expect(isContextOverflow(message, 262144)).toBe(true);
	});

	it("detects LiteLLM-wrapped OpenAI maximum context length errors", () => {
		const message = createErrorMessage(
			"Error: 503 litellm.ServiceUnavailableError: litellm.MidStreamFallbackError: litellm.APIConnectionError: APIConnectionError: OpenAIException - Requested token count exceeds the model's maximum context length of 131072 tokens.",
		);
		expect(isContextOverflow(message, 131072)).toBe(true);
	});

	it("does not treat generic non-overflow Ollama errors as overflow", () => {
		const message = createErrorMessage("500 `model runner crashed unexpectedly`");
		expect(isContextOverflow(message, 32768)).toBe(false);
	});

	it("does not treat Bedrock throttling 'Too many tokens' as overflow", () => {
		// Bedrock returns this for HTTP 429 rate limiting, NOT context overflow.
		// formatBedrockError uses a human-readable prefix for ThrottlingException.
		const message = createErrorMessage("Throttling error: Too many tokens, please wait before trying again.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat Bedrock service unavailable as overflow", () => {
		const message = createErrorMessage("Service unavailable: The service is temporarily unavailable.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat generic rate limit errors as overflow", () => {
		const message = createErrorMessage("Rate limit exceeded, please retry after 30 seconds.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat HTTP 429 style errors as overflow", () => {
		const message = createErrorMessage("Too many requests. Please slow down.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	function createLengthStopMessage(input: number, cacheRead: number, output: number): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "xiaomi",
			model: "mimo-v2.5-pro",
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite: 0,
				totalTokens: input + cacheRead + output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
	}

	it("detects Xiaomi-style overflow (length stop with zero output and filled context)", () => {
		const message = createLengthStopMessage(58, 1048512, 0);
		expect(isContextOverflow(message, 1048576)).toBe(true);
	});

	it("does not treat normal length stops with output as overflow", () => {
		const message = createLengthStopMessage(1000, 0, 4096);
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat length stops far below context as overflow", () => {
		const message = createLengthStopMessage(100, 0, 0);
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	function createStopMessage(
		usage: AssistantMessage["usage"],
		provider: string,
	): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider,
			model: "test-model",
			usage,
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	it("does not treat claude-code cumulative usage as overflow when live per-call context is attached (#2358)", () => {
		// One turn with 4 internal API calls, each re-reading ~51k from cache:
		// the SDK's terminal result.usage is cumulative, so input + cacheRead
		// = 204,240 crosses the 200k window while the live end-of-turn context
		// (last main-loop assistant event) is ~52k = 26% of the window. The
		// adapter attaches that per-call value as liveContextTokens and Case 2
		// must prefer it over the cumulative sum.
		const message = createStopMessage(
			{
				input: 240,
				output: 800,
				cacheRead: 204_000,
				cacheWrite: 5_200,
				totalTokens: 6_240,
				liveContextTokens: 52_440,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			"claude-code",
		);
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("still reports overflow when the attached live context exceeds the window", () => {
		const message = createStopMessage(
			{
				input: 240,
				output: 800,
				cacheRead: 204_000,
				cacheWrite: 5_200,
				totalTokens: 6_240,
				liveContextTokens: 204_500,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			"claude-code",
		);
		expect(isContextOverflow(message, 200000)).toBe(true);
	});

	it("treats a zero liveContextTokens as absent and falls back to input+cacheRead", () => {
		const message = createStopMessage(
			{
				input: 240,
				output: 800,
				cacheRead: 204_000,
				cacheWrite: 5_200,
				totalTokens: 6_240,
				liveContextTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			"claude-code",
		);
		expect(isContextOverflow(message, 200000)).toBe(true);
	});

	it("still detects silent overflow from input+cacheRead when no live context is attached (z.ai zero-totalTokens)", () => {
		// z.ai accepts overflow silently and reports no meaningful totalTokens;
		// no adapter attaches liveContextTokens here, so the legacy
		// input + cacheRead check must keep firing.
		const message = createStopMessage(
			{
				input: 240_000,
				output: 800,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			"zai",
		);
		expect(isContextOverflow(message, 200000)).toBe(true);
	});
});
