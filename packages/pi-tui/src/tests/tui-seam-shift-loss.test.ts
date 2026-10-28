import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, TUI } from "../tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// A tool card that already scrolled into scrollback folds into its one-row
// phase summary in the same frame that the streaming reply grows. Rows above
// the screen top are deleted, so every row from there down moves up, but the
// flushed mark is a row index: the clean repaint (differential fallback,
// forced refill) or the in-place realign (tall→tall shrink) starts below the
// row that was at the top of the screen, and that row is erased without ever
// reaching scrollback. Seen as a table losing one row between two identical
// separator rows.
class Turn implements Component {
	folded = false;
	narration: string[] = [];
	readonly card: number;
	constructor(card: number) {
		this.card = card;
	}
	render(_width: number): string[] {
		const history = Array.from({ length: 60 }, (_, i) => `H${String(i).padStart(3, "0")} reply`);
		const card = this.folded
			? ["SUMMARY Setup / shell 1 action"]
			: Array.from({ length: this.card }, (_, j) => `CARD row ${j}`);
		return [...history, ...card, ...this.narration, "⠋ Working…", "EDITOR", "FOOTER"];
	}
	invalidate(): void {}
}

const SEPARATOR = "├──────┼──────┤";

// Plain narration: N000, N001, ... Table narration: a row, then a separator
// identical to every other separator, then the next row.
function narrationRows(count: number, table: boolean): string[] {
	if (!table) return Array.from({ length: count }, (_, i) => `N${String(i).padStart(3, "0")} text`);
	const out: string[] = [];
	for (let i = 0; out.length < count; i++) {
		if (i > 0) out.push(SEPARATOR);
		out.push(`R${String(i).padStart(3, "0")} cell`);
	}
	return out.slice(0, count);
}

function counts(lines: string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const line of lines) {
		const id = line.startsWith(SEPARATOR) ? "SEPARATOR" : line.match(/^[HNR]\d{3}/)?.[0];
		if (id) out.set(id, (out.get(id) ?? 0) + 1);
	}
	return out;
}

// Grow the narration one row per render until the card and `gap` narration
// rows are above the screen top, then fold the card and add `grow` rows in
// one render.
async function foldAboveSeamWhileGrowing(height: number, card: number, gap: number, grow: number, opts: { table?: boolean; force?: boolean } = {}) {
	const terminal = new VirtualTerminal(80, height);
	const tui = new TUI(terminal);
	const turn = new Turn(card);
	tui.addChild(turn);
	tui.start();
	await terminal.waitForRender();
	// Screen top = frame length - height = 60 + card + gap.
	const target = gap + height - 3;
	while (turn.narration.length < target) {
		turn.narration = narrationRows(turn.narration.length + 1, !!opts.table);
		tui.requestRender();
		await terminal.waitForRender();
	}
	turn.folded = true;
	turn.narration = narrationRows(target + grow, !!opts.table);
	tui.requestRender(!!opts.force);
	await terminal.waitForRender();
	tui.stop();
	return { all: [...terminal.getScrollBuffer()], expected: counts(turn.render(80)) };
}

describe("a card above the screen top folds in the same frame that the reply grows", () => {
	const cases: Array<[number, number, number, number, { table?: boolean; force?: boolean }]> = [
		// [height, card, narration rows above the seam, rows added, options]
		[20, 2, 1, 1, {}], // differential fallback, net growth 0
		[20, 2, 5, 3, {}], // differential fallback, net growth 2
		[20, 4, 1, 3, {}], // three rows deleted above the seam
		[20, 4, 3, 1, {}], // net shrink: tall→tall realign
		[46, 4, 10, 8, {}],
		[46, 2, 7, 2, { table: true }], // the screen top is a table row between identical separators
		[46, 2, 8, 2, { table: true }], // the screen top is a separator
		[20, 2, 1, 3, { force: true }], // forced refill (base <= new)
		[46, 4, 5, 6, { force: true, table: true }],
	];
	for (const [height, card, gap, grow, opts] of cases) {
		const label = `height ${height}, card ${card}, ${gap} rows above the seam, +${grow}${opts.table ? ", table" : ""}${opts.force ? ", forced" : ""}`;
		it(`loses no row and re-emits none (${label})`, async () => {
			const { all, expected } = await foldAboveSeamWhileGrowing(height, card, gap, grow, opts);
			const seen = counts(all);
			const missing = [...expected].filter(([id, n]) => (seen.get(id) ?? 0) < n).map(([id]) => id);
			assert.deepStrictEqual(missing, [], `rows that never reached the terminal: ${missing.join(", ")}`);
			const duplicated = [...seen].filter(([id, n]) => n > (expected.get(id) ?? 0)).map(([id]) => id);
			assert.deepStrictEqual(duplicated, [], `duplicated rows: ${duplicated.join(", ")}`);
		});
	}
});
