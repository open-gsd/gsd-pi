import { openAICompletionsApi } from "../api/openai-completions.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { createProvider, type Provider } from "../models.js";
import { BASETEN_MODELS } from "./baseten.models.js";

export function basetenProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "baseten",
		name: "Baseten",
		baseUrl: "https://inference.baseten.co/v1",
		auth: { apiKey: envApiKeyAuth("Baseten API key", ["BASETEN_API_KEY"]) },
		models: Object.values(BASETEN_MODELS),
		api: openAICompletionsApi(),
	});
}
