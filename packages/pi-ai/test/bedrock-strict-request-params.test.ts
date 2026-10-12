import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { type BedrockOptions, streamBedrock } from "../src/providers/amazon-bedrock.ts";
import type { Context, Model } from "../src/types.ts";

/**
 * #2645 — Claude 5.x models on Bedrock Converse reject the legacy request
 * surface: Sonnet 5.5 / Opus 5.5 / Fable 5.x reject `temperature`, Sonnet 5.5
 * / Opus 5.5 / Fable 5.1 reject a forced tool choice (Fable 5 still accepts
 * it), and Fable 5 must be recognized as adaptive-only (no budget thinking,
 * no interleaved beta). The Converse path mirrors the catalog markers by id
 * because Bedrock models carry no compat metadata.
 */

interface BedrockCommandInput {
	inferenceConfig?: { maxTokens?: number; temperature?: number };
	toolConfig?: {
		tools?: unknown[];
		toolChoice?: { auto?: Record<string, never>; any?: Record<string, never>; tool?: { name: string } };
	};
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

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		tools: [
			{
				name: "lookup",
				description: "Look up a value",
				parameters: { type: "object", properties: {} },
			},
		],
	};
}

async function captureCommandInput(
	model: Model<"bedrock-converse-stream">,
	options?: BedrockOptions,
): Promise<BedrockCommandInput> {
	let capturedPayload: BedrockCommandInput | undefined;
	const s = streamBedrock(model, makeContext(), {
		...options,
		onPayload: (payload) => {
			capturedPayload = payload as BedrockCommandInput;
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

describe("Bedrock strict request params (#2645)", () => {
	it("omits temperature for Sonnet 5.5 even when the caller sets it", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5-5");

		const payload = await captureCommandInput(model, { temperature: 0 });

		expect(payload.inferenceConfig?.temperature).toBeUndefined();
	});

	it("omits temperature for Opus 5.5", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5-5");

		const payload = await captureCommandInput(model, { temperature: 0 });

		expect(payload.inferenceConfig?.temperature).toBeUndefined();
	});

	it("omits temperature for Fable 5", async () => {
		const model = getModel("amazon-bedrock", "anthropic.claude-fable-5");

		const payload = await captureCommandInput(model, { temperature: 0 });

		expect(payload.inferenceConfig?.temperature).toBeUndefined();
	});

	it("keeps temperature for models without the strict surface", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5");

		const payload = await captureCommandInput(model, { temperature: 0 });

		expect(payload.inferenceConfig?.temperature).toBe(0);
	});

	it("downgrades a forced tool choice to auto for Sonnet 5.5", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5-5");

		const payload = await captureCommandInput(model, { toolChoice: "any" });

		expect(payload.toolConfig?.tools).toHaveLength(1);
		expect(payload.toolConfig?.toolChoice).toEqual({ auto: {} });
	});

	it("downgrades a named-tool tool choice to auto for Opus 5.5", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5-5");

		const payload = await captureCommandInput(model, { toolChoice: { type: "tool", name: "lookup" } });

		expect(payload.toolConfig?.toolChoice).toEqual({ auto: {} });
	});

	it("downgrades a forced tool choice for Fable 5.1", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5-1");

		const payload = await captureCommandInput(model, { toolChoice: "any", temperature: 0 });

		expect(payload.toolConfig?.toolChoice).toEqual({ auto: {} });
		expect(payload.inferenceConfig?.temperature).toBeUndefined();
	});

	it("matches strict-surface ids by model name for application inference profiles", async () => {
		// Application inference profile ARNs don't contain the model name; the
		// heuristics must consult model.name like supportsAdaptiveThinking does.
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5-5");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123",
			name: "Claude Sonnet 5.5 (Application profile)",
		};

		const payload = await captureCommandInput(model, { temperature: 0, toolChoice: "any" });

		expect(payload.inferenceConfig?.temperature).toBeUndefined();
		expect(payload.toolConfig?.toolChoice).toEqual({ auto: {} });
	});

	it("keeps a forced tool choice for Fable 5, which still accepts it", async () => {
		const model = getModel("amazon-bedrock", "anthropic.claude-fable-5");

		const payload = await captureCommandInput(model, { toolChoice: "any" });

		expect(payload.toolConfig?.toolChoice).toEqual({ any: {} });
	});

	it("keeps tool_choice auto untouched for strict models", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5-5");

		const payload = await captureCommandInput(model, { toolChoice: "auto" });

		expect(payload.toolConfig?.toolChoice).toEqual({ auto: {} });
	});

	it("recognizes Fable 5 as adaptive-only: no budget thinking, no interleaved beta", async () => {
		const model = getModel("amazon-bedrock", "anthropic.claude-fable-5");

		const payload = await captureCommandInput(model, { reasoning: "high" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});
});

// #2701 — Haiku 5.5 rejects temperature and is adaptive-thinking only, but
// still accepts forced tool choices.
describe("Bedrock Haiku 5.5 request surface (#2701)", () => {
	it("omits temperature for Haiku 5.5", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-haiku-5-5");

		const payload = await captureCommandInput(model, { temperature: 0 });

		expect(payload.inferenceConfig?.temperature).toBeUndefined();
	});

	it("uses adaptive thinking for Haiku 5.5: no budget thinking, no interleaved beta", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-haiku-5-5");

		const payload = await captureCommandInput(model, { reasoning: "high" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});

	it("keeps a forced tool choice for Haiku 5.5, which still accepts it", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-haiku-5-5");

		const payload = await captureCommandInput(model, { toolChoice: "any" });

		expect(payload.toolConfig?.toolChoice).toEqual({ any: {} });
	});

	it("keeps temperature and budget thinking for Haiku 4.5, which lacks the 5.5 surface", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-haiku-4-5-20251001-v1:0");

		const payload = await captureCommandInput(model, { temperature: 0, reasoning: "high" });

		expect(payload.inferenceConfig?.temperature).toBe(0);
		expect(payload.additionalModelRequestFields?.thinking?.type).toBe("enabled");
		expect(payload.additionalModelRequestFields?.thinking?.budget_tokens).toBeGreaterThan(0);
	});

	it("matches Haiku 5.5 by model name for application inference profiles", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-haiku-5-5");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/xyz789",
			name: "Claude Haiku 5.5 (Application profile)",
		};

		const payload = await captureCommandInput(model, { temperature: 0, toolChoice: "any" });

		expect(payload.inferenceConfig?.temperature).toBeUndefined();
		expect(payload.toolConfig?.toolChoice).toEqual({ any: {} });
	});
});
