import type { ProviderClassifier } from "../types.js";

export const piDecisionApi = (): ProviderClassifier => ({
	classify: async (model, context, options) => (await import("./pi-decision.js")).classify(model, context, options),
});
