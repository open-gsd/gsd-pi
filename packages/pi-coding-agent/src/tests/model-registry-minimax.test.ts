import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@gsd/pi-ai";
import { AuthStorage } from "../core/auth-storage.js";
import { ModelRegistry } from "../core/model-registry.js";
import { defaultModelPerProvider, resolveModelScope } from "../core/model-resolver.js";

function setup(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "pi-test-minimax-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const auth = AuthStorage.create(join(dir, "auth.json"));
	for (const provider of ["minimax", "minimax-cn", "openrouter", "anthropic"]) auth.setRuntimeApiKey(provider, "test-key");
	return { dir, auth, registry: () => ModelRegistry.create(auth, join(dir, "models.json")) };
}

test("MiniMax ordinary defaults and choices are Flash then M3; saved IDs remain resolvable", async (t) => {
	const { registry: create } = setup(t);
	const registry = create();
	for (const provider of ["minimax", "minimax-cn"]) {
		assert.equal(defaultModelPerProvider[provider], "MiniMax-M3.1-Flash");
		assert.deepEqual(registry.getAvailable().filter((model) => model.provider === provider).map((model) => model.id), ["MiniMax-M3.1-Flash", "MiniMax-M3"]);
		assert.equal(registry.find(provider, "MiniMax-M2.7")?.id, "MiniMax-M2.7");
		const scoped = await resolveModelScope([`${provider}/MiniMax-M2.7`], registry);
		assert.equal(scoped[0]?.model.id, "MiniMax-M2.7");
		const explicitThinking = await resolveModelScope([`${provider}/MiniMax-M2.7:high`], registry);
		assert.equal(explicitThinking[0]?.model.id, "MiniMax-M2.7");
		const ordinary = await resolveModelScope([`${provider}/*`], registry);
		assert.deepEqual(ordinary.filter((entry) => entry.model.provider === provider).map((entry) => entry.model.id), ["MiniMax-M3.1-Flash", "MiniMax-M3"]);
		assert.ok(ordinary.every((entry) => /minimax-m3(?:$|\.1-flash)/i.test(entry.model.id)));
	}
});

test("dynamic catalog legacy entries are lookup-only while custom legacy entries stay selectable", (t) => {
	const { dir, registry: create } = setup(t);
	const legacy = getModel("openrouter", "minimax/minimax-m2.7");
	writeFileSync(join(dir, "models-catalog.json"), JSON.stringify({
		version: 1, fetchedAt: "2026-10-20T00:00:00Z", source: "https://example.test/catalog.json",
		models: { openrouter: { "minimax/legacy-from-feed": { ...legacy, id: "minimax/legacy-from-feed" } } },
	}));
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {
		minimax: { models: [{ id: "MiniMax-M2.7", name: "My saved legacy override" }] },
		openrouter: { models: [{ id: "minimax/minimax-m2.7", name: "My gateway override" }] },
	} }));
	const registry = create();
	assert.equal(registry.getError(), undefined);
	assert.ok(registry.find("openrouter", "minimax/legacy-from-feed"));
	assert.ok(!registry.getAvailable().some((model) => model.id === "minimax/legacy-from-feed"));
	assert.ok(registry.getAvailable().some((model) => model.name === "My saved legacy override"));
	assert.ok(registry.getAvailable().some((model) => model.name === "My gateway override"));
	assert.ok(registry.getAvailable().some((model) => model.provider === "anthropic"));
});

test("extension-provided legacy models retain their custom provenance", (t) => {
	const { registry: create } = setup(t);
	const registry = create();
	registry.registerProvider("minimax", {
		baseUrl: "https://custom.example.test/anthropic", apiKey: "test-key", api: "anthropic-messages",
		models: [{ id: "MiniMax-M2.7", name: "Extension legacy", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
	});
	assert.ok(registry.getAvailable().some((model) => model.name === "Extension legacy"));
});
