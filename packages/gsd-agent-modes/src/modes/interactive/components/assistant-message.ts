// Project/App: gsd-pi
// File Purpose: Assistant message rail renderer for interactive terminal sessions.
import type { AssistantMessage } from "@gsd/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text, visibleWidth } from "@gsd/pi-tui";
import { getMarkdownTheme, theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { type TimestampFormat } from "./timestamp.js";
import { formatTimestamp } from "./timestamp.js";
import { RenderCache } from "./render-cache.js";
import { CHAT_CORNER_TOP_LEFT, renderPlainSpeakerMessage } from "./transcript-design.js";
import { asServerToolUse, asWebSearchResult, isToolContentBlock } from "../gsd-content-blocks.js";

const ASSISTANT_HEADER_LABEL = "GSD";
// Visible prefix of the speaker header line, ahead of the model meta.
const ASSISTANT_HEADER_PREFIX = `${CHAT_CORNER_TOP_LEFT}${ASSISTANT_HEADER_LABEL} · `;

/**
 * Model + routing provenance for the assistant header, derived only from the
 * stored message (ADR-049). Shows the provider-reported effective model first
 * (`effective ← requested`) when `responseModel` is non-empty and differs,
 * plus the GSD dynamic-routing tier snapshot when present.
 */
export function formatAssistantModelMeta(message: AssistantMessage): string {
	const requested = typeof message.model === "string" ? message.model.trim() : "";
	const reported = typeof message.responseModel === "string" ? message.responseModel.trim() : "";
	const parts: string[] = [];
	if (requested.length > 0 && reported.length > 0 && reported !== requested) {
		parts.push(`${reported} ← ${requested}`);
	} else if (reported.length > 0) {
		parts.push(reported);
	} else if (requested.length > 0) {
		parts.push(requested);
	}
	if (message.modelRouting?.source === "gsd-dynamic") {
		parts.push(`(dynamic/${message.modelRouting.tier})`);
	}
	return parts.join(" ");
}

/** The same meta without the lower-priority requested-alias clause. */
function formatAssistantModelMetaCompact(message: AssistantMessage): string {
	const meta = formatAssistantModelMeta(message);
	const aliasIdx = meta.indexOf(" ← ");
	if (aliasIdx === -1) return meta;
	const tail = meta.slice(aliasIdx);
	const tierIdx = tail.indexOf(" (dynamic/");
	return tierIdx === -1 ? meta.slice(0, aliasIdx) : meta.slice(0, aliasIdx) + tail.slice(tierIdx);
}

function headerMetaFits(meta: string, frameWidth: number): boolean {
	return visibleWidth(ASSISTANT_HEADER_PREFIX) + visibleWidth(meta) <= frameWidth;
}

export interface ContentRange {
	startIndex: number;
	endIndex: number;
}

/**
 * Component that renders a complete assistant message, or a sub-range of its content[].
 * When `range` is provided, only content[startIndex..endIndex] (inclusive) is rendered.
 * Non-text/thinking blocks within the range are silently skipped.
 *
 * Streaming optimization: during incremental updates, existing Markdown instances
 * are reused when their text hasn't changed. Only the last text/thinking block
 * gets its text updated via setText(), avoiding full re-parse of unchanged content.
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private lastMessage?: AssistantMessage;
	private timestampFormat: TimestampFormat;
	private range?: ContentRange;
	private showMetadata: boolean;
	private renderCache = new RenderCache();
	private renderVersion = 0;

	/**
	 * Track Markdown instances by their content key so we can reuse them
	 * during incremental streaming updates. Key = `${type}:${textHash}`.
	 */
	private markdownInstances = new Map<string, Markdown>();

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = true,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		timestampFormat: TimestampFormat = "date-time-iso",
		range?: ContentRange,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.timestampFormat = timestampFormat;
		this.range = range;
		// No range = legacy full-message rendering; show metadata by default.
		// Ranged (interleaved) instances start with metadata hidden; chat-controller
		// calls setShowMetadata(true) on the last segment at message_end.
		this.showMetadata = !range;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	setRange(range: ContentRange | undefined): void {
		this.range = range;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setShowMetadata(show: boolean): void {
		this.showMetadata = show;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.clearRenderCache();
		// Clear markdown instance cache on invalidation (e.g. window resize)
		// so that stale width caches are discarded.
		this.markdownInstances.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		if (this.hideThinkingBlock === hide) return;
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		} else {
			this.clearRenderCache();
		}
	}

	/** @deprecated Plain transcript has no connected rails. */
	setContinuesToUser(_value: boolean): void {}

	/** @deprecated Plain transcript has no connected rails. */
	setConnectedToUser(_value: boolean): void {}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;
		this.clearRenderCache();

		const start = this.range?.startIndex ?? 0;
		const end = this.range?.endIndex ?? message.content.length - 1;
		const slice = message.content.slice(start, end + 1);

		const hasVisibleContent = slice.some((content) => {
			if (content.type === "text") return content.text.trim().length > 0;
			return !this.hideThinkingBlock && content.type === "thinking" && content.thinking.trim().length > 0;
		});
		const hasTextContent = message.content.some((c) => c.type === "text" && c.text.trim().length > 0);
		const hasToolContent = message.content.some((c) => isToolContentBlock(c));
		// Claude Code often emits long reasoning blocks ahead of user-visible text/tool
		// output in the same lifecycle. Keep chat output visible without requiring a
		// manual thinking toggle every turn.
		const shouldCapThinking = hasTextContent || hasToolContent || message.provider === "claude-code";

		// Reconcile: reuse existing instances, update changed text, remove stale ones.
		// We rebuild the children list to maintain correct ordering.
		const newChildren: Array<Markdown | Spacer> = [];
		const usedKeys = new Set<string>();

		for (let i = 0; i < slice.length; i++) {
			const content = slice[i];
			const key = `${content.type}:${i}`;

			if (content.type === "text" && content.text.trim()) {
				const trimmedText = content.text.trim();
				const existing = this.markdownInstances.get(key);
				if (existing && existing.getText() === trimmedText) {
					// Text unchanged — reuse instance as-is
					newChildren.push(existing);
					usedKeys.add(key);
				} else if (existing) {
					// Text changed — update in place (Markdown cache handles delta)
					existing.setText(trimmedText);
					newChildren.push(existing);
					usedKeys.add(key);
				} else {
					// New instance
					const md = new Markdown(trimmedText, 1, 0, this.markdownTheme);
					this.markdownInstances.set(key, md);
					newChildren.push(md);
					usedKeys.add(key);
				}
			} else if (content.type === "thinking" && content.thinking.trim()) {
				if (this.hideThinkingBlock) continue;
				const trimmedText = content.thinking.trim();
				const existing = this.markdownInstances.get(key);
				if (existing && existing.getText() === trimmedText) {
					newChildren.push(existing);
					usedKeys.add(key);
				} else if (existing) {
					existing.setText(trimmedText);
					newChildren.push(existing);
					usedKeys.add(key);
				} else {
					const hasVisibleContentAfter = slice
						.slice(i + 1)
						.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

					const thinkingMarkdown = new Markdown(trimmedText, 1, 0, this.markdownTheme, {
						color: (text: string) => theme.fg("thinkingText", text),
						italic: true,
					});
					if (shouldCapThinking) {
						thinkingMarkdown.maxLines = 8;
					}
					this.markdownInstances.set(key, thinkingMarkdown);
					newChildren.push(thinkingMarkdown);
					usedKeys.add(key);

					if (hasVisibleContentAfter) {
						newChildren.push(new Spacer(1));
					}
				}
			}
		}

		// Remove instances that are no longer in use
		for (const key of Array.from(this.markdownInstances.keys())) {
			if (!usedKeys.has(key)) {
				this.markdownInstances.delete(key);
			}
		}

		// In-place patch: avoid contentContainer.clear() + rebuild which
		// destroys the Box cache and triggers N invalidateCache() calls.
		// Instead, patch children in place (update text, add/remove as needed).
		this.patchContainerChildren(newChildren);

		// Metadata (errors, timestamp): gated on showMetadata so ranged instances stay clean
		// until chat-controller explicitly enables it on the last segment at message_end.
		if (this.showMetadata) {
			// Check if aborted - show after partial content
			// But only if there are no tool calls (tool execution components will show the error)
			const hasToolCalls = message.content.some((c) => c.type === "toolCall");
			if (!hasToolCalls) {
				if (message.stopReason === "aborted") {
					const abortMessage =
						message.errorMessage && message.errorMessage !== "Request was aborted"
							? message.errorMessage
							: "Operation aborted";
					if (hasVisibleContent) {
						this.contentContainer.addChild(new Spacer(1));
					}
					this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
				} else if (message.stopReason === "error") {
					const errorMsg = message.errorMessage || "Unknown error";
					this.contentContainer.addChild(new Spacer(1));
					this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
				}
			}

		}
	}

	/**
	 * Patch container children in-place instead of clear() + rebuild.
	 *
	 * Strategy:
	 * 1. Match newChildren to existing children by component reference (same instance).
	 * 2. For children that exist in both: ensure correct order via re-parenting.
	 * 3. For children only in newChildren: insert at correct position.
	 * 4. For children only in existing: remove them.
	 *
	 * This avoids Box.invalidateCache() calls on every streaming delta,
	 * keeping the Box cache warm and avoiding unnecessary re-layout.
	 */
	private patchContainerChildren(newChildren: Array<Markdown | Spacer>): void {
		const existing = this.contentContainer.children as Array<Markdown | Spacer>;
		const existingSet = new Set(existing);
		const newSet = new Set(newChildren);

		// Children to remove (in existing but not in new)
		const toRemove = existing.filter((c) => !newSet.has(c));
		// Children to add (in new but not in existing)
		const toAdd = newChildren.filter((c) => !existingSet.has(c));
		// Children that exist in both — need to check ordering
		const shared = newChildren.filter((c) => existingSet.has(c));

		// Remove stale children (from end to avoid index shifting)
		for (const child of toRemove) {
			this.contentContainer.removeChild(child);
		}

		// Insert new children at their correct positions
		// Find the insertion point by looking at the last shared child before the gap
		let insertIdx = 0;
		for (let i = 0; i < newChildren.length; i++) {
			const child = newChildren[i];
			if (existingSet.has(child)) {
				// Shared child — ensure it's at the right position
				const currentIdx = this.contentContainer.children.indexOf(child);
				if (currentIdx !== i) {
					// Re-order: remove and re-insert at correct position
					this.contentContainer.removeChild(child);
					this.contentContainer.children.splice(i, 0, child);
					// Don't invalidate — just reorder in-place
				}
				insertIdx = i + 1;
			} else {
				// New child — insert at this position
				this.contentContainer.children.splice(i, 0, child);
			}
		}

		// Invalidate Box cache only once (not N times per addChild)
		if (toRemove.length > 0 || toAdd.length > 0 || shared.length > 0) {
			(this.contentContainer as any).invalidateCache?.();
		}
	}

	override render(width: number): string[] {
		const cached = this.renderCache.get(`${width}:${this.renderVersion}`);
		if (cached) return cached;

		const frameWidth = Math.max(20, width);
		const lines = super.render(frameWidth);
		if (lines.length === 0) return [];
		const rendered = renderPlainSpeakerMessage(lines, frameWidth, {
			label: ASSISTANT_HEADER_LABEL,
			meta: this.renderHeaderMeta(frameWidth),
			tone: "assistant",
		});
		return this.renderCache.set(`${width}:${this.renderVersion}`, rendered);
	}

	/**
	 * Header metadata, derived only from the stored message. Provenance
	 * (effective model, dynamic tier) is metadata: it rides the same
	 * metadata-bearing final segment as the timestamp, while streaming or
	 * non-final segments show the requested model alone. At constrained widths
	 * the effective model and dynamic tier are preserved ahead of
	 * lower-priority requested-alias and timestamp details (ADR-049); whatever
	 * remains overflows into the existing hard truncation.
	 */
	private renderHeaderMeta(frameWidth: number): string | undefined {
		if (!this.lastMessage?.model) return undefined;
		const provenanceMeta = this.showMetadata ? formatAssistantModelMeta(this.lastMessage) : "";
		const baseMeta = this.showMetadata ? provenanceMeta : this.lastMessage.model;
		const timestamp =
			this.showMetadata && this.lastMessage?.timestamp != null
				? formatTimestamp(this.lastMessage.timestamp, this.timestampFormat)
				: undefined;
		const compactMeta = this.showMetadata ? formatAssistantModelMetaCompact(this.lastMessage) : baseMeta;
		const candidates = [
			baseMeta && timestamp ? `${baseMeta} · ${timestamp}` : "",
			baseMeta,
			compactMeta,
		];
		for (const candidate of candidates) {
			if (candidate && headerMetaFits(candidate, frameWidth)) return candidate;
		}
		return baseMeta || undefined;
	}

	private clearRenderCache(): void {
		this.renderVersion++;
		this.renderCache.clear();
	}
}
