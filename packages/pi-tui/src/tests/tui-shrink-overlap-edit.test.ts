import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, TUI } from "../tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// A turn ends: a tool card folds into its one-row summary and the pinned zone
// below the screen top is torn down in the same repaint. When the change
// lands inside the overlap (rows already in scrollback, below the new viewport
// top), firstChangeTop repainted from the changed row and printed every
// unchanged row between it and the old screen top a second time (seen as a
// wrapped reply line shown twice), and a card whose first row was the screen
// top refilled and re-emitted the whole overlap. A change a few rows further
// up was already left hidden in scrollback; these shapes must behave the same.
class Turn implements Component {
	done = false;
	constructor(
		readonly before: number,
		readonly card: number,
		readonly after: number,
		readonly pinned: number,
		readonly editAt = -1,
		readonly fold = true,
		readonly styleOnly = false,
	) {}
	render(_width: number): string[] {
		const row = (i: number) => {
			const text = `R${String(i).padStart(3, "0")} reply`;
			if (!this.done || i !== this.editAt) return text;
			return this.styleOnly ? `\x1b[1m${text}\x1b[22m` : `R${String(i).padStart(3, "0")} EDITED`;
		};
		const before = Array.from({ length: this.before }, (_, i) => row(i));
		const card =
			this.done && this.fold
				? ["SUMMARY Setup · 1 action"]
				: Array.from({ length: this.card }, (_, j) => `CARD row ${j}`);
		const after = Array.from({ length: this.after }, (_, i) => row(this.before + i));
		const pinned = this.done ? [] : Array.from({ length: this.pinned }, (_, j) => `PINNED ${j}`);
		return [...before, ...card, ...after, ...pinned, "EDITOR", "FOOTER"];
	}
	invalidate(): void {}
}

async function endTurn(turn: Turn, height: number, force: boolean) {
	const terminal = new VirtualTerminal(80, height);
	const tui = new TUI(terminal);
	tui.addChild(turn);
	tui.start();
	await terminal.waitForRender();
	turn.done = true;
	tui.requestRender(force);
	await terminal.waitForRender();
	const frame = turn.render(80);
	tui.stop();
	return { all: terminal.getScrollBuffer(), viewport: terminal.getViewport(), frame };
}

// Compared as the reader sees them: visible text, so a styling-only
// re-render shown below its old copy also counts as a row read twice.
const visible = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();

function assertShownOnce(all: string[], viewport: string[], frame: string[], rows: number) {
	const counts = new Map<string, number>();
	const ids = new Set<string>();
	for (const line of all.map(visible)) {
		const id = line.match(/^R\d{3}/)?.[0];
		if (!id) continue;
		ids.add(id);
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	const twice = [...counts].filter(([, n]) => n > 1).map(([line]) => line);
	assert.deepStrictEqual(twice, [], `rows read twice: ${twice.join(", ")}`);
	assert.strictEqual(ids.size, rows, "every reply row is still there");
	const shown = viewport.map(visible).filter((l) => l !== "");
	assert.deepStrictEqual(shown, frame.map(visible).slice(frame.length - shown.length), "the screen shows the end of the frame");
}

describe("shrink whose change lies inside the overlap", () => {
	// Screen 20 rows, 4 pinned rows torn down: the card ends `gap` rows above
	// the old screen top, so firstChangeTop re-emitted `gap` rows.
	for (const gap of [1, 2, 3]) {
		for (const force of [true, false]) {
			it(`a card ${gap} row(s) into scrollback folds (${force ? "forced" : "unforced"})`, async () => {
				const turn = new Turn(40, 6, 14 + gap, 4);
				const { all, viewport, frame } = await endTurn(turn, 20, force);
				assertShownOnce(all, viewport, frame, 54 + gap);
			});
		}
	}

	// No fold: one reply row just above the screen is re-rendered while the
	// pinned zone goes (the old screen-top row stays at its index). The frame
	// is 60 reply + 3 pinned + 2 rows, so the old screen top is row 45 and the
	// overlap is rows 42-44.
	for (const above of [1, 2, 3]) {
		it(`a reply row ${above} above the screen top is re-rendered with new styling only`, async () => {
			const turn = new Turn(60, 0, 0, 3, 45 - above, false, true);
			const { all, viewport, frame } = await endTurn(turn, 20, true);
			assertShownOnce(all, viewport, frame, 60);
		});
		// A real text change is still shown when that reprints no other row
		// (the stale copy stays in scrollback above it); with unchanged rows
		// in between it stays hidden, like a change further up.
		it(`a reply row ${above} above the screen top gets new text`, async () => {
			const turn = new Turn(60, 0, 0, 3, 45 - above, false);
			const { all, viewport, frame } = await endTurn(turn, 20, true);
			assertShownOnce(all, viewport, frame, 60);
			const shown = all.some((l) => visible(l).startsWith(`R0${45 - above} EDITED`));
			assert.strictEqual(shown, above === 1, "shown only when nothing unchanged sits between it and the screen");
		});
	}

	// The card's first row was the screen top: the overlap is unchanged and
	// only the seam row differs, so repaint from it instead of refilling.
	it("a card starting at the screen top folds (forced)", async () => {
		const turn = new Turn(40, 6, 12, 0);
		const { all, viewport, frame } = await endTurn(turn, 20, true);
		assertShownOnce(all, viewport, frame, 52);
	});

	// A fold above plus an edit on the screen in the same frame.
	it("a fold in scrollback and an edit on screen", async () => {
		const turn = new Turn(40, 6, 16, 4, 50);
		const { all, viewport, frame } = await endTurn(turn, 20, true);
		assertShownOnce(all, viewport, frame, 56);
		assert.ok(viewport.some((l) => l.startsWith("R050 EDITED")), "the on-screen edit is shown");
	});
});
