// Pure decision for the openai-codex minimal->low thinking mapping.
// Kept free of side effects so tests can call the real function instead of
// reading generator source. Used by generate-models.ts.

/** GPT-5.x and GPT-6 ids that carry an xhigh-capable ladder. */
export function supportsOpenAiXhigh(modelId: string): boolean {
	return (
		modelId.includes("gpt-5.2") ||
		modelId.includes("gpt-5.3") ||
		modelId.includes("gpt-5.4") ||
		modelId.includes("gpt-5.5") ||
		modelId.includes("gpt-5.6") ||
		modelId.includes("gpt-6")
	);
}

/**
 * True when the openai-codex minimal->low mapping applies. GPT-6 ids are
 * excluded: the Copilot-scoped rule owns GPT-6 for the general xhigh path, and
 * openai-codex must not receive a GPT-6 mapping the rest of the generator scopes
 * to github-copilot.
 */
export function appliesCodexMinimalLow(provider: string, modelId: string): boolean {
	return provider === "openai-codex" && supportsOpenAiXhigh(modelId) && !modelId.includes("gpt-6");
}
