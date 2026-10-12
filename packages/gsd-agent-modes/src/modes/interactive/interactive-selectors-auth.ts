// Project/App: gsd-pi
// File Purpose: Extracted from interactive-selectors-session.ts (Phase E2 seam remediation).
// @ts-nocheck

import type { OAuthProviderId } from "@gsd/pi-ai";
import { getApiKeyEnvVars } from "@gsd/pi-ai";
import { getAuthPath } from "@gsd/pi-coding-agent/config.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "@gsd/pi-coding-agent/core/provider-display-names.js";
import { LoginDialogComponent } from "./components/login-dialog.js";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "./components/oauth-selector.js";
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";

const BLOCKED_BROWSER_OAUTH_PROVIDERS = new Set(["anthropic"]);

function isBrowserOAuthProviderAllowed(providerId: string): boolean {
	return !BLOCKED_BROWSER_OAUTH_PROVIDERS.has(providerId);
}

function uniqueProviders(providers: AuthSelectorProvider[]): AuthSelectorProvider[] {
	const seen = new Set<string>();
	const unique: AuthSelectorProvider[] = [];
	for (const provider of providers) {
		if (seen.has(provider.id)) continue;
		seen.add(provider.id);
		unique.push(provider);
	}
	return unique;
}

function formatAuthStatus(status: { source?: string; label?: string } | undefined): string | undefined {
	if (!status?.source) return undefined;
	if (status.source === "stored") return "✓ configured";
	if (status.source === "environment" && status.label) return `✓ env: ${status.label}`;
	if (status.source === "runtime" && status.label) return `✓ ${status.label}`;
	if (status.source === "models_json_command") return "✓ command in models.json";
	if (status.source === "models_json_key") return "✓ key in models.json";
	if (status.source === "fallback") return "✓ configured";
	return undefined;
}

function formatEnvHint(envVars: readonly string[] | undefined): string {
	if (!envVars || envVars.length === 0) return "";
	return ` (or set ${envVars.join(" / ")})`;
}

function apiKeyCredentialLabel(providerId: string): string {
	if (providerId === "huggingface") return "user access token";
	return "API key";
}

function apiKeyPlaceholder(providerId: string): string | undefined {
	if (providerId === "huggingface") return "hf_...";
	return undefined;
}

export function buildApiKeyLoginPrompt(providerId: string, providerName: string): {
	message: string;
	placeholder?: string;
} {
	const credentialLabel = apiKeyCredentialLabel(providerId);
	const envHint = formatEnvHint(getApiKeyEnvVars(providerId));
	return {
		message: `Paste your ${providerName} ${credentialLabel}${envHint}:`,
		placeholder: apiKeyPlaceholder(providerId),
	};
}

function getApiKeyProviderDisplayName(host: InteractiveModeDelegateHost, providerId: string): string {
	return BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId] ?? host.session.modelRegistry.getProviderDisplayName(providerId);
}

export function buildLoginProviderOptions(host: InteractiveModeDelegateHost): AuthSelectorProvider[] {
	const modelRegistry = host.session.modelRegistry;
	const allOAuthProviders = modelRegistry.authStorage.getOAuthProviders();
	const oauthProviders = allOAuthProviders.filter((provider) => isBrowserOAuthProviderAllowed(provider.id));
	const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
	const apiKeyOnlyOAuthProviderIds = new Set(
		allOAuthProviders.filter((provider) => !isBrowserOAuthProviderAllowed(provider.id)).map((provider) => provider.id),
	);
	const modelProviderIds = Array.from(new Set(modelRegistry.getAll().map((model) => model.provider))).sort();

	const externalCliProviders = modelProviderIds
		.filter((providerId) => modelRegistry.getProviderAuthMode(providerId) === "externalCli")
		.map((providerId) => ({
			id: providerId,
			name: modelRegistry.getProviderDisplayName(providerId),
			authType: "external_cli" as const,
			statusLabel: modelRegistry.isProviderRequestReady(providerId) ? "✓ ready" : undefined,
		}));

	const apiKeyProviders = modelProviderIds
		.filter(
			(providerId) =>
				modelRegistry.getProviderAuthMode(providerId) === "apiKey" || apiKeyOnlyOAuthProviderIds.has(providerId),
		)
		.filter((providerId) => !oauthProviderIds.has(providerId))
		.map((providerId) => ({
			id: providerId,
			name: getApiKeyProviderDisplayName(host, providerId),
			authType: "api_key" as const,
			statusLabel: formatAuthStatus(modelRegistry.getProviderAuthStatus(providerId)),
		}));

	const browserOAuthProviders = oauthProviders.map((provider) => ({
		...provider,
		authType: "oauth" as const,
		statusLabel: formatAuthStatus(modelRegistry.getProviderAuthStatus(provider.id)),
	}));

	return uniqueProviders([
		...externalCliProviders,
		...apiKeyProviders,
		...browserOAuthProviders,
	]);
}

export async function showOAuthSelector(host: InteractiveModeDelegateHost, mode: "login" | "logout"): Promise<void> {
	const loginProviders = mode === "login" ? buildLoginProviderOptions(host) : undefined;

	if (mode === "logout") {
		const providers = host.session.modelRegistry.authStorage.list();
		const loggedInProviders = providers.filter(
			(p) => host.session.modelRegistry.authStorage.get(p)?.type === "oauth",
		);
		if (loggedInProviders.length === 0) {
			host.showStatus("No OAuth providers logged in. Use /login first.");
			return;
		}
	}

	host.showSelector((done) => {
		const selector = new OAuthSelectorComponent(
			mode,
			host.session.modelRegistry.authStorage,
			(providerId: string) => {
				done();

				const handleAsync = async () => {
					if (mode === "login") {
						await handleLoginProviderSelection(host, providerId);
					} else {
						const providerInfo = host.session.modelRegistry.authStorage
							.getOAuthProviders()
							.find((p) => p.id === providerId);
						const providerName = providerInfo?.name || providerId;

						try {
							host.session.modelRegistry.authStorage.logout(providerId);
							host.session.modelRegistry.refresh();
							await host.updateAvailableProviderCount();

							const currentModel = host.session.model;
							if (currentModel?.provider === providerId) {
								try {
									const available = host.session.modelRegistry.getAvailable();
									const fallback = available.find((m) => m.provider !== providerId);
									if (fallback) {
										await host.session.setModel(fallback);
									}
								} catch {
									// Model switch failed — user can manually switch via /model
								}
							}

							host.showStatus(`Logged out of ${providerName}`);
						} catch (error: unknown) {
							host.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				};
				handleAsync().catch(() => {
					// Swallow — showLoginDialog already handles its own errors.
				});
			},
			() => {
				done();
				host.ui.requestRender();
			},
			loginProviders,
		);
		return { component: selector, focus: selector };
	});
}

export async function handleLoginProviderSelection(host: InteractiveModeDelegateHost, providerId: string): Promise<void> {
	const modelRegistry = host.session.modelRegistry;
	const authMode = modelRegistry.getProviderAuthMode(providerId);

	if (authMode === "externalCli") {
		await activateExternalCliProvider(host, providerId);
		return;
	}

	const oauthProvider = modelRegistry.authStorage.getOAuthProviders().find((provider) => provider.id === providerId);
	if (oauthProvider && isBrowserOAuthProviderAllowed(providerId)) {
		await host.showLoginDialog(providerId);
		return;
	}

	await showApiKeyLoginDialog(host, providerId);
}

async function activateExternalCliProvider(host: InteractiveModeDelegateHost, providerId: string): Promise<void> {
	const modelRegistry = host.session.modelRegistry;
	const providerName = modelRegistry.getProviderDisplayName(providerId);

	// The user typically arrives here right after running the CLI's own login,
	// so the cached answer may predate it. Re-probe (asynchronously) first.
	await modelRegistry.settleProviderReadiness(providerId);
	if (!modelRegistry.isProviderRequestReady(providerId)) {
		host.showError(`${providerName} is not ready. Run the provider's own login command, then try /login again.`);
		return;
	}

	modelRegistry.authStorage.set(providerId, { type: "api_key", key: "cli" });
	modelRegistry.refresh();
	await host.updateAvailableProviderCount();

	const targetModel = modelRegistry.getAvailable().find((model) => model.provider === providerId);
	if (targetModel) {
		await host.session.setModel(targetModel);
		host.showStatus(`Using ${providerName}: ${providerId}/${targetModel.id}`);
	} else {
		host.showStatus(`${providerName} is ready. Use /model to choose a model.`);
	}
}

async function showApiKeyLoginDialog(host: InteractiveModeDelegateHost, providerId: string): Promise<void> {
	const providerName = host.session.modelRegistry.getProviderDisplayName(providerId);
	const dialog = new LoginDialogComponent(host.ui, providerId, (_success, _message) => {}, providerName);

	host.editorContainer.clear();
	host.editorContainer.addChild(dialog);
	host.ui.setFocus(dialog);
	host.ui.requestRender();

	const restoreEditor = () => {
		dialog.dispose();
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.ui.setFocus(host.editor);
		host.ui.requestRender();
	};

	try {
		const prompt = buildApiKeyLoginPrompt(providerId, providerName);
		const apiKey = (await dialog.showPrompt(prompt.message, prompt.placeholder)).trim();
		if (!apiKey) {
			throw new Error("API key is required");
		}

		host.session.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });
		restoreEditor();
		host.session.modelRegistry.refresh();
		await host.updateAvailableProviderCount();

		const targetModel = host.session.modelRegistry.getAvailable().find((model) => model.provider === providerId);
		if (targetModel) {
			await host.session.setModel(targetModel);
		}

		host.showStatus(`Saved ${providerName} API key to ${getAuthPath()}`);
	} catch (error: unknown) {
		restoreEditor();
		const errorMsg = error instanceof Error ? error.message : String(error);
		if (errorMsg !== "Login cancelled" && !errorMsg.includes("Superseded") && !errorMsg.includes("disposed")) {
			host.showError(`Failed to save ${providerName} API key: ${errorMsg}`);
		}
	}
}

export async function showLoginDialog(host: InteractiveModeDelegateHost, providerId: string): Promise<void> {
	if (!isBrowserOAuthProviderAllowed(providerId)) {
		await showApiKeyLoginDialog(host, providerId);
		return;
	}

	const providerInfo = host.session.modelRegistry.authStorage.getOAuthProviders().find((p) => p.id === providerId);
	const providerName = providerInfo?.name || providerId;
	const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

	const dialog = new LoginDialogComponent(host.ui, providerId, (_success, _message) => {});

	host.editorContainer.clear();
	host.editorContainer.addChild(dialog);
	host.ui.setFocus(dialog);
	host.ui.requestRender();

	const restoreEditor = () => {
		dialog.dispose();
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.ui.setFocus(host.editor);
		host.ui.requestRender();
	};

	try {
		await host.session.modelRegistry.authStorage.login(providerId as OAuthProviderId, {
			onAuth: (info: { url: string; instructions?: string }) => {
				dialog.showAuth(info.url, info.instructions);

				if (!usesCallbackServer && providerId === "github-copilot") {
					dialog.showWaiting("Waiting for browser authentication...");
				}
			},

			onPrompt: async (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => {
				return dialog.showPrompt(prompt.message, prompt.placeholder, { allowEmpty: prompt.allowEmpty });
			},

			onProgress: (message: string) => {
				dialog.showProgress(message);
			},

			onManualCodeInput: usesCallbackServer
				? () => dialog.showManualInput("Paste redirect URL below, or complete login in browser:")
				: undefined,

			onDeviceCode: (info) => {
				dialog.showDeviceCode(info);
				dialog.showWaiting("Waiting for browser authentication...");
			},
			onSelect: async (prompt) => prompt.options[0]?.id,

			signal: dialog.signal,
		});

		restoreEditor();
		host.session.modelRegistry.refresh();
		await host.updateAvailableProviderCount();

		try {
			const currentModel = host.session.model;
			if (currentModel) {
				const currentKey = await host.session.modelRegistry.getApiKey(currentModel);
				if (!currentKey) {
					const available = host.session.modelRegistry.getAvailable();
					const newProviderModel = available.find((m) => m.provider === providerId);
					if (newProviderModel) {
						await host.session.setModel(newProviderModel);
					} else if (available.length > 0) {
						await host.session.setModel(available[0]);
					}
				}
			}
		} catch {
			// Model switch failed — user can manually switch via /model
		}

		host.showStatus(`Logged in to ${providerName}. Credentials saved to ${getAuthPath()}`);
	} catch (error: unknown) {
		restoreEditor();
		const errorMsg = error instanceof Error ? error.message : String(error);
		if (errorMsg !== "Login cancelled" && !errorMsg.includes("Superseded") && !errorMsg.includes("disposed")) {
			host.showError(`Failed to login to ${providerName}: ${errorMsg}`);
		}
	}
}
