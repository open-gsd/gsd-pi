import type { OAuthCredentials } from "./auth/types.js";

export type OAuthProviderId = string;

export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;
	readonly usesCallbackServer?: boolean;
	login(callbacks: unknown): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
}

function unsupportedLogin(providerId: string): never {
	throw new Error(`OAuth login for "${providerId}" is handled through ModelRuntime in pi v1.6.1`);
}

function unsupportedRefresh(providerId: string): never {
	throw new Error(`OAuth refresh for "${providerId}" is handled through ModelRuntime in pi v1.6.1`);
}

/**
 * Built-in OAuth providers for AuthStorage / onboarding / login selectors.
 *
 * Keep this list descriptor-only (no Node OAuth flow imports) so browser and
 * Next bundles can read provider availability without pulling callback servers.
 * Interactive OAuth login itself goes through ModelRuntime.
 */
const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
	{
		id: "anthropic",
		name: "Anthropic (Claude Pro/Max)",
		usesCallbackServer: true,
		login: async () => unsupportedLogin("anthropic"),
		refreshToken: async () => unsupportedRefresh("anthropic"),
		getApiKey: (credentials) => credentials.access,
	},
	{
		id: "github-copilot",
		name: "GitHub Copilot",
		login: async () => unsupportedLogin("github-copilot"),
		refreshToken: async () => unsupportedRefresh("github-copilot"),
		getApiKey: (credentials) => credentials.access,
	},
	{
		id: "openai-codex",
		name: "OpenAI (ChatGPT Plus/Pro)",
		usesCallbackServer: true,
		login: async () => unsupportedLogin("openai-codex"),
		refreshToken: async () => unsupportedRefresh("openai-codex"),
		getApiKey: (credentials) => credentials.access,
	},
	{
		id: "xai",
		name: "xAI (Grok/X subscription)",
		usesCallbackServer: true,
		login: async () => unsupportedLogin("xai"),
		refreshToken: async () => unsupportedRefresh("xai"),
		getApiKey: (credentials) => credentials.access,
	},
	{
		id: "kimi-coding",
		name: "Kimi Code (subscription)",
		login: async () => unsupportedLogin("kimi-coding"),
		refreshToken: async () => unsupportedRefresh("kimi-coding"),
		getApiKey: (credentials) => credentials.access,
	},
];

const oauthProviderRegistry = new Map<string, OAuthProviderInterface>(
	BUILT_IN_OAUTH_PROVIDERS.map((provider) => [provider.id, provider]),
);

export function getOAuthProviders(): OAuthProviderInterface[] {
	return Array.from(oauthProviderRegistry.values());
}

export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return oauthProviderRegistry.get(id);
}

export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	oauthProviderRegistry.set(provider.id, provider);
}

export function unregisterOAuthProvider(id: string): void {
	const builtIn = BUILT_IN_OAUTH_PROVIDERS.find((provider) => provider.id === id);
	if (builtIn) {
		oauthProviderRegistry.set(id, builtIn);
		return;
	}
	oauthProviderRegistry.delete(id);
}
