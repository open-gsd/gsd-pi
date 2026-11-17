import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@gsd/pi-tui";
import { AttentionOverlayController } from "./attention-overlay.ts";
import { AttentionOverlayComponent, wrapText } from "./attention-overlay-component.ts";
import type { AttentionSource } from "./attention-model.ts";

const kb = { matches: (data: string, action: string) => data === ({
	"tui.select.confirm": "enter", "tui.select.cancel": "esc",
	"tui.select.pageDown": "pgdn", "tui.select.pageUp": "pgup",
	"tui.select.down": "down", "tui.select.up": "up",
} as Record<string, string>)[action] };

async function fixture(n: number, width: number, height: () => number, allSources = false) {
	const description = Array.from({ length: 70 }, (_, i) => `body${i}`).join(" ") + " TAILEND";
	const sources: AttentionSource[] = [{ namespace: "workflow", status: "available", completeness: "complete",
		rows: Array.from({ length: n }, (_, i) => ({ blockerId: `W-${i}`, blockerKind: "consent", resolutionOwner: "user", description })) as never }];
	if (allSources) sources.push(
		{ namespace: "auto-pause", status: "available", completeness: "complete", rows: [{ blockerId: "P-1", description }] as never },
		{ namespace: "interaction", status: "available", completeness: "complete", rows: [{ id: "Q-1", description }] as never },
	);
	const controller = new AttentionOverlayController({ readSnapshot: async () => ({ projectKey: "project", sources }) });
	const component = new AttentionOverlayComponent(controller, kb, () => {}, height);
	await controller.open();
	controller.select(Math.floor(n / 2));
	controller.handleKey("cancel"); // select() focuses details; make this fixture a genuine closed overview.
	return { controller, component, width };
}

function fullCounter(out: string[], selected: number, total: number, width: number) {
	const expected = wrapText(`(${selected + 1}-${selected + 1} of ${total})`, width);
	const at = out.findIndex((line) => line === expected[0]);
	assert.ok(at >= 0, `complete counter required: ${JSON.stringify(out)}`);
	assert.deepEqual(out.slice(at, at + expected.length), expected);
	return at + expected.length;
}

test("compact high-count height-5 details reserve BODY, not a decorative header; tail is reachable", async () => {
	for (const n of [100, 120, 200]) for (const width of [8, 10, 12]) for (const allSources of [false, true]) {
		const { controller, component } = await fixture(n, width, () => 5, allSources);
		component.handleInput("enter");
		const seen: string[] = [];
		for (let step = 0; step < 160; step++) {
			const out = component.render(width);
			assert.ok(out.length <= 4);
			assert.equal(component.lastUnclippedOverflow, 0);
			assert.ok(out.every((line) => visibleWidth(line) <= width));
			assert.ok(out.some((line) => line.startsWith(">")), "selection visible");
			if (!allSources) assert.ok(out.some((line) => line.includes("Unread")), "compact view still admits unread coverage");
			const end = fullCounter(out, controller.state().selected, controller.state().items.length, width);
			assert.ok(out.length > end, "at least one separately rendered BODY row after complete counter");
			assert.ok(!out.slice(end).includes("Details:"), "one-row pane cannot spend its row on decoration");
			seen.push(...out.slice(end));
			const before = controller.state().detailScroll;
			component.handleInput("pgdn");
			if (controller.state().detailScroll === before) break;
		}
		assert.ok(seen.join("").includes("TAILEND"), `body tail reachable n=${n} w=${width} sources=${allSources}`);
		component.handleInput("pgup");
		assert.ok(controller.state().detailScroll >= 0);
		component.handleInput("down");
		assert.equal(controller.state().detailScroll, 0, "selection resets scroll");
	}
});

test("height-4 overview retains its full counter; detail mode admits the complete compact n/N counter, and Resize is reserved for a truly impossible span", async () => {
	for (const width of [8, 10, 12]) {
		const { controller, component } = await fixture(200, width, () => 4);
		const overview = component.render(width);
		fullCounter(overview, controller.state().selected, 200, width);
		assert.ok(overview.some((line) => line.includes("Unread")));
		component.handleInput("enter");
		const detail = component.render(width);
		// The normal counter cannot fit, but the complete compact n/N counter does: no false Resize.
		const selected = controller.state().selected;
		assert.ok(!detail.join(" ").includes("Resize"), `compact counter fits at height 4 width ${width}: ${JSON.stringify(detail)}`);
		assert.ok(detail.join(" ").includes("Unread"), "verdict stays visible: not all-clear");
		const compactLines = wrapText(`${selected + 1}/200`, width);
		const compactAt = detail.findIndex((l) => l === compactLines[0]);
		assert.ok(compactAt >= 0, `complete compact counter rendered: ${JSON.stringify(detail)}`);
		assert.deepEqual(detail.slice(compactAt, compactAt + compactLines.length), compactLines, "compact counter whole across wrapped rows");
		assert.ok(!detail.includes("Details:"), "no decorative header");
		assert.ok(detail.length <= 3);
		assert.equal(component.lastUnclippedOverflow, 0);
		component.handleInput("esc");
		fullCounter(component.render(width), controller.state().selected, 200, width);
	}
});

test("detail-body scroll clamps on resize and refresh, and resets on row selection", async () => {
	let height = 5;
	const { controller, component } = await fixture(120, 10, () => height);
	component.handleInput("enter");
	component.render(10);
	controller.scrollDetails(100000);
	component.render(10);
	const narrowEnd = controller.state().detailScroll;
	assert.ok(narrowEnd > 0);
	height = 16;
	component.render(80);
	assert.ok(controller.state().detailScroll < narrowEnd, "wider/taller body has a smaller measured scroll limit");
	await controller.refresh();
	component.render(80);
	assert.ok(controller.state().detailScroll >= 0);
	controller.select(0);
	assert.equal(controller.state().detailScroll, 0);
	height = 4;
	component.render(8);
	assert.equal(controller.state().detailScroll, 0, "unsupported detail mode has no phantom scroll area");
	height = 5;
	component.render(10);
	component.handleInput("pgdn");
	assert.ok(controller.state().detailScroll > 0, "supported body resumes without reopening details");
});
