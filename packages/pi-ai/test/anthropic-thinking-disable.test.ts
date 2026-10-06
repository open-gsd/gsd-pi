import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import { streamSimple } from "../src/stream.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
	temperature?: number;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makePayloadCaptureContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
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

// #2500 — Sonnet 5.5 rejects the legacy request surface with 400s:
// thinking {type:"disabled"} (off is {type:"between_tools"}), temperature,
// and forced tool_choice. The catalog compat flag `strictRequestParams` marks it.
describe("Anthropic strict request params (Sonnet 5.5)", () => {
	it("sends thinking.type=between_tools for Claude Sonnet 5.5 when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-5-5"));

		expect(payload.thinking).toEqual({ type: "between_tools" });
	});

	it("omits temperature for Claude Sonnet 5.5 even when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-5-5"), { temperature: 0 });

		expect(payload.temperature).toBeUndefined();
		expect(payload.thinking).toEqual({ type: "between_tools" });
	});

	it("leaves legacy behavior untouched for models without the strictRequestParams marker", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-5"), { temperature: 0 });

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.temperature).toBe(0);
	});
});

// `tool_choice` only reaches buildParams through streamAnthropic's
// AnthropicOptions (the simple path does not forward it), so these exercise
// the request-building layer directly against a local HTTP server.
describe("Anthropic strict request params tool_choice (#2500)", () => {
	function createStrictModel(compat?: { strictRequestParams?: boolean }): Model<"anthropic-messages"> {
		return {
			id: "claude-sonnet-5-5",
			name: "Claude Sonnet 5.5",
			api: "anthropic-messages",
			provider: "test-anthropic",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 128000,
			compat,
		};
	}

	async function captureRequest(
		model: Model<"anthropic-messages">,
		options: { toolChoice: "auto" | "any" | { type: "tool"; name: string } },
	): Promise<Record<string, unknown>> {
		let capturedBody: Record<string, unknown> | undefined;
		const server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;

		try {
			const stream = streamAnthropic(
				{ ...model, baseUrl: `http://127.0.0.1:${address.port}` },
				{
					messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
					tools: [{
						name: "lookup",
						description: "Look up a value",
						parameters: { type: "object", properties: {} },
					}],
				},
				{ apiKey: "test-key", ...options },
			);
			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}

		if (!capturedBody) throw new Error("Expected request body to be captured");
		return capturedBody;
	}

	it("omits forced tool_choice any for strict-param models", async () => {
		const body = await captureRequest(createStrictModel({ strictRequestParams: true }), { toolChoice: "any" });

		expect(body.tool_choice).toBeUndefined();
	});

	it("omits named-tool tool_choice for strict-param models", async () => {
		const body = await captureRequest(createStrictModel({ strictRequestParams: true }), {
			toolChoice: { type: "tool", name: "lookup" },
		});

		expect(body.tool_choice).toBeUndefined();
	});

	it("keeps tool_choice auto for strict-param models", async () => {
		const body = await captureRequest(createStrictModel({ strictRequestParams: true }), { toolChoice: "auto" });

		expect(body.tool_choice).toEqual({ type: "auto" });
	});

	it("keeps forced tool_choice for models without the strictRequestParams marker", async () => {
		const body = await captureRequest(createStrictModel(), { toolChoice: "any" });

		expect(body.tool_choice).toEqual({ type: "any" });
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
