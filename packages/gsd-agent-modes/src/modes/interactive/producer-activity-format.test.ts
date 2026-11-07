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
			snapshot: { availability: "available", completeness: "complete", items: [{ id: "a" }, { id: "b" }], gaps: [] },
		},
	]);
	assert.deepEqual(lines, [{ label: "async jobs", text: "2 live, complete" }]);
});

test("subagent runs are labelled stored, never live", () => {
	const lines = formatProducerFacets([
		{
			name: "subagent_runs_snapshot",
			status: "available",
			snapshot: { availability: "available", completeness: "partial", items: [{ status: "running" }], gaps: ["invalid-record"] },
		},
	]);
	assert.deepEqual(lines, [{ label: "subagent runs", text: "1 stored, partial" }]);
	assert.ok(!lines[0]!.text.includes("live"));
});

test("facets stay separate: one line per producer, no combined total", () => {
	const lines = formatProducerFacets([
		{ name: "async_jobs_snapshot", status: "unavailable", snapshot: { availability: "unavailable", completeness: "unknown", reason: "no-runner" } },
		{ name: "subagent_runs_snapshot", status: "unavailable", snapshot: { availability: "unavailable", completeness: "unknown", reason: "no-runner" } },
	]);
	assert.equal(lines.length, 2);
});
