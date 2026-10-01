import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { type BedrockOptions, streamBedrock } from "../src/providers/amazon-bedrock.ts";
import type { Context, Model } from "../src/types.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";

interface BedrockThinkingPayload {
	inferenceConfig?: { temperature?: number };
	toolConfig?: { toolChoice?: Record<string, unknown> };
	additionalModelRequestFields?: {
		thinking?: { type: string; budget_tokens?: number; display?: string };
		output_config?: { effort?: string };
		anthropic_beta?: string[];
	};
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(withTools = false): Context {
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
	model: Model<"bedrock-converse-stream">,
	options?: BedrockOptions & { tools?: boolean },
): Promise<BedrockThinkingPayload> {
	let capturedPayload: BedrockThinkingPayload | undefined;
	const reasoningOff = options !== undefined && "reasoning" in options && options.reasoning === undefined;
	const s = streamBedrock(model, makeContext(options?.tools === true), {
		...options,
		reasoning: reasoningOff ? undefined : (options?.reasoning ?? "high"),
		onPayload: (payload) => {
			capturedPayload = payload as BedrockThinkingPayload;
			throw new PayloadCaptured();
		},
	});

	for await (const event of s) {
		if (event.type === "error") {
			break;
		}
	}

	if (!capturedPayload) {
		throw new Error("Expected Bedrock payload to be captured before request abort");
	}

	return capturedPayload;
}

describe("Bedrock thinking payload", () => {
	it("uses adaptive thinking for Claude Opus 4.7 when reasoning is enabled", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "global.anthropic.claude-opus-4-7-v1",
			name: "Claude Opus 4.7 (Global)",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 4.7", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "global.anthropic.claude-opus-4-7-v1",
			name: "Claude Opus 4.7 (Global)",
		};

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});

	it("uses adaptive thinking for Claude Opus 5 when reasoning is enabled", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5");

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});

	it("uses adaptive thinking for Claude Sonnet 5 when reasoning is enabled", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5");

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});

	it("uses adaptive thinking for Claude Sonnet 5.5 when reasoning is enabled and drops temperature", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5-5");

		const payload = await capturePayload(model, { reasoning: "xhigh", temperature: 0.5 });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
		expect(payload.inferenceConfig?.temperature).toBeUndefined();
	});

	it("sends between_tools for Claude Sonnet 5.5 when thinking is off", async () => {
		const model = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-5-5");

		const payload = await capturePayload(model, { reasoning: undefined, temperature: 0 });

		expect(payload.additionalModelRequestFields).toEqual({ thinking: { type: "between_tools" } });
		expect(payload.inferenceConfig?.temperature).toBeUndefined();
	});

	it("lowers effort instead of disabling thinking for Claude Opus 5.5 when thinking is off", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5-5");

		const payload = await capturePayload(model, { reasoning: undefined, temperature: 0 });

		expect(payload.additionalModelRequestFields).toEqual({ output_config: { effort: "low" } });
		expect(payload.inferenceConfig?.temperature).toBeUndefined();
	});

	it("downgrades forced tool choice to auto for Claude 5.5 models", async () => {
		for (const id of ["anthropic.claude-sonnet-5-5", "global.anthropic.claude-opus-5-5"]) {
			const payload = await capturePayload(getModel("amazon-bedrock", id), { toolChoice: "any", tools: true });
			expect(payload.toolConfig?.toolChoice).toEqual({ auto: {} });
		}
	});

	it("recognizes Claude Sonnet 5.5 application inference profiles by display name", async () => {
		const base = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-5-5");
		const model: Model<"bedrock-converse-stream"> = {
			...base,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123",
			name: "Claude Sonnet 5.5 (US)",
		};

		const payload = await capturePayload(model, { reasoning: undefined, temperature: 0, toolChoice: "any", tools: true });

		expect(payload.additionalModelRequestFields).toEqual({ thinking: { type: "between_tools" } });
		expect(payload.inferenceConfig?.temperature).toBeUndefined();
		expect(payload.toolConfig?.toolChoice).toEqual({ auto: {} });
	});

	it("keeps Claude Sonnet 5 thinking-off and sampling behavior unchanged", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5");

		const payload = await capturePayload(model, { reasoning: undefined, temperature: 0, toolChoice: "any", tools: true });

		expect(payload.additionalModelRequestFields).toBeUndefined();
		expect(payload.inferenceConfig?.temperature).toBe(0);
		expect(payload.toolConfig?.toolChoice).toEqual({ any: {} });
	});

	it("omits display for GovCloud model ids on non-adaptive Claude thinking", async () => {
		const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0",
			name: "Claude Sonnet 4.5 (GovCloud)",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual(["interleaved-thinking-2025-05-14"]);
	});

	it("omits display for GovCloud regions on adaptive Claude thinking", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "global.anthropic.claude-opus-4-7-v1",
			name: "Claude Opus 4.7 (Global)",
		};

		const payload = await capturePayload(model, { region: "us-gov-west-1" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});
});

describe.skipIf(!hasBedrockCredentials())("Bedrock Claude max tokens E2E", () => {
	it(
		"uses the model maxTokens cap instead of Bedrock's 4096-token default for adaptive Claude models",
		{ retry: 2, timeout: 180000 },
		async () => {
			const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6");
			const model: Model<"bedrock-converse-stream"> = {
				...baseModel,
				maxTokens: 6000,
			};

			const response = await streamBedrock(
				model,
				{
					systemPrompt: "You are a deterministic text generator. Follow the requested output format exactly.",
					messages: [
						{
							role: "user",
							content:
								"Output exactly 5200 repetitions of the token alpha, separated by single spaces. Do not number them. Do not use markdown. Do not add any other text.",
							timestamp: Date.now(),
						},
					],
				},
				{ reasoning: "low" },
			).result();

			expect(response.stopReason, response.errorMessage).not.toBe("error");
			expect(response.usage.output).toBeGreaterThan(4096);
		},
	);
});

describe("Application inference profile support", () => {
	it("uses adaptive thinking when model.name contains the model name but ARN does not", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "Claude Opus 4.6",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
	});

	it("injects cache points when model.name identifies a supported Claude model", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "Claude Sonnet 4.6",
		};

		let capturedPayload: any;
		const s = streamBedrock(
			model,
			{
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			},
			{
				onPayload: (payload) => {
					capturedPayload = payload;
					throw new PayloadCaptured();
				},
			},
		);

		for await (const event of s) {
			if (event.type === "error") break;
		}

		// System prompt should have a cache point
		expect(capturedPayload.system).toHaveLength(2);
		expect(capturedPayload.system[1]).toHaveProperty("cachePoint");

		// Last user message should have a cache point
		const lastMsg = capturedPayload.messages[capturedPayload.messages.length - 1];
		const lastContent = lastMsg.content[lastMsg.content.length - 1];
		expect(lastContent).toHaveProperty("cachePoint");
	});

	it("falls back to fixed-budget thinking for non-adaptive Claude via model.name", async () => {
		const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "Claude Sonnet 4.5",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "enabled",
			budget_tokens: expect.any(Number),
		});
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual(["interleaved-thinking-2025-05-14"]);
	});
});
