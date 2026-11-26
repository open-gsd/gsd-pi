/**
 * GSD host compatibility surface for the v1.6.1 pin.
 */

export type { ApiKeyCredential, Credential as AuthCredential, OAuthCredential } from "./auth/types.js";
export { getEnvApiKey } from "./env-api-keys.js";
export { getProviderCapabilities, type ProviderCapabilities } from "./providers/provider-capabilities.js";
export type { Models, Provider } from "./models.js";
export { getModel, getModels, getProviders } from "./compat.js";
export {
	streamOpenAICodexResponses,
	streamOpenAIResponses,
	streamSimpleAnthropic,
	streamSimpleOpenAICompletions,
	streamSimpleOpenAIResponses,
} from "./legacy-api-aliases.js";
export { clampThinkingLevel, getSupportedThinkingLevels } from "./models.js";
export { convertTools } from "./api/google-shared.js";
export {
	isModelsCatalog,
	isModelsCatalogOverlay,
	type ModelsCatalog,
	type ModelsCatalogOverlay,
} from "./gsd-models-catalog.js";
export {
	ALWAYS_PRESERVED_SHIM_TOOL_NAMES,
	createToolSearchShimResult,
	parseToolSearchSelectQuery,
} from "./utils/tool-shims.js";
export { parseMcpToolName, stripMcpToolPrefix } from "./utils/mcp-tool-name.js";
export { sanitizeSchemaForMoonshot } from "./utils/moonshot-tool-schema.js";
export {
	type ProviderSwitchReport,
	setProviderSwitchObserver,
} from "./providers/transform-messages.js";
export { getGitHubCopilotBaseUrl } from "./auth/oauth/github-copilot.js";
export {
	isAnthropicApi,
	isBedrockApi,
	isGeminiApi,
	isOpenAIApi,
} from "./providers/api-family.js";
export { hasXmlParameterTags, hasYamlBulletLists, repairToolJson } from "./utils/repair-tool-json.js";

// TypeBox re-export historically available from @gsd/pi-ai
export type { Static, TSchema } from "typebox";
export { Type } from "typebox";

/** Inference metrics block historically attached to AssistantMessage. */
export interface InferenceMetrics {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	[key: string]: unknown;
}
