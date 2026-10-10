/**
 * Provider readiness policy extracted from ModelRegistry.
 */

import { getOAuthProviders } from "@gsd/pi-ai/oauth";
import type { AuthStorage } from "./auth-storage.js";

export type ProviderAuthMode = "apiKey" | "oauth" | "none" | "externalCli";

export interface ProviderReadinessConfig {
	/**
	 * Synchronous readiness answer. Called once per model from UI code, so it
	 * must not block: providers that probe an external CLI answer from a cache
	 * and refresh it in the background.
	 */
	isReady?: () => boolean;
	/**
	 * Optional async companion to `isReady()` for providers whose answer comes
	 * from a background probe. Resolves once `isReady()` reflects a probe no
	 * older than the provider's cache window.
	 */
	settleReadiness?: () => Promise<unknown>;
	oauth?: unknown;
	apiKey?: string;
	authMode?: ProviderAuthMode;
}

export interface ProviderReadinessDeps {
	authStorage: AuthStorage;
	registeredProviders: Map<string, ProviderReadinessConfig>;
	providerRequestConfigs: Map<string, { apiKey?: string }>;
	disabledModelProviders: Set<string>;
}

export function getProviderAuthMode(deps: ProviderReadinessDeps, provider: string): ProviderAuthMode {
	if (provider === "gsd-fake") return "none";
	const config = deps.registeredProviders.get(provider);
	if (config) {
		if (config.authMode) return config.authMode;
		if (config.oauth) return "oauth";
		if (config.apiKey) return "apiKey";
		return "apiKey";
	}
	// Built-in OAuth providers (openai-codex, github-copilot, …) are not
	// registered via registerProvider(), but still authenticate via OAuth.
	if (getOAuthProviders().some((oauthProvider) => oauthProvider.id === provider)) {
		return "oauth";
	}
	return "apiKey";
}

export function setDisabledModelProviders(deps: ProviderReadinessDeps, providers: string[]): void {
	deps.disabledModelProviders.clear();
	for (const provider of providers) {
		const normalized = provider.trim().toLowerCase();
		if (normalized.length > 0) {
			deps.disabledModelProviders.add(normalized);
		}
	}
}

export function getDisabledModelProviders(deps: ProviderReadinessDeps): string[] {
	return Array.from(deps.disabledModelProviders);
}

/**
 * Wait until the cached `isReady()` answers are current — for one provider, or
 * for every registered provider when `provider` is omitted. Never blocks the
 * event loop. Use before acting on readiness in a way that is hard to undo
 * (persisted default-model rewrites, activating a provider, dispatching a
 * unit); plain listings can keep using the cached answer.
 */
export async function settleProviderReadiness(deps: ProviderReadinessDeps, provider?: string): Promise<void> {
	const pending: Promise<unknown>[] = [];
	for (const [name, config] of deps.registeredProviders) {
		if (provider !== undefined && name !== provider) continue;
		if (!config.settleReadiness) continue;
		if (deps.disabledModelProviders.has(name.trim().toLowerCase())) continue;
		try {
			pending.push(config.settleReadiness());
		} catch {
			// A provider whose probe cannot start keeps its cached answer.
		}
	}
	await Promise.allSettled(pending);
}

export function isProviderRequestReady(deps: ProviderReadinessDeps, provider: string): boolean {
	if (deps.disabledModelProviders.has(provider.trim().toLowerCase())) return false;
	const config = deps.registeredProviders.get(provider);
	if (config?.isReady) return config.isReady();
	const authMode = getProviderAuthMode(deps, provider);
	if (authMode === "externalCli" || authMode === "none") return true;
	return deps.authStorage.hasAuth(provider) || deps.providerRequestConfigs.has(provider);
}
