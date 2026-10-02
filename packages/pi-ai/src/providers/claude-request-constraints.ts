/**
 * Request-surface constraints of current Claude models, keyed by model id for
 * providers that carry no Anthropic compat metadata (Bedrock Converse,
 * OpenAI-compatible gateways such as GitHub Copilot and OpenRouter). The
 * Anthropic Messages path reads the same rules from catalog compat
 * (`strictRequestParams` / `thinkingOffMode`), authored by the generator from
 * this module.
 *
 * - Sonnet 5.5: `thinking: {type: "disabled"}` 400s; `{type: "between_tools"}`
 *   is its off switch.
 * - Opus 5.5, Fable 5, Fable 5.1: thinking cannot be disabled; omit `thinking`
 *   (adaptive) and lower the effort instead.
 * - All of them reject sampling params (`temperature`, `top_p`, `top_k`).
 * - All but Fable 5 also reject forced `tool_choice` (`any` / a named tool).
 *
 * Matches first-party, Vertex (`@date`), Bedrock (`us.anthropic.…`), gateway
 * (`anthropic/…`, `:batch`, `-fast`) and dotted (`claude-opus-5.5`) ids.
 */
export type ClaudeThinkingOffMode = "between_tools" | "omit";

export interface ClaudeRequestConstraints {
	/** Model rejects sampling params and forced tool choice. */
	strictRequestParams: boolean;
	/** How to express "thinking off". `"omit"` means thinking is always on, so sampling params are rejected too. */
	thinkingOffMode: ClaudeThinkingOffMode;
}

const SONNET_5_5 = /sonnet[-.]5[-.]5(?!\d)/i;
const OPUS_5_5 = /opus[-.]5[-.]5(?!\d)/i;
const FABLE_5_1 = /fable[-.]5[-.]1(?!\d)/i;
const FABLE_5 = /fable[-.]5(?!\d)(?![-.]\d(?!\d))/i; // not fable-5-1 / fable-5.1, but fable-5-20260101

export function getClaudeRequestConstraints(modelId: string | undefined): ClaudeRequestConstraints | undefined {
	if (!modelId) return undefined;
	if (SONNET_5_5.test(modelId)) return { strictRequestParams: true, thinkingOffMode: "between_tools" };
	if (OPUS_5_5.test(modelId) || FABLE_5_1.test(modelId)) return { strictRequestParams: true, thinkingOffMode: "omit" };
	if (FABLE_5.test(modelId)) return { strictRequestParams: false, thinkingOffMode: "omit" };
	return undefined;
}

/** True when the model rejects `temperature` / `top_p` / `top_k`. */
export function rejectsSamplingParams(constraints: ClaudeRequestConstraints | undefined): boolean {
	return constraints?.strictRequestParams === true || constraints?.thinkingOffMode === "omit";
}
