import assert from "node:assert/strict";
import { test } from "node:test";
import { projectAsyncJobs } from "../producer-activity-snapshot.ts";

const readAt = "2026-11-07T12:00:00.000Z";

test("missing manager is unavailable with unknown completeness, never an empty complete list", () => {
	const snap = projectAsyncJobs(null, readAt);
	assert.equal(snap.availability, "unavailable");
	assert.equal(snap.completeness, "unknown");
	assert.ok(!("items" in snap));
});

test("an initialized manager with no jobs is a complete empty inventory", () => {
	const snap = projectAsyncJobs([], readAt);
	assert.deepEqual(snap, {
		schemaVersion: 1,
		readAt,
		availability: "available",
		completeness: "complete",
		basis: "memory",
		items: [],
		gaps: [],
	});
});

test("jobs are projected to scalar DTOs; live handles and output are not copied", () => {
	const live = {
		id: "j1",
		type: "bash",
		status: "running",
		label: "npm test",
		startTime: 1700000000000,
		abortController: new AbortController(),
		promise: Promise.resolve(),
		resultText: "SECRET OUTPUT",
		awaited: true,
		delivered: true,
	};
	const snap = projectAsyncJobs([live], readAt);
	assert.equal(snap.availability, "available");
	if (snap.availability !== "available") return;
	assert.deepEqual(snap.items, [{ id: "j1", type: "bash", status: "running", label: "npm test", startTime: 1700000000000 }]);
	const serialized = JSON.stringify(snap);
	assert.ok(!serialized.includes("SECRET OUTPUT"));
	assert.ok(!serialized.includes("awaited"));
	assert.ok(!serialized.includes("delivered"));
});

test("an invalid record is skipped and makes the snapshot partial, not silently complete", () => {
	const snap = projectAsyncJobs(
		[
			{ id: "ok", type: "bash", status: "completed", label: "a", startTime: 1 },
			{ id: "bad", type: "bash", status: "weird", label: "b", startTime: 2 },
		],
		readAt,
	);
	assert.equal(snap.availability, "available");
	if (snap.availability !== "available") return;
	assert.equal(snap.items.length, 1);
	assert.equal(snap.completeness, "partial");
	assert.deepEqual(snap.gaps, ["invalid-record"]);
});

test("a snapshot never reports a combined count or a running/done bit", () => {
	const snap = projectAsyncJobs([{ id: "j", type: "bash", status: "running", label: "x", startTime: 1 }], readAt);
	assert.ok(!("count" in snap));
	assert.ok(!("running" in snap));
	assert.ok(!("done" in snap));
});
