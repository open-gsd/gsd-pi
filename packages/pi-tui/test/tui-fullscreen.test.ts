import assert from "node:assert";
import { describe, it } from "node:test";
import { shouldEnableMouseReporting } from "../src/terminal.ts";
import { type Component, type MouseEvent, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Renders a fixed list of lines; mutated by tests to simulate transcript growth. */
class ListComponent implements Component {
	lines: string[] = [];
	handleMouse?: (event: MouseEvent) => void;
	render(_width: number): string[] {
		return [...this.lines];
	}
	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

const WHEEL_UP = "\x1b[<64;10;5M";
const WHEEL_DOWN = "\x1b[<65;10;5M";

interface Setup {
	terminal: LoggingVirtualTerminal;
	tui: TUI;
	scroll: ListComponent;
	pinned: ListComponent;
}

/** 10-row terminal: 8 transcript viewport rows over a 2-row pinned tail. */
async function setupFullscreen(): Promise<Setup> {
	const terminal = new LoggingVirtualTerminal(20, 10);
	const tui = new TUI(terminal);
	const scroll = new ListComponent();
	const pinned = new ListComponent();
	for (let i = 0; i < 30; i++) {
		scroll.lines.push(`L${i}`);
	}
	pinned.lines = ["PIN-A", "PIN-B"];
	tui.addChild(scroll);
	tui.addChild(pinned);
	tui.setFullscreenPinBoundary(pinned);
	tui.setFullscreen(true);
	tui.start();
	await terminal.waitForRender();
	return { terminal, tui, scroll, pinned };
}

describe("TUI fullscreen (alternate screen) mode", () => {
	it("inline default renderer never emits alt-screen sequences", async () => {
		const terminal = new LoggingVirtualTerminal(20, 10);
		const tui = new TUI(terminal);
		const component = new ListComponent();
		component.lines = ["a", "b"];
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();
		tui.stop();

		const writes = terminal.getWrites();
		assert.ok(!writes.includes("\x1b[?1049"), "inline renderer must not touch the alternate screen");
	});

	it("enters the alternate screen on start and leaves it on stop", async () => {
		const { terminal, tui } = await setupFullscreen();
		assert.ok(terminal.getWrites().includes("\x1b[?1049h"), "start must enter the alternate screen");
		terminal.clearWrites();
		tui.stop();
		assert.ok(terminal.getWrites().includes("\x1b[?1049l"), "stop must leave the alternate screen");
	});

	it("shows the transcript viewport above the pinned tail and follows new output while live", async () => {
		const { terminal, tui, scroll } = await setupFullscreen();

		let view = terminal.getViewport();
		assert.equal(view[0], "L22");
		assert.equal(view[7], "L29");
		assert.equal(view[8], "PIN-A", "pinned tail owns the bottom rows");
		assert.equal(view[9], "PIN-B");

		// Live mode follows the bottom.
		scroll.lines.push("L30");
		tui.requestRender();
		await terminal.waitForRender();
		view = terminal.getViewport();
		assert.equal(view[7], "L30");
		assert.equal(view[8], "PIN-A");

		tui.stop();
	});

	it("pageUp freezes the viewport: appends do not move it and the hint counts new lines", async () => {
		const { terminal, tui, scroll } = await setupFullscreen();

		terminal.sendInput("\x1b[5~"); // pageUp
		await terminal.waitForRender();

		let view = terminal.getViewport();
		assert.equal(view[0], "L15", "pageUp scrolls up by viewport-1");
		assert.equal(view[6], "L21");
		// The hint truncates on narrow terminals; assert the count, not the tail.
		assert.ok(view[7].includes("7 new lines"), `hint on the bottom viewport row: ${JSON.stringify(view[7])}`);

		// New output while frozen must not move the viewport.
		scroll.lines.push("L30", "L31", "L32");
		tui.requestRender();
		await terminal.waitForRender();
		view = terminal.getViewport();
		assert.equal(view[0], "L15", "frozen viewport must not move on appends");
		assert.equal(view[6], "L21");
		assert.ok(view[7].includes("10 new lines"), `hint counts appends: ${JSON.stringify(view[7])}`);

		// ctrl+end jumps back to the live bottom.
		terminal.sendInput("\x1b[8^"); // ctrl+end
		await terminal.waitForRender();
		view = terminal.getViewport();
		assert.equal(view[0], "L25");
		assert.equal(view[7], "L32");

		tui.stop();
	});

	it("wheel events scroll the transcript viewport", async () => {
		const { terminal, tui } = await setupFullscreen();

		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();
		let view = terminal.getViewport();
		assert.equal(view[0], "L19", "wheel-up scrolls three lines up");
		assert.ok(view[7].includes("3 new lines"));

		terminal.sendInput(WHEEL_DOWN);
		await terminal.waitForRender();
		view = terminal.getViewport();
		assert.equal(view[0], "L22", "wheel-down returns to the live bottom");
		assert.equal(view[7], "L29", "no hint once live");

		tui.stop();
	});

	it("rewrites only changed rows: unchanged pinned rows stay untouched", async () => {
		const { terminal, tui, scroll } = await setupFullscreen();
		terminal.clearWrites();

		scroll.lines.push("L30");
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(!terminal.getWrites().includes("PIN-A"), "unchanged pinned rows must not be rewritten");
		tui.stop();
	});

	it("resize re-lays out the grid: the pinned tail stays on the bottom rows", async () => {
		const { terminal, tui } = await setupFullscreen();

		terminal.resize(20, 6);
		await terminal.waitForRender();

		const view = terminal.getViewport();
		assert.equal(view[0], "L26");
		assert.equal(view[3], "L29");
		assert.equal(view[4], "PIN-A");
		assert.equal(view[5], "PIN-B");
		tui.stop();
	});

	it("retireScreenToScrollback clears the alt screen instead of scrolling into scrollback", async () => {
		const { terminal, tui } = await setupFullscreen();
		terminal.clearWrites();

		tui.retireScreenToScrollback();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(writes.includes("\x1b[2J"), "alt screen is cleared in place");
		assert.ok(!writes.includes("\x1b[10;1H"), "no scroll-into-scrollback dance on the alternate screen");

		// The renderer restarts cleanly: the next frame rewrites from the top.
		assert.ok(terminal.getViewport()[8] === "PIN-A");
		tui.stop();
	});

	it("pageUp steps overlap the hint row so no transcript line is skipped", async () => {
		const { terminal, tui } = await setupFullscreen();

		terminal.sendInput("\x1b[5~"); // pageUp
		await terminal.waitForRender();
		let view = terminal.getViewport();
		assert.equal(view[0], "L15", "page step is viewport-1: the hint row overlaps");

		terminal.sendInput("\x1b[5~"); // pageUp again
		await terminal.waitForRender();
		view = terminal.getViewport();
		assert.equal(view[0], "L8", "consecutive pages tile the transcript without gaps");

		tui.stop();
	});

	it("width change drops the frozen anchor and returns to the live bottom", async () => {
		const { terminal, tui } = await setupFullscreen();

		terminal.sendInput("\x1b[5~"); // freeze at L14
		await terminal.waitForRender();

		terminal.resize(40, 10); // reflow invalidates the line-index anchor
		await terminal.waitForRender();

		const view = terminal.getViewport();
		assert.equal(view[7], "L29", "live bottom after reflow");
		assert.ok(!view.some((line) => line.includes("new lines")), "no hint once live");
		tui.stop();
	});

	it("clicks route to the component under the pointer", async () => {
		const terminal = new LoggingVirtualTerminal(20, 10);
		const tui = new TUI(terminal);
		const scroll = new ListComponent();
		for (let i = 0; i < 30; i++) {
			scroll.lines.push(`L${i}`);
		}
		const clickable = new ListComponent();
		const clicks: string[] = [];
		clickable.lines = ["PIN-A"];
		clickable.handleMouse = (event) => {
			clicks.push(`${event.x},${event.y}`);
		};
		tui.addChild(scroll);
		tui.addChild(clickable);
		tui.setFullscreenPinBoundary(clickable);
		tui.setFullscreen(true);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		// SGR click at column 3, row 10 (1-based) = screen (2, 9); the pinned
		// row starts at grid row 9, so the component sees (2, 0).
		terminal.sendInput("\x1b[<0;3;10M");
		await terminal.waitForRender();

		assert.deepEqual(clicks, ["2,0"]);
		tui.stop();
	});

	it("setFullscreen(false) leaves the alternate screen and restores inline rendering", async () => {
		const { terminal, tui } = await setupFullscreen();
		terminal.clearWrites();

		tui.setFullscreen(false);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(writes.includes("\x1b[?1049l"), "leaving must restore the primary buffer");

		// Inline rendering resumes on the primary buffer.
		tui.requestRender();
		await terminal.waitForRender();
		const view = terminal.getViewport();
		assert.ok(view.some((line) => line.startsWith("L")), "inline frame repaints the primary buffer");
		tui.stop();
	});
});

describe("mouse reporting opt-in", () => {
	it("is enabled by PI_TUI_MOUSE=1 or PI_TUI_FULLSCREEN=1", () => {
		assert.equal(shouldEnableMouseReporting({}), false);
		assert.equal(shouldEnableMouseReporting({ PI_TUI_MOUSE: "1" }), true);
		assert.equal(shouldEnableMouseReporting({ PI_TUI_FULLSCREEN: "1" }), true);
	});
});
