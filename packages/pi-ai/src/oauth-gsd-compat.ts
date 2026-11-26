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

/** GSD host compatibility: built-in OAuth providers are registered via ModelRuntime in v1.6.1. */
export function getOAuthProviders(): OAuthProviderInterface[] {
	return [];
}

export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return getOAuthProviders().find((provider) => provider.id === id);
}