import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.js";
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { createProvider, type Provider } from "../models.js";
import { VERCEL_AI_GATEWAY_CLASSIFIER_MODELS, VERCEL_AI_GATEWAY_MODELS } from "./vercel-ai-gateway.models.js";

export function vercelAIGatewayProvider(): Provider<"anthropic-messages"> {
	return createProvider<"anthropic-messages">({
		id: "vercel-ai-gateway",
		name: "Vercel AI Gateway",
		baseUrl: "https://ai-gateway.vercel.sh",
		auth: { apiKey: envApiKeyAuth("Vercel AI Gateway API key", ["AI_GATEWAY_API_KEY"]) },
		models: [...Object.values(VERCEL_AI_GATEWAY_MODELS), ...Object.values(VERCEL_AI_GATEWAY_CLASSIFIER_MODELS)],
		api: anthropicMessagesApi(),
		// AI Gateway serves TypeSafe's System One protocol at /typesafe/v1/systemone.
		classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
	});
}
