import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

/**
 * #2906 — MiniMax-M3.1-Flash over the direct Anthropic-compatible endpoints
 * (https://api.minimax.io/anthropic, https://api.minimaxi.com/anthropic).
 *
 * Per platform.minimax.io (text-anthropic-api): the endpoint only serves
 * MiniMax-M3.1-Flash and MiniMax-M3; Flash always thinks — thinking
 * {type:"disabled"} returns HTTP 400 (error 2013) — and output_config.effort
 * accepts low/medium/high/xhigh/max with a server default of max. M3 exposes
 * adaptive and disabled thinking modes.
 *
 * These tests pin the request shapes at the HTTP boundary, offline: onPayload
 * captures the exact wire payload before the (failing) transport call.
 */

interface AnthropicThinkingPayload {
	model?: string;
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
	messages?: Array<{ role: string; content: unknown }>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	provider: "minimax" | "minimax-cn",
	modelId: string,
	options?: SimpleStreamOptions,
): Promise<{ payload: AnthropicThinkingPayload; error?: string }> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	let errorMessage: string | undefined;

	const model = getModel(provider, modelId as "MiniMax-M3.1-Flash") as Model<"anthropic-messages">;
	const s = streamSimple(model, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			throw new PayloadCaptured();
		},
	});

	const result = await s.result();
	if (result.stopReason === "error" && result.errorMessage !== "payload captured") {
		errorMessage = result.errorMessage;
	}

	if (!capturedPayload) {
		if (!errorMessage) {
			throw new Error("Expected payload to be captured or an error to be reported");
		}
		return { payload: {}, error: errorMessage };
	}

	return { payload: capturedPayload, error: errorMessage };
}

describe("MiniMax M3.1-Flash direct request contract (#2906)", () => {
	for (const provider of ["minimax", "minimax-cn"] as const) {
		it(`[${provider}] sends adaptive thinking with explicit effort for the default level`, async () => {
			const { payload, error } = await capturePayload(provider, "MiniMax-M3.1-Flash", { reasoning: "medium" });

			expect(error).toBeUndefined();
			expect(payload.model).toBe("MiniMax-M3.1-Flash");
			expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
			expect(payload.output_config).toEqual({ effort: "medium" });
		});

		it(`[${provider}] maps the thinking ladder onto the accepted effort values`, async () => {
			const minimal = await capturePayload(provider, "MiniMax-M3.1-Flash", { reasoning: "minimal" });
			expect(minimal.payload.output_config).toEqual({ effort: "low" });

			const xhigh = await capturePayload(provider, "MiniMax-M3.1-Flash", { reasoning: "xhigh" });
			expect(xhigh.payload.output_config).toEqual({ effort: "xhigh" });

			const max = await capturePayload(provider, "MiniMax-M3.1-Flash", { reasoning: "max" });
			expect(max.payload.output_config).toEqual({ effort: "max" });
		});

		it(`[${provider}] rejects thinking "off" client-side with a clear error instead of a disabled request`, async () => {
			const { payload, error } = await capturePayload(provider, "MiniMax-M3.1-Flash");

			expect(payload.thinking).toBeUndefined();
			expect(error).toBeDefined();
			expect(error).toContain("cannot disable thinking");
			expect(error).toContain("always thinks");
		});
	}

	it("keeps M3 adaptive/disabled behavior unchanged", async () => {
		const on = await capturePayload("minimax", "MiniMax-M3", { reasoning: "high" });
		expect(on.payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(on.payload.output_config).toEqual({ effort: "high" });

		const off = await capturePayload("minimax", "MiniMax-M3");
		expect(off.payload.thinking).toEqual({ type: "disabled" });
		expect(off.payload.output_config).toBeUndefined();
	});

	it("preserves image blocks on the wire for the multimodal Flash entry", async () => {
		const model = getModel("minimax", "MiniMax-M3.1-Flash") as Parameters<typeof streamSimple>[0];
		expect(model.input).toContain("image");

		let capturedPayload: AnthropicThinkingPayload | undefined;
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "What is in this image?" },
						{
							type: "image",
							mimeType: "image/png",
							data: "iVBORw0KGgo=",
						},
					],
					timestamp: Date.now(),
				},
			],
		};
		const s = streamSimple(model, context, {
			apiKey: "fake-key",
			reasoning: "low",
			onPayload: (payload) => {
				capturedPayload = payload as AnthropicThinkingPayload;
				throw new PayloadCaptured();
			},
		});
		await s.result();

		expect(capturedPayload).toBeDefined();
		const userMessage = capturedPayload?.messages?.find((m) => m.role === "user");
		expect(Array.isArray(userMessage?.content)).toBe(true);
		const content = userMessage?.content as Array<Record<string, unknown>>;
		expect(content.some((block) => block.type === "image")).toBe(true);
	});
});
