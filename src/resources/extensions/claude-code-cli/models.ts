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
	compat?: { forceAdaptiveThinking?: boolean; strictRequestParams?: boolean; thinkingOffMode?: "between_tools" | "omit" };
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
		// Thinking cannot be disabled; strict request surface (#2500).
		compat: { forceAdaptiveThinking: true, strictRequestParams: true, thinkingOffMode: "omit" },
	},
	{
		id: "claude-fable-5",
		name: "Claude Fable 5 (via Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		// Thinking cannot be disabled (#2500); forced tool choice is still accepted.
		compat: { forceAdaptiveThinking: true, thinkingOffMode: "omit" },
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
];

// Durable first-party release ids only: dated snapshot aliases
// (claude-opus-4-5-20251101) are excluded — the local CLI resolves aliases
// itself and GSD should surface one entry per release line.
const CATALOG_MODEL_PATTERN = /^claude-(opus|sonnet|fable|haiku)-\d+(-\d{1,2})?$/;

function loadAnthropicCatalogModels(): ClaudeCodeModelDefinition[] {
	return getModels("anthropic") as unknown as ClaudeCodeModelDefinition[];
}

/**
 * Merge the pi-ai anthropic catalog into the hardcoded Claude Code list
 * (#2437). CLAUDE_CODE_MODELS win conflicts so the curated list stays
 * authoritative, and the curated order is preserved so "first model"
 * fallback selection does not drift with catalog updates. Catalog-only
 * entries (e.g. a Claude release newer than this build) are appended with
 * zero cost plus their compat/thinkingLevelMap metadata.
 */
export function buildClaudeCodeModelList(
	catalogModels: readonly ClaudeCodeModelDefinition[] = loadAnthropicCatalogModels(),
): ClaudeCodeModelDefinition[] {
	const merged = new Map<string, ClaudeCodeModelDefinition>();
	for (const model of CLAUDE_CODE_MODELS) {
		merged.set(model.id, model);
	}
	for (const entry of catalogModels) {
		if (!CATALOG_MODEL_PATTERN.test(entry.id) || merged.has(entry.id)) continue;
		merged.set(entry.id, {
			id: entry.id,
			name: `${entry.name} (via Claude Code)`,
			reasoning: entry.reasoning,
			input: entry.input.filter((part): part is "text" | "image" => part === "text" || part === "image"),
			cost: ZERO_COST,
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxTokens,
			...(entry.compat ? { compat: entry.compat } : {}),
			...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
		});
	}
	return [...merged.values()];
}
