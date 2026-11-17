import assert from "node:assert/strict";
import { test } from "node:test";
import { AttentionOverlayController, type AttentionReader } from "./attention-overlay.ts";
import { AttentionOverlayComponent, wrapText, type AttentionKeybindings } from "./attention-overlay-component.ts";
import type { AttentionSource } from "./attention-model.ts";

// App keybinding stub: only the four navigation actions exist. Raw bytes map to actions.
const KEY = { CANCEL: "\u001b", ENTER: "\r", UP: "\u001b[A", DOWN: "\u001b[B", APPROVE: "a", RETRY: "r", RESOLVE: "x", DISMISS: "d", RECOVER: "R" };
const kb: AttentionKeybindings = {
	matches: (data, action) => ({
		"tui.select.cancel": data === KEY.CANCEL,
		"tui.select.confirm": data === KEY.ENTER,
		"tui.select.up": data === KEY.UP,
		"tui.select.down": data === KEY.DOWN,
	})[action],
};

const workflowRow = { blockerId: "W-1", blockerKind: "consent", resolutionOwner: "user", description: "Confirm deploy", openedProjectRevision: 3 };
const pauseRow = { blockerId: "P-9", blockerKind: "user_request", resolutionOwner: "user", description: "Pause request", openedProjectRevision: 4 };

function reader(sources: AttentionSource[]): { r: AttentionReader; sent: string[]; calls: { n: number } } {
	const sent: string[] = [];
	const calls = { n: 0 };
	const r: AttentionReader = { readSnapshot: async () => { calls.n++; return { projectKey: "P1", sources }; } };
	return { r, sent, calls };
}

async function mounted(sources: AttentionSource[], sendCommand?: (c: string) => void) {
	const { r, sent, calls } = reader(sources);
	const controller = new AttentionOverlayController(r, { sendCommand: (c) => { sent.push(c); sendCommand?.(c); } });
	let closed = 0;
	const component = new AttentionOverlayComponent(controller, kb, () => { closed++; });
	await controller.open();
	return { controller, component, sent, calls, closed: () => closed };
}

const wf: AttentionSource[] = [{ namespace: "workflow", status: "available", completeness: "complete", rows: [workflowRow] as never }];
const mixed: AttentionSource[] = [
	{ namespace: "workflow", status: "available", completeness: "complete", rows: [workflowRow] as never },
	{ namespace: "auto-pause", status: "available", completeness: "complete", rows: [pauseRow] as never },
];

test("open renders the item list; opening a row shows details and sends nothing", async () => {
	const m = await mounted(wf);
	m.component.handleInput(KEY.ENTER);
	assert.equal(m.controller.state().detailsOpen, true);
	assert.deepEqual(m.sent, []);
	assert.ok(m.component.render(80).some((l) => l.includes("Confirm deploy")));
});

test("inspect navigation on a verified workflow blocker sends exactly the read-only inspect command", async () => {
	const m = await mounted(wf);
	m.controller.select(0);
	m.controller.requestInspect();
	assert.deepEqual(m.sent, ["/gsd blocker inspect W-1"]);
});

test("pause row inspect is refused with the exact inspect-only notice, nothing sent", async () => {
	const m = await mounted(mixed);
	m.controller.select(1);
	m.controller.requestInspect();
	assert.deepEqual(m.sent, []);
	assert.ok(m.controller.state().notice.startsWith("No verified owner-controlled destination"));
});

test("Escape-equivalent cancel closes details first, then closes the overlay and reports close once", async () => {
	const m = await mounted(wf);
	m.component.handleInput(KEY.ENTER);
	m.component.handleInput(KEY.CANCEL);
	assert.equal(m.controller.state().detailsOpen, false);
	assert.equal(m.closed(), 0);
	m.component.handleInput(KEY.CANCEL);
	assert.equal(m.controller.state().open, false);
	assert.equal(m.closed(), 1);
	assert.equal(m.controller.state().focusRestoreTarget, "previous-editor");
});

test("approve, retry, resolve, dismiss and recover keys are unbound: no response, no state change", async () => {
	const m = await mounted(wf);
	for (const k of [KEY.APPROVE, KEY.RETRY, KEY.RESOLVE, KEY.DISMISS, KEY.RECOVER]) m.component.handleInput(k);
	assert.deepEqual(m.sent, []);
	assert.equal(m.controller.state().open, true);
	assert.equal(m.controller.state().items.length, 1);
	assert.equal(m.controller.state().items[0]!.destination.kind, "inspect-blocker");
});

test("arrow navigation moves selection within bounds without focus or state side effects", async () => {
	const m = await mounted(mixed);
	m.component.handleInput(KEY.DOWN);
	m.component.handleInput(KEY.DOWN);
	assert.equal(m.controller.state().selected, 1);
	m.component.handleInput(KEY.UP);
	m.component.handleInput(KEY.UP);
	assert.equal(m.controller.state().selected, 0);
	assert.deepEqual(m.sent, []);
});

test("a refresh that adds the same identity announces it only once and never steals selection", async () => {
	const m = await mounted(wf);
	m.controller.select(0);
	await m.controller.refresh();
	await m.controller.refresh();
	assert.equal(m.controller.state().announcements.length, 1);
	assert.equal(m.controller.state().selected, 0);
});

test("rendering contains no executable approve/retry/resolve label", async () => {
	const m = await mounted(mixed);
	m.component.handleInput(KEY.ENTER);
	const text = m.component.render(120).join("\n").toLowerCase();
	for (const w of ["approve", "retry", "resolve", "dismiss", "recover"]) assert.ok(!text.includes(w), `label ${w}`);
});

test("absent or failed snapshot renders each unread namespace with its reason, never all-clear", async () => {
	const failing: AttentionReader = {
		readSnapshot: async () => ({
			projectKey: null,
			sources: [
				{ namespace: "workflow", status: "unavailable", completeness: "unknown", rows: [] as never, reason: "no-project-database" },
				{ namespace: "auto-pause", status: "unavailable", completeness: "unknown", rows: [] as never, reason: "no-project-database" },
				{ namespace: "interaction", status: "unavailable", completeness: "unknown", rows: [] as never, reason: "no-project-database" },
			],
		}),
	};
	const controller = new AttentionOverlayController(failing);
	const component = new AttentionOverlayComponent(controller, kb, () => {});
	await controller.open();
	const text = component.render(120).join("\n");
	assert.ok(text.includes("workflow: unavailable, unknown (no-project-database)"), text);
	assert.ok(text.includes("auto-pause: unavailable, unknown"), text);
	assert.ok(text.includes("interaction: unavailable, unknown"), text);
	assert.ok(text.includes("Not all-clear"), text);
	assert.ok(!text.includes("No open attention"), "never all-clear");
});

test("long detail text is preserved in full and wrapped, not truncated to the title length", async () => {
	const longText = "Confirm the deploy target carefully: " + "production region eu-west-1 and rollback owner must be named. ".repeat(6);
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: [{ ...workflowRow, description: longText }] as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, kb, () => {});
	await controller.open();
	component.handleInput(KEY.ENTER);
	const joined = component.render(60).join(" ").replace(/\s+/g, " ");
	assert.ok(joined.includes("rollback owner must be named"), "tail of the long detail text is visible after wrapping");
	for (const line of component.render(60)) assert.ok(line.length <= 60, `line within width: ${line.length}`);
});

test("on a short terminal the selected row and its details remain in the rendered output", async () => {
	const rows = Array.from({ length: 12 }, (_, i) => ({ ...workflowRow, blockerId: `W-${i}`, description: `item ${i}`, openedProjectRevision: i + 1 }));
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: rows as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, kb, () => {});
	await controller.open();
	for (let i = 0; i < 9; i++) component.handleInput(KEY.DOWN);
	component.handleInput(KEY.ENTER);
	const previous = process.stdout.rows;
	Object.defineProperty(process.stdout, "rows", { value: 12, configurable: true });
	try {
		const out = component.render(100).join("\n");
		assert.ok(out.includes("> [consent] item 9"), "selected row is visible");
		assert.ok(out.includes("Details:"), "details block is visible");
	} finally {
		Object.defineProperty(process.stdout, "rows", { value: previous, configurable: true });
	}
});

test("wide CJK and emoji text is bounded by display columns, not UTF-16 length", async () => {
	const { visibleWidth } = await import("@gsd/pi-tui");
	const wide = "中".repeat(60) + " 🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀";
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: [{ ...workflowRow, description: wide }] as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, kb, () => {});
	await controller.open();
	component.handleInput(KEY.ENTER);
	for (const line of component.render(40)) {
		assert.ok(visibleWidth(line) <= 40, `display width ${visibleWidth(line)} within 40`);
	}
});

test("on a 12-row terminal with long titles, the selected row and its details stay in the output", async () => {
	const longRows = Array.from({ length: 6 }, (_, i) => ({
		...workflowRow, blockerId: `W-${i}`, openedProjectRevision: i + 1,
		description: `item ${i} ` + "long explanatory text that wraps across several rows ".repeat(3),
	}));
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: longRows as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, kb, () => {});
	await controller.open();
	for (let i = 0; i < 5; i++) component.handleInput(KEY.DOWN);
	component.handleInput(KEY.ENTER);
	const sized = new AttentionOverlayComponent(controller, kb, () => {}, () => 12);
	for (let i = 0; i < 5; i++) sized.handleInput(KEY.DOWN);
	sized.handleInput(KEY.ENTER);
	const out = sized.render(60);
	assert.ok(out.some((l) => l.includes("> [consent] item 5")), "selected long row is visible");
	assert.ok(out.some((l) => l.includes("Details:")), "details block is visible");
	// Hard requirement: the whole rendered overlay fits the terminal height.
	assert.ok(out.length <= 12, `output must fit the 12-row terminal: ${out.length} lines`);
});

test("the details panel scrolls and the whole overlay stays within terminal height", async () => {
	const longText = Array.from({ length: 30 }, (_, i) => `line-${i} explanatory detail word`).join(" ");
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: [{ ...workflowRow, description: longText }] as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, kb, () => {}, () => 14);
	await controller.open();
	component.handleInput(KEY.ENTER);
	const first = component.render(60);
	assert.ok(first.length <= 14, `fits 14 rows: ${first.length}`);
	const before = first.join("\n");
	controller.scrollDetails(4);
	const after = component.render(60).join("\n");
	assert.notEqual(after, before, "scrolling changes the visible details");
	assert.ok(before.includes("Details:"), "the details header is visible at the top of the panel");
	assert.ok(component.render(60).length <= 14, "still within height after scrolling");
});

test("a very small terminal still renders a bounded selected row without exceeding its height", async () => {
	const rows = Array.from({ length: 5 }, (_, i) => ({ ...workflowRow, blockerId: `W-${i}`, openedProjectRevision: i + 1, description: `item ${i}` }));
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: rows as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, kb, () => {}, () => 5);
	await controller.open();
	for (let i = 0; i < 3; i++) component.handleInput(KEY.DOWN);
	const out = component.render(40);
	assert.ok(out.length <= 5, `fits 5 rows: ${out.length}`);
	assert.ok(out.some((l) => l.startsWith("> ")), "selected row is still visible");
});

test("selection change resets the details scroll offset", async () => {
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: [workflowRow, { ...workflowRow, blockerId: "W-2", openedProjectRevision: 9 }] as never }]);
	const controller = new AttentionOverlayController(r);
	await controller.open();
	controller.select(0);
	controller.scrollDetails(5);
	assert.equal(controller.state().detailScroll, 5);
	controller.select(1);
	assert.equal(controller.state().detailScroll, 0, "new selection starts at the top of its details");
});

test("keyboard page scrolling reaches every detail segment past the title limit, bounded and read from the details panel only", async () => {
	// Tokens sit well beyond the 240-character title limit, so they can appear only in the details body.
	const words = Array.from({ length: 60 }, (_, i) => `seg${i}`).join(" ");
	const pageDown = "\u001b[6~";
	const pageUp = "\u001b[5~";
	const pageKb = {
		matches: (data: string, action: string) => ({
			"tui.select.confirm": data === "\r",
			"tui.select.cancel": data === "\u001b",
			"tui.select.up": data === "\u001b[A",
			"tui.select.down": data === "\u001b[B",
			"tui.select.pageDown": data === pageDown,
			"tui.select.pageUp": data === pageUp,
		} as Record<string, boolean>)[action] ?? false,
	};
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: [{ ...workflowRow, description: words }] as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, pageKb, () => {}, () => 14);
	await controller.open();
	component.handleInput("\r");
	// Details rows are the lines after the list. Once the header scrolls away, the whole
	// visible block below the list is still the details body, so count every line after the
	// first list row marker or group header that precedes the details.
	const detailTokens = (out: string[]) => {
		const listEnd = out.findIndex((l) => l.startsWith("  ") && l.includes("Enter:"));
		const body = out.filter((l) => !/^(> |  \[|-- |\(|Coverage|Not all|No open)/.test(l));
		return body.join(" ").split(/\s+/).filter((tok) => /^seg\d+$/.test(tok));
	};
	const seen = new Set<string>();
	for (let step = 0; step < 200; step++) {
		const out = component.render(60);
		assert.ok(out.length <= 14, `height bound at step ${step}: ${out.length}`);
		for (const tok of detailTokens(out)) seen.add(tok);
		component.handleInput(pageDown);
	}
	for (let i = 0; i < 60; i++) assert.ok(seen.has(`seg${i}`), `seg${i} reachable through the details panel`);
	// Scrolling stops at the end: more page-downs do not move past the last line.
	const atEnd = component.render(60).join("\n");
	component.handleInput(pageDown);
	assert.equal(component.render(60).join("\n"), atEnd, "bounded at the last line");
	// Page up returns toward the top.
	for (let i = 0; i < 200; i++) component.handleInput(pageUp);
	assert.equal(controller.state().detailScroll, 0, "page up reaches the top");
});

test("changing project or terminal size keeps the overlay within its height", async () => {
	const rows = Array.from({ length: 4 }, (_, i) => ({ ...workflowRow, blockerId: `W-${i}`, openedProjectRevision: i + 1, description: `item ${i} ` + "text ".repeat(20) }));
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: rows as never }]);
	const controller = new AttentionOverlayController(r);
	let height = 20;
	const component = new AttentionOverlayComponent(controller, kb, () => {}, () => height);
	await controller.open();
	component.handleInput(KEY.ENTER);
	height = 9;
	assert.ok(component.render(40).length <= 9, "shrink respected");
	height = 30;
	assert.ok(component.render(40).length <= 30, "grow respected");
	controller.select(2);
	assert.equal(controller.state().detailScroll, 0, "selection change resets scroll");
});

test("layout grid: height is never exceeded, and the selection stays visible at every supported size (height>=5, width>=10)", async () => {
	const rows = [0, 1, 2].map((i) => ({ ...workflowRow, blockerId: `W-${i}`, openedProjectRevision: i + 1, description: `item ${i}` }));
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: rows as never }]);
	// Height >=5 / width >=10 must remain usable. Height 4 is also exercised: only a
	// physically impossible selected-row/counter/body allocation may use an explicit resize fallback.
	for (const height of [4, 5, 6, 8, 12, 20]) {
		for (const width of [10, 20, 40, 80]) {
			const controller = new AttentionOverlayController(r);
			const component = new AttentionOverlayComponent(controller, kb, () => {}, () => height);
			await controller.open();
			controller.select(2);
			const out = component.render(width);
			assert.ok(out.length <= height, `height ${height} width ${width}: ${out.length} lines`);
			// The selection marker is always rendered. At the narrowest widths the title itself may be cut,
			// so the title is asserted only where it fits (width >= 20).
			assert.ok(out.some((l) => l.startsWith(">") || l === ">"), `selection marker visible at ${height}x${width}`);
			if (height >= 5 && width >= 20) {
				assert.ok(out.join("\n").includes("item 2"), `selected title visible at ${height}x${width}`);
			}
		}
	}
});

test("a verdict on any width is a positive not-all-clear marker while a source is incomplete", async () => {
	const { r } = reader([
		{ namespace: "workflow", status: "available", completeness: "partial", rows: [] as never },
	]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, kb, () => {}, () => 6);
	await controller.open();
	for (const width of [10, 20, 40]) {
		const text = component.render(width).join(" ");
		assert.ok(/Not all-clear|\bUnread\b/.test(text), `explicit unread-source verdict at width ${width}: ${text}`);
		assert.ok(!/No open attention|All sources read complete|All read/.test(text), `no all-clear wording at width ${width}: ${text}`);
	}
});

test("detail-only tail beyond the title limit is reachable with real page-down input", async () => {
	const body = Array.from({ length: 70 }, (_, k) => `body${k}`).join(" ");
	const tail = "TAILMARKER-END";
	const description = `${body} ${tail}`;
	assert.ok(description.length > 240, "fixture exceeds the title limit");
	const pageKb = {
		matches: (data: string, action: string) => ({
			"tui.select.confirm": data === "\r",
			"tui.select.pageDown": data === "\u001b[6~",
		} as Record<string, boolean>)[action] ?? false,
	};
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: [{ ...workflowRow, description }] as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, pageKb, () => {}, () => 14);
	await controller.open();
	component.handleInput("\r");
	let sawTail = false;
	const bodies = new Set<string>();
	for (let i = 0; i < 80; i++) {
		const text = component.render(60).join("\n");
		if (text.includes(tail)) sawTail = true;
		for (const m of text.matchAll(/body(\d+)/g)) bodies.add(m[1]!);
		component.handleInput("\u001b[6~");
	}
	assert.equal(sawTail, true, "tail marker reached through the details panel");
	assert.equal(bodies.size, 70, `all 70 body tokens reached, saw ${bodies.size}`);
});

test("project switch clears the view to an honest empty state until a refresh", async () => {
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: [workflowRow] as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, kb, () => {}, () => 12);
	await controller.open();
	controller.setProject("P-OTHER");
	const text = component.render(60).join("\n");
	assert.ok(!text.includes("Confirm deploy"), "stale rows from the previous project are not shown");
	assert.equal(controller.state().allClear, false, "a switch never implies all-clear");
});

test("regression: a workflow-only view reaches every detail segment at 12 rows and up, within the 92% cap", async () => {
	const PD = "\u001b[6~";
	const words = Array.from({ length: 60 }, (_, i) => `seg${i}`).join(" ");
	const pageKb = {
		matches: (data: string, action: string) => ({
			"tui.select.confirm": data === "\r",
			"tui.select.pageDown": data === PD,
		} as Record<string, boolean>)[action] ?? false,
	};
	for (const terminalRows of [12, 14, 20]) {
		const oneSource = [{ namespace: "workflow" as const, status: "available" as const, completeness: "complete" as const, rows: [{ ...workflowRow, description: words }] as never }];
		const { r } = reader(oneSource);
		const controller = new AttentionOverlayController(r);
		const component = new AttentionOverlayComponent(controller, pageKb, () => {}, () => terminalRows);
		await controller.open();
		component.handleInput("\r");
		const cap = Math.floor(0.92 * terminalRows);
		// Reachability: every segment must appear somewhere in the overlay during a full scroll. The
		// Details header scrolls out of view, so the header is not a valid anchor for counting body text.
		const shown = new Set<string>();
		for (let step = 0; step < 200; step++) {
			const out = component.render(60);
			assert.ok(out.length <= cap, `rows ${terminalRows}: ${out.length} lines within cap ${cap}`);
			for (const line of out) for (const tok of line.split(/\s+/)) if (/^seg\d+$/.test(tok)) shown.add(tok);
			component.handleInput(PD);
		}
		assert.equal(shown.size, 60, `rows ${terminalRows}: all 60 segments reachable through scrolling, saw ${shown.size}`);
		assert.ok(shown.has("seg59"), `rows ${terminalRows}: last segment reachable`);
	}
});

test("regression: several namespace headers inside the window are counted, the details keep their lines and the cap holds", async () => {
	const PD = "\u001b[6~";
	const pageKb = {
		matches: (data: string, action: string) => ({
			"tui.select.confirm": data === "\r",
			"tui.select.pageDown": data === PD,
		} as Record<string, boolean>)[action] ?? false,
	};
	const longText = "long workflow explanation ".repeat(20);
	const sources: AttentionSource[] = [
		{ namespace: "workflow", status: "available", completeness: "complete", rows: [{ ...workflowRow, description: longText }] as never },
		{ namespace: "auto-pause", status: "available", completeness: "complete", rows: [pauseRow] as never },
		{ namespace: "interaction", status: "available", completeness: "complete", rows: [{ id: "Q-1", text: "q one", createdAt: "x" }, { id: "Q-2", text: "q two", createdAt: "x" }] as never },
	];
	const { r } = reader(sources);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, pageKb, () => {}, () => 14);
	await controller.open();
	controller.select(1);
	component.handleInput("\r");
	const cap = Math.floor(0.92 * 14);
	for (let step = 0; step < 40; step++) {
		const out = component.render(60);
		assert.ok(out.length <= cap, `step ${step}: ${out.length} lines within cap ${cap}`);
		assert.ok(out.some((l) => l.startsWith(">")), `step ${step}: selection visible`);
		component.handleInput(PD);
	}
});

test("regression: at 9 rows every detail segment is reachable by paging (page step equals the rendered detail budget)", async () => {
	const PD = "\u001b[6~";
	const words = Array.from({ length: 60 }, (_, i) => `seg${i}`).join(" ");
	const pageKb = {
		matches: (data: string, action: string) => ({
			"tui.select.confirm": data === "\r",
			"tui.select.pageDown": data === PD,
		} as Record<string, boolean>)[action] ?? false,
	};
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: [{ ...workflowRow, description: words }] as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, pageKb, () => {}, () => 9);
	await controller.open();
	component.handleInput("\r");
	const shown = new Set<string>();
	for (let step = 0; step < 200; step++) {
		const out = component.render(60);
		assert.ok(out.length <= Math.floor(0.92 * 9), `step ${step}: ${out.length} lines within the 9-row cap`);
		for (const line of out) for (const tok of line.split(/\s+/)) if (/^seg\d+$/.test(tok)) shown.add(tok);
		component.handleInput(PD);
	}
	assert.equal(shown.size, 60, `9 rows: all 60 segments reachable by paging, saw ${shown.size}`);
});

test("regression: three namespaces at 9 rows show all three groups with their headers, and the details stay visible", async () => {
	const sources: AttentionSource[] = [
		{ namespace: "workflow", status: "available", completeness: "complete", rows: [workflowRow] as never },
		{ namespace: "auto-pause", status: "available", completeness: "complete", rows: [pauseRow] as never },
		{ namespace: "interaction", status: "available", completeness: "complete", rows: [{ id: "Q-1", text: "q one", createdAt: "x" }] as never },
	];
	const { r } = reader(sources);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, kb, () => {}, () => 9);
	await controller.open();
	controller.select(1);
	const out = component.render(120);
	assert.ok(out.length <= Math.floor(0.92 * 9), `within cap: ${out.length}`);
	assert.ok(out.some((l) => l.startsWith(">")), "selection visible");
	assert.ok(out.some((l) => l.startsWith("Details:")), "details visible");
});

test("regression: a 10-column, 9-row view keeps the selection and stays within the cap; details may be hidden by width, never the selection", async () => {
	const rows = Array.from({ length: 12 }, (_, i) => ({ ...workflowRow, blockerId: `W-${i}`, openedProjectRevision: i + 1, description: `title ${i} ` + "long words ".repeat(8) }));
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: rows as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, kb, () => {}, () => 9);
	await controller.open();
	controller.select(2);
	component.handleInput("\r");
	const out = component.render(10);
	assert.ok(out.length <= Math.floor(0.92 * 9), `within cap: ${out.length}`);
	assert.ok(out.some((l) => l.startsWith(">")), "selection marker stays visible at 10 columns");
});

test("regression: the rendered list block never exceeds its budget, and every emitted header was counted (9 rows, width 10)", async () => {
	const rows = Array.from({ length: 12 }, (_, i) => ({ ...workflowRow, blockerId: `W-${i}`, openedProjectRevision: i + 1, description: `title ${i} ` + "long words ".repeat(8) }));
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: rows as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, kb, () => {}, () => 9);
	await controller.open();
	controller.select(2);
	const out = component.render(10);
	const counterLines = wrapText("(3-3 of 12)", 10);
	const counterAt = out.findIndex((l) => l.startsWith("("));
	assert.ok(counterAt >= 0, "counter is rendered");
	// The full wrapped counter must be present row for row, not just its first line.
	assert.deepEqual(out.slice(counterAt, counterAt + counterLines.length), counterLines);
	const listStart = out.findIndex((l) => l.startsWith("-- ") || l.startsWith(">"));
	const counterEnd = counterAt + counterLines.length;
	assert.ok(out.length <= Math.floor(0.92 * 9), `within cap: ${out.length}`);
	assert.ok(counterEnd - listStart <= 5, `list block ${counterEnd - listStart} rows fits the 5-row list allowance`);
	assert.ok(out.some((l) => l.startsWith("Details:")), "details stay visible when the list fits");
});

test("regression: narrow width and high item counts keep the selection, a complete counter and the cap at every height", async () => {
	for (const height of [5, 6, 9, 10, 12]) {
		for (const count of [3, 12, 40, 120]) {
			for (const width of [6, 8, 10, 12, 14]) {
				for (const sel of [0, Math.floor(count / 2), count - 1]) {
					const rows = Array.from({ length: count }, (_, i) => ({ ...workflowRow, blockerId: `W-${i}`, openedProjectRevision: i + 1, description: `title ${i} ` + "long words ".repeat(8) + `end${i}` }));
					const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: rows as never }]);
					const controller = new AttentionOverlayController(r);
					const component = new AttentionOverlayComponent(controller, kb, () => {}, () => height);
					await controller.open();
					controller.select(sel);
					component.handleInput("\r");
					const out = component.render(width);
					const label = `h=${height} n=${count} w=${width} sel=${sel}`;
					const cap = Math.floor(0.92 * height);
					assert.ok(out.length <= cap, `${label}: ${out.length} rows within cap ${cap}`);
					assert.equal(component.lastUnclippedOverflow, 0, `${label}: allocation fits before the safety clip`);
					assert.ok(out.some((l) => l.startsWith(">")), `${label}: selection visible`);
					// The counter must appear exactly when items are omitted, and then all of its wrapped rows must be present.
					const shownAll = Array.from({ length: count }, (_, i) => i).every((i) => out.join("").includes(`end${i}`));
					const omitted = !shownAll && count > 1;
					// A counter is either the normal `(a-b of N)` form or the complete compact `n/N` form.
					const counterAt = out.findIndex((l) => l.startsWith("(") || /^\d+\/\d+$/.test(l));
					if (out.some((line) => line.includes("Resize"))) {
						assert.equal(width, 6, `${label}: no supported width may use a fallback`);
						const minimum = wrapText("> Unread", width).length + wrapText(`(${sel + 1}-${sel + 1} of ${count})`, width).length + 1;
						assert.ok(minimum > cap, `${label}: fallback requires a genuinely impossible selection/verdict/counter/body span`);
						assert.ok(out.includes("Unread"), `${label}: fallback is explicitly not all-clear`);
						assert.equal(counterAt, -1, `${label}: resize fallback does not claim a list span`);
					} else if (omitted) {
						assert.ok(counterAt >= 0, `${label}: every omitted-item list has its complete counter`);
					}
					if (counterAt >= 0) {
						const m = out.slice(counterAt).join("").match(/\((\d+)-(\d+)\s*of\s*(\d+)\)|^(\d+)\/(\d+)/);
						assert.ok(m, `${label}: counter rows form a whole counter, got ${JSON.stringify(out.slice(counterAt))}`);
						const total = Number(m![3] ?? m![5]);
						assert.equal(total, count, `${label}: counter total`);
					}
				}
			}
		}
	}
});

test("regression: an interior namespace header stays first in its group when the window grows backward (A1)", async () => {
	const rows = Array.from({ length: 120 }, (_, i) => ({ ...workflowRow, blockerId: `W-${i}`, openedProjectRevision: i + 1, description: `title ${i}` }));
	const sources: AttentionSource[] = [
		{ namespace: "workflow", status: "available", completeness: "complete", rows: rows as never },
		{ namespace: "auto-pause", status: "available", completeness: "complete", rows: [pauseRow] as never },
	];
	const { r } = reader(sources);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, kb, () => {}, () => 20);
	await controller.open();
	controller.select(10);
	const out = component.render(60);
	const headerAt = out.findIndex((l) => l === "-- workflow --");
	assert.ok(headerAt >= 0, "workflow header rendered");
	const firstWorkflowRow = out.slice(headerAt + 1).find((l) => l.includes("[consent]") || l.startsWith(">"));
	assert.ok(firstWorkflowRow, "a workflow row follows the header");
	assert.ok(firstWorkflowRow!.includes("title"), `header precedes the first included workflow row, got ${firstWorkflowRow}`);
	assert.ok(!out.slice(0, headerAt).some((l) => l.includes("title")), "no workflow row precedes its header");
});

test("regression: at supported terminal height 6 and width 10, the complete counter and at least one real detail body row are shown and paging reaches the tail", async () => {
	const PD = "\u001b[6~";
	const pageKb = { matches: (data: string, action: string) => ({ "tui.select.confirm": data === "\r", "tui.select.pageDown": data === PD } as Record<string, boolean>)[action] ?? false };
	const words = Array.from({ length: 60 }, (_, i) => `seg${i}`).join(" ") + " TAILEND";
	const rows = Array.from({ length: 120 }, (_, i) => ({ ...workflowRow, blockerId: `W-${i}`, openedProjectRevision: i + 1, description: words }));
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: rows as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, pageKb, () => {}, () => 6);
	await controller.open();
	controller.select(100);
	component.handleInput("\r");
	const shown = new Set<string>();
	let tail = false;
	for (let step = 0; step < 300; step++) {
		const out = component.render(10);
		assert.equal(component.lastUnclippedOverflow, 0, `step ${step}: allocation fits`);
		const counterLines = wrapText("(101-101 of 120)", 10);
		const at = out.findIndex((l) => l === counterLines[0]);
		assert.ok(at >= 0 && JSON.stringify(out.slice(at, at + counterLines.length)) === JSON.stringify(counterLines), `step ${step}: complete counter`);
		for (const line of out.slice(at + counterLines.length)) for (const tok of line.split(/\s+/)) if (/^seg\d+$/.test(tok)) shown.add(tok);
		if (out.some((l) => l.includes("TAILEND"))) tail = true;
		component.handleInput(PD);
	}
	assert.ok(shown.size > 0, "at least one real detail body row is visible at 6x10");
	assert.ok(tail, "paging reaches the detail tail at 6x10");
});

test("contract: at terminal height 5 compact coverage leaves a real detail body row after the complete counter", async () => {
	const rows = Array.from({ length: 120 }, (_, i) => ({ ...workflowRow, blockerId: `W-${i}`, openedProjectRevision: i + 1, description: "body text" }));
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: rows as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, kb, () => {}, () => 5);
	await controller.open();
	controller.select(100);
	component.handleInput("\r");
	const out = component.render(10);
	assert.ok(out.length <= Math.floor(0.92 * 5), `within cap: ${out.length}`);
	assert.equal(component.lastUnclippedOverflow, 0, "allocation fits before the safety clip");
	assert.ok(out.some((l) => l.includes("Unread")), "unread-source verdict stays visible");
	const counterLines = wrapText("(101-101 of 120)", 10);
	const counterAt = out.findIndex((l) => l === counterLines[0]);
	assert.ok(counterAt >= 0, "counter is mandatory");
	assert.deepEqual(out.slice(counterAt, counterAt + counterLines.length), counterLines, "complete counter stays visible");
	assert.ok(out.length > counterAt + counterLines.length, "separate body row is reserved");
	assert.ok(!out.includes("Details:"), "decorative header cannot consume the only body row");
});

test("EXEC-ACTUAL-COUNTER-FIX-04 regression: N120 workflow-only selection 0 with details open at terminal height 4 width 12 renders the complete actual counter and a real body row, not Resize", async () => {
	const rows = Array.from({ length: 120 }, (_, i) => ({ ...workflowRow, blockerId: `W-${i}`, openedProjectRevision: i + 1, description: "workflow body" }));
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: rows as never }]);
	const controller = new AttentionOverlayController(r);
	const component = new AttentionOverlayComponent(controller, kb, () => {}, () => 4);
	await controller.open();
	controller.select(0);
	component.handleInput("\r");
	const out = component.render(12);
	assert.ok(out.length <= Math.floor(0.92 * 4), `within cap: ${out.length}`);
	assert.equal(component.lastUnclippedOverflow, 0, "allocation fits before the safety clip");
	assert.ok(!out.some((l) => l.includes("Resize")), `physically fitting viewport must not fall back to Resize: ${JSON.stringify(out)}`);
	const counterLines = wrapText("(1-1 of 120)", 12);
	const counterAt = out.findIndex((l) => l === counterLines[0]);
	assert.ok(counterAt >= 0, `complete counter visible: ${JSON.stringify(out)}`);
	assert.deepEqual(out.slice(counterAt, counterAt + counterLines.length), counterLines, "complete counter stays whole");
	assert.ok(out.some((l) => l.includes("workflow:W-0")), `real body row visible after counter: ${JSON.stringify(out)}`);
	assert.ok(out.length > counterAt + counterLines.length, "body row follows the counter");
});

test("retained admission sweep: complete counters across the separate 432 compact-fit cases (not the original 84)", async () => {
	// Retained broad sweep. Exact original 84-case/content coverage is asserted separately.
	let compactCases = 0;
	for (const count of [3, 12, 40, 100, 120, 200]) for (const height of [4, 5, 6, 9, 10, 12]) for (const width of [8, 10, 12, 14]) for (const sel of [0, Math.floor(count / 2), count - 1]) {
		const rows = Array.from({ length: count }, (_, i) => ({ ...workflowRow, blockerId: `W-${i}`, openedProjectRevision: i + 1, description: `title ${i} ` + "long words ".repeat(8) + `end${i}` }));
		const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: rows as never }]);
		const controller = new AttentionOverlayController(r);
		const component = new AttentionOverlayComponent(controller, kb, () => {}, () => height);
		await controller.open();
		controller.select(sel);
		component.handleInput("\r");
		const out = component.render(width);
		const label = `n=${count} h=${height} w=${width} sel=${sel}`;
		assert.ok(out.length <= Math.floor(0.92 * height), `${label}: within cap`);
		assert.equal(component.lastUnclippedOverflow, 0, `${label}: no safety clip`);
		assert.ok(!out.some((l) => l.includes("Resize")), `${label}: complete compact counter must avoid Resize: ${JSON.stringify(out)}`);
		assert.ok(out.some((l) => l.startsWith(">")), `${label}: selection visible`);
		assert.ok(out.some((l) => l.includes("Not all-clear") || l.includes("Unread")), `${label}: coverage verdict visible`);
		const compact = `${sel + 1}/${count}`;
		if (wrapText(`(${sel + 1}-${sel + 1} of ${count})`, width).length > Math.floor(0.92 * height) - 2) {
			compactCases++;
			assert.ok(out.some((l) => l === wrapText(compact, width)[0]), `${label}: complete compact ${compact} rendered whole`);
		}
	}
	assert.ok(compactCases > 0, "this separate broad sweep also exercises compact admission");
});

test("EXEC-COMPACT-ADMISSION-05 transition: the same selection moves from normal counter to compact counter as the height shrinks, with no oscillation back to Resize", async () => {
	const rows = Array.from({ length: 120 }, (_, i) => ({ ...workflowRow, blockerId: `W-${i}`, openedProjectRevision: i + 1, description: "workflow body" }));
	const { r } = reader([{ namespace: "workflow", status: "available", completeness: "complete", rows: rows as never }]);
	const controller = new AttentionOverlayController(r);
	let height = 12;
	const component = new AttentionOverlayComponent(controller, kb, () => {}, () => height);
	await controller.open();
	controller.select(9);
	component.handleInput("\r");
	for (const h of [12, 8, 6, 5, 4, 5, 6, 8, 12, 4]) {
		height = h;
		const out = component.render(12);
		assert.ok(!out.some((l) => l.includes("Resize")), `h=${h}: no Resize when a compact counter fits: ${JSON.stringify(out)}`);
		assert.ok(out.some((l) => l.startsWith(">")), `h=${h}: selection visible`);
		assert.ok(out.some((l) => l.includes("Unread")), `h=${h}: coverage verdict visible`);
		assert.equal(component.lastUnclippedOverflow, 0, `h=${h}: no clip`);
		assert.ok(out.length <= Math.floor(0.92 * h), `h=${h}: within cap ${out.length}`);
		const counterAtLine = out.findIndex((l) => /^\(\d+-\d+ of \d+\)$/.test(l) || /^\d+\/\d+$/.test(l) || l.startsWith("("));
		assert.ok(counterAtLine >= 0, `h=${h}: counter present: ${JSON.stringify(out)}`);
	}
});
