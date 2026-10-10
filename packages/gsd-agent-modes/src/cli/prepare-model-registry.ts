/**
 * Shared setup for --list-models: load extensions and flush provider registrations.
 * GSD-specific probes (Ollama, preferences) are applied via optional afterLoad hook.
 */

import type { DefaultResourceLoader, ModelRegistry } from "@gsd/pi-coding-agent";

export interface PrepareModelRegistryOptions {
	agentDir: string;
	cwd?: string;
	additionalExtensionPaths?: string[];
	/** GSD root hooks: deferred provider probes, disabled-provider preferences, etc. */
	afterLoad?: (modelRegistry: ModelRegistry) => Promise<void>;
}

function flushPendingProviderRegistrations(
	resourceLoader: DefaultResourceLoader,
	modelRegistry: ModelRegistry,
): void {
	const { runtime } = resourceLoader.getExtensions();
	for (const { name, config } of runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config);
	}
	runtime.pendingProviderRegistrations = [];
}

/**
 * Prepare a ModelRegistry for listing: extension load and provider flush.
 */
export async function prepareModelRegistryForListing(
	modelRegistry: ModelRegistry,
	options: PrepareModelRegistryOptions,
): Promise<ModelRegistry> {
	const { DefaultResourceLoader } = await import("@gsd/pi-coding-agent");
	const loader = new DefaultResourceLoader({
		agentDir: options.agentDir,
		cwd: options.cwd ?? process.cwd(),
		additionalExtensionPaths: options.additionalExtensionPaths,
	});
	await loader.reload();
	flushPendingProviderRegistrations(loader, modelRegistry);
	if (options.afterLoad) {
		await options.afterLoad(modelRegistry);
	}
	// External-CLI providers report "not ready" until their first async
	// probe lands; wait for it so the listing reflects real readiness.
	await modelRegistry.settleProviderReadiness();
	return modelRegistry;
}
