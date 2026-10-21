// Project/App: gsd-pi
// File Purpose: Regression tests for generated model catalog output.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isModelsCatalog } from "../src/model-catalog.ts";
import { calculateCost } from "../src/models.ts";
import { MODELS } from "../src/models.generated.ts";

describe("models.generated.ts", () => {
	test("models.generated.json mirrors the complete generated catalog", () => {
		// allow-source-grep: reads the generated JSON data snapshot (manifest output), not source, to verify it mirrors MODELS
		const snapshot = JSON.parse(readFileSync(join(import.meta.dirname, "../src/models.generated.json"), "utf8"));

		expect(snapshot).toEqual(MODELS);
	});

	test("models.generated.json satisfies catalog validation", () => {
		// allow-source-grep: reads the generated JSON data snapshot (manifest output), not source, to validate its shape
		const snapshot = JSON.parse(readFileSync(join(import.meta.dirname, "../src/models.generated.json"), "utf8"));

		expect(isModelsCatalog(snapshot)).toBe(true);
	});

	test("does not include floating-point precision artifacts in cost literals", () => {
		// allow-source-grep: generated catalog is data output; this test guards numeric literal formatting only
		const generated = readFileSync(join(import.meta.dirname, "../src/models.generated.ts"), "utf8");
		const noisyCostLiteral = /^\s+(?:input|output|cacheRead|cacheWrite): \d+\.\d{13,},/m;

		expect(generated).not.toMatch(noisyCostLiteral);
	});

	test("includes Claude Fable 5 across its supported providers with adaptive thinking", () => {
		const anthropic = MODELS.anthropic["claude-fable-5"];
		expect(anthropic).toBeDefined();
		expect(anthropic.api).toBe("anthropic-messages");
		expect(anthropic.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		expect(anthropic.compat).toMatchObject({ forceAdaptiveThinking: true });

		const vertex = MODELS["anthropic-vertex"]["claude-fable-5"];
		expect(vertex).toBeDefined();
		expect(vertex.api).toBe("anthropic-vertex");
		expect(vertex.compat).toMatchObject({ forceAdaptiveThinking: true });

		expect(MODELS["amazon-bedrock"]["us.anthropic.claude-fable-5"]).toBeDefined();
		expect(MODELS.openrouter["anthropic/claude-fable-5"]).toBeDefined();
	});

	test("includes Claude Opus 5 across Anthropic-backed providers with adaptive thinking", () => {
		const anthropic = MODELS.anthropic["claude-opus-5"];
		expect(anthropic).toBeDefined();
		expect(anthropic.api).toBe("anthropic-messages");
		expect(anthropic.name).toBe("Claude Opus 5");
		expect(anthropic.contextWindow).toBe(1_000_000);
		expect(anthropic.maxTokens).toBe(128_000);
		expect(anthropic.cost).toMatchObject({ input: 5, output: 25 });
		expect(anthropic.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		expect(anthropic.compat).toMatchObject({ forceAdaptiveThinking: true });

		const vertex = MODELS["anthropic-vertex"]["claude-opus-5"];
		expect(vertex).toBeDefined();
		expect(vertex.api).toBe("anthropic-vertex");
		expect(vertex.name).toBe("Claude Opus 5 (Vertex)");
		expect(vertex.contextWindow).toBe(1_000_000);
		expect(vertex.maxTokens).toBe(128_000);
		expect(vertex.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		expect(vertex.compat).toMatchObject({ forceAdaptiveThinking: true });

		for (const [id, name] of [
			["anthropic.claude-opus-5", "Claude Opus 5"],
			["us.anthropic.claude-opus-5", "Claude Opus 5 (US)"],
			["global.anthropic.claude-opus-5", "Claude Opus 5 (Global)"],
		] as const) {
			const bedrock = MODELS["amazon-bedrock"][id];
			expect(bedrock).toBeDefined();
			expect(bedrock.api).toBe("bedrock-converse-stream");
			expect(bedrock.name).toBe(name);
			expect(bedrock.contextWindow).toBe(1_000_000);
			expect(bedrock.maxTokens).toBe(128_000);
			expect(bedrock.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		}
	});

	test("includes Claude Sonnet 5 across Anthropic-backed providers with adaptive thinking", () => {
		const anthropic = MODELS.anthropic["claude-sonnet-5"];
		expect(anthropic).toBeDefined();
		expect(anthropic.api).toBe("anthropic-messages");
		expect(anthropic.name).toBe("Claude Sonnet 5");
		expect(anthropic.contextWindow).toBe(1_000_000);
		expect(anthropic.maxTokens).toBe(128_000);
		expect(anthropic.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		expect(anthropic.compat).toMatchObject({ forceAdaptiveThinking: true });

		const vertex = MODELS["anthropic-vertex"]["claude-sonnet-5"];
		expect(vertex).toBeDefined();
		expect(vertex.api).toBe("anthropic-vertex");
		expect(vertex.name).toBe("Claude Sonnet 5 (Vertex)");
		expect(vertex.contextWindow).toBe(1_000_000);
		expect(vertex.maxTokens).toBe(128_000);
		expect(vertex.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		expect(vertex.compat).toMatchObject({ forceAdaptiveThinking: true });

		for (const [id, name] of [
			["anthropic.claude-sonnet-5", "Claude Sonnet 5"],
			["us.anthropic.claude-sonnet-5", "Claude Sonnet 5 (US)"],
			["global.anthropic.claude-sonnet-5", "Claude Sonnet 5 (Global)"],
		] as const) {
			const bedrock = MODELS["amazon-bedrock"][id];
			expect(bedrock).toBeDefined();
			expect(bedrock.api).toBe("bedrock-converse-stream");
			expect(bedrock.name).toBe(name);
			expect(bedrock.contextWindow).toBe(1_000_000);
			expect(bedrock.maxTokens).toBe(128_000);
			expect(bedrock.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		}
	});

	test("includes GPT-5.6 variants for the GitHub Copilot provider", () => {
		// models.dev 2026-09 refresh: Copilot's gpt-5.6-sol cost moved to 4/20/0.4, matching the OpenAI listing; terra/luna unchanged.
		expect("gpt-5.6" in MODELS["github-copilot"]).toBe(false);

		for (const [id, name, input, output, cacheRead] of [
			["gpt-5.6-sol", "GPT-5.6 Sol", 4, 20, 0.4],
			["gpt-5.6-terra", "GPT-5.6 Terra", 2, 12, 0.2],
			["gpt-5.6-luna", "GPT-5.6 Luna", 0.2, 1.2, 0.02],
		] as const) {
			const copilot = MODELS["github-copilot"][id];
			expect(copilot).toBeDefined();
			expect(copilot.api).toBe("openai-responses");
			expect(copilot.name).toBe(name);
			expect(copilot.baseUrl).toBe("https://api.individual.githubcopilot.com");
			expect(copilot.contextWindow).toBe(1_050_000);
			expect(copilot.maxTokens).toBe(128_000);
			expect(copilot.thinkingLevelMap).toMatchObject({ minimal: "low", xhigh: "xhigh", max: "max" });
			expect(copilot.cost.input).toBe(input);
			expect(copilot.cost.output).toBe(output);
			expect(copilot.cost.cacheRead).toBe(cacheRead);
		}
	});

	test("includes MAI Code 1.1 Flash for GitHub Copilot", () => {
		const model = MODELS["github-copilot"]["mai-code-1.1-flash"];
		expect(model).toMatchObject({
			id: "mai-code-1.1-flash",
			name: "MAI Code 1.1 Flash",
			api: "openai-responses",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			reasoning: true,
			cost: { input: 0.2, output: 1.2 },
		});
		expect(model.headers).toMatchObject({
			"Copilot-Integration-Id": "vscode-chat",
		});
		expect(model.thinkingLevelMap).toMatchObject({ off: null, minimal: "low", medium: "medium", xhigh: "high" });
	});

	test("includes GPT-6 Astra for GitHub Copilot", () => {
		const model = MODELS["github-copilot"]["gpt-6-astra"];
		expect(model).toMatchObject({
			id: "gpt-6-astra",
			api: "openai-completions",
			provider: "github-copilot",
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		});
	});

	test("includes GPT-5.6 variants for OpenAI and OpenAI Codex providers", () => {
		// models.dev now lists the GPT-5.6 family natively; the curated fill in
		// generate-models.ts stands down when upstream data is present.
		expect("gpt-5.6" in MODELS.openai).toBe(true);
		expect("gpt-5.6" in MODELS["openai-codex"]).toBe(false);
		expect(MODELS.openai["gpt-5.6"].contextWindow).toBe(1_050_000);
		expect(MODELS.openai["gpt-5.6"].cost).toMatchObject({ input: 4, output: 20, cacheRead: 0.4 });

		const variants = [
			// [id, name, openai input, openai output, codex input, codex output]
			["gpt-5.6-sol", "GPT-5.6 Sol", 4, 20, 5, 30],
			["gpt-5.6-terra", "GPT-5.6 Terra", 2, 12, 2.5, 15],
			["gpt-5.6-luna", "GPT-5.6 Luna", 0.2, 1.2, 1, 6],
		] as const;

		for (const [id, name, openaiInput, openaiOutput, codexInput, codexOutput] of variants) {
			const openai = MODELS.openai[id];
			expect(openai).toBeDefined();
			expect(openai.api).toBe("openai-responses");
			expect(openai.name).toBe(name);
			expect(openai.contextWindow).toBe(272_000);
			expect(openai.maxTokens).toBe(128_000);
			expect(openai.thinkingLevelMap).toMatchObject({ off: "none", xhigh: "xhigh", max: "max" });
			expect(openai.cost.input).toBe(openaiInput);
			expect(openai.cost.output).toBe(openaiOutput);

			const codex = MODELS["openai-codex"][id];
			expect(codex).toBeDefined();
			expect(codex.api).toBe("openai-codex-responses");
			expect(codex.name).toBe(name);
			expect(codex.baseUrl).toBe("https://chatgpt.com/backend-api");
			expect(codex.contextWindow).toBe(372_000);
			expect(codex.maxTokens).toBe(128_000);
			expect(codex.thinkingLevelMap).toMatchObject({ xhigh: "xhigh", max: "max", minimal: "low" });
			expect(codex.cost.input).toBe(codexInput);
			expect(codex.cost.output).toBe(codexOutput);
		}

		const sol = MODELS["openai-codex"]["gpt-5.6-sol"];
		expect(sol.cost.tiers?.[0]).toMatchObject({ inputTokensAbove: 272_000, input: 10, output: 45 });
		const usage = {
			input: 272_001,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 273_001,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		expect(calculateCost(sol, usage).input).toBeCloseTo((10 / 1_000_000) * 272_001);
	});

	test("includes Anthropic Vertex models from the generated catalog", () => {
		const models = MODELS["anthropic-vertex"];

		expect(models).toBeDefined();
		expect(models["claude-sonnet-4-6"]).toBeDefined();
		expect(models["claude-opus-4-8"]).toBeDefined();
		expect(models["claude-haiku-4-5@20251001"]).toBeDefined();
		expect(Object.keys(models).some((id) => id.includes("@default"))).toBe(false);

		for (const model of Object.values(models)) {
			expect(model.provider).toBe("anthropic-vertex");
			expect(model.api).toBe("anthropic-vertex");
		}
	});

	test("includes MiniMax M3 for direct MiniMax providers", () => {
		const providers = [
			["minimax", "https://api.minimax.io/anthropic"],
			["minimax-cn", "https://api.minimaxi.com/anthropic"],
		] as const;

		for (const [provider, baseUrl] of providers) {
			const model = MODELS[provider]["MiniMax-M3"];

			expect(model).toMatchObject({
				id: "MiniMax-M3",
				name: "MiniMax-M3",
				api: "anthropic-messages",
				provider,
				baseUrl,
				reasoning: true,
				input: ["text", "image", "video"],
				compat: { forceAdaptiveThinking: true },
				cost: {
					input: 0.3,
					output: 1.2,
					cacheRead: 0.06,
					cacheWrite: 0,
				},
				contextWindow: 1000000,
				maxTokens: 131072,
			});
		}
	});

	test("includes Grok 4.5 as a first-class xAI model", () => {
		const model = MODELS.xai["grok-4.5"];

		expect(model).toMatchObject({
			id: "grok-4.5",
			name: "Grok 4.5",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 2,
				output: 6,
				cacheRead: 0.3,
				cacheWrite: 0,
			},
			contextWindow: 500000,
			maxTokens: 500000,
		});
	});

	test("includes Muse Spark 1.1 as a first-class Vercel AI Gateway model", () => {
		const model = MODELS["vercel-ai-gateway"]["meta/muse-spark-1.1"];

		expect(model).toMatchObject({
			id: "meta/muse-spark-1.1",
			name: "Muse Spark 1.1",
			// The generator tags every Vercel AI Gateway model as anthropic-messages;
			// the gateway serves an Anthropic-compatible endpoint across its catalog.
			api: "anthropic-messages",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 4.25,
				cacheRead: 0.15,
				cacheWrite: 0,
			},
			contextWindow: 1048576,
			maxTokens: 1048576,
		});
	});

	test("keeps GitHub Copilot Claude context at Copilot's 200K limit", () => {
		// models.dev 2026-09 refresh: Copilot dropped the Claude 4.6 generation this test pinned (claude-opus-4.6), so the 200K cap is guarded as a property over the Anthropic-transport Claude entries.
		const anthropicClaudeModels = Object.values(MODELS["github-copilot"]).filter(
			(model) => model.api === "anthropic-messages",
		);

		expect(anthropicClaudeModels.length).toBeGreaterThan(0);
		for (const model of anthropicClaudeModels) {
			expect(model.id).toMatch(/^claude-/);
			expect(model.provider).toBe("github-copilot");
			expect(model.contextWindow).toBe(200_000);
		}
	});

	test("includes Copilot Kimi models on the GitHub Copilot OpenAI-compatible transport", () => {
		for (const [id, contextWindow, maxTokens] of [
			["kimi-k2.7-code", 256000, 32000],
			["kimi-k3", 1048576, 131072],
		] as const) {
			const model = MODELS["github-copilot"][id];

			expect(model).toBeDefined();
			expect(model).toMatchObject({
				id,
				api: "openai-completions",
				provider: "github-copilot",
				baseUrl: "https://api.individual.githubcopilot.com",
				reasoning: true,
				input: ["text", "image"],
				contextWindow,
				maxTokens,
				headers: {
					"User-Agent": "GitHubCopilotChat/0.35.0",
					"Copilot-Integration-Id": "vscode-chat",
				},
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
				},
			});
			expect(model.cost.input).toBeGreaterThan(0);
			expect(model.cost.output).toBeGreaterThan(0);
		}
	});

	test("supplements the ZAI catalog with the GLM models missing from models.dev", () => {
		// models.dev's "zai-coding-plan" provider lags the live z.ai endpoint, so
		// the generator pins these known-available GLM models. Guard that they stay
		// in the catalog with the expected shape. Token limits are asserted as lower
		// bounds only: if models.dev later ships these IDs with different limits the
		// upstream entry wins, and the catalog is still complete.
		const cases = [
			// glm-4.5 is in ZAI_TOOL_STREAM_UNSUPPORTED_MODELS, so no zaiToolStream flag.
			["glm-4.5", "GLM-4.5", false],
			["glm-4.6", "GLM-4.6", true],
			["glm-5", "GLM-5", true],
			["glm-5.2", "GLM-5.2", true],
		] as const;

		for (const [id, name, zaiToolStream] of cases) {
			const model = MODELS.zai[id];

			expect(model).toBeDefined();
			expect(model).toMatchObject({
				id,
				name,
				api: "openai-completions",
				provider: "zai",
				baseUrl: "https://api.z.ai/api/coding/paas/v4",
				reasoning: true,
				input: ["text"],
			});
			expect(model.contextWindow).toBeGreaterThanOrEqual(131072);
			expect(model.maxTokens).toBeGreaterThanOrEqual(98304);
			expect(model.compat).toMatchObject({ supportsDeveloperRole: false, thinkingFormat: "zai" });
			expect((model.compat as { zaiToolStream?: boolean }).zaiToolStream ?? false).toBe(zaiToolStream);
		}
	});

	test("keeps the ZAI catalog keys in deterministic sorted order", () => {
		// The generator writes ZAI models via Object.keys(models).sort(), and the
		// provider carries no curated ordering, so the keys must stay
		// lexicographically sorted. Guards against hand-edited insertions landing
		// out of order (e.g. glm-4.6 after glm-4.7), which produced noisy diffs.
		const ids = Object.keys(MODELS.zai);
		expect(ids).toEqual([...ids].sort());
	});
});
