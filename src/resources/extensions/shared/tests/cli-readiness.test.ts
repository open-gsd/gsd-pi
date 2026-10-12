import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createReadinessCache, keepEventLoopAlive, runCliProbe } from "../cli-readiness.ts";

/** A probe whose completion the test controls, and which counts its runs. */
function makeControlledProbe<T>() {
	const calls: Array<{ previous: T | null; resolve: (value: T) => void; reject: (error: Error) => void }> = [];
	const probe = (previous: T | null) =>
		new Promise<T>((resolve, reject) => {
			calls.push({ previous, resolve, reject });
		});
	return { probe, calls };
}

/** Let the cache's deferred probe start (it yields once before probing). */
async function flushMicrotasks(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("createReadinessCache", () => {
	test("cold peek() answers null immediately and starts exactly one background probe", async () => {
		const { probe, calls } = makeControlledProbe<boolean>();
		const cache = createReadinessCache({ probe });

		assert.equal(cache.peek(), null);
		assert.equal(calls.length, 0, "the probe must not start on the caller's stack");
		assert.equal(cache.peek(), null);
		assert.equal(cache.peek(), null);

		await flushMicrotasks();
		assert.equal(calls.length, 1, "repeated peeks share one in-flight probe");

		calls[0].resolve(true);
		await flushMicrotasks();
		assert.equal(cache.peek(), true);
		assert.equal(calls.length, 1, "a fresh cache does not re-probe");
	});

	test("stale peek() returns the last answer synchronously, then the refresh updates it", async (t) => {
		t.mock.timers.enable({ apis: ["Date"] });
		const { probe, calls } = makeControlledProbe<boolean>();
		const cache = createReadinessCache({ probe, intervalMs: 30_000 });

		const first = cache.settle();
		await flushMicrotasks();
		calls[0].resolve(true);
		assert.equal(await first, true);

		t.mock.timers.tick(29_000);
		assert.equal(cache.peek(), true);
		await flushMicrotasks();
		assert.equal(calls.length, 1, "still inside the cache window");

		t.mock.timers.tick(2_000);
		assert.equal(cache.peek(), true, "stale cache still answers with the last known value");
		assert.equal(cache.peek(), true);
		await flushMicrotasks();
		assert.equal(calls.length, 2, "one background refresh for the stale window");
		assert.equal(calls[1].previous, true, "the probe sees the previous snapshot");

		calls[1].resolve(false);
		await flushMicrotasks();
		assert.equal(cache.peek(), false, "the async refresh replaced the cached value");
		assert.equal(calls.length, 2);
	});

	test("settle() reuses a fresh cache, joins an in-flight probe, and re-probes a stale one", async (t) => {
		t.mock.timers.enable({ apis: ["Date"] });
		const { probe, calls } = makeControlledProbe<string>();
		const cache = createReadinessCache({ probe, intervalMs: 30_000 });

		cache.peek();
		const joined = cache.settle();
		await flushMicrotasks();
		assert.equal(calls.length, 1, "settle() joined the probe peek() started");
		calls[0].resolve("first");
		assert.equal(await joined, "first");

		assert.equal(await cache.settle(), "first");
		assert.equal(calls.length, 1, "fresh cache: no new probe");

		t.mock.timers.tick(31_000);
		const refreshed = cache.settle();
		await flushMicrotasks();
		assert.equal(calls.length, 2);
		calls[1].resolve("second");
		assert.equal(await refreshed, "second", "settle() never returns a stale answer");
	});

	test("clear() drops the snapshot and ignores a probe that started before it", async () => {
		const { probe, calls } = makeControlledProbe<boolean>();
		const cache = createReadinessCache({ probe });

		const first = cache.settle();
		await flushMicrotasks();
		calls[0].resolve(true);
		await first;
		assert.equal(cache.peek(), true);

		cache.clear();
		assert.equal(cache.peek(), null, "cold again after clear()");
		await flushMicrotasks();
		assert.equal(calls.length, 2);

		// A second clear() while that probe is in flight: its answer predates
		// the clear and must not be written back.
		cache.clear();
		calls[1].resolve(false);
		await flushMicrotasks();
		assert.equal(cache.peek(), null);
		await flushMicrotasks();
		assert.equal(calls.length, 3, "the next check after clear() re-probes");
		calls[2].resolve(true);
		await flushMicrotasks();
		assert.equal(cache.peek(), true);
	});

	test("a rejecting probe keeps the snapshot and is retried once per window, not per call", async (t) => {
		t.mock.timers.enable({ apis: ["Date"] });
		const { probe, calls } = makeControlledProbe<boolean>();
		const cache = createReadinessCache({ probe, intervalMs: 30_000 });

		const first = cache.settle();
		await flushMicrotasks();
		calls[0].resolve(true);
		await first;

		t.mock.timers.tick(31_000);
		assert.equal(cache.peek(), true);
		await flushMicrotasks();
		calls[1].reject(new Error("probe blew up"));
		await flushMicrotasks();

		assert.equal(cache.peek(), true, "known-good snapshot survives a failed probe");
		assert.equal(cache.peek(), true);
		await flushMicrotasks();
		assert.equal(calls.length, 2, "no probe storm after a failure");

		t.mock.timers.tick(31_000);
		cache.peek();
		await flushMicrotasks();
		assert.equal(calls.length, 3);
	});
});

describe("runCliProbe", () => {
	test("resolves with stdout without blocking, and rejects on a non-zero exit", async () => {
		const pending = runCliProbe(process.execPath, ["-e", "process.stdout.write('probe-ok')"], 30_000);
		assert.ok(pending instanceof Promise);
		assert.equal(await keepEventLoopAlive(pending), "probe-ok");

		await assert.rejects(keepEventLoopAlive(runCliProbe(process.execPath, ["-e", "process.exit(3)"], 30_000)));
	});

	test("rejects when the command does not exist", async () => {
		await assert.rejects(keepEventLoopAlive(runCliProbe("gsd-definitely-not-a-real-binary", ["--version"], 30_000)));
	});

	test("closes the child's stdin so a CLI that reads it sees EOF", async () => {
		const script = "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'))";
		assert.equal(await keepEventLoopAlive(runCliProbe(process.execPath, ["-e", script], 30_000)), "eof");
	});
});
