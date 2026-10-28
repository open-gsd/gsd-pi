import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, TUI } from "../tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Mid-turn, a finished tool's card folds into a one-row phase summary
// (GSD's replaceCompactToolRowsWithPhaseSummary on tool_execution_end, an
// unforced render). When the card straddles the screen top, the shrink both
// edits and deletes rows that are already in scrollback, the padded retained
// layout no longer matches by index, and the tall→tall realign repainted the
// screen from the new viewport top: the unchanged rows just above the card
// were printed a second time, once per finished tool.
class Turn implements Component {
	folded = false;
	narration: number;
	readonly history: number;
	readonly card: number;
	constructor(history: number, card: number, narration: number) {
		this.history = history;
		this.card = card;
		this.narration = narration;
	}
	render(_width: number): string[] {
		const history = Array.from({ length: this.history }, (_, i) => `H${String(i).padStart(3, "0")} reply`);
		const card = this.folded
			? ["SUMMARY Setup / shell 1 action"]
			: Array.from({ length: this.card }, (_, j) => `CARD row ${j}`);
		const narration = Array.from({ length: this.narration }, (_, i) => `N${String(i).padStart(3, "0")} text`);
		return [...history, ...card, ...narration, "⠋ Working…", "EDITOR", "FOOTER"];
	}
	invalidate(): void {}
}

function counts(lines: string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const line of lines) {
		const id = line.match(/^[HN]\d{3}/)?.[0];
		if (id) out.set(id, (out.get(id) ?? 0) + 1);
	}
	return out;
}

// Grow the narration one row per render until `inScrollback` rows of the card
// have scrolled off the top, then fold the card.
async function foldStraddlingCard(height: number, card: number, inScrollback: number) {
	const terminal = new VirtualTerminal(80, height);
	const tui = new TUI(terminal);
	const turn = new Turn(60, card, 0);
	tui.addChild(turn);
	tui.start();
	await terminal.waitForRender();
	// Frame length = 60 + card + narration + 3; the card's first row (index 60)
	// is `inScrollback` rows above the screen top when length - height = 60 + inScrollback.
	const target = 60 + inScrollback + height - 60 - card - 3;
	while (turn.narration < target) {
		turn.narration++;
		tui.requestRender();
		await terminal.waitForRender();
	}
	turn.folded = true;
	tui.requestRender();
	await terminal.waitForRender();
	tui.stop();
	return { all: [...terminal.getScrollBuffer()], viewport: terminal.getViewport(), narration: turn.narration };
}

describe("unforced shrink when a card straddling the screen top folds into a summary", () => {
	for (const [height, card, inScrollback] of [
		[20, 4, 2],
		[20, 4, 3],
		[20, 6, 1],
		[46, 5, 3],
		[46, 8, 6],
	]) {
		it(`re-emits no scrollback (height ${height}, card ${card}, ${inScrollback} rows above the screen)`, async () => {
			const { all, viewport, narration } = await foldStraddlingCard(height, card, inScrollback);
			const seen = counts(all);
			const duplicated = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
			assert.deepStrictEqual(duplicated, [], `duplicated lines: ${duplicated.join(", ")}`);
			assert.strictEqual(seen.size, 60 + narration, "every history and narration line is still there");
			assert.ok(
				all.some((l) => l.startsWith("SUMMARY")),
				"the summary that replaced the card is shown",
			);
			assert.ok(viewport.some((l) => l.startsWith("FOOTER")), `the frame tail is on screen: ${JSON.stringify(viewport)}`);
			const trailingBlanks = [...viewport].reverse().findIndex((l) => l.trim() !== "");
			assert.ok(trailingBlanks <= Math.floor(height / 2), `at most half the screen blank (#613): ${trailingBlanks}`);
		});
	}
});
