import assert from "node:assert/strict";
import { test } from "node:test";
import { formatProducerFacets } from "./producer-activity-format.ts";

test("unavailable is shown as unavailable with its reason, never as zero", () => {
	const lines = formatProducerFacets([
		{ name: "async_jobs_snapshot", status: "unavailable", snapshot: { availability: "unavailable", completeness: "unknown", reason: "capability-missing" } },
	]);
	assert.deepEqual(lines, [{ label: "async jobs", text: "unavailable (capability-missing)" }]);
	assert.ok(!lines[0]!.text.includes("0 "));
});

test("available async jobs are labelled live and show completeness", () => {
	const lines = formatProducerFacets([
		{
			name: "async_jobs_snapshot",
			status: "available",
			snapshot: { availability: "available", completeness: "complete", items: [{ id: "a", status: "running" }, { id: "b", status: "running" }], gaps: [] },
		},
	]);
	assert.deepEqual(lines, [{ label: "async jobs", text: "2 running (snapshot, complete)", qualifier: "(snapshot, complete)", detail: "2 running" }]);
});

test("subagent runs are labelled stored, never live", () => {
	const lines = formatProducerFacets([
		{
			name: "subagent_runs_snapshot",
			status: "available",
			snapshot: { availability: "available", completeness: "partial", items: [{ status: "running" }], gaps: ["invalid-record"] },
		},
	]);
	assert.deepEqual(lines, [{ label: "subagent runs", text: "1 running (stored, partial)", qualifier: "(stored, partial)", detail: "1 running" }]);
	assert.ok(!lines[0]!.text.includes("live"));
});

test("facets stay separate: one line per producer, no combined total", () => {
	const lines = formatProducerFacets([
		{ name: "async_jobs_snapshot", status: "unavailable", snapshot: { availability: "unavailable", completeness: "unknown", reason: "no-runner" } },
		{ name: "subagent_runs_snapshot", status: "unavailable", snapshot: { availability: "unavailable", completeness: "unknown", reason: "no-runner" } },
	]);
	assert.equal(lines.length, 2);
});

test("a failed job alongside a running job is not rendered like two running jobs", () => {
	const running = formatProducerFacets([
		{ name: "async_jobs_snapshot", status: "available", snapshot: { availability: "available", completeness: "complete", items: [{ status: "running" }, { status: "running" }], gaps: [] } },
	]);
	const mixed = formatProducerFacets([
		{ name: "async_jobs_snapshot", status: "available", snapshot: { availability: "available", completeness: "complete", items: [{ status: "running" }, { status: "failed" }], gaps: [] } },
	]);
	assert.notEqual(mixed[0]!.text, running[0]!.text);
	assert.ok(mixed[0]!.text.includes("1 failed"));
	assert.ok(mixed[0]!.text.includes("1 running"));
});

// Defensive path: a status outside the enum is counted as unknown, never dropped.
for (const [name, basis] of [
	["async_jobs_snapshot", "snapshot"],
	["subagent_runs_snapshot", "stored"],
] as const) {
	test(`${name} keeps an unexpected status in the unknown bucket`, () => {
		const snapshot = { availability: "available", completeness: "complete", items: [{ status: "running" }, { status: "pending" }], gaps: [] };
		const [line] = formatProducerFacets([{ name, status: "available", snapshot }]);
		assert.equal(line!.text, `1 running, 1 unknown (${basis}, complete)`);
	});
}
