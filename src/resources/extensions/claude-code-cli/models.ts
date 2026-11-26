/**
 * Model definitions for the Claude Code CLI provider.
 *
 * Costs are zero because inference is covered by the user's Claude Code
 * subscription. The SDK's `result` message still provides token counts
 * for display in the TUI.
 *
 * Context windows and max tokens match the Anthropic API definitions
 * in models.generated.ts.
 *
 * The hardcoded list is merged with the pi-ai anthropic catalog at
 * registration time (#2437) so new Claude releases register without a code
 * change here; CLAUDE_CODE_MODELS stay authoritative on conflict.
 */

import { getModels } from "@gsd/pi-ai";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Structural model shape accepted by `registerProvider` for this provider. */
export interface ClaudeCodeModelDefinition {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: {
		forceAdaptiveThinking?: boolean;
		strictRequestParams?: boolean;
		thinkingOffMode?: "between_tools";
		rejectsTemperature?: boolean;
	};
}

export const CLAUDE_CODE_MODELS: ClaudeCodeModelDefinition[] = [
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6 (via Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7 (via Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8 (via Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5 (via Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5 (via Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		// Curated entries win the catalog merge (#2437), so the strict-surface
		// compat must be restated here or thinking-off would send
		// {type: "disabled"} and 400 (#2645).
		compat: { forceAdaptiveThinking: true, strictRequestParams: true },
	},
	{
		id: "claude-fable-5",
		name: "Claude Fable 5 (via Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		// Fable 5 rejects thinking {type:"disabled"} and temperature but still
		// accepts forced tool_choice (#2645) — granular flags, not the umbrella.
		compat: { forceAdaptiveThinking: true, thinkingOffMode: "between_tools", rejectsTemperature: true },
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5 (via Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (via Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5 (via Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-haiku-5-5",
		name: "Claude Haiku 5.5 (via Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		// Adaptive-thinking only (budget_tokens 400s) and rejects temperature;
		// still accepts thinking disabled + forced tool_choice, so no strict
		// umbrella (#2701). Curated entries win the catalog merge (#2437).
		compat: { forceAdaptiveThinking: true, rejectsTemperature: true },
	},
];

// Durable first-party release ids only: dated snapshot aliases
// (claude-opus-4-5-20251101) are excluded — the local CLI resolves aliases
// itself and GSD should surface one entry per release line.
const CATALOG_MODEL_PATTERN = /^claude-(opus|sonnet|fable|haiku)-\d+(-\d{1,2})?$/;

function isClaude55StrictRequestModel(modelId: string): boolean {
	return (
		modelId.includes("sonnet-5-5")
		|| modelId.includes("sonnet-5.5")
		|| modelId.includes("opus-5-5")
		|| modelId.includes("opus-5.5")
		|| modelId.includes("fable-5-1")
		|| modelId.includes("fable-5.1")
	);
}

function isFable5BaseModel(modelId: string): boolean {
	return (
		(modelId.includes("fable-5") || modelId.includes("fable.5"))
		&& !modelId.includes("fable-5-1")
		&& !modelId.includes("fable-5.1")
	);
}

/**
 * v1.6.1 pi-ai catalogs expose granular Anthropic compat flags; the Claude Code
 * stream adapter still keys off the legacy strictRequestParams umbrella (#2437).
 */
function normalizeCatalogCompat(
	compat: ClaudeCodeModelDefinition["compat"] | undefined,
	modelId: string,
): ClaudeCodeModelDefinition["compat"] | undefined {
	if (!compat && !isClaude55StrictRequestModel(modelId)) return undefined;
	const normalized = { ...(compat ?? {}) };
	if (
		normalized.strictRequestParams !== true
		&& !isFable5BaseModel(modelId)
		&& isClaude55StrictRequestModel(modelId)
	) {
		normalized.strictRequestParams = true;
	}
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

const CLAUDE_CODE_COMPAT_KEYS = new Set([
	"forceAdaptiveThinking",
	"strictRequestParams",
	"thinkingOffMode",
	"rejectsTemperature",
]);

function toClaudeCodeCompat(
	compat: ClaudeCodeModelDefinition["compat"] | undefined,
	modelId: string,
): ClaudeCodeModelDefinition["compat"] | undefined {
	const normalized = normalizeCatalogCompat(compat, modelId);
	if (!normalized) return undefined;
	const out: NonNullable<ClaudeCodeModelDefinition["compat"]> = {};
	for (const [key, value] of Object.entries(normalized)) {
		if (CLAUDE_CODE_COMPAT_KEYS.has(key)) {
			(out as Record<string, unknown>)[key] = value;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Inherit effort maps that matter to Claude Code: aliases and explicit xhigh tiers. */
function catalogThinkingLevelOverrides(
	map: Record<string, string | null>,
): Record<string, string | null> {
	const out: Record<string, string | null> = {};
	for (const [level, mapped] of Object.entries(map)) {
		if (mapped === null) continue;
		if (mapped !== level || level === "xhigh") {
			out[level] = mapped;
		}
	}
	return out;
}

function loadAnthropicCatalogModels(): ClaudeCodeModelDefinition[] {
	return getModels("anthropic") as unknown as ClaudeCodeModelDefinition[];
}

/**
 * Merge the pi-ai anthropic catalog into the hardcoded Claude Code list
 * (#2437). CLAUDE_CODE_MODELS win conflicts so the curated list stays
 * authoritative, and the curated order is preserved so "first model"
 * fallback selection does not drift with catalog updates. Catalog thinking
 * metadata is additive: a curated entry inherits the catalog entry's compat
 * flags and thinkingLevelMap keys it does not set itself (#2830), with
 * curated keys winning where both specify. Catalog-only entries (e.g. a
 * Claude release newer than this build) are appended with zero cost plus
 * their compat/thinkingLevelMap metadata.
 */
export function buildClaudeCodeModelList(
	catalogModels: readonly ClaudeCodeModelDefinition[] = loadAnthropicCatalogModels(),
): ClaudeCodeModelDefinition[] {
	const merged = new Map<string, ClaudeCodeModelDefinition>();
	for (const model of CLAUDE_CODE_MODELS) {
		merged.set(model.id, model);
	}
	for (const entry of catalogModels) {
		if (!CATALOG_MODEL_PATTERN.test(entry.id)) continue;
		const curated = merged.get(entry.id);
		if (curated) {
			const catalogMap = entry.thinkingLevelMap
				? catalogThinkingLevelOverrides(entry.thinkingLevelMap)
				: {};
			const thinkingLevelMap = {
				...catalogMap,
				...(curated.thinkingLevelMap ?? {}),
			};
			merged.set(entry.id, {
				...curated,
				compat: toClaudeCodeCompat(
					{ ...entry.compat, ...curated.compat },
					entry.id,
				),
				...(Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
			});
			continue;
		}
		merged.set(entry.id, {
			id: entry.id,
			name: `${entry.name} (via Claude Code)`,
			reasoning: entry.reasoning,
			input: entry.input.filter((part): part is "text" | "image" => part === "text" || part === "image"),
			cost: ZERO_COST,
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxTokens,
			...(entry.compat || isClaude55StrictRequestModel(entry.id)
				? { compat: toClaudeCodeCompat(entry.compat, entry.id) }
				: {}),
			...(entry.thinkingLevelMap
				? { thinkingLevelMap: catalogThinkingLevelOverrides(entry.thinkingLevelMap) }
				: {}),
		});
	}
	return [...merged.values()];
}
