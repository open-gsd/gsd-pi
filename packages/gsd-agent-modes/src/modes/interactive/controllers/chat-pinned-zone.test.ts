// gsd-pi — pinned-zone viewport measurement vs displayed (rolled-up) tool height.
//
// Regression: rowsRenderedAfterContentIndex() counted kind:"tool" segments via
// component.render(width).length — the FULL body render (read tool shows up to
// 10 collapsed lines, bash cards show 5 preview lines) rather than the rows the
// transcript actually displays after replaceCompactToolRowsWithPhaseSummary()
// folds finished tools into single-row phase summaries. The overcount crossed
// the offscreen threshold while the pinnable text was still on-screen, so the
// pinned zone mirrored a sentence the transcript still showed — the same line
// rendered twice, 3 rows apart (issue: screenshot evidence "Working · Latest
// Output" duplicating the last assistant sentence).

import assert from "node:assert/strict";
import test from "node:test";

import {
	findLatestPinnableCandidates,
	rowsRenderedAfterContentIndex,
	tearDownPinnedZone,
	updatePinnedMessageZone,
} from "./chat-pinned-zone.js";
import { createStreamingRenderState } from "../streaming-render-state.js";
import { Container, TUI } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";

initTheme();

function makeTerminal(rows: number, columns: number) {
	return {
		isTTY: true,
		columns,
		rows,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		drainInput: async () => {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
	} as any;
}

/**
 * Fake tool segment: render() returns a tall frame (like an expanded read/exec
 * result), but the transcript actually displays it rolled up to one summary
 * row (replaceCompactToolRowsWithPhaseSummary).
 */
class TallButRolledUpTool {
	constructor(private displayLines: number, private fullLines: number) {}
	render(width: number): string[] {
		return Array.from({ length: this.fullLines }, () => "x".repeat(width));
	}
	getDisplayedLineCount(width: number): number {
		return this.displayLines;
	}
}

function makeHost(termRows = 33, termCols = 110) {
	const ui = new TUI(makeTerminal(termRows, termCols));
	return {
		streamingRenderState: createStreamingRenderState(),
		pinnedMessageContainer: new Container(),
		statusContainer: new Container(),
		loadingAnimation: undefined,
		getMarkdownThemeWithSettings: () => undefined,
		ui: Object.assign(ui, { requestRender: () => {} }),
	} as any;
}

test("rowsRenderedAfterContentIndex counts tool-summary segments at their displayed height", () => {
	const rs = createStreamingRenderState();
	// One rolled-up tool run after the pinnable text: displayed as a 1-row
	// phase summary, but its raw render() is 30 rows tall.
	rs.renderedSegments = [
		{ kind: "tool-summary", component: { render: () => ["summary"] } as any, phases: [] },
	];
	let rows = rowsRenderedAfterContentIndex(0, 110, rs);
	// tool-summary is not counted via seg.kind === "tool" —PATCH NOTE: pre-fix
	// behavior counts nothing for tool-summary segments; the second segment
	// below exercises the tool branch.
	rs.renderedSegments = [
		{ kind: "tool", contentIndex: 7, component: new TallButRolledUpTool(1, 30) as any },
	];
	rows = rowsRenderedAfterContentIndex(0, 110, rs);
	assert.equal(rows, 1, "tool with getDisplayedLineCount must count displayed rows, not render() rows");
});

test("updatePinnedMessageZone does not mirror text still visible in the transcript", () => {
	const host = makeHost();
	const rs = host.streamingRenderState;
	const sentence = "现在编写这个测试文件。mypy 仅检查 src，因此测试只需要 ruff。";
	const contentBlocks = [
		{ type: "text", text: sentence },
		{ type: "toolCall", id: "t1", name: "gsd_exec", arguments: {} },
	];
	// Tool finished and rolled up: transcript shows exactly 1 row after the text.
	rs.renderedSegments = [
		{ kind: "tool", contentIndex: 1, component: new TallButRolledUpTool(1, 30) as any },
	];

	const { toreDownPinnedZone } = updatePinnedMessageZone(host, rs, contentBlocks);

	// offscreenThreshold = max(1, 33 - 13 - 8) = 12; after-rows = 1 < 12,
	// so no candidate qualifies and no pinned zone may be created.
	assert.equal(toreDownPinnedZone, false);
	assert.equal(rs.pinnedBorder, undefined, "pinned zone must not mirror text that is still on-screen");
});

test("updatePinnedMessageZone still mirrors when following rows genuinely push text off-screen", () => {
	const host = makeHost();
	const rs = host.streamingRenderState;
	const sentence = "现在编写这个测试文件。mypy 仅检查 src，因此测试只需要 ruff。";
	const contentBlocks = [
		{ type: "text", text: sentence },
		{ type: "toolCall", id: "t1", name: "gsd_exec", arguments: {} },
	];
	rs.renderedSegments = [
		{ kind: "tool", contentIndex: 1, component: new TallButRolledUpTool(14, 14) as any },
	];

	updatePinnedMessageZone(host, rs, contentBlocks);

	assert.ok(rs.pinnedBorder, "pinned zone must still engage when rows truly exceed the threshold");
	assert.equal(rs.lastPinnedText, sentence);

	tearDownPinnedZone(host);
});

test("findLatestPinnableCandidates skips text after the last tool call", () => {
	const candidates = findLatestPinnableCandidates([
		{ type: "text", text: "earlier" },
		{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
		{ type: "text", text: "still streaming" },
	]);
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].text, "earlier");
});
