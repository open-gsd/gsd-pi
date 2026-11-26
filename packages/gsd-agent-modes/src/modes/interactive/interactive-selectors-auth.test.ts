import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AuthStorage } from "@gsd/pi-coding-agent/core/auth-storage.js";
import { ModelRegistry } from "@gsd/pi-coding-agent/core/model-registry.js";
import { buildApiKeyLoginPrompt, buildLoginProviderOptions } from "./interactive-selectors-auth.js";

describe("buildApiKeyLoginPrompt", () => {
	test("uses Hugging Face token wording and HF_TOKEN hint", () => {
		const prompt = buildApiKeyLoginPrompt("huggingface", "Hugging Face");

		assert.equal(prompt.message, "Paste your Hugging Face user access token (or set HF_TOKEN):");
		assert.equal(prompt.placeholder, "hf_...");
	});

	test("uses known environment variable hints for API-key providers", () => {
		const prompt = buildApiKeyLoginPrompt("openrouter", "OpenRouter");

		assert.equal(prompt.message, "Paste your OpenRouter API key (or set OPENROUTER_API_KEY):");
		assert.equal(prompt.placeholder, undefined);
	});

	test("falls back cleanly for custom API-key providers", () => {
		const prompt = buildApiKeyLoginPrompt("local-proxy", "Local Proxy");

		assert.equal(prompt.message, "Paste your Local Proxy API key:");
		assert.equal(prompt.placeholder, undefined);
	});

	test("uses plain Anthropic naming when browser OAuth is blocked into API-key login", async () => {
		const modelRegistry = await ModelRegistry.inMemory(AuthStorage.inMemory());
		const host = { session: { modelRegistry } };
		const providers = buildLoginProviderOptions(host as never);
		const anthropic = providers.find((provider) => provider.id === "anthropic");

		assert.equal(anthropic?.authType, "api_key");
		assert.equal(anthropic?.name, "Anthropic");
	});
});
