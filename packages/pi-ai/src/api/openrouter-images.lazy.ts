import type { ProviderImages } from "../types.js";

export const openrouterImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./openrouter-images.js")).generateImages(model, context, options),
});
