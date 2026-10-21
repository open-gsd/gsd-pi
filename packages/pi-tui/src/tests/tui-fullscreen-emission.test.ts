import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { type Component, TUI } from "../tui.js";
import type { Terminal } from "../terminal.js";

/**
 * Minimal recording terminal: no emulation, just captures writes so tests can
 * assert on the escape sequences the renderer emits. Runs in the compiled
 * dist-test set (see run-package-tests.cjs); the full viewport behavior suite
 * lives in test/tui-fullscreen.test.ts with an emulated terminal.
 */
class RecordingTerminal implements Terminal {
	writes = "";
	inputHandler?: (data: string) => void;
	resizeHandler?: () => void;

	get isTTY(): boolean {
		return true;
	}
	get columns(): number {
		return 20;
	}
	get rows(): number {
		return 10;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes += data;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

class StaticComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return [...this.lines];
	}
	invalidate(): void {}
}

/** Drain the renderer's nextTick + timer scheduling. */
async function settle(): Promise<void> {
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

let terminal: RecordingTerminal;
let tui: TUI;

beforeEach(() => {
	terminal = new RecordingTerminal();
	tui = new TUI(terminal);
});

afterEach(() => {
	// Always leave the alternate screen so a failed assertion cannot leak the
	// mode into the next test.
	tui.stop();
});

test("inline default renderer never emits alt-screen sequences", async () => {
	const component = new StaticComponent();
	component.lines = ["a", "b"];
	tui.addChild(component);
	tui.start();
	await settle();
	assert.ok(!terminal.writes.includes("\x1b[?1049"), "inline renderer must not touch the alternate screen");
});

test("fullscreen renders nothing before start() enters the alternate screen", async () => {
	const scroll = new StaticComponent();
	scroll.lines = ["L0", "L1"];
	tui.addChild(scroll);
	tui.setFullscreen(true);
	await settle();
	assert.ok(!terminal.writes.includes("\x1b[?1049h"), "no enter before start()");
	assert.equal(terminal.writes, "", "a render scheduled between setFullscreen and start must not paint the primary buffer");
});

test("fullscreen mode enters the alternate screen on start and leaves on stop", async () => {
	const scroll = new StaticComponent();
	for (let i = 0; i < 30; i++) scroll.lines.push(`L${i}`);
	const pinned = new StaticComponent();
	pinned.lines = ["PIN-A", "PIN-B"];
	tui.addChild(scroll);
	tui.addChild(pinned);
	tui.setFullscreenPinBoundary(pinned);
	tui.setFullscreen(true);
	assert.ok(!terminal.writes.includes("\x1b[?1049h"), "no enter before start()");
	tui.start();
	await settle();
	assert.ok(terminal.writes.includes("\x1b[?1049h"), "start must enter the alternate screen");
	assert.ok(terminal.writes.includes("PIN-A"), "the pinned tail renders");

	terminal.writes = "";
	tui.stop();
	assert.ok(terminal.writes.includes("\x1b[?1049l"), "stop must leave the alternate screen");
	assert.ok(!terminal.writes.includes("\x1b[?1049h"), "stop must not re-enter");
});

test("fullscreen scrolling freezes the viewport against appends", async () => {
	const scroll = new StaticComponent();
	for (let i = 0; i < 30; i++) scroll.lines.push(`L${i}`);
	const pinned = new StaticComponent();
	pinned.lines = ["PIN-A", "PIN-B"];
	tui.addChild(scroll);
	tui.addChild(pinned);
	tui.setFullscreenPinBoundary(pinned);
	tui.setFullscreen(true);
	tui.start();
	await settle();

	terminal.inputHandler?.("\x1b[5~"); // pageUp: freeze one page up
	await settle();
	// Viewport is 8 rows (10 minus the 2-row pinned tail); the page step
	// overlaps the hint row, so the window pins at L15 with the hint below it.
	assert.ok(terminal.writes.includes("L15"), "pageUp scrolled to the frozen window");
	assert.ok(terminal.writes.includes("new lines"), "frozen frame carries the new-lines hint");

	terminal.writes = "";
	scroll.lines.push("L30");
	tui.requestRender();
	await settle();
	assert.ok(!terminal.writes.includes("L16"), "appends must not move the frozen window");
	assert.ok(terminal.writes.includes("8 new lines"), "the hint counts the appended line");

	terminal.writes = "";
	terminal.inputHandler?.("\x1b[8^"); // ctrl+end: back to the live bottom
	await settle();
	assert.ok(terminal.writes.includes("L30"), "jump returns to the live bottom");

	tui.stop();
});
