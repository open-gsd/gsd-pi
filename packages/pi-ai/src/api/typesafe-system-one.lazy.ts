import type { ProviderClassifier } from "../types.js";

export const typesafeSystemOneApi = (): ProviderClassifier => ({
	classify: async (model, context, options) =>
		(await import("./typesafe-system-one.js")).classify(model, context, options),
});
