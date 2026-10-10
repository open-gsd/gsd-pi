/**
 * Readiness checks for the Google local CLI providers.
 *
 * A Google CLI provider is ready when its binary resolves on PATH
 * (`where` on Windows, `which` elsewhere). The provider `isReady()` hook runs
 * once per model per availability check, so the lookup is cached and only
 * ever refreshed by an asynchronous child process (see
 * ../shared/cli-readiness.ts): a stale cache returns the last known answer
 * and re-probes in the background; a cold cache returns `false` and is
 * primed at extension load. Code that must not act on a cold or stale
 * answer awaits the settle variants.
 */

import { createReadinessCache, READINESS_CHECK_INTERVAL_MS, runCliProbe } from "../shared/cli-readiness.js";

const RESOLVE_TIMEOUT_MS = 5_000;

async function isCommandInPath(command: string): Promise<boolean> {
	const resolver = process.platform === "win32" ? "where" : "which";
	try {
		await runCliProbe(resolver, [command], RESOLVE_TIMEOUT_MS);
		return true;
	} catch {
		return false;
	}
}

export interface CommandReadiness {
	/** Cached answer; false while the cache is cold. Never blocks. */
	isReady(): boolean;
	/** Answer from a lookup no older than the cache window. */
	settle(): Promise<boolean>;
	/** Start the first lookup in the background. */
	prime(): void;
	clear(): void;
}

/**
 * Cached PATH lookup for one command. `resolve` is injectable so tests can
 * count lookups without spawning.
 */
export function createCommandReadiness(
	command: string,
	resolve: (command: string) => Promise<boolean> = isCommandInPath,
	intervalMs: number = READINESS_CHECK_INTERVAL_MS,
): CommandReadiness {
	const cache = createReadinessCache<boolean>({ probe: () => resolve(command), intervalMs });
	return {
		isReady: () => cache.peek() ?? false,
		settle: () => cache.settle(),
		prime: () => {
			cache.peek();
		},
		clear: () => cache.clear(),
	};
}

const geminiReadiness = createCommandReadiness("gemini");
const antigravityReadiness = createCommandReadiness("agy");

export function isGeminiCliReady(): boolean {
	return geminiReadiness.isReady();
}

export function isAntigravityCliReady(): boolean {
	return antigravityReadiness.isReady();
}

export function settleGeminiCliReadiness(): Promise<boolean> {
	return geminiReadiness.settle();
}

export function settleAntigravityCliReadiness(): Promise<boolean> {
	return antigravityReadiness.settle();
}

/** Start both PATH lookups in the background. Called at extension load. */
export function primeGoogleCliReadiness(): void {
	geminiReadiness.prime();
	antigravityReadiness.prime();
}

export function clearGoogleCliReadinessCache(): void {
	geminiReadiness.clear();
	antigravityReadiness.clear();
}
