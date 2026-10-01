/**
 * Claude models whose API rejects `thinking: {type: "disabled"}`, sampling
 * parameters (`temperature`, `top_p`, `top_k`) and forced `tool_choice`
 * (`any` / a named tool) with a 400.
 *
 * - Sonnet 5.5: the lowest thinking setting is `{type: "between_tools"}`
 *   (valid at effort `high` or below, no other `thinking` fields allowed).
 * - Opus 5.5: thinking cannot be turned off at any effort; omit `thinking`
 *   and lower the effort instead.
 *
 * Matches first-party, Vertex (`@date`), Bedrock (`us.anthropic.…-v1:0`),
 * gateway (`anthropic/…`) and dotted Copilot-style (`claude-sonnet-5.5`) ids.
 */
export type ClaudeThinkingOffMode = "between-tools" | "low-effort";

const SONNET_5_5 = /sonnet[-.]5[-.]5(?!\d)/i;
const OPUS_5_5 = /opus[-.]5[-.]5(?!\d)/i;

/** How to express "thinking off" for models that reject disabled thinking; undefined when `disabled` is accepted. */
export function getClaudeThinkingOffMode(modelId: string): ClaudeThinkingOffMode | undefined {
	if (SONNET_5_5.test(modelId)) return "between-tools";
	if (OPUS_5_5.test(modelId)) return "low-effort";
	return undefined;
}

/** True when the model rejects `temperature` / `top_p` / `top_k`. */
export function rejectsClaudeSamplingParams(modelId: string): boolean {
	return getClaudeThinkingOffMode(modelId) !== undefined;
}

/** True when the model rejects forced `tool_choice` (`any` / a named tool). */
export function rejectsClaudeForcedToolChoice(modelId: string): boolean {
	return getClaudeThinkingOffMode(modelId) !== undefined;
}
