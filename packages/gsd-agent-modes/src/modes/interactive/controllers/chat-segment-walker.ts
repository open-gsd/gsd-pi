// Project/App: gsd-pi
// File Purpose: Segment walker and message_end rebuild for interactive chat streaming.
import type { InteractiveModeStateHost } from "../interactive-mode-state.js";
import type { RenderedSegment, StreamingRenderState } from "../streaming-render-state.js";
import { AssistantMessageComponent } from "../components/assistant-message.js";
import type { TimestampFormat } from "../components/timestamp.js";
import { reconcileChatTurnConnections } from "../components/chat-turn-connect.js";
import { ToolExecutionComponent } from "../components/tool-execution.js";
import { markFirstVisibleAssistantOutput } from "./chat-controller-latency.js";
import {
	buildDesiredSegmentsForMessage,
	filterRedundantDiscussTextRuns,
	getProvisionalPreToolPrunePlan,
	getTextFromContentBlocks,
	getTextLengthFromContentBlocks,
	isProvisionalPreToolProse,
	isSubTurnTextReplacement,
	shouldSuppressRedundantHandoffText,
} from "./chat-handoff-filter.js";
import { registerPendingToolComponent } from "./chat-tool-rollup.js";

/** Host surface for streaming helpers — extends state host with mode methods. */
type ChatStreamHost = InteractiveModeStateHost & {
	formatWebSearchResult: (content: unknown) => string;
	getRegisteredToolDefinition: (toolName: string) => any;
	getMarkdownThemeWithSettings: () => any;
};

export function applySubTurnContentShrink(
	rs: StreamingRenderState,
	contentBlocks: Array<any>,
): void {
	const replacedAt = contentBlocks.length <= rs.lastContentLength
		? isSubTurnTextReplacement(contentBlocks, rs.renderedSegments)
		: null;
	if (contentBlocks.length < rs.lastContentLength) {
		// Accumulate across successive shrinks — overwriting would drop
		// segments displaced by an earlier shrink, leaving them stranded
		// in chatContainer once the prune pass finally runs.
		rs.orphanedSegments = [...rs.orphanedSegments, ...rs.renderedSegments];
		rs.renderedSegments = [];
		rs.lastPinnedText = "";
		rs.lastProcessedContentIndex = 0;
	} else if (replacedAt !== null) {
		// Same-index wholesale replacement: orphan only the replaced
		// text-run and any text-runs after it. Earlier unchanged text
		// and tool segments stay in rs.renderedSegments so they are not
		// re-rendered and duplicated in chatContainer.
		rs.orphanedSegments = [
			...rs.orphanedSegments,
			...rs.renderedSegments.filter((seg) => seg.kind === "text-run" && seg.startIndex >= replacedAt),
		];
		rs.renderedSegments = rs.renderedSegments.filter(
			(seg) => !(seg.kind === "text-run" && seg.startIndex >= replacedAt),
		);
		rs.lastPinnedText = "";
		rs.lastProcessedContentIndex = replacedAt;
	} else if (rs.lastProcessedContentIndex >= contentBlocks.length) {
		rs.lastProcessedContentIndex = 0;
	}
	rs.lastContentLength = contentBlocks.length;
}

export function scanNewContentBlocks(
	host: ChatStreamHost,
	rs: StreamingRenderState,
	contentBlocks: Array<any>,
): void {
	for (let i = rs.lastProcessedContentIndex; i < contentBlocks.length; i++) {
		const content = contentBlocks[i];
		if (content.type === "toolCall") {
			const { component } = registerPendingToolComponent(
				host,
				content.id,
				content.name,
				content.arguments,
				"content",
				() =>
					new ToolExecutionComponent(
						content.name,
						content.arguments,
						{ showImages: host.settingsManager.getShowImages() },
						host.getRegisteredToolDefinition(content.name),
						host.ui,
					),
			);
			component.updateArgs(content.arguments);
		} else if (content.type === "serverToolUse") {
			// Provider-side tools (e.g. native web search) never get
			// tool_execution_start/end events, so count them from block
			// registration until their result block arrives (#2925).
			const { created } = registerPendingToolComponent(
				host,
				content.id,
				content.name,
				content.input ?? {},
				"content",
				() =>
					new ToolExecutionComponent(
						content.name,
						content.input ?? {},
						{ showImages: host.settingsManager.getShowImages() },
						undefined,
						host.ui,
					),
			);
			if (created) {
				host.activeToolInvocations.add(content.id);
			}
		} else if (content.type === "webSearchResult") {
			host.activeToolInvocations.delete(content.toolUseId);
			const component = host.pendingTools.get(content.toolUseId);
			if (component) {
				if (process.env.PI_OFFLINE === "1") {
					component.updateResult({
						content: [{ type: "text", text: "Web search disabled (offline mode)" }],
						isError: false,
					});
				} else {
					const searchContent = content.content;
					const isError = searchContent && typeof searchContent === "object" && "type" in (searchContent as any) && (searchContent as any).type === "web_search_tool_result_error";
					component.updateResult({
						content: [{ type: "text", text: host.formatWebSearchResult(searchContent) }],
						isError: !!isError,
					});
				}
			}
		}
	}
}

export function runSegmentWalker(
	host: ChatStreamHost,
	rs: StreamingRenderState,
	timestampFormat: TimestampFormat,
): void {
	const blocks = host.streamingMessage.content;

	// NOTE: _desiredSegmentsCache is intentionally disabled — it causes
	// stale text length during streaming, resulting in blocked incremental
	// updates. Benchmark showed zero measurable CPU benefit for cache ON
	// vs OFF (both ~1-2%). Keeping cache OFF for correct streaming;
	// re-enable later with a proper invalidation strategy.
	const blockCount = blocks.length;
	let desired: ReturnType<typeof buildDesiredSegmentsForMessage>;
	let shouldPruneProvisionalPreToolProse = false;
	{
		const { shouldPrune: pruneFlag } =
			getProvisionalPreToolPrunePlan(host.streamingMessage);
		shouldPruneProvisionalPreToolProse = pruneFlag;
		desired = buildDesiredSegmentsForMessage(host.streamingMessage, {
			hideThinkingBlock: host.hideThinkingBlock,
		});
	}
	desired = filterRedundantDiscussTextRuns(desired, blocks);

	// Claude Code MCP can emit provisional pre-tool prose that gets
	// superseded by post-tool output. Prune stale text-run segments so
	// the final assistant output remains below tool output.
	if (shouldPruneProvisionalPreToolProse) {
		if (rs.orphanedSegments.length > 0) {
			const remainingOrphans: RenderedSegment[] = [];
			for (const orphan of rs.orphanedSegments) {
				if (
					orphan.kind === "text-run"
					&& orphan.contentType === "text"
					&& isProvisionalPreToolProse(orphan.cachedText ?? "")
				) {
					host.chatContainer.removeChild(orphan.component);
					if (host.streamingComponent === orphan.component) {
						host.streamingComponent = undefined;
					}
					continue;
				}
				remainingOrphans.push(orphan);
			}
			rs.orphanedSegments = remainingOrphans;
		}
		const desiredTextKeys = new Set(
			desired
				.filter((seg): seg is Extract<typeof desired[number], { kind: "text-run" }> => seg.kind === "text-run")
				.map((seg) => `${seg.contentType}:${seg.startIndex}`),
		);
		const desiredToolIndices = new Set(
			desired
				.filter((seg): seg is Extract<typeof desired[number], { kind: "tool" }> => seg.kind === "tool")
				.map((seg) => seg.contentIndex),
		);
		const nextRendered: RenderedSegment[] = [];
		for (const seg of rs.renderedSegments) {
			if (
				seg.kind === "text-run"
				&& seg.contentType === "text"
				&& !desiredTextKeys.has(`${seg.contentType}:${seg.startIndex}`)
			) {
				host.chatContainer.removeChild(seg.component);
				if (host.streamingComponent === seg.component) {
					host.streamingComponent = undefined;
				}
				continue;
			}
			if (seg.kind === "tool" && !desiredToolIndices.has(seg.contentIndex)) {
				continue;
			}
			nextRendered.push(seg);
		}
		rs.renderedSegments = nextRendered;
	}

	// Append any newly needed segments (never reorder existing ones).
	for (const seg of desired) {
		if (seg.kind === "tool") {
			// Tool segments are already handled above via pendingTools; just
			// register them in rs.renderedSegments if not yet tracked.
			const existing = rs.renderedSegments.find(
				(s) => s.kind === "tool" && s.contentIndex === seg.contentIndex,
			);
			if (!existing) {
				const comp = host.pendingTools.get(seg.toolId);
				if (comp) {
					rs.renderedSegments.push({ kind: "tool", contentIndex: seg.contentIndex, component: comp });
				}
			}
		} else {
			// text-run segment
			const existing = rs.renderedSegments.find(
				(s) => s.kind === "text-run" && s.startIndex === seg.startIndex && s.contentType === seg.contentType,
			);
			if (!existing) {
				const segmentText = getTextFromContentBlocks(blocks, seg.startIndex, seg.endIndex, seg.contentType);
				if (
					seg.contentType === "text" &&
					shouldSuppressRedundantHandoffText(
						host.session.messages,
						segmentText,
						rs.orphanedSegments,
						rs.renderedSegments,
					)
				) {
					continue;
				}
				const comp = new AssistantMessageComponent(
					undefined,
					host.hideThinkingBlock,
					host.getMarkdownThemeWithSettings(),
					timestampFormat,
					{ startIndex: seg.startIndex, endIndex: seg.endIndex },
				);
				host.chatContainer.addChild(comp);
				comp.updateContent(host.streamingMessage);
				markFirstVisibleAssistantOutput(host, seg.contentType, {
					contentIndex: seg.startIndex,
				});
				rs.renderedSegments.push({
					kind: "text-run",
					startIndex: seg.startIndex,
					endIndex: seg.endIndex,
					contentType: seg.contentType,
					component: comp,
					cachedText: segmentText,
					cachedTextLength: segmentText.length,
				});
				host.streamingComponent = comp;
				reconcileChatTurnConnections(host.chatContainer.children);
			}
		}
	}

	// Update all trailing text-run segments with the latest message so
	// streaming text grows in place.
	// Optimization: use getTextLengthFromContentBlocks as a fast O(1) cache
	// check to avoid allocating new strings via getTextFromContentBlocks on
	// every streaming delta.
	for (const seg of rs.renderedSegments) {
		if (seg.kind === "text-run") {
			// Find corresponding desired segment to get current endIndex
			const d = desired.find(
				(ds) => ds.kind === "text-run" && ds.startIndex === seg.startIndex && ds.contentType === seg.contentType,
			);
			if (d && d.kind === "text-run" && d.endIndex !== seg.endIndex) {
				seg.endIndex = d.endIndex;
				seg.component.setRange({ startIndex: seg.startIndex, endIndex: seg.endIndex });
			}
			// Fast length check — skip string allocation if unchanged
			const newLength = getTextLengthFromContentBlocks(blocks, seg.startIndex, seg.endIndex, seg.contentType);
			if (newLength !== seg.cachedTextLength) {
				seg.cachedTextLength = newLength;
				const newText = getTextFromContentBlocks(blocks, seg.startIndex, seg.endIndex, seg.contentType);
				seg.cachedText = newText;
				seg.component.updateContent(host.streamingMessage);
			}
		}
	}

	// Keep streamingComponent pointing at the last text-run for message_end compatibility.
	const lastTextSeg = [...rs.renderedSegments].reverse().find((s) => s.kind === "text-run");
	if (lastTextSeg && lastTextSeg.kind === "text-run") {
		host.streamingComponent = lastTextSeg.component;
	}
}

export function rebuildSegmentsOnMessageEnd(
	host: ChatStreamHost,
	rs: StreamingRenderState,
	timestampFormat: TimestampFormat,
): void {
	if (rs.renderedSegments.length === 0) return;

	const finalBlocks = host.streamingMessage.content;
	const desired = filterRedundantDiscussTextRuns(
		buildDesiredSegmentsForMessage(host.streamingMessage, {
			hideThinkingBlock: host.hideThinkingBlock,
		}),
		finalBlocks,
	);

	const toolComponentsById = new Map<string, ToolExecutionComponent>();
	for (const [toolId, component] of host.pendingTools.entries()) {
		toolComponentsById.set(toolId, component);
	}

	for (const seg of rs.renderedSegments) {
		host.chatContainer.removeChild(seg.component);
		if (seg.kind === "tool") {
			const priorBlocks = host.streamingMessage.content;
			const priorBlock = priorBlocks[seg.contentIndex] as any;
			if (priorBlock?.id && !toolComponentsById.has(priorBlock.id)) {
				toolComponentsById.set(priorBlock.id, seg.component);
			}
		}
	}
	rs.renderedSegments = [];
	host.streamingComponent = undefined;

	for (const seg of desired) {
		if (seg.kind === "tool") {
			const finalBlock = finalBlocks[seg.contentIndex] as any;
			let component = toolComponentsById.get(seg.toolId);
			if (!component && finalBlock?.id) {
				component = host.pendingTools.get(finalBlock.id);
			}
			if (!component && finalBlock?.type === "toolCall") {
				component = new ToolExecutionComponent(
					finalBlock.name,
					finalBlock.arguments,
					{ showImages: host.settingsManager.getShowImages() },
					host.getRegisteredToolDefinition(finalBlock.name),
					host.ui,
				);
				component.setExpanded(host.toolOutputExpanded);
				host.pendingTools.set(finalBlock.id, component);
				toolComponentsById.set(finalBlock.id, component);
			} else if (!component && finalBlock?.type === "serverToolUse") {
				component = new ToolExecutionComponent(
					finalBlock.name,
					finalBlock.input ?? {},
					{ showImages: host.settingsManager.getShowImages() },
					undefined,
					host.ui,
				);
				component.setExpanded(host.toolOutputExpanded);
				host.pendingTools.set(finalBlock.id, component);
				toolComponentsById.set(finalBlock.id, component);
			}
			if (component) {
				host.chatContainer.removeChild(component);
				host.chatContainer.addChild(component);
				rs.renderedSegments.push({ kind: "tool", contentIndex: seg.contentIndex, component });
			}
			continue;
		}

		const comp = new AssistantMessageComponent(
			undefined,
			host.hideThinkingBlock,
			host.getMarkdownThemeWithSettings(),
			timestampFormat,
			{ startIndex: seg.startIndex, endIndex: seg.endIndex },
		);
		comp.updateContent(host.streamingMessage);
		const segmentText = getTextFromContentBlocks(finalBlocks, seg.startIndex, seg.endIndex, seg.contentType);
		if (
			seg.contentType === "text" &&
			shouldSuppressRedundantHandoffText(
				host.session.messages,
				segmentText,
				rs.orphanedSegments,
				rs.renderedSegments,
			)
		) {
			continue;
		}
		host.chatContainer.addChild(comp);
		markFirstVisibleAssistantOutput(host, seg.contentType, {
			contentIndex: seg.startIndex,
			source: "message_end_rebuild",
		});
		rs.renderedSegments.push({
			kind: "text-run",
			startIndex: seg.startIndex,
			endIndex: seg.endIndex,
			contentType: seg.contentType,
			component: comp,
			cachedText: segmentText,
			cachedTextLength: segmentText.length,
		});
		host.streamingComponent = comp;
	}
	reconcileChatTurnConnections(host.chatContainer.children);
}
