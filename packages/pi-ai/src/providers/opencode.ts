import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.js";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.js";
import { openAICompletionsApi } from "../api/openai-completions.lazy.js";
import { openAIResponsesApi } from "../api/openai-responses.lazy.js";
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { createProvider, type Provider } from "../models.js";
import { OPENCODE_CLASSIFIER_MODELS, OPENCODE_MODELS } from "./opencode.models.js";
import { withOpenCodeSessionHeader } from "./opencode-headers.js";

type OpenCodeApi = "anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses";

export function opencodeProvider(): Provider<OpenCodeApi> {
	return createProvider<OpenCodeApi>({
		id: "opencode",
		name: "OpenCode Zen",
		auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
		models: [...Object.values(OPENCODE_MODELS), ...Object.values(OPENCODE_CLASSIFIER_MODELS)],
		api: {
			"anthropic-messages": withOpenCodeSessionHeader(anthropicMessagesApi()),
			"google-generative-ai": withOpenCodeSessionHeader(googleGenerativeAIApi()),
			"openai-completions": withOpenCodeSessionHeader(openAICompletionsApi()),
			"openai-responses": withOpenCodeSessionHeader(openAIResponsesApi()),
		},
		// OpenCode Zen serves TypeSafe's System One protocol at /inference/systemone/v1/systemone.
		classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
	});
}
