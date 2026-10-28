import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, TUI } from "../tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// A turn ends (#2804): its tool rows collapse far above the screen and the
// working loader below the screen top goes away, in one forced repaint. Rows
// are deleted both far above the overlap (tool roll-up) and below the old
// screen top (pinned-zone teardown), so neither the unchanged-overlap guard
// nor repairShiftedOverlap can keep the flushed top — the refill re-emits the
// scrollback rows that now sit above the new viewport top. Nothing already in
// scrollback may be written again, and no surviving row may vanish.
class Transcript implements Component {
	collapsed = false;
	edited = -1;
	rows: number;
	readonly tools: number;
	readonly loader: number;
	readonly toolsAt: number;
	constructor(rows: number, tools: number, loader: number, toolsAt: number) {
		this.rows = rows;
		this.tools = tools;
		this.loader = loader;
		this.toolsAt = toolsAt;
	}
	render(_width: number): string[] {
		const t = Array.from({ length: this.rows }, (_, i) =>
			`T${String(i).padStart(3, "0")} transcript ${this.collapsed && i === this.edited ? "EDITED" : "line"}`,
		);
		const tools = this.collapsed ? [] : Array.from({ length: this.tools }, (_, j) => `B${String(j).padStart(3, "0")} tool row`);
		const loader = this.collapsed ? [] : Array.from({ length: this.loader }, (_, j) => (j === this.loader - 1 ? "Working…" : ""));
		return [...t.slice(0, this.toolsAt), ...tools, ...t.slice(this.toolsAt), ...loader, "EDITOR", "FOOTER"];
	}
	invalidate(): void {}
}

function countLines(lines: string[], prefix: RegExp): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of lines) {
		const id = line.match(prefix)?.[0];
		if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return counts;
}

async function endTurn(rows: number, tools: number, loader: number, height: number, edited = -1) {
	const terminal = new VirtualTerminal(80, height);
	const tui = new TUI(terminal);
	const component = new Transcript(rows, tools, loader, 20);
	tui.addChild(component);
	tui.start();
	await terminal.waitForRender();
	component.collapsed = true;
	component.edited = edited;
	tui.requestRender(true);
	await terminal.waitForRender();
	tui.stop();
	return { terminal, all: [...terminal.getScrollBuffer()], viewport: terminal.getViewport() };
}

describe("forced shrink that deletes rows above the overlap and below the screen top", () => {
	for (const [tools, loader, height] of [
		[30, 2, 20],
		[5, 2, 20],
		[200, 2, 46],
		[30, 8, 20],
	]) {
		it(`re-emits no scrollback (tools ${tools}, loader ${loader}, height ${height})`, async () => {
			const rows = tools > 100 ? 300 : 80;
			const { all, viewport } = await endTurn(rows, tools, loader, height);
			const duplicated = [...countLines(all, /^T\d{3}/)].filter(([, n]) => n > 1).map(([id]) => id);
			assert.deepStrictEqual(duplicated, [], `duplicated transcript lines: ${duplicated.join(", ")}`);
			assert.strictEqual(countLines(all, /^T\d{3}/).size, rows, "every transcript line is still there");
			assert.ok(
				viewport.some((l) => l.startsWith("FOOTER")),
				`the frame tail is on screen: ${JSON.stringify(viewport)}`,
			);
			const trailingBlanks = [...viewport].reverse().findIndex((l) => l.trim() !== "");
			assert.ok(
				trailingBlanks <= Math.floor(height / 2),
				`the aligned screen leaves at most half the screen blank (#613): ${trailingBlanks} of ${height}`,
			);
		});
	}

	it("keeps the refill when a row it would re-emit was edited, so the edit stays visible", async () => {
		const { all } = await endTurn(80, 30, 2, 20, 63);
		assert.ok(all.some((l) => l.startsWith("T063 transcript EDITED")), "the edited row is shown");
	});

	// An above-screen edit (a reply header gaining its timestamp, #2582) must
	// not send the compound shrink back to the refill: the edit is hidden by
	// license, and the refill would re-emit the skipped scrollback rows.
	it("keeps the aligned repaint when a row above the viewport was edited", async () => {
		const { all } = await endTurn(80, 30, 2, 20, 10);
		const duplicated = [...countLines(all, /^T\d{3}/)].filter(([, n]) => n > 1).map(([id]) => id);
		assert.deepStrictEqual(duplicated, [], `duplicated transcript lines: ${duplicated.join(", ")}`);
		assert.strictEqual(countLines(all, /^T\d{3}/).size, 80, "every transcript line is still there");
	});

	// The blank cap bounds the aligned screen's TOTAL trailing blanks — the
	// padding plus the frame's own trailing visually-blank lines (#613;
	// space-only and zero-width rows render blank too) — so a frame that ends
	// in blanks cannot compound into a mostly-blank screen.
	for (const blank of ["", " ", "\u200b"]) {
		it(`refills when the frame's own trailing blanks (${JSON.stringify(blank)}) would compound past half the screen`, async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui = new TUI(terminal);
			const component = new Transcript(0, 0, 0, 0);
			const p = (n: number) => `p${n}`;
			component.render = () =>
				component.collapsed
					? [p(0), p(4), p(5), p(6), "A", blank, blank]
					: [p(0), p(1), p(2), p(3), p(4), p(5), p(6), "A", "B", "C", "D", blank, blank];
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();
			component.collapsed = true;
			tui.requestRender(true);
			await terminal.waitForRender();
			tui.stop();
			const viewport = terminal.getViewport();
			const trailingBlanks = [...viewport].reverse().findIndex((l) => l.trim() !== "");
			assert.ok(
				trailingBlanks <= 3,
				`at most half the screen may be blank (#613): ${trailingBlanks} of ${viewport.length} in ${JSON.stringify(viewport)}`,
			);
			for (const row of ["p4", "p5", "p6", "A"]) {
				assert.ok(
					terminal.getScrollBuffer().some((l) => l === row),
					`surviving row ${row} stays visible`,
				);
			}
		});
	}

	// A visible emoji row is content, not a blank: astral characters are read
	// as whole code points, so a frame ending in emoji keeps the retention
	// (which repaints them) instead of miscounting the row as blank, falling
	// to the refill, and duplicating the rolled-up rows.
	it("treats astral-character rows as content when counting trailing blanks", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const component = new Transcript(0, 0, 0, 0);
		const p = (n: number) => `p${n}`;
		component.render = () =>
			component.collapsed
				? [p(0), p(4), p(5), p(6), "A", "😀", "😀"]
				: [p(0), p(1), p(2), p(3), p(4), p(5), p(6), "A", "B", "C", "D", "😀", "😀"];
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		component.collapsed = true;
		tui.requestRender(true);
		await terminal.waitForRender();
		tui.stop();
		const buffer = terminal.getScrollBuffer();
		for (const row of ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "A"]) {
			assert.strictEqual(
				buffer.filter((l) => l === row).length,
				1,
				`row ${row} appears exactly once: ${JSON.stringify(buffer)}`,
			);
		}
	});

	// A hidden above-screen edit (the licensed #2582 hide) must not let a
	// later compound shrink destroy the edited value's last physical copy:
	// when a candidate removes a value from the visible screen while still
	// displaying it above the aligned top, the retention is refused and the
	// loss-free refill runs.
	it("refills when a removed screen row's value could lean on a hidden edit above the boundary", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const component = new Transcript(0, 0, 0, 0);
		const frames = [
			["B", "B", "B", "B", "P", "Q", "R", "A", "C", "D", "E", "F"],
			// the edit above the screen top is committed but never shown
			["B", "B", "B", "B", "A", "Q", "R", "A", "C", "D", "E", "F"],
			// the shrink deletes the hidden edit's row and three B rows
			["B", "A", "Q", "C", "D", "E", "F"],
		];
		let step = 0;
		component.render = () => frames[step] ?? frames[frames.length - 1];
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		step = 1;
		tui.requestRender(true);
		await terminal.waitForRender();
		step = 2;
		tui.requestRender(true);
		await terminal.waitForRender();
		tui.stop();
		const visible = terminal.getScrollBuffer().filter((l) => l === "A").length;
		assert.ok(
			visible >= 1,
			`the surviving "A" row stays visible (loss-free): ${JSON.stringify(terminal.getScrollBuffer())}`,
		);
	});

	// Repetition must not let the two-seam alignment double-book scrollback
	// copies: every surviving row of the new frame has to stay visible in the
	// terminal, even when identical rows let a wrong deletion split verify.
	// Loss-free over duplicate-free (#2415) — the refill this falls back to
	// duplicates, but never destroys.
	it("shows every surviving row when repeated content could double-book scrollback copies", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const component = new Transcript(0, 0, 0, 0);
		component.render = () => (component.collapsed ? Array.from({ length: 7 }, () => "A") : ["B", "B", "A", "A", "A", "A", "A", "A", "B", "A", "B"]);
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		component.collapsed = true;
		tui.requestRender(true);
		await terminal.waitForRender();
		tui.stop();
		const buffer = terminal.getScrollBuffer();
		const visible = buffer.filter((l) => l === "A").length;
		assert.ok(
			visible >= 7,
			`every surviving row stays visible (loss-free over duplicate-free): ${visible} of 7 "A" rows in ${JSON.stringify(buffer)}`,
		);
	});

	// The aligned commit demotes the flush mark to the aligned top and pads
	// the frame; a later append must fill the screen in place without
	// re-committing the skipped rows or destroying the retained ones.
	it("appends cleanly after the compound-shrink repaint", async () => {
		const terminal = new VirtualTerminal(80, 20);
		const tui = new TUI(terminal);
		const component = new Transcript(80, 30, 2, 20);
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		component.collapsed = true;
		tui.requestRender(true);
		await terminal.waitForRender();
		component.rows = 81;
		tui.requestRender();
		await terminal.waitForRender();
		tui.stop();
		const counts = countLines(terminal.getScrollBuffer(), /^T\d{3}/);
		const duplicated = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
		assert.deepStrictEqual(duplicated, [], `duplicated transcript lines after append: ${duplicated.join(", ")}`);
		assert.strictEqual(counts.size, 81, "every transcript line is still there");
		assert.ok(
			terminal.getViewport().some((l) => l.startsWith("T080")),
			`the appended row is visible: ${JSON.stringify(terminal.getViewport())}`,
		);
	});
});
