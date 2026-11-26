import { openAIResponsesApi } from "../api/openai-responses.lazy.js";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.js";
import { loadMetaOAuth } from "../auth/oauth/load.js";
import { createProvider, type Provider } from "../models.js";
import { META_MODELS } from "./meta.models.js";

export function metaProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "meta",
		name: "Meta",
		baseUrl: "https://api.meta.ai/v1",
		auth: {
			apiKey: envApiKeyAuth("Meta Model API key", ["META_API_KEY"]),
			oauth: lazyOAuth({
				name: "Meta (Muse subscription)",
				isSubscription: true,
				loginLabel: "Sign in with Meta",
				load: loadMetaOAuth,
			}),
		},
		models: Object.values(META_MODELS),
		api: openAIResponsesApi(),
	});
}
