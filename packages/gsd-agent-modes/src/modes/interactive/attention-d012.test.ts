import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAttentionView, type AttentionSource, type Namespace } from "./attention-model.ts";
import { createAttentionReader, type ReadSeam } from "./attention-reader.ts";
import { AttentionOverlayController, type AttentionSnapshot } from "./attention-overlay.ts";
import { AttentionOverlayComponent } from "./attention-overlay-component.ts";

const authority = { project_id: "P1", project_root_realpath: "/fixture", revision: 4, authority_epoch: 1 };
const blocker = (id: string) => ({ blockerId: id, blockerKind: "consent", resolutionOwner: "user", description: id });
const source = (namespace: Namespace, rows: Record<string, unknown>[]): AttentionSource => ({ namespace, rows, status: "available", completeness: "complete" });

function reader(options: { fail?: Namespace | "authority" | "entry" | "cleanup"; authority?: typeof authority | null; questions?: Record<string, unknown>[]; limit?: number } = {}) {
	const attempted: Namespace[] = [];
	const seam: ReadSeam = {
		withReadOnlySnapshot(_path, inspect) {
			if (options.fail === "entry") throw new Error("snapshot-entry-failed");
			const result = inspect((sql) => {
				if (sql.includes("project_authority")) {
					if (options.fail === "authority") throw new Error("authority-unread");
					return options.authority === null ? [] : [options.authority ?? authority];
				}
				const namespace: Namespace = sql.includes("workflow_blockers") ? "workflow" : sql.includes("auto_pauses") ? "auto-pause" : "interaction";
				attempted.push(namespace);
				if (options.fail === namespace) throw new Error("fixture-query-failed");
				return namespace === "workflow" ? [blocker("B-1")] : namespace === "auto-pause" ? [blocker("P-1")] : options.questions ?? [];
			});
			if (options.fail === "cleanup") throw new Error("snapshot-cleanup-failed");
			return result;
		},
	};
	return { attempted, read: createAttentionReader({ databasePath: "/fixture/.gsd/gsd.db", projectRoot: "/fixture", seam, limit: options.limit }) };
}

for (const questions of [[], [{ id: "Q-1", description: "Durable question" }]]) {
	test(`durable questions (${questions.length}) retain rows without claiming native-prompt coverage`, async () => {
		const snap = await reader({ questions }).read.readSnapshot();
		const interaction = snap.sources.find((s) => s.namespace === "interaction")!;
		assert.equal(interaction.status, "available");
		assert.equal(interaction.completeness, "partial");
		assert.match(interaction.reason!, /native.*prompt.*(unread|not read|unavailable)/i);
		assert.deepEqual(interaction.rows, questions);
		const view = buildAttentionView(snap.sources.map((s) => s.namespace === "interaction" ? s : { ...s, rows: [] }));
		assert.equal(view.allClear, false);
		for (const item of view.items) assert.equal(item.destination.kind, "details-only");
	});
}

test("question truncation and the native-prompt gap are both visible", async () => {
	const snap = await reader({ questions: [{ id: "Q-1" }, { id: "Q-2" }], limit: 1 }).read.readSnapshot();
	const interaction = snap.sources.find((s) => s.namespace === "interaction")!;
	assert.equal(interaction.rows.length, 1);
	assert.equal(interaction.completeness, "partial");
	assert.match(interaction.reason!, /truncated/);
	assert.match(interaction.reason!, /native.*prompt/i);
});

for (const fail of ["workflow", "auto-pause", "interaction"] as const) {
	test(`${fail} query failure preserves healthy namespaces and the verified project`, async () => {
		const fixture = reader({ fail, questions: [{ id: "Q-1" }] });
		const snap = await fixture.read.readSnapshot();
		assert.equal(snap.projectKey, "P1");
		assert.deepEqual(fixture.attempted, ["workflow", "auto-pause", "interaction"]);
		for (const s of snap.sources) {
			if (s.namespace === fail) {
				assert.equal(s.status, "unavailable");
				assert.equal(s.completeness, "unknown");
				assert.equal(s.rows.length, 0);
				assert.ok(s.reason);
			} else {
				assert.equal(s.status, "available");
				assert.equal(s.rows.length, 1);
				assert.equal(s.completeness, s.namespace === "interaction" ? "partial" : "complete");
			}
		}
		assert.equal(buildAttentionView(snap.sources).allClear, false);
	});
}

for (const fail of ["authority", "entry", "cleanup"] as const) {
	test(`snapshot-wide ${fail} failure discards every result`, async () => {
		const snap = await reader({ fail }).read.readSnapshot();
		assert.equal(snap.projectKey, null);
		assert.ok(snap.sources.every((s) => s.status === "unavailable" && s.completeness === "unknown" && s.rows.length === 0));
	});
}
for (const binding of [null, { ...authority, project_root_realpath: "/other" }]) {
	test(`missing or mismatched authority never attempts namespace reads (${binding === null ? "missing" : "mismatch"})`, async () => {
		const fixture = reader({ authority: binding });
		const snap = await fixture.read.readSnapshot();
		assert.equal(snap.projectKey, null);
		assert.deepEqual(fixture.attempted, []);
		assert.ok(snap.sources.every((s) => s.status === "unavailable"));
	});
}

for (const nextIds of [["B", "C"], ["X", "A", "B", "C"], ["A", "C"], []]) {
	test(`refresh preserves identity, pane, scroll and Inspect target: ${nextIds.join(",") || "empty"}`, async () => {
		let snapshot: AttentionSnapshot = { projectKey: "P1", sources: [source("workflow", ["A", "B", "C"].map(blocker))] };
		const sent: string[] = [];
		const controller = new AttentionOverlayController({ readSnapshot: async () => snapshot }, { sendCommand: (c) => { sent.push(c); } });
		await controller.open();
		controller.select(1);
		controller.scrollDetails(3);
		snapshot = { projectKey: "P1", sources: [source("workflow", nextIds.map(blocker))] };
		await controller.refresh();
		assert.deepEqual(sent, [], "refresh itself sends nothing");
		const s = controller.state();
		if (nextIds.includes("B")) {
			assert.equal(s.items[s.selected]?.identity, JSON.stringify(["workflow", "B"]));
			assert.equal(s.detailsOpen, true);
			assert.equal(s.detailScroll, 3);
			controller.requestInspect();
			assert.deepEqual(sent, ["/gsd blocker inspect B"]);
		} else {
			assert.equal(s.detailsOpen, false);
			assert.equal(s.detailScroll, 0);
			assert.ok(s.selected >= 0 && s.selected <= Math.max(0, nextIds.length - 1));
		}
	});
}

test("equal raw IDs in different namespaces cannot inherit an open pane", async () => {
	let snapshot: AttentionSnapshot = { projectKey: "P1", sources: [source("workflow", [blocker("B")])] };
	const sent: string[] = [];
	const controller = new AttentionOverlayController({ readSnapshot: async () => snapshot }, { sendCommand: (c) => { sent.push(c); } });
	await controller.open();
	controller.select(0);
	controller.scrollDetails(2);
	snapshot = { projectKey: "P1", sources: [source("auto-pause", [blocker("B")])] };
	await controller.refresh();
	assert.equal(controller.state().detailsOpen, false);
	assert.equal(controller.state().detailScroll, 0);
	controller.requestInspect();
	assert.deepEqual(sent, []);
});

test("roomy coverage explains the native-prompt gap; narrow coverage stays incomplete", async () => {
	const snap = await reader().read.readSnapshot();
	const controller = new AttentionOverlayController({ readSnapshot: async () => snap });
	await controller.open();
	let height = 50;
	const component = new AttentionOverlayComponent(controller, { matches: () => false }, () => {}, () => height);
	const roomy = component.render(160).join("\n");
	assert.match(roomy, /native.*prompt/i);
	assert.doesNotMatch(roomy, /All read/);
	height = 12;
	assert.match(component.render(35).join("\n"), /Unread|Not all-clear/);
});

test("a known-kind unknown-owner pause keeps details and never gains Inspect", () => {
	const view = buildAttentionView([source("auto-pause", [{ ...blocker("P-1"), blockerKind: "machine_fixable", resolutionOwner: "unknown" }])]);
	assert.equal(view.items[0].owner, "unknown");
	assert.equal(view.items[0].details.kind, "machine_fixable");
	assert.equal(view.items[0].destination.kind, "details-only");
});
