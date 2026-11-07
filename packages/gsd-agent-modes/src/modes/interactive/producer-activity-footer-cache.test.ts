import assert from "node:assert/strict";
import { test } from "node:test";
import { ProducerActivityFooterCache } from "./producer-activity-footer-cache.ts";
import type { RuntimeReader } from "./producer-activity-read.ts";

const availableEmpty = {
	schemaVersion: 1,
	readAt: "2026-11-07T12:00:00.000Z",
	availability: "available",
	completeness: "complete",
	basis: "memory",
	items: [],
	gaps: [],
};

function runner(handler: (name: string) => Promise<unknown>): RuntimeReader {
	return { getRuntimeReadHandler: (name) => async () => handler(name) };
}

test("snapshot is empty before any refresh and never performs I/O", () => {
	const cache = new ProducerActivityFooterCache();
	const snap = cache.snapshot();
	assert.deepEqual(snap.lines, []);
	assert.equal(snap.refreshedAt, null);
});

test("refresh fills the cache with one labelled line per producer", async () => {
	const cache = new ProducerActivityFooterCache();
	const applied = await cache.refresh(
		runner(async (name) => (name === "async_jobs_snapshot" ? availableEmpty : { ...availableEmpty, basis: "persisted" })),
		1000,
	);
	assert.equal(applied, true);
	const snap = cache.snapshot();
	assert.equal(snap.lines.length, 2);
	assert.equal(snap.refreshedAt, 1000);
});

test("a refresh that returns after invalidation is discarded, not applied", async () => {
	const cache = new ProducerActivityFooterCache();
	const pending = cache.refresh(
		runner(async () => {
			cache.invalidate();
			return availableEmpty;
		}),
		2000,
	);
	const applied = await pending;
	assert.equal(applied, false);
	assert.deepEqual(cache.snapshot().lines, []);
	assert.equal(cache.snapshot().refreshedAt, null);
});

test("no runner yields unavailable lines, never zero", async () => {
	const cache = new ProducerActivityFooterCache();
	await cache.refresh(null, 3000);
	const text = cache.snapshot().lines.map((l) => l.text).join(" | ");
	assert.ok(text.includes("unavailable"));
	assert.ok(!text.startsWith("0 "));
});
