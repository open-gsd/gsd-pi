import { describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.ts";
import type { Model } from "../src/types.ts";

/**
 * #2645 — Claude 5.x entries relayed through OpenAI-compatible endpoints
 * (Copilot, OpenRouter) reject `temperature`, and the 5.5/5.1 tier also
 * rejects a forced tool_choice. Catalog entries carry granular compat flags;
 * the provider omits those params for marked models only.
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

interface RelayPayload {
	temperature?: number;
	tool_choice?: unknown;
}

function makeRelayModel(
	compat: Record<string, unknown>,
	id = "claude-opus-5.5",
): Model<"openai-completions"> {
	return {
		id,
		name: "Claude Opus 5.5",
		api: "openai-completions",
		provider: "test-relay",
		baseUrl: "https://relay.example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 128000,
		compat,
	} as Model<"openai-completions">;
}

async function captureRelayPayload(
	model: Model<"openai-completions">,
	options: {
		temperature?: number;
		toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	},
): Promise<RelayPayload> {
	let payload: unknown;
	await streamSimple(
		model,
		{
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools: [
				{
					name: "ping",
					description: "Ping tool",
					parameters: { type: "object", properties: {} },
				},
			],
		},
		{
			apiKey: "test",
			...options,
			onPayload: (params: unknown) => {
				payload = params;
			},
		} as unknown as Parameters<typeof streamSimple>[2],
	).result();
	return (payload ?? mockState.lastParams) as RelayPayload;
}

describe("openai-completions Claude 5.x relay guards (#2645)", () => {
	it("omits temperature for models marked rejectsTemperature", async () => {
		const model = makeRelayModel({ rejectsTemperature: true, rejectsForcedToolChoice: true });

		const params = await captureRelayPayload(model, { temperature: 0 });

		expect(params.temperature).toBeUndefined();
	});

	it("omits a forced tool_choice for models marked rejectsForcedToolChoice", async () => {
		const model = makeRelayModel({ rejectsTemperature: true, rejectsForcedToolChoice: true });

		const params = await captureRelayPayload(model, { toolChoice: "required" });

		expect(params.tool_choice).toBeUndefined();
	});

	it("omits a named-function tool_choice for models marked rejectsForcedToolChoice", async () => {
		const model = makeRelayModel({ rejectsTemperature: true, rejectsForcedToolChoice: true });

		const params = await captureRelayPayload(model, {
			toolChoice: { type: "function", function: { name: "ping" } },
		});

		expect(params.tool_choice).toBeUndefined();
	});

	it("keeps tool_choice none for marked models", async () => {
		const model = makeRelayModel({ rejectsTemperature: true, rejectsForcedToolChoice: true });

		const params = await captureRelayPayload(model, { toolChoice: "none" });

		expect(params.tool_choice).toBe("none");
	});

	it("keeps tool_choice auto for marked models", async () => {
		const model = makeRelayModel({ rejectsTemperature: true, rejectsForcedToolChoice: true });

		const params = await captureRelayPayload(model, { toolChoice: "auto" });

		expect(params.tool_choice).toBe("auto");
	});

	it("keeps a forced tool_choice for temperature-only (granular) models", async () => {
		const model = makeRelayModel({ rejectsTemperature: true }, "claude-fable-5");

		const params = await captureRelayPayload(model, { toolChoice: "required" });

		expect(params.tool_choice).toBe("required");
	});

	it("omits temperature but keeps forced tool_choice for the Haiku 5.5 relay entry (#2701)", async () => {
		const model = makeRelayModel({ rejectsTemperature: true }, "claude-haiku-5.5");

		const params = await captureRelayPayload(model, { temperature: 0, toolChoice: "required" });

		expect(params.temperature).toBeUndefined();
		expect(params.tool_choice).toBe("required");
	});

	it("leaves unmarked models untouched", async () => {
		const model = makeRelayModel({}, "claude-sonnet-5");

		const params = await captureRelayPayload(model, { temperature: 0, toolChoice: "required" });

		expect(params.temperature).toBe(0);
		expect(params.tool_choice).toBe("required");
	});
});
