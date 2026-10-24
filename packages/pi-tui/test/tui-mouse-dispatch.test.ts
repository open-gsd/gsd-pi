import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { SelectList, type SelectListTheme } from "../src/components/select-list.ts";
import { Container, type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "../src/tests/virtual-terminal.ts";

const theme: SelectListTheme = {
	selectedPrefix: (t) => t,
	selectedText: (t) => t,
	description: (t) => t,
	scrollInfo: (t) => t,
	noMatch: (t) => t,
};

class InputRecorder implements Component {
	readonly inputs: string[] = [];
	render(): string[] {
		return [""];
	}
	handleInput(data: string): void {
		this.inputs.push(data);
	}
	invalidate(): void {}
}

class EmptyContent implements Component {
	render(): string[] {
		return [];
	}
	invalidate(): void {}
}

// A fixed-height filler so base content reaches/exceeds the screen height,
// matching a real session where chat history fills the viewport.
class Filler implements Component {
	constructor(private lineCount: number) {}
	render(): string[] {
		return Array.from({ length: this.lineCount }, (_, i) => `line ${i}`);
	}
	invalidate(): void {}
}

async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

describe("TUI mouse dispatch", () => {
	it("does not deliver mouse sequences to a focused component as keystrokes", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();

		tui.setFocus(recorder);
		tui.start();
		await renderAndFlush(tui, terminal);

		terminal.sendInput("\x1b[<0;5;5M");

		assert.deepStrictEqual(recorder.inputs, []);
		tui.stop();
	});

	it("routes a click inside an overlay list to the clicked item", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);

		const items = [
			{ value: "one", label: "One" },
			{ value: "two", label: "Two" },
			{ value: "three", label: "Three" },
		];
		const list = new SelectList(items, 10, theme);
		const selected: string[] = [];
		list.onSelect = (item) => selected.push(item.value);

		tui.addChild(new EmptyContent());
		// Anchor at a known top-left position so screen rows map to item rows.
		tui.showOverlay(list, { anchor: "top-left", margin: 0, width: 40 });
		tui.start();
		await renderAndFlush(tui, terminal);

		// Overlay top-left => row 0 is "One", row 2 is "Three" (1-based y).
		terminal.sendInput("\x1b[<0;3;3M");

		assert.deepStrictEqual(selected, ["three"]);
		tui.stop();
	});

	it("routes wheel events inside an overlay list to move the selection", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);

		const items = [
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
			{ value: "c", label: "C" },
		];
		const list = new SelectList(items, 10, theme);
		const changes: string[] = [];
		list.onSelectionChange = (item) => changes.push(item.value);

		tui.addChild(new EmptyContent());
		tui.showOverlay(list, { anchor: "top-left", margin: 0, width: 40 });
		tui.start();
		await renderAndFlush(tui, terminal);

		// Wheel down once: selection moves from "a" to "b".
		terminal.sendInput("\x1b[<65;1;1M");
		assert.strictEqual(list.getSelectedItem()?.value, "b");
		assert.deepStrictEqual(changes, ["b"]);
		tui.stop();
	});

	it("routes a click through a Box-wrapped overlay to its child", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);

		const items = [
			{ value: "one", label: "One" },
			{ value: "two", label: "Two" },
		];
		const list = new SelectList(items, 10, theme);
		const selected: string[] = [];
		list.onSelect = (item) => selected.push(item.value);

		// Box with 1 row of top padding and 2 cols of left padding.
		const box = new Box(2, 1);
		box.addChild(list);

		tui.addChild(new EmptyContent());
		tui.showOverlay(box, { anchor: "top-left", margin: 0, width: 40 });
		tui.start();
		await renderAndFlush(tui, terminal);

		// Box top padding pushes "One" to screen row 1 (y=2), col offset 2 (x>=3).
		terminal.sendInput("\x1b[<0;4;2M");

		assert.deepStrictEqual(selected, ["one"]);
		tui.stop();
	});

	it("routes a click to a base-content list when content fills the screen", async () => {
		const rows = 24;
		const terminal = new VirtualTerminal(80, rows);
		const tui = new TUI(terminal);

		const items = [
			{ value: "alpha", label: "Alpha" },
			{ value: "beta", label: "Beta" },
			{ value: "gamma", label: "Gamma" },
		];
		const list = new SelectList(items, 10, theme);
		const selected: string[] = [];
		list.onSelect = (item) => selected.push(item.value);

		// editorContainer-style wrapper containing the focused list.
		const editorContainer = new Container();
		editorContainer.addChild(list);

		// Tall history above the selector so content fills the viewport.
		tui.addChild(new Filler(40));
		tui.addChild(editorContainer);
		tui.setFocus(list);
		tui.start();
		await renderAndFlush(tui, terminal);

		// Content is 43 lines (40 filler + 3 items), bottom-aligned in 24 rows:
		// the 3 list items occupy the last 3 screen rows (y = 22, 23, 24).
		// Click the middle item ("Beta") at y = 23.
		terminal.sendInput("\x1b[<0;5;23M");

		assert.deepStrictEqual(selected, ["beta"]);
		tui.stop();
	});

	it("ignores base-content clicks above the rendered content", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);

		const items = [{ value: "alpha", label: "Alpha" }];
		const list = new SelectList(items, 10, theme);
		const selected: string[] = [];
		list.onSelect = (item) => selected.push(item.value);

		const editorContainer = new Container();
		editorContainer.addChild(list);
		tui.addChild(editorContainer);
		tui.setFocus(list);
		tui.start();
		await renderAndFlush(tui, terminal);

		// Only one content line; it sits at the bottom (y = 24). A click near the
		// top of the screen lands in the empty area and must not select anything.
		terminal.sendInput("\x1b[<0;5;3M");

		assert.deepStrictEqual(selected, []);
		tui.stop();
	});
});
