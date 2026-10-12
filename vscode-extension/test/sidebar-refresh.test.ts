// Project/App: gsd-pi
// File Purpose: Verifies sidebar refresh coalescing (stronger queued refresh
// intent) and progress provenance classification with controlled deferred
// responses (issue #2668).

import test from "node:test";
import assert from "node:assert/strict";

import {
	classifyProgressProvenance,
	SidebarRefreshCoordinator,
} from "../src/sidebar-refresh.ts";

/** Manual promise so tests order refresh completions deterministically. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

test("idle strong request runs immediately without queueing", async () => {
	const runs: boolean[] = [];
	const coordinator = new SidebarRefreshCoordinator(async (force) => {
		runs.push(force);
	});

	await coordinator.request(true);

	assert.deepEqual(runs, [true]);
});

test("weak request during an in-flight refresh joins it and schedules nothing", async () => {
	const gate = deferred();
	const runs: boolean[] = [];
	const coordinator = new SidebarRefreshCoordinator(async (force) => {
		runs.push(force);
		if (runs.length === 1) await gate.promise;
	});

	const first = coordinator.request(false);
	const joiner = coordinator.request(false);

	gate.resolve();
	await Promise.all([first, joiner]);

	assert.deepEqual(runs, [false]);
});

test("strong request during a weaker in-flight refresh runs after it and resolves after the strong run", async () => {
	const weakGate = deferred();
	const strongGate = deferred();
	const runs: boolean[] = [];
	const coordinator = new SidebarRefreshCoordinator(async (force) => {
		runs.push(force);
		if (runs.length === 1) await weakGate.promise;
		if (runs.length === 2) await strongGate.promise;
	});

	const weak = coordinator.request(false);
	const strong = coordinator.request(true);

	// The strong caller must not resolve when the weak refresh completes.
	weakGate.resolve();
	await weak;
	await new Promise((resolveTick) => setTimeout(resolveTick, 0));
	assert.deepEqual(runs, [false, true], "the queued strong refresh must start once the weak refresh settles");
	let strongSettled = false;
	strong.then(() => {
		strongSettled = true;
	});
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(strongSettled, false, "strong caller resolved before the queued strong refresh ran");

	strongGate.resolve();
	await strong;
	assert.deepEqual(runs, [false, true]);
	assert.equal(strongSettled, true);
});

test("concurrent strong callers during one weak refresh share a single queued strong run", async () => {
	const weakGate = deferred();
	const strongGate = deferred();
	const runs: boolean[] = [];
	const coordinator = new SidebarRefreshCoordinator(async (force) => {
		runs.push(force);
		if (runs.length === 1) await weakGate.promise;
		if (runs.length === 2) await strongGate.promise;
	});

	const weak = coordinator.request(false);
	const strongA = coordinator.request(true);
	const strongB = coordinator.request(true);

	weakGate.resolve();
	await weak;
	strongGate.resolve();
	await Promise.all([strongA, strongB]);

	assert.deepEqual(runs, [false, true], "each strong caller must not schedule its own strong refresh");
});

test("a failed weak refresh does not cancel the queued strong refresh", async () => {
	const weakGate = deferred();
	const strongGate = deferred();
	const runs: boolean[] = [];
	const coordinator = new SidebarRefreshCoordinator(async (force) => {
		runs.push(force);
		if (runs.length === 1) await weakGate.promise;
		if (runs.length === 2) await strongGate.promise;
	});

	const weak = coordinator.request(false);
	const strong = coordinator.request(true);

	weakGate.reject(new Error("weak refresh failed"));
	await assert.rejects(weak, /weak refresh failed/);

	strongGate.resolve();
	await strong;
	assert.deepEqual(runs, [false, true]);
});

test("at most one refresh runs at a time across queued transitions", async () => {
	const gates = [deferred(), deferred()];
	const runs: boolean[] = [];
	let concurrent = 0;
	let maxConcurrent = 0;
	const coordinator = new SidebarRefreshCoordinator(async (force) => {
		runs.push(force);
		concurrent++;
		maxConcurrent = Math.max(maxConcurrent, concurrent);
		const gate = gates[runs.length - 1];
		if (gate) await gate.promise;
		concurrent--;
	});

	const weak = coordinator.request(false);
	const strong = coordinator.request(true);

	gates[0].resolve();
	await weak;
	gates[1]?.resolve();
	await strong;

	assert.equal(maxConcurrent, 1);
	assert.deepEqual(runs, [false, true]);
});

test("classifyProgressProvenance recognizes only the exact canonical pairs", () => {
	assert.equal(classifyProgressProvenance({ readMetadata: { source: "database", authority: "db-authoritative" } }), "database");
	assert.equal(classifyProgressProvenance({ readMetadata: { source: "projection", authority: "projection-fallback" } }), "projection");
	assert.equal(classifyProgressProvenance({ readMetadata: { source: "projection" } }), "unknown");
	assert.equal(classifyProgressProvenance({ readMetadata: { source: "database", authority: "projection-fallback" } }), "unknown");
	assert.equal(classifyProgressProvenance({ readMetadata: { source: "unknown", authority: "db-authoritative" } }), "unknown");
	assert.equal(classifyProgressProvenance({ readMetadata: null }), "unknown");
	assert.equal(classifyProgressProvenance({}), "unknown");
	assert.equal(classifyProgressProvenance(null), "unknown");
});

test("strong request during an active strong refresh joins it instead of scheduling a successor", async () => {
	const strongGate = deferred();
	const runs: boolean[] = [];
	const coordinator = new SidebarRefreshCoordinator(async (force) => {
		runs.push(force);
		if (runs.length === 1) await strongGate.promise;
	});

	const first = coordinator.request(true);
	const second = coordinator.request(true);

	strongGate.resolve();
	await Promise.all([first, second]);

	assert.deepEqual(runs, [true], "a strong request must coalesce with an already-strong run");
});

test("a caller joining an in-flight refresh observes that run's failure", async () => {
	const gate = deferred();
	const coordinator = new SidebarRefreshCoordinator(async () => {
		await gate.promise;
		throw new Error("shared refresh failed");
	});

	const first = coordinator.request(false);
	const joiner = coordinator.request(false);

	gate.resolve();
	await assert.rejects(first, /shared refresh failed/);
	await assert.rejects(joiner, /shared refresh failed/);
});

test("a caller joining a queued strong refresh observes the strong run's failure", async () => {
	const weakGate = deferred();
	const strongGate = deferred();
	const runs: boolean[] = [];
	const coordinator = new SidebarRefreshCoordinator(async (force) => {
		runs.push(force);
		if (runs.length === 1) await weakGate.promise;
		throw new Error("strong refresh failed");
	});

	const weak = coordinator.request(false);
	weakGate.resolve();
	void weak.catch(() => {});
	const strong = coordinator.request(true);
	const joiner = coordinator.request(false);

	strongGate.resolve();
	await assert.rejects(strong, /strong refresh failed/);
	await assert.rejects(joiner, /strong refresh failed/);
	assert.deepEqual(runs, [false, true]);
});

test("bumpGeneration during a run schedules exactly one fresh strong refresh for the new generation", async () => {
	const weakGate = deferred();
	const strongGate = deferred();
	const runs: boolean[] = [];
	const coordinator = new SidebarRefreshCoordinator(async (force) => {
		runs.push(force);
		if (runs.length === 1) await weakGate.promise;
		if (runs.length === 2) await strongGate.promise;
	});
	const generationBefore = coordinator.generation;

	const weak = coordinator.request(false);
	const refreshed = coordinator.bumpGeneration();

	assert.equal(coordinator.generation, generationBefore + 1);
	assert.ok(refreshed, "a bump during an in-flight refresh must schedule a fresh strong refresh");

	weakGate.resolve();
	await weak;
	await new Promise((resolveTick) => setTimeout(resolveTick, 0));
	assert.deepEqual(runs, [false, true], "the bump must schedule exactly one strong re-run");

	strongGate.resolve();
	await refreshed;
	assert.deepEqual(runs, [false, true]);
});

test("bumpGeneration when idle schedules nothing; the next strong request starts fresh work", async () => {
	const runs: boolean[] = [];
	const coordinator = new SidebarRefreshCoordinator(async (force) => {
		runs.push(force);
	});

	assert.equal(coordinator.bumpGeneration(), null, "an idle coordinator needs no queued work");
	assert.equal(coordinator.generation, 1);

	await coordinator.request(true);
	assert.deepEqual(runs, [true]);
});

test("repeated bumps during one run collapse into a single queued strong refresh", async () => {
	const weakGate = deferred();
	const strongGate = deferred();
	const runs: boolean[] = [];
	const coordinator = new SidebarRefreshCoordinator(async (force) => {
		runs.push(force);
		if (runs.length === 1) await weakGate.promise;
		if (runs.length === 2) await strongGate.promise;
	});

	void coordinator.request(false);
	const first = coordinator.bumpGeneration();
	const second = coordinator.bumpGeneration();

	weakGate.resolve();
	strongGate.resolve();
	await Promise.all([first, second]);
	assert.deepEqual(runs, [false, true], "connection-change storms must not stack refreshes");
	assert.equal(coordinator.generation, 2);
});

test("bumpGeneration during an active strong refresh schedules one fresh strong refresh", async () => {
	const strongGate = deferred();
	const freshGate = deferred();
	const runs: boolean[] = [];
	const coordinator = new SidebarRefreshCoordinator(async (force) => {
		runs.push(force);
		if (runs.length === 1) await strongGate.promise;
		if (runs.length === 2) await freshGate.promise;
	});

	const first = coordinator.request(true);
	const refreshed = coordinator.bumpGeneration();
	assert.ok(refreshed, "a bump during a strong run still owes the new generation a fresh read");

	strongGate.resolve();
	await first;
	await new Promise((resolveTick) => setTimeout(resolveTick, 0));
	assert.deepEqual(runs, [true, true]);

	freshGate.resolve();
	await refreshed;
	assert.deepEqual(runs, [true, true]);
});

test("bumpGeneration while a strong refresh is already queued does not stack another one", async () => {
	const weakGate = deferred();
	const gates = [deferred(), deferred()];
	const runs: boolean[] = [];
	const coordinator = new SidebarRefreshCoordinator(async (force) => {
		runs.push(force);
		const gate = gates[runs.length - 1];
		if (gate) await gate.promise;
	});

	void coordinator.request(false);
	void coordinator.request(true);
	const refreshed = coordinator.bumpGeneration();
	assert.equal(coordinator.generation, 1);
	assert.ok(refreshed);

	// The queued strong refresh has not fetched yet: it starts after the bump
	// and therefore IS the fresh work for the new generation.
	weakGate.resolve();
	gates[0]?.resolve();
	await new Promise((resolveTick) => setTimeout(resolveTick, 0));
	gates[1]?.resolve();
	await refreshed;
	assert.deepEqual(runs, [false, true]);
});

test("a queued refresh from bumpGeneration delivers the strong run's rejection to its callers", async () => {
	const weakGate = deferred();
	const strongGate = deferred();
	const runs: boolean[] = [];
	const coordinator = new SidebarRefreshCoordinator(async (force) => {
		runs.push(force);
		if (runs.length === 1) await weakGate.promise;
		throw new Error("fresh refresh failed");
	});

	void coordinator.request(false);
	const refreshed = coordinator.bumpGeneration();
	assert.ok(refreshed);

	weakGate.resolve();
	await assert.rejects(refreshed, /fresh refresh failed/);
	strongGate.resolve();
	assert.deepEqual(runs, [false, true]);
});
