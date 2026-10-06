/**
 * gsd-pi — Regression tests for startup model validation (#3534)
 *
 * Verifies that validateConfiguredModel() correctly handles extension-provided
 * models and that stale model IDs (e.g. claude-opus-4-6[1m]) trigger fallback.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { formatModelFallbackNotice, validateConfiguredModel } from "../startup-model-validation.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface MockModel {
	provider: string;
	id: string;
}

function createMockRegistry(
	allModels: MockModel[],
	availableModels?: MockModel[],
	options?: { isProviderRequestReady?: (provider: string) => boolean },
) {
	return {
		getAll: () => allModels,
		getAvailable: () => availableModels ?? allModels,
		...(options?.isProviderRequestReady
			? { isProviderRequestReady: options.isProviderRequestReady }
			: {}),
	};
}

function createMockSettings(defaults: { provider?: string; model?: string; thinking?: "off" | "high" }) {
	let currentProvider = defaults.provider;
	let currentModel = defaults.model;
	let currentThinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" = defaults.thinking ?? "off";

	return {
		getDefaultProvider: () => currentProvider,
		getDefaultModel: () => currentModel,
		getDefaultThinkingLevel: () => currentThinking,
		setDefaultModelAndProvider: (provider: string, modelId: string) => {
			currentProvider = provider;
			currentModel = modelId;
		},
		setDefaultThinkingLevel: (level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => {
			currentThinking = level;
		},
		// Expose for assertions
		get _provider() { return currentProvider; },
		get _model() { return currentModel; },
		get _thinking() { return currentThinking; },
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("validateConfiguredModel — regression #3534", () => {
	it("preserves valid extension-provided model without overwriting", () => {
		// Simulate: user configured claude-code/claude-opus-4-6, extension has registered it
		const registry = createMockRegistry([
			{ provider: "claude-code", id: "claude-opus-4-6" },
			{ provider: "google", id: "gemini-2.5-pro" },
		]);
		const settings = createMockSettings({ provider: "claude-code", model: "claude-opus-4-6" });

		validateConfiguredModel(registry, settings);

		// Should NOT have changed the settings — the model is valid
		assert.equal(settings._provider, "claude-code");
		assert.equal(settings._model, "claude-opus-4-6");
	});

	it("falls back when configured model ID does not exist in registry", () => {
		// Simulate: user configured claude-opus-4-6[1m] but registry only has claude-opus-4-6
		const registry = createMockRegistry([
			{ provider: "anthropic", id: "claude-opus-4-6" },
			{ provider: "google", id: "gemini-2.5-pro" },
		]);
		const settings = createMockSettings({ provider: "anthropic", model: "claude-opus-4-6[1m]" });

		validateConfiguredModel(registry, settings);

		// Should have replaced with a fallback — the [1m] variant doesn't exist
		assert.notEqual(settings._model, "claude-opus-4-6[1m]");
	});

	it("prefers the user's saved provider when falling back", () => {
		// Simulate: stale model triggers fallback. The fallback should stay on
		// the user's chosen provider rather than silently jumping to a different
		// one — model-agnostic provider stickiness, not a hard-coded preference.
		const registry = createMockRegistry([
			{ provider: "anthropic", id: "claude-opus-4-6" },
			{ provider: "google", id: "gemini-2.5-pro" },
		]);
		const settings = createMockSettings({ provider: "anthropic", model: "nonexistent-model" });

		validateConfiguredModel(registry, settings);

		// Provider stickiness: should stay on anthropic, since a model from
		// that provider is still available.
		assert.equal(settings._provider, "anthropic");
	});

	it("resets thinking level when model is replaced", () => {
		const registry = createMockRegistry([
			{ provider: "anthropic", id: "claude-opus-4-6" },
		]);
		const settings = createMockSettings({
			provider: "anthropic",
			model: "nonexistent-model",
			thinking: "high",
		});

		validateConfiguredModel(registry, settings);

		assert.equal(settings._thinking, "off");
	});

	it("is a no-op when no model is configured at all", () => {
		const registry = createMockRegistry([
			{ provider: "anthropic", id: "claude-opus-4-6" },
			{ provider: "google", id: "gemini-2.5-pro" },
		]);
		const settings = createMockSettings({ provider: undefined, model: undefined });

		validateConfiguredModel(registry, settings);

		// Should pick a fallback since nothing was configured
		assert.ok(settings._provider);
		assert.ok(settings._model);
	});

	it("falls back when configured model exists in registry but provider has no auth", () => {
		// Simulate: user configured xai/grok-4 but XAI_API_KEY is unset, so
		// xai is in getAll() but not getAvailable(). Previously this slipped
		// through configuredExists and left an unusable default in place.
		const allModels = [
			{ provider: "xai", id: "grok-4-fast-non-reasoning" },
			{ provider: "anthropic", id: "claude-opus-4-6" },
		];
		const availableModels = [
			{ provider: "anthropic", id: "claude-opus-4-6" },
		];
		const registry = createMockRegistry(allModels, availableModels, {
			isProviderRequestReady: (provider) => provider === "anthropic",
		});
		const settings = createMockSettings({
			provider: "xai",
			model: "grok-4-fast-non-reasoning",
			thinking: "high",
		});

		validateConfiguredModel(registry, settings);

		// Should have replaced with an authenticated fallback
		assert.equal(settings._provider, "anthropic");
		assert.equal(settings._model, "claude-opus-4-6");
		// Thinking level resets because the original model was replaced
		assert.equal(settings._thinking, "off");
	});

	it("preserves claude-opus-4-7 when registered and configured (#4348)", () => {
		const registry = createMockRegistry([
			{ provider: "anthropic", id: "claude-opus-4-6" },
			{ provider: "anthropic", id: "claude-opus-4-7" },
		]);
		const settings = createMockSettings({ provider: "anthropic", model: "claude-opus-4-7" });

		validateConfiguredModel(registry, settings);

		assert.equal(settings._provider, "anthropic");
		assert.equal(settings._model, "claude-opus-4-7");
	});

	it("preserves configured model when catalog entry exists but getAvailable is temporarily empty (#2077)", () => {
		const allModels = [
			{ provider: "ccswitch-anthropic-k3", id: "kimi-k3" },
			{ provider: "anthropic", id: "claude-opus-4-6" },
		];
		const registry = createMockRegistry(allModels, [], {
			isProviderRequestReady: () => true,
		});
		const settings = createMockSettings({
			provider: "ccswitch-anthropic-k3",
			model: "kimi-k3",
		});

		validateConfiguredModel(registry, settings);

		assert.equal(settings._provider, "ccswitch-anthropic-k3");
		assert.equal(settings._model, "kimi-k3");
	});

	it("preserves claude-opus-4-8 when registered and configured", () => {
		const registry = createMockRegistry([
			{ provider: "anthropic", id: "claude-opus-4-7" },
			{ provider: "anthropic", id: "claude-opus-4-8" },
		]);
		const settings = createMockSettings({ provider: "anthropic", model: "claude-opus-4-8" });

		const result = validateConfiguredModel(registry, settings);

		assert.equal(settings._provider, "anthropic");
		assert.equal(settings._model, "claude-opus-4-8");
		assert.deepEqual(result, { action: "preserved", from: null, to: null });
	});
});

describe("validateConfiguredModel — fallback notification (#2077)", () => {
	it("reports fell-back with from/to when the configured model is replaced", () => {
		const registry = createMockRegistry([
			{ provider: "anthropic", id: "claude-opus-4-6" },
		]);
		const settings = createMockSettings({ provider: "anthropic", model: "nonexistent-model" });

		const result = validateConfiguredModel(registry, settings);

		assert.deepEqual(result, {
			action: "fell-back",
			from: "anthropic/nonexistent-model",
			to: "anthropic/claude-opus-4-6",
		});
	});

	it("reports preserved when the configured model is valid", () => {
		const registry = createMockRegistry([
			{ provider: "anthropic", id: "claude-opus-4-6" },
		]);
		const settings = createMockSettings({ provider: "anthropic", model: "claude-opus-4-6" });

		const result = validateConfiguredModel(registry, settings);

		assert.deepEqual(result, { action: "preserved", from: null, to: null });
	});

	it("reports preserved when the catalog-preserve path keeps temporarily-unavailable settings", () => {
		const allModels = [
			{ provider: "ccswitch-anthropic-k3", id: "kimi-k3" },
			{ provider: "anthropic", id: "claude-opus-4-6" },
		];
		const registry = createMockRegistry(allModels, [], {
			isProviderRequestReady: () => true,
		});
		const settings = createMockSettings({
			provider: "ccswitch-anthropic-k3",
			model: "kimi-k3",
		});

		const result = validateConfiguredModel(registry, settings);

		assert.deepEqual(result, { action: "preserved", from: null, to: null });
		assert.equal(settings._model, "kimi-k3");
	});

	it("does not rewrite settings when no fallback model exists", () => {
		// Registry is empty — there is nothing to fall back to, so the
		// configured default must stay in place rather than being blanked.
		const registry = createMockRegistry([]);
		const settings = createMockSettings({ provider: "anthropic", model: "claude-opus-4-6" });

		const result = validateConfiguredModel(registry, settings);

		assert.equal(settings._provider, "anthropic");
		assert.equal(settings._model, "claude-opus-4-6");
		assert.deepEqual(result, { action: "preserved", from: null, to: null });
	});

	it("formats a notice naming both models on the fell-back path", () => {
		const notice = formatModelFallbackNotice({
			action: "fell-back",
			from: "ccswitch-anthropic-k3/kimi-k3",
			to: "anthropic/claude-opus-4-6",
		});

		assert.ok(notice, "fell-back results must produce a user-facing notice");
		assert.match(notice, /ccswitch-anthropic-k3\/kimi-k3/);
		assert.match(notice, /anthropic\/claude-opus-4-6/);
	});

	it("formats no notice for preserved, initial-setup, or no-fallback results", () => {
		assert.equal(
			formatModelFallbackNotice({ action: "preserved", from: null, to: null }),
			null,
		);
		// Nothing was configured before — writing a default is setup, not a downgrade.
		assert.equal(
			formatModelFallbackNotice({ action: "fell-back", from: null, to: "anthropic/claude-opus-4-6" }),
			null,
		);
		// No fallback available — settings were not rewritten, nothing to announce.
		assert.equal(
			formatModelFallbackNotice({ action: "fell-back", from: "anthropic/claude-opus-4-6", to: null }),
			null,
		);
	});
});
