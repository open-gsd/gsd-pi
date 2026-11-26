import type { ProviderClassifier } from "../types.js";

export const llamaCppClassifyApi = (): ProviderClassifier => ({
	classify: async (model, context, options) =>
		(await import("./llama-cpp-classify.js")).classify(model, context, options),
});
