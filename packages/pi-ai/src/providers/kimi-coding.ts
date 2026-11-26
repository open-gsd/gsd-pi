import { openAICompletionsApi } from "../api/openai-completions.lazy.js";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.js";
import { loadKimiCodingOAuth } from "../auth/oauth/load.js";
import { createProvider, type Provider } from "../models.js";
import { KIMI_CODING_MODELS } from "./kimi-coding.models.js";

export function kimiCodingProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "kimi-coding",
		name: "Kimi For Coding",
		baseUrl: "https://api.kimi.com/coding/v1",
		auth: {
			apiKey: envApiKeyAuth("Kimi API key", ["KIMI_API_KEY"]),
			oauth: lazyOAuth({
				name: "Kimi Code (subscription)",
				isSubscription: true,
				loginLabel: "Sign in with Kimi Code",
				load: loadKimiCodingOAuth,
			}),
		},
		models: Object.values(KIMI_CODING_MODELS),
		api: openAICompletionsApi(),
	});
}
