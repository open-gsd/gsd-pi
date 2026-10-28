import { FAKE_MODEL, FAKE_MODEL_ID, FAKE_PROVIDER } from "./models/fake-model.js";
import { MODELS } from "./models.generated.js";
import type { Api, Model, ModelThinkingLevel, Usage } from "./types.js";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

// E2E-test-only: register the fake model when GSD_FAKE_LLM_TRANSCRIPT is set.
if (process.env.GSD_FAKE_LLM_TRANSCRIPT) {
	const providerModels = new Map<string, Model<Api>>();
	providerModels.set(FAKE_MODEL_ID, FAKE_MODEL as Model<Api>);
	modelRegistry.set(FAKE_PROVIDER, providerModels);
}

/** Providers present in the generated catalog (may be a subset of KnownProvider). */
export type GeneratedProvider = keyof typeof MODELS;

type ModelApi<
	TProvider extends GeneratedProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends GeneratedProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): GeneratedProvider[] {
	return Array.from(modelRegistry.keys()) as GeneratedProvider[];
}

export function getModels<TProvider extends GeneratedProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	const cost = getCostRates(model.cost, usage.input);
	usage.cost.input = (cost.input / 1000000) * usage.input;
	usage.cost.output = (cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isCopilotCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
	return model.provider === "github-copilot" && model.api === "openai-completions";
}

function getCostRates(cost: Model<Api>["cost"], inputTokens: number) {
	const tier = cost.tiers
		?.filter((candidate) => inputTokens > candidate.inputTokensAbove)
		.sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0];

	return {
		input: tier?.input ?? cost.input,
		output: tier?.output ?? cost.output,
		cacheRead: tier?.cacheRead ?? cost.cacheRead,
		cacheWrite: tier?.cacheWrite ?? cost.cacheWrite,
	};
}

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	if (
		isCopilotCompletionsModel(model)
		&& model.compat?.supportsReasoningEffort === false
	) {
		return model.thinkingLevelMap?.off === null ? [] : ["off"];
	}

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** GSD compat: whether the model supports xhigh thinking level. */
export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
	return getSupportedThinkingLevels(model).includes("xhigh");
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
