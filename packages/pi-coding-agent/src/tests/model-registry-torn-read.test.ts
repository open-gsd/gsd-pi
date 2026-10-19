// @gsd/pi-coding-agent + model-registry-torn-read.test — regression coverage for
// #2077: models.json is read without a lock, so a read racing a concurrent
// rewrite can fail to parse and would silently wipe the custom-model registry
// (arming the startup model fallback). A persistent read failure must retain
// the last successfully parsed models AND their request configuration
// (provider auth/headers + per-model headers), with the error still visible
// via getError(). Deleting the file is an intentional removal and must clear
// the retained state.
//
// Lives under src/tests so the compile-tests node:test runner (and CI) picks
// it up — the packages/pi-coding-agent vitest suite is not part of CI.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@gsd/pi-ai";
import { AuthStorage } from "../core/auth-storage.js";
import { ModelRegistry } from "../core/model-registry.js";

function makeTempDir(t: TestContext): string {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-test-models-torn-read-"));
	t.after(() => rmSync(tempDir, { recursive: true, force: true }));
	return tempDir;
}

function modelsJsonPath(tempDir: string): string {
	return join(tempDir, "models.json");
}

function validModelsJson(modelId: string): string {
	return JSON.stringify({
		providers: {
			"custom-proxy": {
				baseUrl: "https://proxy.example.com/v1",
				apiKey: "TEST_KEY",
				api: "anthropic-messages",
				headers: { "X-Provider": "provider-level" },
				models: [
					{
						id: modelId,
						name: modelId,
						reasoning: false,
						input: ["text"],
						cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
						contextWindow: 100000,
						maxTokens: 8000,
						headers: { "X-Model": "model-level" },
					},
				],
			},
		},
	});
}

async function requestHeadersFor(registry: ModelRegistry, model: Model<Api>): Promise<Record<string, string>> {
	const auth = await registry.getApiKeyAndHeaders(model);
	assert.ok(auth.ok, `request auth should resolve for ${model.provider}/${model.id}`);
	assert.ok(auth.headers, "request headers should be present");
	return auth.headers!;
}

test("model-registry torn read: refresh keeps custom models, headers, and surfaces the error (#2077)", async (t) => {
	const tempDir = makeTempDir(t);
	const path = modelsJsonPath(tempDir);
	writeFileSync(path, validModelsJson("claude-custom"), "utf-8");

	const registry = ModelRegistry.create(AuthStorage.create(join(tempDir, "auth.json")), path);
	const model = registry.find("custom-proxy", "claude-custom");
	assert.ok(model, "custom model should load from models.json");
	const before = await requestHeadersFor(registry, model);
	assert.equal(before["X-Provider"], "provider-level");
	assert.equal(before["X-Model"], "model-level");

	// Simulate a read racing a concurrent rewrite: truncated JSON on disk.
	writeFileSync(path, '{"providers": {"custom-proxy": {"base', "utf-8");
	registry.refresh();

	// The registry must not be wiped by the transient read — the last
	// successfully parsed custom models keep serving, with their request
	// configuration intact, and the failure stays visible via getError().
	const retained = registry.find("custom-proxy", "claude-custom");
	assert.ok(retained, "retained custom model must survive a torn read");
	const after = await requestHeadersFor(registry, retained);
	assert.equal(after["X-Provider"], "provider-level", "provider-level headers must be retained");
	assert.equal(after["X-Model"], "model-level", "per-model headers must be retained");
	assert.match(registry.getError() ?? "", /models\.json/);

	// A subsequent good read heals the registry and clears the error.
	writeFileSync(path, validModelsJson("claude-custom-2"), "utf-8");
	registry.refresh();

	assert.ok(!registry.find("custom-proxy", "claude-custom"), "old custom model should be replaced");
	assert.ok(registry.find("custom-proxy", "claude-custom-2"), "new custom model should load");
	assert.equal(registry.getError(), undefined);
});

test("model-registry torn read: first load with a torn file reports the error without custom models (#2077)", (t) => {
	const tempDir = makeTempDir(t);
	const path = modelsJsonPath(tempDir);
	// No prior successful load exists, so there is nothing to retain —
	// built-ins serve and the error is surfaced.
	writeFileSync(path, '{"providers": {"custom-proxy": {"base', "utf-8");

	const registry = ModelRegistry.create(AuthStorage.create(join(tempDir, "auth.json")), path);

	assert.ok(!registry.find("custom-proxy", "claude-custom"), "no custom model from a torn file");
	assert.match(registry.getError() ?? "", /models\.json/);
});

test("model-registry torn read: deleting models.json is an intentional removal and clears retained state (#2077)", (t) => {
	const tempDir = makeTempDir(t);
	const path = modelsJsonPath(tempDir);
	writeFileSync(path, validModelsJson("claude-custom"), "utf-8");

	const registry = ModelRegistry.create(AuthStorage.create(join(tempDir, "auth.json")), path);
	assert.ok(registry.find("custom-proxy", "claude-custom"));

	// Removal is deliberate — the retained state must not resurrect the models.
	rmSync(path);
	registry.refresh();

	assert.ok(!registry.find("custom-proxy", "claude-custom"), "removed models must not come back");
	assert.equal(registry.getError(), undefined);
	assert.ok(!existsSync(path));
});
