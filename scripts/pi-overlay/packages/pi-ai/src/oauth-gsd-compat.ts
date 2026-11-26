import type { OAuthCredentials } from "./auth/types.js";
import { anthropicOAuth } from "./auth/oauth/anthropic.js";

export type OAuthProviderId = string;

export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;
	readonly usesCallbackServer?: boolean;
	login(callbacks: unknown): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
}

/**
 * Built-in OAuth providers surfaced to AuthStorage / login selectors.
 *
 * Browser OAuth for Anthropic is blocked in GSD interactive login and falls
 * back to API-key login with plain "Anthropic" naming; the registry still
 * needs the OAuth entry so blocked-provider detection works.
 */
const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
	{
		id: "anthropic",
		name: anthropicOAuth.name,
		usesCallbackServer: true,
		login: (callbacks) => anthropicOAuth.login(callbacks as never),
		refreshToken: (credentials, signal) =>
			anthropicOAuth.refresh(credentials as never, signal ?? AbortSignal.timeout(60_000)),
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
