import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel, getModels, getProviders, getSupportedThinkingLevels } from "../src/models.ts";
import { MINIMAX_FLASH_MODELS } from "../src/models/minimax.ts";
import { streamAnthropic, streamSimpleAnthropic } from "../src/providers/anthropic.ts";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "../src/providers/openai-completions.ts";
import type { Api, Context, Model, ThinkingLevel } from "../src/types.ts";

const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };
const anthropicSse = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
const openaiSse = 'data: {"id":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

afterEach(() => vi.unstubAllGlobals());

function captureHttp(api: Api) {
	const requests: { url: string; body: Record<string, any> }[] = [];
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		requests.push({ url: request.url, body: JSON.parse(await request.text()) });
		return new Response(api === "anthropic-messages" ? anthropicSse : openaiSse, {
			status: 200, headers: { "content-type": "text/event-stream" },
		});
	}));
	return requests;
}

function directModel(provider: "minimax" | "minimax-cn", id: "MiniMax-M3.1-Flash" | "MiniMax-M3", api: "anthropic-messages" | "openai-completions"): Model<any> {
	const model = { ...getModel(provider, id), api };
	if (api === "openai-completions") model.baseUrl = model.baseUrl.replace("/anthropic", "/v1");
	return model;
}

describe("MiniMax release catalog", () => {
	it("offers only Flash then M3 for direct providers while preserving exact legacy lookup", () => {
		for (const provider of ["minimax", "minimax-cn"] as const) {
			expect(getModels(provider).map((model) => model.id)).toEqual(["MiniMax-M3.1-Flash", "MiniMax-M3"]);
			expect(getModel(provider, "MiniMax-M2.7").id).toBe("MiniMax-M2.7");
			expect(getSupportedThinkingLevels(getModel(provider, "MiniMax-M3.1-Flash"))).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
		}
	});
	it("keeps generated metadata aligned and filters legacy gateway choices without deleting lookup data", () => {
		// allow-source-grep: generated JSON catalog is data, checked against curated release metadata.
		const snapshot = JSON.parse(readFileSync(new URL("../src/models.generated.json", import.meta.url), "utf8"));
		for (const model of MINIMAX_FLASH_MODELS) expect(snapshot[model.provider][model.id]).toEqual(model);
		for (const provider of getProviders()) {
			for (const model of getModels(provider)) {
				if (/minimax/i.test(model.id)) expect(model.id).toMatch(/minimax-m3(?:$|\.1-flash)/i);
			}
		}
		expect(getModel("openrouter", "minimax/minimax-m2.7").id).toBe("minimax/minimax-m2.7");
		expect(getModels("anthropic").length).toBe(getModels("anthropic", { includeLegacy: true }).length);
	});
});

for (const provider of ["minimax", "minimax-cn"] as const) {
	for (const api of ["anthropic-messages", "openai-completions"] as const) {
		describe(`${provider} ${api} serialized SDK requests`, () => {
			for (const effort of [undefined, "low", "medium", "high", "xhigh", "max"] as const) {
				it(`Flash sends adaptive thinking and ${effort ?? "default max"}`, async () => {
					const requests = captureHttp(api);
					const model = directModel(provider, "MiniMax-M3.1-Flash", api);
					const options = { apiKey: "test-key", maxRetries: 0, thinkingEnabled: false, thinkingBudgetTokens: 1234 };
					const result = await (api === "anthropic-messages"
						? streamAnthropic(model, context, { ...options, effort })
						: streamOpenAICompletions(model, context, { ...options, reasoningEffort: effort })).result();
					expect(result.stopReason).not.toBe("error");
					expect(requests).toHaveLength(1);
					const { body, url } = requests[0];
					expect(url).toBe(`${model.baseUrl}/${api === "anthropic-messages" ? "v1/messages" : "chat/completions"}`);
					expect(body.model).toBe("MiniMax-M3.1-Flash");
					expect(body.thinking).toEqual({ type: "adaptive" });
					if (api === "anthropic-messages") {
						expect(body.output_config).toEqual({ effort: effort ?? "max" });
						expect(body.reasoning_effort).toBeUndefined();
					} else {
						expect(body.reasoning_effort).toBe(effort ?? "max");
						expect(body.output_config).toBeUndefined();
					}
					expect(body.reasoning).toBeUndefined();
				});
			}
			for (const thinkingEnabled of [true, false]) {
				it(`M3 retains thinking ${thinkingEnabled} and omits effort`, async () => {
					const requests = captureHttp(api);
					const model = directModel(provider, "MiniMax-M3", api);
					await (api === "anthropic-messages"
						? streamAnthropic(model, context, { apiKey: "test-key", maxRetries: 0, thinkingEnabled, effort: "high" })
						: streamOpenAICompletions(model, context, { apiKey: "test-key", maxRetries: 0, thinkingEnabled, reasoningEffort: "high" })).result();
					expect(requests).toHaveLength(1);
					expect(requests[0].body.thinking).toEqual({ type: thinkingEnabled ? "adaptive" : "disabled" });
					expect(requests[0].body.output_config).toBeUndefined();
					expect(requests[0].body.reasoning_effort).toBeUndefined();
				});
			}
			for (const reasoning of [undefined, "minimal", "xhigh", "max"] as (ThinkingLevel | undefined)[]) {
				it(`simple stream normalizes ${reasoning ?? "unset"} for Flash`, async () => {
					const requests = captureHttp(api);
					const model = directModel(provider, "MiniMax-M3.1-Flash", api);
					await (api === "anthropic-messages" ? streamSimpleAnthropic : streamSimpleOpenAICompletions)(model, context, { apiKey: "test-key", maxRetries: 0, reasoning }).result();
					expect(requests).toHaveLength(1);
					expect(requests[0].body.thinking).toEqual({ type: "adaptive" });
					const effort = reasoning === "minimal" ? "low" : reasoning ?? "max";
					expect(api === "anthropic-messages" ? requests[0].body.output_config.effort : requests[0].body.reasoning_effort).toBe(effort);
				});
			}
		});
	}
}

for (const model of MINIMAX_FLASH_MODELS.filter((entry) => entry.api === "openai-completions")) {
	for (const reasoningEffort of [undefined, "low", "medium", "high", "xhigh", "max"] as const) {
		it(`${model.provider} Flash uses its verified gateway wire format (${reasoningEffort ?? "default"})`, async () => {
			const requests = captureHttp("openai-completions");
			const result = await streamOpenAICompletions(model as Model<"openai-completions">, context, { apiKey: "test-key", maxRetries: 0, reasoningEffort }).result();
			expect(result.stopReason).not.toBe("error");
			expect(requests[0].body.model).toBe(model.id);
			expect(requests[0].body.thinking).toBeUndefined();
			if (model.provider === "openrouter") {
				expect(requests[0].body.reasoning).toEqual({ effort: reasoningEffort ?? "max" });
				expect(requests[0].body.reasoning_effort).toBeUndefined();
			} else expect(requests[0].body.reasoning_effort).toBe(reasoningEffort ?? "max");
		});
	}
}

it("keeps the saved direct M2.7 request contract unchanged", async () => {
	const requests = captureHttp("anthropic-messages");
	await streamSimpleAnthropic(getModel("minimax", "MiniMax-M2.7"), context, { apiKey: "test-key", maxRetries: 0, reasoning: "high" }).result();
	expect(requests[0].body.model).toBe("MiniMax-M2.7");
	expect(requests[0].body.thinking.type).toBe("enabled");
	expect(requests[0].body.thinking.budget_tokens).toBeGreaterThan(0);
	expect(requests[0].body.output_config).toBeUndefined();
});

it("preserves image payloads on the direct Anthropic request boundary", async () => {
	const requests = captureHttp("anthropic-messages");
	const model = getModel("minimax", "MiniMax-M3.1-Flash");
	await streamSimpleAnthropic(model, { messages: [{ role: "user", timestamp: 0, content: [
		{ type: "text", text: "Describe this" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
	] }] }, { apiKey: "test-key", maxRetries: 0 }).result();
	expect(requests[0].body.messages[0].content).toEqual(expect.arrayContaining([
		expect.objectContaining({ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }),
	]));
});

it("rejects unsupported Flash effort before sending a request", async () => {
	const requests = captureHttp("openai-completions");
	const result = await streamOpenAICompletions(directModel("minimax", "MiniMax-M3.1-Flash", "openai-completions"), context, {
		apiKey: "test-key", maxRetries: 0, reasoningEffort: "none" as never,
	}).result();
	expect(result.errorMessage).toContain("does not support reasoning effort none");
	expect(requests).toHaveLength(0);
});

it("does not apply the direct contract to a custom Anthropic proxy", async () => {
	const requests = captureHttp("anthropic-messages");
	const model = { ...getModel("minimax", "MiniMax-M3.1-Flash"), baseUrl: "https://proxy.example.test/anthropic" };
	await streamAnthropic(model, context, { apiKey: "test-key", maxRetries: 0, thinkingEnabled: false }).result();
	expect(requests[0].body.thinking).toEqual({ type: "disabled" });
	expect(requests[0].body.output_config).toBeUndefined();
});
