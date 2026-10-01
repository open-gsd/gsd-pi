import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { getModel } from "../src/models.ts";
import { type AnthropicOptions, streamAnthropic } from "../src/providers/anthropic.ts";
import { streamSimple } from "../src/stream.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
	temperature?: number;
	tool_choice?: { type: string; name?: string };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makePayloadCaptureContext(withTools = false): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		...(withTools
			? {
					tools: [
						{
							name: "lookup",
							description: "Look something up",
							parameters: Type.Object({ query: Type.String() }),
						},
					],
				}
			: {}),
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makePayloadCaptureContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

/** Capture via the raw provider stream, for options streamSimple does not forward (toolChoice, unset thinkingEnabled). */
async function captureRawPayload(
	model: Model<"anthropic-messages">,
	options: AnthropicOptions,
	withTools = false,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	const s = streamAnthropic({ ...model, baseUrl: "http://127.0.0.1:9" }, makePayloadCaptureContext(withTools), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

interface RunResult {
	thinkingEventCount: number;
	thinkingCharCount: number;
	text: string;
	contentTypes: string[];
}

function makeE2EContext(): Context {
	return {
		systemPrompt: "You are a precise assistant. Follow the requested output format exactly.",
		messages: [
			{
				role: "user",
				content:
					"Before replying, carefully solve 36863 * 5279 internally. Then reply with the word pong repeated exactly 40 times, separated by single spaces. Do not add any other text.",
				timestamp: Date.now(),
			},
		],
	};
}

function countPongs(text: string): number {
	return text.match(/\bpong\b/gi)?.length ?? 0;
}

async function runWithoutReasoning(model: Model<"anthropic-messages">): Promise<RunResult> {
	const s = streamSimple(model, makeE2EContext(), {
		temperature: 0,
		maxTokens: 160,
	});

	let thinkingEventCount = 0;
	let thinkingCharCount = 0;

	for await (const event of s) {
		if (event.type === "thinking_start" || event.type === "thinking_end") {
			thinkingEventCount += 1;
		}
		if (event.type === "thinking_delta") {
			thinkingEventCount += 1;
			thinkingCharCount += event.delta.length;
		}
	}

	const response = await s.result();
	expect(response.stopReason, response.errorMessage).toBe("stop");

	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();

	return {
		thinkingEventCount,
		thinkingCharCount,
		text,
		contentTypes: response.content.map((block) => block.type),
	};
}

describe("Anthropic thinking disable payload", () => {
	it("sends thinking.type=disabled for budget-based reasoning models when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-5"));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for adaptive reasoning models when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-6"));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for Claude Opus 4.7 when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7"));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("uses adaptive thinking for Claude Opus 4.7 when reasoning is enabled", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7"), { reasoning: "high" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 4.7", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7"), { reasoning: "xhigh" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});
});

describe("Claude 5.5 thinking-off payload (disabled thinking and sampling params return 400)", () => {
	it("sends thinking.type=between_tools for Claude Sonnet 5.5 when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-5-5"), { temperature: 0 });

		// between_tools accepts no other thinking fields and only effort <= high, so nothing else is sent.
		expect(payload.thinking).toEqual({ type: "between_tools" });
		expect(payload.output_config).toBeUndefined();
		expect(payload.temperature).toBeUndefined();
	});

	it("omits thinking and lowers effort for Claude Opus 5.5 when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-5-5"), { temperature: 0 });

		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toEqual({ effort: "low" });
		expect(payload.temperature).toBeUndefined();
	});

	it("keeps adaptive thinking for Claude Sonnet 5.5 when reasoning is enabled", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-5-5"), {
			reasoning: "xhigh",
			temperature: 0.5,
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
		expect(payload.temperature).toBeUndefined();
	});

	it("applies to dotted Copilot-style 5.5 ids", async () => {
		const base = getModel("anthropic", "claude-sonnet-5-5");
		const payload = await capturePayload({ ...base, id: "claude-sonnet-5.5" }, { temperature: 0 });

		expect(payload.thinking).toEqual({ type: "between_tools" });
		expect(payload.temperature).toBeUndefined();
	});

	it("downgrades forced tool_choice to auto for Claude Sonnet 5.5 and Opus 5.5", async () => {
		for (const id of ["claude-sonnet-5-5", "claude-opus-5-5"] as const) {
			const named = await captureRawPayload(
				getModel("anthropic", id),
				{ toolChoice: { type: "tool", name: "lookup" } },
				true,
			);
			expect(named.tool_choice).toEqual({ type: "auto" });

			const any = await captureRawPayload(getModel("anthropic", id), { toolChoice: "any" }, true);
			expect(any.tool_choice).toEqual({ type: "auto" });

			const none = await captureRawPayload(getModel("anthropic", id), { toolChoice: "none" }, true);
			expect(none.tool_choice).toEqual({ type: "none" });
		}
	});

	it("drops temperature for 5.5 models even when thinkingEnabled is left unset", async () => {
		for (const id of ["claude-sonnet-5-5", "claude-opus-5-5"] as const) {
			const payload = await captureRawPayload(getModel("anthropic", id), { temperature: 0.2 });
			expect(payload.temperature).toBeUndefined();
			expect(payload.thinking).toBeUndefined();
		}
	});

	it("uses adaptive thinking for 5.5 ids even when catalog compat lacks forceAdaptiveThinking", async () => {
		for (const id of ["claude-sonnet-5-5", "claude-opus-5-5"] as const) {
			const { compat: _compat, ...base } = getModel("anthropic", id);
			const payload = await capturePayload({ ...base, provider: "custom-gateway" }, { reasoning: "high" });
			expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
			expect(payload.thinking?.budget_tokens).toBeUndefined();
			expect(payload.output_config).toEqual({ effort: "high" });
		}
	});

	it("still sends thinking.type=disabled and temperature for Claude Sonnet 5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-5"), { temperature: 0 });

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.temperature).toBe(0);
	});

	it("still forwards forced tool_choice for Claude Sonnet 5", async () => {
		const payload = await captureRawPayload(getModel("anthropic", "claude-sonnet-5"), { toolChoice: "any" }, true);

		expect(payload.tool_choice).toEqual({ type: "any" });
	});
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic thinking disable E2E", () => {
	it("disables thinking for Claude reasoning models", { retry: 2, timeout: 30000 }, async () => {
		const result = await runWithoutReasoning(getModel("anthropic", "claude-sonnet-4-5"));

		expect(result.thinkingEventCount).toBe(0);
		expect(result.thinkingCharCount).toBe(0);
		expect(result.contentTypes).not.toContain("thinking");
		expect(countPongs(result.text)).toBeGreaterThanOrEqual(35);
	});
});
