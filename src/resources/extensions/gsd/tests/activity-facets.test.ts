import assert from "node:assert/strict";
import { test } from "node:test";
import { projectActivityFacets } from "../activity-facets.ts";

test("assistant facet reflects turn state from the tracker and never invents idle", () => {
	const facets = projectActivityFacets({
		turn: { getState: () => "waiting-question" },
		sessions: null,
	});
	assert.deepEqual(facets.assistant, {
		availability: "available",
		state: "waiting-question",
		source: "turn-status",
	});
});

test("missing turn tracker yields unavailable assistant, not idle", () => {
	const facets = projectActivityFacets({ turn: null, sessions: null });
	assert.equal(facets.assistant.availability, "unavailable");
});

test("failed session-status read is unavailable, never zero running workers", () => {
	const facets = projectActivityFacets({
		turn: null,
		sessions: { readRunningWorkerCount: () => null },
	});
	assert.equal(facets.workers.availability, "unavailable");
	assert.notEqual((facets.workers as { running?: number }).running, 0);
});

test("successful session-status read reports the worker count from its own source", () => {
	const facets = projectActivityFacets({
		turn: null,
		sessions: { readRunningWorkerCount: () => 2 },
	});
	assert.deepEqual(facets.workers, { availability: "available", running: 2, source: "session-status" });
});

test("async jobs and subagents are always unavailable until producers expose a verified contract", () => {
	const facets = projectActivityFacets({
		turn: { getState: () => "working" },
		sessions: { readRunningWorkerCount: () => 3 },
	});
	assert.equal(facets.asyncJobs.availability, "unavailable");
	assert.equal(facets.subagents.availability, "unavailable");
});

test("facets stay separate: no combined total field is produced", () => {
	const facets = projectActivityFacets({
		turn: { getState: () => "working" },
		sessions: { readRunningWorkerCount: () => 1 },
	});
	assert.deepEqual(Object.keys(facets).sort(), ["assistant", "asyncJobs", "subagents", "workers"]);
});
