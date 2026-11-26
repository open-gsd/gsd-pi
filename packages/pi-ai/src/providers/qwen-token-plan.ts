import { openAICompletionsApi } from "../api/openai-completions.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { createProvider, type Provider } from "../models.js";
import { QWEN_TOKEN_PLAN_MODELS } from "./qwen-token-plan.models.js";

export function qwenTokenPlanProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen-token-plan",
		name: "Qwen Token Plan Team",
		baseUrl: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1",
		auth: {
			apiKey: envApiKeyAuth("Qwen Token Plan Team API key", [
				"QWEN_TOKEN_PLAN_TEAM_API_KEY",
				"QWEN_TOKEN_PLAN_API_KEY",
			]),
		},
		models: Object.values(QWEN_TOKEN_PLAN_MODELS),
		api: openAICompletionsApi(),
	});
}
