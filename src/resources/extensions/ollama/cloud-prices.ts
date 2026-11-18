// gsd-pi — Ollama Cloud model pricing ($ per million tokens)
/**
 * Price table for ollama models routed to the cloud by the local daemon.
 *
 * Cloud-routed models appear on the daemon under names with a trailing
 * ":cloud" or "-cloud" marker — both forms exist in practice
 * ("glm-5.3-flash:cloud", "gpt-oss:120b-cloud"). Ollama's own Cloud Usage
 * API reports these models under the marker-stripped name
 * (https://docs.ollama.com/api/cloud-usage), which is the key used here.
 *
 * Resolution is exact-ID with explicit aliases, never family-prefix
 * inference: pricing siblings differ by up to ~10x (glm-5.3 vs
 * glm-5.3-flash), so a prefix match would silently misbill. Unknown cloud
 * models resolve to undefined and the caller reports $0 with a debug log
 * rather than an invented rate.
 *
 * Source of truth: https://ollama.com/pricing (snapshot below, verified
 * 2026-11-04; on-peak input/output columns). models.dev is a cross-check
 * only — it lags ollama.com (mistral-large-4) and carries off-peak rates
 * for the deepseek models. On-peak rates are registered by decision: the
 * reported cost reads high, never low. Cached-input rates are documented
 * per-comment but not modeled — the native /api/chat reports no cached
 * token counts, so there is nothing to apply them to.
 *
 * Refresh: manual, same policy as KNOWN_MODELS in model-capabilities.ts.
 */

export interface CloudModelCost {
	input: number;
	output: number;
}

/** Official ollama.com/pricing snapshot (on-peak $/M tokens). */
export const CLOUD_MODEL_PRICES: Record<string, CloudModelCost> = {
	// Off-peak $0.66/$1.98 (outside 12:00–18:00 UTC weekdays, weekends)
	"deepseek-v4-pro": { input: 1.32, output: 3.96 },
	// Off-peak $0.15/$0.60; cached input $0.006
	"deepseek-v4.1-flash": { input: 0.3, output: 1.2 },
	// Cached input $0.05
	gemma4: { input: 0.14, output: 0.4 },
	// Cached input $0.26
	"glm-5.2": { input: 1.4, output: 4.4 },
	// Cached input $0.26
	"glm-5.3": { input: 1.4, output: 4.4 },
	// Cached input $0.03
	"glm-5.3-flash": { input: 0.15, output: 0.5 },
	// Cached input $0.014
	"gpt-oss:120b": { input: 0.15, output: 0.6 },
	// Cached input $0.035
	"gpt-oss:20b": { input: 0.07, output: 0.3 },
	"kimi-k2.6": { input: 0.95, output: 4 },
	"kimi-k2.7-code": { input: 0.95, output: 4 },
	"kimi-k3": { input: 3, output: 15 },
	"kimi-k3.1-pro": { input: 2, output: 10 },
	// Cached input $0.0028
	"mimo-v2.6-flash": { input: 0.14, output: 0.28 },
	// Cached input $0.0036
	"mimo-v2.6-pro": { input: 0.435, output: 0.87 },
	// Cached input $0.015
	"minimax-m3.1-flash": { input: 0.15, output: 0.6 },
	// Cached input $0.12
	"minimax-m3": { input: 0.6, output: 2.4 },
	// Cached input $0.06
	"minimax-m2.7": { input: 0.3, output: 1.2 },
	// Cached input $0.07
	"mistral-large-4": { input: 0.7, output: 2.1 },
	"mistral-large-3": { input: 0.5, output: 1.5 },
	// Cached input $0.15
	"muse-spark-open": { input: 1.25, output: 4.25 },
	"nemotron-3-nano": { input: 0.06, output: 0.24 },
	"nemotron-3-super": { input: 0.015, output: 0.6 },
	"nemotron-3-ultra": { input: 0.1, output: 3 },
};

/**
 * Size-tagged and dated daemon variants priced identically to their base
 * model on ollama.com. Hand-curated — never inferred by prefix (inference
 * is the glm-5.3 → glm-5.3-flash misbilling trap).
 */
export const CLOUD_MODEL_ALIASES: Record<string, string> = {
	"gemma4:31b": "gemma4",
	"mistral-large-3:675b": "mistral-large-3",
	"nemotron-3-nano:30b": "nemotron-3-nano",
	"deepseek-v4.1-flash:1017": "deepseek-v4.1-flash",
};

/**
 * Date the ollama.com/pricing snapshot was taken (ISO yyyy-mm-dd). Surfaced
 * through a staleness warning so a rotting table announces itself instead
 * of silently mispricing.
 */
export const CLOUD_PRICES_SNAPSHOT_DATE = "2026-11-04";

/** Age at which the snapshot warns that its rates may have drifted. */
export const STALE_PRICE_SNAPSHOT_DAYS = 90;

/** Whole days between the snapshot date and `now`. */
export function priceSnapshotAgeDays(now: Date = new Date()): number {
	const snapshot = new Date(`${CLOUD_PRICES_SNAPSHOT_DATE}T00:00:00Z`);
	return Math.floor((now.getTime() - snapshot.getTime()) / 86_400_000);
}

/**
 * Staleness warning for a snapshot older than STALE_PRICE_SNAPSHOT_DAYS,
 * or undefined while fresh. Pure/deterministic for tests.
 */
export function stalePriceSnapshotMessage(now: Date = new Date()): string | undefined {
	const age = priceSnapshotAgeDays(now);
	if (age < STALE_PRICE_SNAPSHOT_DAYS) return undefined;
	return (
		`[ollama] cloud price snapshot from ${CLOUD_PRICES_SNAPSHOT_DATE} is ${age} days old — ` +
		`rates may have drifted; verify and refresh from https://ollama.com/pricing`
	);
}

/**
 * Strip the cloud marker from a daemon model name; undefined when the
 * model is not cloud-routed (local inference).
 *
 * Real daemon cloud names are always "name:tag-cloud" or "name:cloud" —
 * ollama's Cloud Usage API reports them under the stripped name. A bare
 * "-cloud" suffix without a colon is a local model name ("my-model-cloud")
 * and must not be classified as cloud-routed.
 *
 * Known limit, undetectable by name: a local copy made with
 * `ollama cp` into a colliding tag (e.g. renaming a small model to
 * "gpt-oss:120b-cloud") would be priced at the cloud rates. Ollama offers
 * no API signal to distinguish such a tag from the real cloud entry.
 */
export function cloudModelKey(name: string): string | undefined {
	if (name === ":cloud" || name === "-cloud") return undefined;
	if (name.endsWith(":cloud")) return name.slice(0, -":cloud".length);
	if (name.endsWith("-cloud") && name.includes(":")) return name.slice(0, -"-cloud".length);
	return undefined;
}

/**
 * Resolve per-million-token rates for a daemon model name, or undefined
 * when the model is local or has no price entry.
 */
export function resolveCloudModelCost(name: string): CloudModelCost | undefined {
	const key = cloudModelKey(name);
	if (key === undefined) return undefined;
	const aliasTarget = CLOUD_MODEL_ALIASES[key];
	return CLOUD_MODEL_PRICES[key] ?? (aliasTarget !== undefined ? CLOUD_MODEL_PRICES[aliasTarget] : undefined);
}
