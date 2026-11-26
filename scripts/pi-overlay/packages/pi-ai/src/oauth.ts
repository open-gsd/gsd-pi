/** Type-only compatibility entry point for coding-agent extension OAuth declarations. */
export type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
} from "./compat/extension-oauth-types.js";
export type { OAuthProviderInterface, OAuthProviderId } from "./oauth-gsd-compat.js";
export { getOAuthProviders } from "./oauth-gsd-compat.js";

export { getGitHubCopilotBaseUrl } from "./auth/oauth/github-copilot.js";
