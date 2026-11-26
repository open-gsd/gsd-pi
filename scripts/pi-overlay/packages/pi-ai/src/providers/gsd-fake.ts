/**
 * GSD e2e fake provider — registered only when GSD_FAKE_LLM_TRANSCRIPT is set.
 *
 * ModelRegistry.ensureFakeProviderIfEnabled() must:
 * 1. registerNativeProvider(install.provider) — so `--model gsd-fake-model` resolves
 * 2. registerApiProvider(install.streams) — so Agent's compat `streamSimple` finds api `"fake"`
 */

import type { ProviderAuth } from "../auth/types.js";
import { createProvider, type Provider } from "../models.js";
import { FAKE_MODEL, FAKE_PROVIDER } from "../models/fake-model.js";
import { createFakeProvider, type FakeApiProvider } from "./fake.js";

/** Ambient auth so ModelRuntime treats gsd-fake as request-ready without credentials. */
const fakeAuth: ProviderAuth = {
	apiKey: {
		name: "GSD Fake (e2e)",
		resolve: async () => ({ auth: {}, source: "GSD fake (e2e)" }),
	},
};

export interface GsdFakeInstall {
	provider: Provider;
	streams: FakeApiProvider;
}

/**
 * Build the gsd-fake provider + stream pair bound to the current transcript env,
 * or undefined when e2e mode is off. Caller registers both the Provider (ModelRuntime)
 * and the streams (compat api-registry) so catalog lookup and Agent streaming share
 * one transcript cursor.
 */
export function gsdFakeInstall(): GsdFakeInstall | undefined {
	const transcriptPath = process.env.GSD_FAKE_LLM_TRANSCRIPT;
	if (!transcriptPath) return undefined;

	const streams = createFakeProvider({ transcriptPath });
	const provider = createProvider({
		id: FAKE_PROVIDER,
		name: "GSD Fake (e2e replay)",
		baseUrl: FAKE_MODEL.baseUrl,
		auth: fakeAuth,
		models: [FAKE_MODEL],
		api: {
			stream: streams.stream,
			streamSimple: streams.streamSimple,
		},
	});

	return { provider, streams };
}

/** @deprecated Prefer {@link gsdFakeInstall}; kept for call sites that only need the Provider. */
export function gsdFakeProvider(): Provider | undefined {
	return gsdFakeInstall()?.provider;
}
