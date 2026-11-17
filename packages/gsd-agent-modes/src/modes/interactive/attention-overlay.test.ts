import assert from "node:assert/strict";
import { test } from "node:test";
import { AttentionOverlayController, type AttentionReader } from "./attention-overlay.ts";
import type { AttentionSource } from "./attention-model.ts";

const okSource = (rows: unknown[], namespace: AttentionSource["namespace"] = "workflow"): AttentionSource => ({
	namespace,
	status: "available",
	completeness: "complete",
	rows: rows as never,
});

const row = (over: Record<string, unknown> = {}) => ({
	blockerId: "B-1",
	blockerKind: "consent",
	resolutionOwner: "user",
	description: "Confirm deploy",
	openedProjectRevision: 3,
	...over,
});

function fakeReader(sources: AttentionSource[] = [okSource([row()])]) {
	const calls = { read: 0, write: 0, respond: 0, dispatch: 0, bootstrap: 0 };
	const reader: AttentionReader = {
		readSnapshot: async () => {
			calls.read++;
			return { projectKey: "project-A", sources };
		},
	};
	return { reader, calls };
}

test("opening the overlay performs a mutation-free read and renders items", async () => {
	const { reader, calls } = fakeReader();
	const c = new AttentionOverlayController(reader);
	await c.open();
	assert.equal(calls.read, 1);
	assert.equal(c.state().items.length, 1);
	assert.equal(calls.write + calls.respond + calls.dispatch + calls.bootstrap, 0);
});

test("details and inspect-navigation send nothing; close restores focus target", async () => {
	const { reader, calls } = fakeReader();
	const sent: string[] = [];
	const c = new AttentionOverlayController(reader, { sendCommand: (cmd) => sent.push(cmd) });
	await c.open();
	c.select(0);
	assert.equal(c.state().detailsOpen, true);
	c.requestInspect();
	assert.deepEqual(sent, ["/gsd blocker inspect B-1"]);
	c.close();
	assert.equal(c.state().open, false);
	assert.equal(c.state().focusRestoreTarget, "previous-editor");
	assert.equal(calls.write, 0);
});

test("Escape closes details first, then the overlay, and never answers or resolves", async () => {
	const { reader } = fakeReader();
	const sent: string[] = [];
	const c = new AttentionOverlayController(reader, { sendCommand: (cmd) => sent.push(cmd) });
	await c.open();
	c.select(0);
	c.handleKey("cancel");
	assert.equal(c.state().detailsOpen, false);
	assert.equal(c.state().open, true);
	c.handleKey("cancel");
	assert.equal(c.state().open, false);
	assert.deepEqual(sent, []);
});

test("no approve, retry, resolve, dismiss or recover key is bound", async () => {
	const { reader } = fakeReader();
	const sent: string[] = [];
	const c = new AttentionOverlayController(reader, { sendCommand: (cmd) => sent.push(cmd) });
	await c.open();
	for (const key of ["approve", "retry", "resolve", "dismiss", "recover", "answer"]) c.handleKey(key);
	assert.deepEqual(sent, []);
	assert.equal(c.state().open, true);
});

test("inspect is offered only for a verified workflow blocker; pause rows stay details-only", async () => {
	const { reader } = fakeReader([
		okSource([row({ blockerId: "W-1" })], "workflow"),
		okSource([row({ blockerId: "P-9", blockerKind: "user_request" })], "auto-pause"),
	]);
	const sent: string[] = [];
	const c = new AttentionOverlayController(reader, { sendCommand: (cmd) => sent.push(cmd) });
	await c.open();
	c.select(1);
	c.requestInspect();
	assert.deepEqual(sent, []);
	assert.equal(c.state().notice.includes("No verified owner-controlled destination"), true);
});

test("late result from an old project is discarded after a project switch", async () => {
	let release!: (v: unknown) => void;
	const slow: AttentionReader = {
		readSnapshot: () => new Promise((resolve) => { release = resolve; }),
	};
	const c = new AttentionOverlayController(slow);
	const opening = c.open();
	c.setProject("project-B");
	release({ projectKey: "project-A", sources: [okSource([row({ blockerId: "OLD" })])] });
	await opening;
	assert.equal(c.state().items.length, 0, "old project rows must not appear");
	assert.equal(c.state().allClear, false);
});

test("failed read is shown as unavailable and never as all-clear", async () => {
	const failing: AttentionReader = { readSnapshot: async () => { throw new Error("db busy"); } };
	const c = new AttentionOverlayController(failing);
	await c.open();
	assert.equal(c.state().allClear, false);
	assert.equal(c.state().status, "unavailable");
});

test("announcements fire once per retained identity", async () => {
	const { reader } = fakeReader();
	const c = new AttentionOverlayController(reader);
	await c.open();
	await c.refresh();
	await c.refresh();
	assert.equal(c.state().announcements.length, 1);
});

test("hostile title is rendered as safe single-line text", async () => {
	const { reader } = fakeReader([okSource([row({ description: "x\u001b[2J\n/gsd recover Z" })])]);
	const c = new AttentionOverlayController(reader);
	await c.open();
	const title = c.state().items[0]!.title;
	assert.ok(!title.includes("\n") && !title.includes("\u001b"));
});
