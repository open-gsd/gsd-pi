import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@gsd/pi-tui";
import { INSPECT_ONLY_NOTICE, type AttentionSource } from "./attention-model.ts";
import { AttentionOverlayController } from "./attention-overlay.ts";
import { AttentionOverlayComponent, wrapText } from "./attention-overlay-component.ts";

const keys = {
	matches: (data: string, action: string) => data === ({
		"tui.select.confirm": "\r", "tui.select.cancel": "\u001b",
		"tui.select.up": "\u001b[A", "tui.select.down": "\u001b[B",
		"tui.select.pageDown": "\u001b[6~", "tui.select.pageUp": "\u001b[5~",
	} as Record<string, string>)[action],
};

async function fixture(n: number, height: () => number) {
	const rows = Array.from({ length: n }, (_, i) => ({
		blockerId: `W-${i}`, blockerKind: "consent", resolutionOwner: "user",
		openedProjectRevision: i + 1,
		description: `title ${i} ` + "body words ".repeat(12) + `tail_${i}`,
	}));
	const controller = new AttentionOverlayController({
		readSnapshot: async () => ({ projectKey: "P1", sources: [
			{ namespace: "workflow", status: "available", completeness: "complete", rows },
		] }),
	});
	const component = new AttentionOverlayComponent(controller, keys, () => {}, height);
	await controller.open();
	return { controller, component };
}

/** Complete emitted rows, not a prefix match or a private renderer helper. */
function counter(out: string[], width: number) {
	for (let at = 0; at < out.length; at++) for (let count = 1; count <= out.length - at; count++) {
		const rows = out.slice(at, at + count);
		const normal = /^\((\d+)-(\d+) of (\d+)\)$/.exec(rows.join(" "));
		if (normal && JSON.stringify(rows) === JSON.stringify(wrapText(normal[0], width))) {
			return { form: "normal", at, count, first: +normal[1], last: +normal[2], total: +normal[3] };
		}
		const compact = /^(\d+)\/(\d+)$/.exec(rows.join(""));
		if (compact && JSON.stringify(rows) === JSON.stringify(wrapText(compact[0], width))) {
			return { form: "compact", at, count, first: +compact[1], last: +compact[1], total: +compact[2] };
		}
	}
	assert.fail(`complete normal or compact counter required: ${JSON.stringify(out)}`);
}

function check(f: Awaited<ReturnType<typeof fixture>>, n: number, selected: number, width: number, height: number) {
	const out = f.component.render(width);
	const cap = Math.floor(0.92 * height);
	assert.ok(out.length <= cap, `physical cap ${out.length}/${cap}`);
	assert.ok(out.every((line) => visibleWidth(line) <= width), "physical cell widths");
	assert.equal(f.component.lastUnclippedOverflow, 0, "safety clip removed nothing");
	assert.ok(!out.some((line) => line.includes("Resize")), "these exact cases admit a complete counter and body");
	assert.ok(/Unread|Not all-clear/.test(out.join(" ")), "unread namespaces remain honest");
	assert.ok(!out.join(" ").includes("All read"), "not all-clear");
	assert.ok(out.some((line) => line === ">" || line.startsWith("> ")), "selected marker");
	const state = f.controller.state();
	assert.equal(state.selected, selected, "keyboard-selected position");
	const item = state.items[selected]!;
	assert.equal(item.id, `W-${selected}`, "selected identity");
	assert.equal(state.detailsOpen, true);
	const c = counter(out, width);
	assert.equal(c.total, n);
	assert.ok(c.first <= selected + 1 && selected + 1 <= c.last, "complete counter contains selection");
	// Independent minimum: one combined verdict/selection row, complete counter, one real body row.
	const normalFits = 1 + wrapText(`(${selected + 1}-${selected + 1} of ${n})`, width).length + 1 <= cap;
	assert.equal(c.form, normalFits ? "normal" : "compact", "normal preferred; compact only when normal cannot fit");
	if (c.form === "compact") assert.equal(c.first, selected + 1);
	let bodyAt = c.at + c.count;
	if (out[bodyAt] === "Details:") bodyAt++;
	const expected = [item.details.sourceIdentity,
		`  kind: ${item.details.kind}  owner: ${item.owner}  freshness: ${item.freshness}`,
		`  text: ${item.details.text}`,
		"  i: Inspect blocker (read-only)",
	].flatMap((line) => wrapText(line, width));
	const body = out.slice(bodyAt);
	assert.ok(body.length >= 1, "at least one real detail body row AFTER the complete counter");
	assert.deepEqual(body, expected.slice(state.detailScroll, state.detailScroll + body.length), "actual selected body's scroll window");
	return { form: c.form, body, expected, scroll: state.detailScroll };
}

// The original 84 tuples, not the later 432-case grid. This exact Cartesian
// product contains all 29 originally rejected normal-counter-impossible cases.
for (const n of [12, 100, 120, 200]) for (const width of [10, 11, 12, 13, 14, 15, 16]) for (const selected of [0, 1, 9]) {
	test(`original84: n=${n} terminalH=4 effectiveH=3 w=${width} selected=${selected}`, async () => {
		const f = await fixture(n, () => 4);
		for (let i = 0; i < selected; i++) f.component.handleInput("\u001b[B");
		f.component.handleInput("\r");
		let result = check(f, n, selected, width, 4);
		const emitted = [...result.body];
		for (let page = 0; page <= result.expected.length; page++) {
			const before = result.scroll;
			f.component.handleInput("\u001b[6~");
			result = check(f, n, selected, width, 4);
			emitted.push(...result.body);
			if (before === result.scroll) break;
		}
		assert.ok(emitted.some((line) => line.includes(`tail_${selected}`)), "real description tail remains scrollable");
		assert.equal(result.scroll, result.expected.length - result.body.length, "reached the complete body end");
		for (let page = 0; page <= result.expected.length; page++) f.component.handleInput("\u001b[5~");
		assert.equal(check(f, n, selected, width, 4).scroll, 0, "keyboard paging returns to selected identity");
	});
}

for (const heights of [[12, 4, 12, 4, 12], [5, 4, 5, 4, 5], [16, 4, 8, 4, 16]]) {
	test(`counter transition/body preservation: ${heights.join(">")}`, async () => {
		let height = heights[0];
		const f = await fixture(120, () => height);
		for (let i = 0; i < 9; i++) f.component.handleInput("\u001b[B");
		f.component.handleInput("\r");
		check(f, 120, 9, 12, height);
		f.component.handleInput("\u001b[6~");
		for (const next of heights) {
			const before = f.controller.state().detailScroll;
			height = next;
			const r = check(f, 120, 9, 12, height);
			assert.equal(r.scroll, Math.min(before, r.expected.length - r.body.length), "resize only clamps scroll; never resets or substitutes body");
		}
	});
}

test("Inspect key is explicit: ordinary open/detail/close never navigates; known workflow does", async () => {
	const sent: string[] = [];
	const c = new AttentionOverlayController({ readSnapshot: async () => ({ projectKey: "P1", sources: [
		{ namespace: "workflow", status: "available", completeness: "complete", rows: [
			{ blockerId: "W-1", blockerKind: "consent", resolutionOwner: "user" },
		] },
	] }) }, { sendCommand: (command) => sent.push(command) });
	const v = new AttentionOverlayComponent(c, keys, () => {});
	await c.open();
	v.handleInput("i");
	v.handleInput("\r");
	v.handleInput("\r");
	assert.deepEqual(sent, []);
	v.handleInput("i");
	assert.deepEqual(sent, ["/gsd blocker inspect W-1"]);
	v.handleInput("\u001b");
	v.handleInput("\u001b");
	assert.equal(sent.length, 1);
});

for (const [namespace, kind, owner] of [
	["auto-pause", "user_request", "user"], ["interaction", "consent", "user"], ["future-namespace", "consent", "user"],
	["workflow", "future-kind", "user"], ["workflow", "consent", "unknown"],
] as const) test(`Inspect key sends nothing for ${namespace}/${kind}/${owner}`, async () => {
	const sent: string[] = [];
	// Deliberately malformed namespace input must never acquire a workflow destination.
	const sources: AttentionSource[] = [{ namespace: namespace as AttentionSource["namespace"], status: "available", completeness: "complete", rows: [
		{ blockerId: "same-id", blockerKind: kind, resolutionOwner: owner },
	] }];
	const c = new AttentionOverlayController({ readSnapshot: async () => ({ projectKey: "P1", sources }) }, { sendCommand: (command) => sent.push(command) });
	const v = new AttentionOverlayComponent(c, keys, () => {});
	await c.open();
	v.handleInput("\r");
	v.handleInput("i");
	assert.deepEqual(sent, []);
	assert.equal(c.state().notice, INSPECT_ONLY_NOTICE);
});

test("Inspect key reports unavailable host navigation without losing details", async () => {
	const f = await fixture(12, () => 12);
	f.component.handleInput("\r");
	f.component.handleInput("i");
	assert.match(f.controller.state().notice, /Inspect navigation is unavailable/);
	assert.equal(f.controller.state().detailsOpen, true);
});
