import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";
import type { Model, SimpleStreamOptions } from "../src/types.ts";

/**
 * #2906 — MiniMax M3.1-Flash / M3 routes on the OpenAI-compatible gateways
 * (OpenRouter `minimax/minimax-m3.1-flash:free` + `minimax/minimax-m3`,
 * OpenCode Zen `minimax-m3.1-flash-free` + `minimax-m3`).
 *
 * Upstream accepts reasoning effort low/medium/high/xhigh/max (server default
 * max); `none` is rejected. The catalog entries carry thinkingLevelMap so the
 * thinking ladder lands on accepted values and "off" maps to "low" instead of
 * the rejected "none". These tests pin the wire shapes offline through a
 * mocked OpenAI client.
 */

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

interface GatewayPayload {
	model?: string;
	reasoning_effort?: string;
	reasoning?: { effort?: string };
}

async function captureGatewayPayload(
	provider: "openrouter" | "opencode" | "opencode-go",
	modelId: string,
	options?: SimpleStreamOptions,
): Promise<GatewayPayload> {
	// getModel's literal-typed generic intersects to never across the provider
	// union; the runtime lookup is a plain key index, so erase to a string form.
	const model = (getModel as (provider: string, modelId: string) => Model<"openai-completions">)(
		provider,
		modelId,
	);

	const s = streamSimple(
		model,
		{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
		{
			apiKey: "test",
			...options,
		},
	);
	await s.result();

	return mockState.lastParams as GatewayPayload;
}

describe("MiniMax gateway route request contracts (#2906)", () => {
	it("openrouter Flash maps reasoning onto the nested reasoning.effort object", async () => {
		const medium = await captureGatewayPayload("openrouter", "minimax/minimax-m3.1-flash:free", {
			reasoning: "medium",
		});
		expect(medium.model).toBe("minimax/minimax-m3.1-flash:free");
		expect(medium.reasoning).toEqual({ effort: "medium" });
		expect(medium.reasoning_effort).toBeUndefined();

		const off = await captureGatewayPayload("openrouter", "minimax/minimax-m3.1-flash:free");
		expect(off.reasoning).toEqual({ effort: "low" });
	});

	it("opencode Flash maps reasoning onto reasoning_effort", async () => {
		const medium = await captureGatewayPayload("opencode", "minimax-m3.1-flash-free", { reasoning: "medium" });
		expect(medium.model).toBe("minimax-m3.1-flash-free");
		expect(medium.reasoning_effort).toBe("medium");

		const off = await captureGatewayPayload("opencode", "minimax-m3.1-flash-free");
		expect(off.reasoning_effort).toBe("low");
	});

	it("opencode-go Flash maps reasoning onto reasoning_effort", async () => {
		const max = await captureGatewayPayload("opencode-go", "minimax-m3.1-flash-free", { reasoning: "max" });
		expect(max.model).toBe("minimax-m3.1-flash-free");
		expect(max.reasoning_effort).toBe("max");
	});

	it("openrouter M3 keeps plain reasoning passthrough (off maps to effort none = disabled)", async () => {
		const high = await captureGatewayPayload("openrouter", "minimax/minimax-m3", { reasoning: "high" });
		expect(high.model).toBe("minimax/minimax-m3");
		expect(high.reasoning).toEqual({ effort: "high" });

		// M3 supports turning thinking off, so the openrouter-format off value
		// ("none") is correct for it — only Flash must never send it.
		const off = await captureGatewayPayload("openrouter", "minimax/minimax-m3");
		expect(off.reasoning).toEqual({ effort: "none" });
	});
});
