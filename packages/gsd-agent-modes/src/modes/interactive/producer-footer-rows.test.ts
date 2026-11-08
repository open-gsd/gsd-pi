import assert from "node:assert/strict";
import { test } from "node:test";
import { producerFooterRows } from "./producer-footer-rows.ts";
import type { WidthOps } from "./producer-facet-rows.ts";

const ascii: WidthOps = {
	visibleWidth: (s) => s.length,
	truncateToWidth: (s, w, e) => (s.length <= w ? s : s.slice(0, Math.max(0, w - e.length)) + e),
};
const stamp = (t: number) => `as of ${new Date(t).toISOString().slice(11, 16)}`;
// refreshedAt 12:00 UTC so the stamp text is deterministic.
const T = Date.UTC(2026, 10, 8, 12, 0);

const available = (label: string, text: string, qualifier: string, detail: string) => ({ label, text, qualifier, detail });
const unavailable = (label: string) => ({ label, text: `unavailable (read-threw)` });

test("no cache (compatibility): no rows, footer keeps its single row", () => {
	assert.deepEqual(producerFooterRows(undefined, 80, ascii, stamp), []);
});

test("cache present but no facet lines: no rows", () => {
	assert.deepEqual(producerFooterRows({ lines: [], refreshedAt: null }, 80, ascii, stamp), []);
});

test("unavailable facet is shown as unavailable, never as zero", () => {
	const rows = producerFooterRows({ lines: [unavailable("async jobs")], refreshedAt: null }, 80, ascii, stamp);
	assert.equal(rows.length, 1);
	assert.ok(rows[0]!.includes("unavailable (read-threw)"), rows[0]);
	assert.ok(!rows[0]!.includes(": 0 "), `must not render a zero: ${rows[0]}`);
});

test("timestamped mixed state at 40 and 60 columns keeps every count and the qualifier", () => {
	const lines = [available("async jobs", "", "(snapshot, complete)", "1 running, 1 completed, 1 failed")];
	for (const width of [40, 60]) {
		const text = producerFooterRows({ lines, refreshedAt: T }, width, ascii, stamp).join(" ").replace(/\s+/g, " ");
		for (const field of ["1 running", "1 completed", "1 failed", "(snapshot, complete)", "as of 12:00"]) {
			assert.ok(text.includes(field), `width ${width} missing ${field}: ${text}`);
		}
	}
});

test("timestamped mixed state at 20 columns keeps the qualifier and the stamp", () => {
	const lines = [available("subagent runs", "", "(stored, partial)", "1 running, 1 succeeded")];
	const rows = producerFooterRows({ lines, refreshedAt: T }, 20, ascii, stamp);
	assert.ok(rows.includes("(stored, partial)"), JSON.stringify(rows));
	assert.ok(rows.join(" ").replace(/\s+/g, " ").includes("as of 12:00"), JSON.stringify(rows));
	for (const row of rows) assert.ok(row.length <= 20, `fits 20: ${row}`);
});

test("stamp appears on the first facet only", () => {
	const lines = [
		available("async jobs", "", "(snapshot, complete)", "2 running"),
		available("subagent runs", "", "(stored, complete)", "1 succeeded"),
	];
	const rows = producerFooterRows({ lines, refreshedAt: T }, 200, ascii, stamp);
	assert.ok(rows[0]!.includes("as of 12:00"));
	assert.ok(!rows[1]!.includes("as of 12:00"));
});

test("no refresh time yet: no stamp", () => {
	const lines = [available("async jobs", "", "(snapshot, complete)", "0 snapshot")];
	const rows = producerFooterRows({ lines, refreshedAt: null }, 200, ascii, stamp);
	assert.ok(!rows[0]!.includes("as of"), rows[0]);
});

test("every row fits the width from 1 to 200 columns, timestamped", () => {
	const lines = [
		available("async jobs", "", "(snapshot, complete)", "1 running, 1 completed, 1 failed"),
		available("subagent runs", "", "(stored, partial)", "1 running, 1 succeeded"),
	];
	for (let width = 1; width <= 200; width++) {
		for (const row of producerFooterRows({ lines, refreshedAt: T }, width, ascii, stamp)) {
			assert.ok(row.length <= width, `width ${width}: ${JSON.stringify(row)}`);
		}
	}
});
