import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, TUI } from "../tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// A tall frame shrinks while a docked (reserveSpace) overlay is open: the
// question dialog, an elicitation form. The tall→tall shrink path is skipped
// while an overlay is open, so the differential draws the shrink: it clears the
// freed rows in place and keeps the working area, so the screen top does not
// move. The shrink demotion has already lowered the flushed mark to
// `length - height`, below that screen top. The next tall shrink without an
// overlay (the overlay closing, the loader going at turn end) then rejects the
// kept top as "top > flushed" and realigns from `length - height`, writing the
// rows between the mark and the screen top a second time. Seen as the last
// lines of a reply (a table's bottom border and the paragraph under it)
// printed twice. A floating overlay never shrinks the frame (compositing pads
// it to the working area), so its cases are guards only.
class Reply implements Component {
	rows = Array.from({ length: 60 }, (_, i) => `N${String(i).padStart(3, "0")} reply`);
	tail = ["", "⠋ Working…", "  esc to interrupt"];
	render(_width: number): string[] {
		return [...this.rows, ...this.tail, "EDITOR", "FOOTER"];
	}
	invalidate(): void {}
}

const box: Component = { render: () => ["┌ overlay ┐", "│ content │", "└─────────┘"], invalidate() {} };

function counts(lines: string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const line of lines) {
		const id = line.match(/^N\d{3}/)?.[0];
		if (id) out.set(id, (out.get(id) ?? 0) + 1);
	}
	return out;
}

type Step = "show" | "hide" | "shrink" | "grow";

async function run(height: number, docked: boolean, steps: Step[]) {
	const terminal = new VirtualTerminal(80, height);
	const tui = new TUI(terminal);
	const reply = new Reply();
	tui.addChild(reply);
	tui.start();
	await terminal.waitForRender();
	let handle: { hide(): void } | undefined;
	for (const step of steps) {
		if (step === "show") handle = tui.showOverlay(box, docked ? { reserveSpace: true } : { anchor: "center" });
		if (step === "hide") handle?.hide();
		if (step === "shrink") reply.tail = reply.tail.slice(0, Math.max(0, reply.tail.length - 2));
		if (step === "grow") reply.rows.push(`N${String(reply.rows.length).padStart(3, "0")} reply`);
		tui.requestRender();
		await terminal.waitForRender();
	}
	tui.stop();
	return { seen: counts([...terminal.getScrollBuffer()]), expected: counts(reply.render(80)) };
}

describe("a tall frame that shrank under an overlay keeps its flushed mark at the screen top", () => {
	const cases: Array<[number, boolean, Step[]]> = [
		[46, true, ["show", "shrink", "hide"]], // the docked dialog closes after the reply shrank under it
		[46, true, ["show", "shrink", "hide", "grow", "shrink"]],
		[20, true, ["show", "grow", "shrink", "hide"]],
		[46, false, ["show", "shrink", "hide", "grow", "shrink"]], // a floating overlay, then the loader goes
		[20, false, ["show", "shrink", "grow", "hide", "shrink"]],
	];
	for (const [height, docked, steps] of cases) {
		it(`re-emits no row (height ${height}, ${docked ? "docked" : "floating"}, ${steps.join(" → ")})`, async () => {
			const { seen, expected } = await run(height, docked, steps);
			const missing = [...expected].filter(([id, n]) => (seen.get(id) ?? 0) < n).map(([id]) => id);
			assert.deepStrictEqual(missing, [], `rows that never reached the terminal: ${missing.join(", ")}`);
			const duplicated = [...seen].filter(([id, n]) => n > (expected.get(id) ?? 0)).map(([id]) => id);
			assert.deepStrictEqual(duplicated, [], `duplicated rows: ${duplicated.join(", ")}`);
		});
	}
});
