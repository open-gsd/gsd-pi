import assert from "node:assert/strict";
import { test } from "node:test";
import { isSnapshotShape, readProducer, type RuntimeReader } from "./producer-activity-read.ts";

const available = {
	schemaVersion: 1,
	readAt: "2026-11-07T12:00:00.000Z",
	availability: "available",
	completeness: "complete",
	basis: "memory",
	items: [],
	gaps: [],
};

function runnerWith(handler: (() => Promise<unknown>) | undefined): RuntimeReader {
	return { getRuntimeReadHandler: () => (handler ? async () => handler() : undefined) };
}

test("no runner yields unavailable, never an empty complete inventory", async () => {
	const r = await readProducer(null, "async_jobs_snapshot", () => true);
	assert.equal(r.status, "unavailable");
	assert.equal((r.snapshot as { completeness: string }).completeness, "unknown");
});

test("missing capability is unavailable with a reason", async () => {
	const r = await readProducer(runnerWith(undefined), "subagent_runs_snapshot", () => true);
	assert.equal(r.status, "unavailable");
	assert.equal((r.snapshot as { reason: string }).reason, "capability-missing");
});

test("a throwing handler is unavailable, not propagated", async () => {
	const r = await readProducer(
		runnerWith(async () => {
			throw new Error("boom");
		}),
		"async_jobs_snapshot",
		() => true,
	);
	assert.equal(r.status, "unavailable");
	assert.equal((r.snapshot as { reason: string }).reason, "read-threw");
});

test("an invalid response shape is unavailable", async () => {
	const r = await readProducer(runnerWith(async () => ({ foo: "bar" })), "async_jobs_snapshot", () => true);
	assert.equal(r.status, "unavailable");
	assert.equal((r.snapshot as { reason: string }).reason, "invalid-response");
});

test("a valid snapshot is returned as available", async () => {
	const r = await readProducer(runnerWith(async () => available), "async_jobs_snapshot", () => true);
	assert.equal(r.status, "available");
	assert.deepEqual(r.snapshot, available);
});

test("a late response after the session changed is discarded as stale", async () => {
	let current = true;
	const r = await readProducer(
		runnerWith(async () => {
			current = false;
			return available;
		}),
		"async_jobs_snapshot",
		() => current,
	);
	assert.equal(r.status, "unavailable");
	assert.equal((r.snapshot as { reason: string }).reason, "stale-response");
});

test("shape check rejects an available envelope without items or gaps", () => {
	assert.equal(isSnapshotShape({ schemaVersion: 1, readAt: "x", availability: "available", completeness: "complete" }), false);
	assert.equal(isSnapshotShape(available), true);
});

test("a basis mismatch for the requested producer is invalid-response, not an inventory", async () => {
	const wrongBasis = { ...available, basis: "persisted", items: [{ id: "a", label: "x", status: "running" }] };
	const r = await readProducer(runnerWith(async () => wrongBasis), "async_jobs_snapshot", () => true);
	assert.equal(r.status, "unavailable");
	assert.equal((r.snapshot as { reason: string }).reason, "invalid-response");
});

test("malformed item fields are invalid-response, not counted", async () => {
	const badItem = { ...available, basis: "memory", items: [null] };
	const r = await readProducer(runnerWith(async () => badItem), "async_jobs_snapshot", () => true);
	assert.equal(r.status, "unavailable");
	assert.equal((r.snapshot as { reason: string }).reason, "invalid-response");
});
