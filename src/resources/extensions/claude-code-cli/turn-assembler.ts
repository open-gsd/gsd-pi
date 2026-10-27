// gsd-pi - Claude Code logical turn assembly

import type {
	AssistantMessage,
	AssistantMessageEvent,
	ToolCall,
} from "@gsd/pi-ai";
import { PartialMessageBuilder } from "./partial-builder.js";
import type {
	BetaRawMessageStreamEvent,
	SDKUserMessage,
} from "./sdk-types.js";

/** A single content block returned by an external (SDK-executed) tool call. */
export interface ExternalToolResultContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/** The full result payload returned by an external tool, including content blocks and error status. */
export interface ExternalToolResultPayload {
	content: ExternalToolResultContentBlock[];
	details?: Record<string, unknown>;
	isError: boolean;
}

/** A `ToolCall` block augmented with the external result attached by the SDK synthetic user message. */
export type ToolCallWithExternalResult = ToolCall & {
	externalResult?: ExternalToolResultPayload;
};

/** Normalise heterogeneous SDK tool-result content (string, array, or object) into a uniform `ExternalToolResultContentBlock[]`. */
function normalizeToolResultContent(content: unknown): ExternalToolResultContentBlock[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}

	if (!Array.isArray(content)) {
		if (content == null) return [{ type: "text", text: "" }];
		return [{ type: "text", text: JSON.stringify(content) }];
	}

	const blocks: ExternalToolResultContentBlock[] = [];

	for (const item of content) {
		if (typeof item === "string") {
			blocks.push({ type: "text", text: item });
			continue;
		}
		if (!item || typeof item !== "object") {
			blocks.push({ type: "text", text: String(item) });
			continue;
		}

		const block = item as Record<string, unknown>;
		if (block.type === "text") {
			blocks.push({ type: "text", text: typeof block.text === "string" ? block.text : "" });
			continue;
		}
		if (
			block.type === "image"
			&& typeof block.data === "string"
			&& typeof block.mimeType === "string"
		) {
			blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
			continue;
		}
		// Anthropic image block (e.g. Claude Code's `Read` on an image file):
		// `{type: "image", source: {type: "base64", media_type, data}}`. Without
		// this conversion the base64 payload falls through to `JSON.stringify`
		// below and is stored as text, re-entering every prompt until the
		// request exceeds the context limit (#3027). Only `base64` sources are
		// convertible to the pi shape; anything else keeps the fallback.
		const source = block.source;
		if (
			block.type === "image"
			&& !!source && typeof source === "object" && !Array.isArray(source)
			&& (source as Record<string, unknown>).type === "base64"
			&& typeof (source as Record<string, unknown>).data === "string"
			&& typeof (source as Record<string, unknown>).media_type === "string"
		) {
			const base64Source = source as Record<string, string>;
			blocks.push({ type: "image", data: base64Source.data, mimeType: base64Source.media_type });
			continue;
		}

		blocks.push({ type: "text", text: JSON.stringify(block) });
	}

	return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

/**
 * Extract a `details` payload from an MCP tool-result block.
 *
 * MCP's `CallToolResult` carries structured data in `structuredContent` — the
 * protocol's supported channel for non-text payloads. Claude Code's synthetic
 * user message may surface that field in one of two shapes depending on SDK
 * version: as a sibling on the `mcp_tool_result` block itself, or as a
 * dedicated content sub-block with `type: "structuredContent"`. Snake-case
 * (`structured_content`) is accepted defensively in case a transport hop
 * rewrites casing. All other shapes return undefined, matching the nullable
 * `details` contract consumed by tool result renderers.
 */
function extractStructuredDetailsFromBlock(block: Record<string, unknown>): Record<string, unknown> | undefined {
	const sibling = block.structuredContent ?? (block as Record<string, unknown>).structured_content;
	if (sibling && typeof sibling === "object" && !Array.isArray(sibling)) {
		return sibling as Record<string, unknown>;
	}

	if (Array.isArray(block.content)) {
		for (const item of block.content) {
			if (!item || typeof item !== "object") continue;
			const sub = item as Record<string, unknown>;
			if (sub.type !== "structuredContent" && sub.type !== "structured_content") continue;
			const payload = sub.structuredContent ?? sub.structured_content ?? sub.data ?? sub.value;
			if (payload && typeof payload === "object" && !Array.isArray(payload)) {
				return payload as Record<string, unknown>;
			}
		}
	}

	// Return undefined (not {}) when no structured payload is present, matching
	// the pre-#4477 contract where `details` was nullable. An empty-object
	// sentinel is truthy and breaks downstream consumers that gate on
	// `if (details)`. `undefined` matches the type of the field these results
	// flow into (`Record<string, unknown> | undefined`).
	return undefined;
}

/**
 * True for items that are MCP `structuredContent` pseudo-blocks living inside
 * a tool-result `content[]` array. These blocks carry the structured payload
 * (extracted separately by `extractStructuredDetailsFromBlock`) and must NOT
 * leak into the visible content rendered to the user — otherwise the renderer
 * stringifies the JSON pseudo-block and shows it next to the actual tool
 * output. See PR #4477 review (post-fix-round).
 */
function isStructuredContentPseudoBlock(item: unknown): boolean {
	if (!item || typeof item !== "object") return false;
	const type = (item as Record<string, unknown>).type;
	return type === "structuredContent" || type === "structured_content";
}

/**
 * Strip `structuredContent` pseudo-blocks from a tool-result content array
 * before normalization. The structured payload is extracted via the sibling
 * `structuredContent` field (or a dedicated extractor pass on the raw block);
 * the visible content path must not include the pseudo-block itself.
 */
function stripStructuredContentPseudoBlocks(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content.filter((item) => !isStructuredContentPseudoBlock(item));
}

/** Extract tool result payloads from an SDK synthetic user message, keyed by tool-use ID. */
export function extractToolResultsFromSdkUserMessage(message: SDKUserMessage): Array<{
	toolUseId: string;
	result: ExternalToolResultPayload;
}> {
	const extracted: Array<{ toolUseId: string; result: ExternalToolResultPayload }> = [];
	const seen = new Set<string>();
	const rawMessage = message.message as Record<string, unknown> | null | undefined;
	const content = Array.isArray(rawMessage?.content) ? rawMessage.content : [];

	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as Record<string, unknown>;
		const type = typeof block.type === "string" ? block.type : "";
		if (type !== "tool_result" && type !== "mcp_tool_result") continue;

		const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
		if (!toolUseId || seen.has(toolUseId)) continue;
		seen.add(toolUseId);

		extracted.push({
			toolUseId,
			result: {
				content: normalizeToolResultContent(stripStructuredContentPseudoBlocks(block.content)),
				details: extractStructuredDetailsFromBlock(block),
				isError: block.is_error === true,
			},
		});
	}

	if (extracted.length === 0) {
		const fallback = message.tool_use_result;
		if (fallback && typeof fallback === "object") {
			const toolResult = fallback as Record<string, unknown>;
			const toolUseId = typeof toolResult.tool_use_id === "string" ? toolResult.tool_use_id : "";
			if (toolUseId) {
				extracted.push({
					toolUseId,
					result: {
						content: normalizeToolResultContent(stripStructuredContentPseudoBlocks(toolResult.content)),
						details: extractStructuredDetailsFromBlock(toolResult),
						isError: toolResult.is_error === true,
					},
				});
			}
		}
	}

	return extracted;
}

/** Attach external tool results from the SDK synthetic user message to their corresponding tool-call blocks by ID. */
export function attachExternalResultsToToolBlocks(
	toolBlocks: AssistantMessage["content"],
	toolResultsById: ReadonlyMap<string, ExternalToolResultPayload>,
): void {
	for (const block of toolBlocks) {
		if (block.type !== "toolCall" && block.type !== "serverToolUse") continue;
		const externalResult = toolResultsById.get(block.id);
		if (!externalResult) continue;
		(block as ToolCallWithExternalResult & { id: string }).externalResult = externalResult;
	}
}

function textFromExternalResult(result: ExternalToolResultPayload | undefined): string {
	return (result?.content ?? [])
		.map((block) => typeof block.text === "string" ? block.text : "")
		.join("\n");
}

function isEmptyToolArguments(value: unknown): boolean {
	return !!value
		&& typeof value === "object"
		&& !Array.isArray(value)
		&& Object.keys(value as Record<string, unknown>).length === 0;
}

function sameToolSurface(a: ToolCall, b: ToolCall): boolean {
	return a.name === b.name
		&& (a as ToolCall & { mcpServer?: string }).mcpServer === (b as ToolCall & { mcpServer?: string }).mcpServer;
}

export function shouldSuppressDuplicateToolUnavailableBlock(
	block: AssistantMessage["content"][number],
	allBlocks: AssistantMessage["content"],
): boolean {
	if (block.type !== "toolCall") return false;
	const externalResult = (block as ToolCallWithExternalResult).externalResult;
	if (!externalResult?.isError) return false;
	if (!isEmptyToolArguments(block.arguments)) return false;
	if (!/No such tool available:/i.test(textFromExternalResult(externalResult))) return false;

	return allBlocks.some((candidate) => {
		if (candidate.type !== "toolCall" || candidate.id === block.id) return false;
		const candidateResult = (candidate as ToolCallWithExternalResult).externalResult;
		return candidateResult?.isError === false && sameToolSurface(block, candidate);
	});
}

/**
 * Build the final assistant content that Agent Core consumes in
 * `externalToolExecution` mode. This preserves tool-call blocks, attaches any
 * SDK-produced external results by tool-call id, and then appends the final
 * text/thinking blocks for the completed turn.
 */
export function buildFinalAssistantContent(params: {
	intermediateToolBlocks: AssistantMessage["content"];
	intermediateTextBlocks?: AssistantMessage["content"];
	pendingContent?: AssistantMessage["content"];
	toolResultsById: ReadonlyMap<string, ExternalToolResultPayload>;
	lastThinkingContent?: string;
	lastTextContent?: string;
	fallbackResultText?: string;
}): AssistantMessage["content"] {
	const mergedToolBlocks = [...params.intermediateToolBlocks];
	if (params.pendingContent) {
		mergePendingToolCalls(mergedToolBlocks, params.pendingContent);
	}
	attachExternalResultsToToolBlocks(mergedToolBlocks, params.toolResultsById);

	const finalContent: AssistantMessage["content"] = mergedToolBlocks.filter(
		(block) => !shouldSuppressDuplicateToolUnavailableBlock(block, mergedToolBlocks),
	);
	// Emit prose/thinking captured at earlier turn-boundaries (each successive
	// `ask_user_questions` elicitation completes a turn) before the final
	// segment. Capturing these in an ordered accumulator — symmetric with
	// `intermediateToolBlocks` — is what keeps intermediate explanations from
	// being collapsed to a single overwritten scalar and silently dropped.
	const intermediateTextBlocks = params.intermediateTextBlocks ?? [];
	for (const block of intermediateTextBlocks) {
		finalContent.push(block);
	}
	if (params.pendingContent && params.pendingContent.length > 0) {
		for (const block of params.pendingContent) {
			if (block.type === "text" || block.type === "thinking") {
				finalContent.push(block);
			}
		}
	} else {
		// No builder content survived to this turn boundary, so fall back to the
		// last scalar thinking/text captured off the stream. When the turn ends
		// on an elicitation these scalars just mirror the final intermediate
		// block (they are overwritten at each synthetic-user boundary), so only
		// emit them when they carry content not already accumulated — otherwise
		// a non-streaming `assistant` message's prose/thinking is silently lost.
		const lastBlockOfType = (type: "text" | "thinking") => {
			for (let i = intermediateTextBlocks.length - 1; i >= 0; i--) {
				if (intermediateTextBlocks[i].type === type) return intermediateTextBlocks[i];
			}
			return undefined;
		};
		if (params.lastThinkingContent) {
			const lastThinking = lastBlockOfType("thinking") as { thinking?: string } | undefined;
			if (lastThinking?.thinking !== params.lastThinkingContent) {
				finalContent.push({ type: "thinking", thinking: params.lastThinkingContent });
			}
		}
		if (params.lastTextContent) {
			const lastText = lastBlockOfType("text") as { text?: string } | undefined;
			if (lastText?.text !== params.lastTextContent) {
				finalContent.push({ type: "text", text: params.lastTextContent });
			}
		}
	}

	if (finalContent.length === 0 && params.fallbackResultText) {
		finalContent.push({ type: "text", text: params.fallbackResultText });
	}

	return finalContent;
}

/**
 * Merge tool-call blocks from the active partial-message builder into the
 * running list of intermediate tool calls, preserving order and de-duping
 * by tool-call id. Exposed for testing the F3 fix (final-turn tool calls
 * dropped when `result` arrives without a preceding synthetic `user`).
 */
export function mergePendingToolCalls(
	intermediate: AssistantMessage["content"],
	pending: AssistantMessage["content"],
): AssistantMessage["content"] {
	const alreadyIncluded = new Set<string>();
	for (const block of intermediate) {
		if (block.type === "toolCall") alreadyIncluded.add(block.id);
	}
	for (const block of pending) {
		if (block.type !== "toolCall") continue;
		if (alreadyIncluded.has(block.id)) continue;
		alreadyIncluded.add(block.id);
		intermediate.push(block);
	}
	return intermediate;
}

export function handleClaudeCodePartialStreamEvent(
	builder: PartialMessageBuilder | null,
	event: BetaRawMessageStreamEvent,
	modelId: string,
): { builder: PartialMessageBuilder | null; assistantEvent: AssistantMessageEvent | null } {
	if (event.type === "message_start") {
		// Claude Code can emit repeated SDK message_start events inside one
		// logical assistant response. Keep appending until a synthetic user
		// tool-result boundary explicitly clears the builder.
		return {
			builder: builder ?? new PartialMessageBuilder((event as any).message?.model ?? modelId),
			assistantEvent: null,
		};
	}

	if (!builder) return { builder, assistantEvent: null };
	return { builder, assistantEvent: builder.handleEvent(event) };
}
