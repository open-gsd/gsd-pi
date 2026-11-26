import type { ProviderClassifier } from "../types.js";

export const cloudflareWorkersAISystemOneApi = (): ProviderClassifier => ({
	classify: async (model, context, options) =>
		(await import("./cloudflare-workers-ai-system-one.js")).classify(model, context, options),
});
