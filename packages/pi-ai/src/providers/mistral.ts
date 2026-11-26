import { mistralConversationsApi } from "../api/mistral-conversations.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { createProvider, type Provider } from "../models.js";
import { MISTRAL_MODELS } from "./mistral.models.js";

export function mistralProvider(): Provider<"mistral-conversations"> {
	return createProvider({
		id: "mistral",
		name: "Mistral",
		baseUrl: "https://api.mistral.ai",
		auth: { apiKey: envApiKeyAuth("Mistral API key", ["MISTRAL_API_KEY"]) },
		models: Object.values(MISTRAL_MODELS),
		api: mistralConversationsApi(),
	});
}
