// Core only, side-effect free: no generated catalogs, no provider factories,
// no api-registry, no OAuth implementations, no compat. Provider factories
// live under "@gsd/pi-ai/providers/*", API implementations under
// "@gsd/pi-ai/api/*", the old global API under
// "@gsd/pi-ai/compat".
export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./api/anthropic-messages.js";
export type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.js";
export type { BedrockOptions, BedrockThinkingDisplay } from "./api/bedrock-converse-stream.js";
export type { GoogleOptions } from "./api/google-generative-ai.js";
export type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "./api/google-shared.js";
export type { GoogleVertexOptions } from "./api/google-vertex.js";
export * from "./api/lazy.js";
export type { MistralOptions } from "./api/mistral-conversations.js";
export type { OpenAICodexResponsesOptions, OpenAICodexWebSocketDebugStats } from "./api/openai-codex-responses.js";
export type { OpenAICompletionsOptions } from "./api/openai-completions.js";
export type { OpenAIResponsesOptions } from "./api/openai-responses.js";
export type { PiDecisionOptions, PiDecisionRequest, PiDecisionResponse } from "./api/pi-decision.js";
export type { PiMessagesEvent, PiMessagesOptions, PiMessagesRewriteImpact } from "./api/pi-messages.js";
export * from "./auth/context.js";
export * from "./auth/credential-store.js";
export * from "./auth/helpers.js";
export * from "./auth/types.js";
export * from "./cache-warming.js";
export type {
	OAuthAuthInfo,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
} from "./compat/extension-oauth-types.js";
export * from "./models.js";
export * from "./models-store.js";
export * from "./providers/faux.js";
export * from "./session-resources.js";
export * from "./types.js";
export * from "./utils/diagnostics.js";
export * from "./utils/event-stream.js";
export * from "./utils/identity.js";
export * from "./utils/json-parse.js";
export * from "./utils/overflow.js";
export * from "./utils/retry.js";
export * from "./utils/streaming-json.js";
export * from "./utils/string-enum.js";
export { contentText, getSystemMessageText, renderSystemMessageUpdate } from "./utils/text.js";
export * from "./utils/transcript.js";
export { uuidv7 } from "./utils/uuid.js";
export * from "./utils/validation.js";
export { PI_AI_VERSION } from "./utils/version.js";
export * from "./gsd-compat-types.js";
export {
	isEmptyPathToolArguments,
	normalizeToolArguments,
} from "./utils/normalize-tool-arguments.js";
export { normalizeToolResultContent } from "./tool-result-content.js";
export type { OAuthProviderInterface, OAuthProviderId } from "./oauth-gsd-compat.js";
export { getOAuthProvider, getOAuthProviders } from "./oauth-gsd-compat.js";
export { hasXmlParameterTags, hasYamlBulletLists, repairToolJson } from "./utils/repair-tool-json.js";
export {
	isAnthropicApi,
	isBedrockApi,
	isGeminiApi,
	isOpenAIApi,
} from "./providers/api-family.js";

// GSD host compatibility: re-export the most-used compat stream helpers from the
// package root so existing `@gsd/pi-ai` imports keep resolving after the v1.6.1 split.
export {
	completeSimple,
	resetApiProviders,
	streamSimple,
} from "./compat.js";
export * from "./host-compat.js";
