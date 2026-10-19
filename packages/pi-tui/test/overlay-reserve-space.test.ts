import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, type MouseEvent, type OverlayOptions, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Block implements Component {
	height: number;
	private prefix: string;
	mouseEvents: MouseEvent[] = [];

	constructor(prefix: string, height: number) {
		this.prefix = prefix;
		this.height = height;
	}

	render(): string[] {
		return Array.from({ length: this.height }, (_, i) => `${this.prefix}${String(i).padStart(2, "0")}`);
	}
	invalidate() {}
	handleMouse(event: MouseEvent): void {
		this.mouseEvents.push(event);
	}
}

const ROWS = 20;
const SUMMARY = 40; // taller than the screen, like a long depth summary

async function open(t: { after: (fn: () => void) => void }, options: OverlayOptions, dialog: Block) {
	const terminal = new VirtualTerminal(60, ROWS);
	const tui = new TUI(terminal);
	tui.addChild(new Block("SUM", SUMMARY));
	tui.start();
	t.after(() => tui.stop());
	await terminal.waitForRender();
	const handle = tui.showOverlay(dialog, options);
	await terminal.waitForRender();
	return { terminal, tui, handle };
}

describe("TUI overlay reserveSpace", () => {
	it("a floating overlay paints over the content above it", async (t) => {
		const { terminal, tui } = await open(t, { anchor: "bottom-center" }, new Block("DLG", 6));
		const viewport = terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("DLG")), "dialog is shown");
		assert.ok(!viewport.some((line) => line.startsWith("SUM39")), "last summary line is covered");
	});

	it("a docked overlay pushes the content up instead of covering it", async (t) => {
		const { terminal, tui } = await open(t, { reserveSpace: true }, new Block("DLG", 6));
		const viewport = terminal.getViewport();
		const dialogRows = viewport.map((line, i) => (line.includes("DLG") ? i : -1)).filter((i) => i >= 0);
		assert.strictEqual(dialogRows.length, 6, "all dialog rows are shown");
		assert.strictEqual(dialogRows[dialogRows.length - 1], ROWS - 1, "dialog sits on the bottom rows");
		assert.ok(viewport.some((line) => line.startsWith("SUM39")), "last summary line stays visible");
		assert.strictEqual(
			viewport.filter((line) => line.startsWith("SUM")).length,
			ROWS - 6,
			"the rows above the dialog are all content",
		);
	});

	it("a docked overlay hands the screen back when hidden", async (t) => {
		const { terminal, tui, handle } = await open(t, { reserveSpace: true }, new Block("DLG", 6));
		handle.hide();
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		assert.ok(!viewport.some((line) => line.includes("DLG")), "dialog is gone");
		assert.ok(viewport.some((line) => line.startsWith("SUM39")), "content is intact");
	});

	it("a docked overlay keeps its tallest height so the frame never shrinks while shown", async (t) => {
		const dialog = new Block("DLG", 8);
		const { terminal, tui } = await open(t, { reserveSpace: true }, dialog);
		dialog.height = 3;
		tui.requestRender();
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		const dialogRows = viewport.map((line, i) => (line.includes("DLG") ? i : -1)).filter((i) => i >= 0);
		assert.strictEqual(dialogRows.length, 3);
		assert.strictEqual(dialogRows[dialogRows.length - 1], ROWS - 1, "still bottom-aligned");
		assert.strictEqual(viewport.filter((line) => line.startsWith("SUM")).length, ROWS - 8, "content rows unchanged");
	});

	it("docked rows never exceed the terminal height", async (t) => {
		const { terminal } = await open(t, { reserveSpace: true }, new Block("DLG", ROWS + 10));
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport.length, ROWS);
		assert.strictEqual(viewport.filter((line) => line.includes("DLG")).length, ROWS);
	});

	it("on short content the docked overlay still sits on the bottom rows", async (t) => {
		const terminal = new VirtualTerminal(60, ROWS);
		const tui = new TUI(terminal);
		t.after(() => tui.stop());
		tui.addChild(new Block("SUM", 3));
		tui.showOverlay(new Block("DLG", 5), { reserveSpace: true });
		tui.start();
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		assert.ok(viewport[0].startsWith("SUM00") && viewport[2].startsWith("SUM02"), "content stays at the top");
		assert.ok(viewport[ROWS - 1].includes("DLG04"), "dialog ends on the last row");
		assert.ok(viewport[ROWS - 5].includes("DLG00"), "dialog is five rows tall");
	});

	it("a float opened after a dock paints over it (focus order, not kind)", async (t) => {
		const { terminal, tui } = await open(t, { reserveSpace: true }, new Block("DLG", 6));
		tui.showOverlay(new Block("FLT", 3), { anchor: "bottom-center" });
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		// The float overlaps the dock's bottom rows and is newer, so it wins there.
		for (let i = 0; i < 3; i++) {
			assert.ok(viewport[ROWS - 3 + i].includes(`FLT0${i}`), `float row ${i} visible at the bottom`);
		}
		// The dock's rows above the float stay visible.
		assert.ok(viewport[ROWS - 6].includes("DLG00"), "dock rows above the float remain visible");
	});

	it("the dock's mouse region covers only its real rows, not retained padding", async (t) => {
		const dialog = new Block("DLG", 8);
		const { terminal, tui } = await open(t, { reserveSpace: true }, dialog);
		dialog.height = 3;
		tui.requestRender();
		await terminal.waitForRender();
		// Reserved block is 8 rows (rows 12..19); the 3 actual rows sit at 17..19.
		terminal.sendInput("\x1b[<0;1;18M"); // press at 1-based col 1, row 18 -> first actual dock row
		await terminal.waitForRender();
		assert.equal(dialog.mouseEvents.length, 1, "dock receives the click");
		assert.equal(dialog.mouseEvents[0].y, 0, "first visible dock row maps to local y 0");
	});

	it("open, shrink and close never duplicate transcript lines into scrollback", async (t) => {
		const dialog = new Block("DLG", 8);
		const { terminal, tui, handle } = await open(t, { reserveSpace: true }, dialog);
		dialog.height = 3;
		tui.requestRender();
		await terminal.waitForRender();
		handle.hide();
		await terminal.waitForRender();
		const counts = new Map<string, number>();
		for (const line of terminal.getScrollBuffer()) {
			const m = line.match(/^SUM(\d\d)$/);
			if (m) counts.set(line, (counts.get(line) ?? 0) + 1);
		}
		for (const [line, count] of counts) {
			assert.equal(count, 1, `${line} appears ${count} times in scrollback (re-emitted transcript)`);
		}
		assert.ok(counts.size > 0, "summary lines reached scrollback at all");
	});
});
