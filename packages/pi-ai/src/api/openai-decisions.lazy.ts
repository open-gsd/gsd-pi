import type { ProviderClassifier } from "../types.js";

export const openAIDecisionsApi = (): ProviderClassifier => ({
	classify: async (model, context, options) =>
		(await import("./openai-decisions.js")).classify(model, context, options),
});
