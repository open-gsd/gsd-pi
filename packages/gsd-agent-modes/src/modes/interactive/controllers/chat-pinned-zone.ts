// Project/App: gsd-pi
// File Purpose: Pinned assistant output zone above the editor during tool runs.
import { Markdown } from "@gsd/pi-tui";

import type { InteractiveModeStateHost } from "../interactive-mode-state.js";
import type { StreamingRenderState } from "../streaming-render-state.js";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { DynamicBorder } from "../components/dynamic-border.js";

// Pinnable text candidates: non-empty text blocks that appear strictly before
// the most recent tool call, returned newest-first. Text blocks after the last
// tool call are still streaming live into the chat container.
export function findLatestPinnableCandidates(
	contentBlocks: Array<any>,
): Array<{ text: string; contentIndex: number }> {
	let lastToolIdx = -1;
	for (let i = contentBlocks.length - 1; i >= 0; i--) {
		const c = contentBlocks[i];
		if (c?.type === "toolCall" || c?.type === "serverToolUse") {
			lastToolIdx = i;
			break;
		}
	}
	const out: Array<{ text: string; contentIndex: number }> = [];
	for (let i = lastToolIdx - 1; i >= 0; i--) {
		const c = contentBlocks[i];
		if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
			out.push({ text: c.text.trim(), contentIndex: i });
		}
	}
	return out;
}

export function findLatestPinnableText(contentBlocks: Array<any>): string {
	return findLatestPinnableCandidates(contentBlocks)[0]?.text ?? "";
}

// Sum rendered line counts of segments that appear strictly after the given
// content-block index. Used to decide whether a pinnable text block has
// scrolled out of the viewport and therefore warrants mirroring.
//
// Performance: uses getLineCount() for Markdown components to avoid full
// markdown lexer passes on every streaming delta. The cached line count
// is only recomputed when the width changes (rare during streaming).
export function rowsRenderedAfterContentIndex(
	contentIndex: number,
	width: number,
	streamState: StreamingRenderState,
): number {
	let rows = 0;
	for (const seg of streamState.renderedSegments) {
		try {
			if (seg.kind === "text-run" && seg.startIndex > contentIndex) {
				// Use cached line count — avoids full render + lexer pass
				rows += (seg.component as any).getLineCount?.(width) ?? seg.component.render(width).length;
			} else if (seg.kind === "tool" && seg.contentIndex > contentIndex) {
				rows += seg.component.render(width).length;
			}
		} catch {
			// Defensive: a component that throws during measurement shouldn't
			// destabilize pinned-zone logic. Skip it.
		}
	}
	return rows;
}

export function tearDownPinnedZone(
	host: { pinnedMessageContainer: { clear(): void }; ui: { requestRender(force?: boolean): void }; streamingRenderState: StreamingRenderState },
	options?: { realignViewport?: boolean },
): void {
	const streamState = host.streamingRenderState;
	const needsRealign = streamState.pinnedZoneNeedsViewportRealign;
	if (streamState.pinnedBorder) streamState.pinnedBorder.stopSpinner();
	streamState.pinnedBorder = undefined;
	streamState.pinnedTextComponent = undefined;
	host.pinnedMessageContainer.clear();
	streamState.lastPinnedText = "";
	streamState.hasToolsInTurn = false;
	streamState.pinnedZoneNeedsViewportRealign = false;
	if (options?.realignViewport && needsRealign) {
		host.ui.requestRender(true);
	}
}

export function updatePinnedMessageZone(
	host: InteractiveModeStateHost & {
		getMarkdownThemeWithSettings: () => any;
		loadingAnimation?: { stop(): void } | undefined;
		statusContainer: { clear(): void };
	},
	rs: StreamingRenderState,
	contentBlocks: Array<any>,
): { toreDownPinnedZone: boolean } {
	const hasTools = contentBlocks.some(
		(c: any) => c.type === "toolCall" || c.type === "serverToolUse",
	);
	if (hasTools) rs.hasToolsInTurn = true;

	if (!rs.hasToolsInTurn) {
		return { toreDownPinnedZone: false };
	}

	const candidates = findLatestPinnableCandidates(contentBlocks);
	const termRows = host.ui.terminal.rows;
	const termCols = host.ui.terminal.columns;
	const pinnedMax = Math.max(3, Math.floor(termRows * 0.4));
	// Reserve rows for pinned zone + its border + editor + footer chrome.
	// Anything below this row budget is still in the viewport.
	const offscreenThreshold = Math.max(1, termRows - pinnedMax - 8);

	// Walk candidates newest→oldest; pick the first whose following
	// segments have pushed enough rows to scroll it off-screen.
	let picked: { text: string; contentIndex: number } | undefined;
	for (const c of candidates) {
		if (rowsRenderedAfterContentIndex(c.contentIndex, termCols, rs) >= offscreenThreshold) {
			picked = c;
			break;
		}
	}

	if (picked) {
		if (picked.text !== rs.lastPinnedText) {
			rs.lastPinnedText = picked.text;

			if (!rs.pinnedBorder) {
				// First time: create border + text component
				host.pinnedMessageContainer.clear();
				rs.pinnedBorder = new DynamicBorder(
					(str: string) => theme.fg("dim", str),
					"Working · Latest Output",
				);
				rs.pinnedBorder.startSpinner(host.ui, (str: string) => theme.fg("accent", str));
				host.pinnedMessageContainer.addChild(rs.pinnedBorder);
				rs.pinnedTextComponent = new Markdown(picked.text, 1, 0, host.getMarkdownThemeWithSettings());
				// Cap pinned content to ~40% of terminal height so tall output
				// doesn't exceed the viewport and cause render flashing.
				rs.pinnedTextComponent.maxLines = pinnedMax;
				host.pinnedMessageContainer.addChild(rs.pinnedTextComponent);
				rs.pinnedZoneNeedsViewportRealign = true;
				// Hide the separate status loader — the pinned zone replaces it
				if (host.loadingAnimation) {
					host.loadingAnimation.stop();
					host.loadingAnimation = undefined;
				}
				host.statusContainer.clear();
			} else {
				// Update existing markdown component in-place
				rs.pinnedTextComponent?.setText(picked.text);
				// Refresh maxLines in case terminal was resized
				if (rs.pinnedTextComponent) {
					rs.pinnedTextComponent.maxLines = pinnedMax;
				}
			}
		}
		return { toreDownPinnedZone: false };
	}

	if (rs.pinnedBorder) {
		// Every candidate is still visible in the chat scrollback —
		// tear down the pinned zone so we don't duplicate on-screen text.
		tearDownPinnedZone(host);
		return { toreDownPinnedZone: true };
	}

	return { toreDownPinnedZone: false };
}
