// gsd-pi — ModelRegistry.settleProviderReadiness(): async companion to isReady().
//
// External-CLI providers answer `isReady()` from a cache that an asynchronous
// probe fills in, so a cold cache reports "not ready". Startup acts on that
// answer and persists the result (default-model validation, provider
// migrations), so it must wait for the probe first — otherwise a user's saved
// claude-code default would be rewritten on every launch.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "../../packages/pi-coding-agent/src/core/model-registry.ts";
import { validateConfiguredModel } from "../startup-model-validation.ts";

function createAuthStorage(): any {
	return {
		setFallbackResolver: () => {},
		onCredentialChange: () => {},
		getOAuthProviders: () => [],
		get: () => undefined,
		hasAuth: () => false,
		getApiKey: async () => undefined,
	};
}

/** Stand-in for an external-CLI provider: cached answer plus an async probe. */
function makeCachedCliProvider(probeAnswer: boolean) {
	let cached: boolean | null = null;
	let settles = 0;
	return {
		isReady: () => cached ?? false,
		settleReadiness: async () => {
			settles += 1;
			await new Promise<void>((resolve) => setImmediate(resolve));
			cached = probeAnswer;
			return cached;
		},
		settleCount: () => settles,
	};
}

function registerCliProvider(
	registry: ModelRegistry,
	name: string,
	hooks: { isReady: () => boolean; settleReadiness?: () => Promise<unknown> },
): void {
	registry.registerProvider(name, {
		authMode: "externalCli",
		api: "anthropic-messages",
		baseUrl: `local://${name}`,
		isReady: hooks.isReady,
		settleReadiness: hooks.settleReadiness,
		models: [{
			id: `${name}-model`,
			name: `${name} model`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		}],
	});
}

function createSettings(provider: string, model: string) {
	const state = { provider, model, thinking: "off" as const };
	return {
		state,
		getDefaultProvider: () => state.provider,
		getDefaultModel: () => state.model,
		getDefaultThinkingLevel: () => state.thinking,
		setDefaultModelAndProvider: (nextProvider: string, nextModel: string) => {
			state.provider = nextProvider;
			state.model = nextModel;
		},
		setDefaultThinkingLevel: () => {},
	};
}

describe("ModelRegistry.settleProviderReadiness", () => {
	function createRegistry(t: { after: (fn: () => void) => void }): ModelRegistry {
		const dir = mkdtempSync(join(tmpdir(), "gsd-settle-readiness-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		return new ModelRegistry(createAuthStorage(), join(dir, "models.json"));
	}

	test("a cold provider is not ready until its async probe has settled", async (t) => {
		const registry = createRegistry(t);
		const cli = makeCachedCliProvider(true);
		registerCliProvider(registry, "fake-cli", cli);

		assert.equal(registry.isProviderRequestReady("fake-cli"), false);
		assert.equal(registry.getAvailable().some((m) => m.provider === "fake-cli"), false);

		await registry.settleProviderReadiness();

		assert.equal(registry.isProviderRequestReady("fake-cli"), true);
		assert.equal(registry.getAvailable().some((m) => m.provider === "fake-cli"), true);
	});

	test("startup validation keeps a saved external-CLI default once readiness has settled", async (t) => {
		const registry = createRegistry(t);
		registerCliProvider(registry, "fake-cli", makeCachedCliProvider(true));
		registerCliProvider(registry, "always-ready", { isReady: () => true });

		// Acting on the cold cache would rewrite the user's saved default.
		const coldSettings = createSettings("fake-cli", "fake-cli-model");
		assert.equal(validateConfiguredModel(registry, coldSettings).action, "fell-back");
		assert.equal(coldSettings.state.provider, "always-ready");

		// Startup awaits the probe first, so the saved default survives.
		await registry.settleProviderReadiness();
		const settings = createSettings("fake-cli", "fake-cli-model");
		assert.equal(validateConfiguredModel(registry, settings).action, "preserved");
		assert.equal(settings.state.provider, "fake-cli");
		assert.equal(settings.state.model, "fake-cli-model");
	});

	test("settles only the named provider when one is given", async (t) => {
		const registry = createRegistry(t);
		const first = makeCachedCliProvider(true);
		const second = makeCachedCliProvider(true);
		registerCliProvider(registry, "first-cli", first);
		registerCliProvider(registry, "second-cli", second);

		await registry.settleProviderReadiness("second-cli");

		assert.equal(first.settleCount(), 0);
		assert.equal(second.settleCount(), 1);
		assert.equal(registry.isProviderRequestReady("first-cli"), false);
		assert.equal(registry.isProviderRequestReady("second-cli"), true);
	});

	test("skips disabled providers and tolerates a rejecting probe", async (t) => {
		const registry = createRegistry(t);
		const disabled = makeCachedCliProvider(true);
		const healthy = makeCachedCliProvider(true);
		registerCliProvider(registry, "disabled-cli", disabled);
		registerCliProvider(registry, "broken-cli", {
			isReady: () => false,
			settleReadiness: async () => {
				throw new Error("probe failed");
			},
		});
		registerCliProvider(registry, "healthy-cli", healthy);
		registry.setDisabledModelProviders(["disabled-cli"]);

		await registry.settleProviderReadiness();

		assert.equal(disabled.settleCount(), 0);
		assert.equal(registry.isProviderRequestReady("broken-cli"), false);
		assert.equal(registry.isProviderRequestReady("healthy-cli"), true);
	});
});
