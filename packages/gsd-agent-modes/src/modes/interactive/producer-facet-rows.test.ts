import assert from "node:assert/strict";
import { test } from "node:test";
import { producerFacetRows, type WidthOps } from "./producer-facet-rows.ts";

// ASCII-only width ops: exact for the ASCII text used here. The production footer
// injects the real pi-tui visibleWidth/truncateToWidth, which handle ANSI.
const ascii: WidthOps = {
	visibleWidth: (s) => s.length,
	truncateToWidth: (s, width, ellipsis) => (s.length <= width ? s : s.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis),
};

const mixedSubagents = {
	label: "subagent runs",
	text: "1 running, 1 succeeded (stored, partial)",
	qualifier: "(stored, partial)",
	detail: "1 running, 1 succeeded",
};
const mixedJobs = {
	label: "async jobs",
	text: "1 running, 1 completed, 1 failed (snapshot, complete)",
	qualifier: "(snapshot, complete)",
	detail: "1 running, 1 completed, 1 failed",
};

test("at 40 columns the qualifier survives, even when the count is shortened", () => {
	const rows = producerFacetRows([mixedJobs, mixedSubagents], 40, "", ascii);
	assert.equal(rows.length, 2, "one row per facet");
	for (const row of rows) {
		assert.ok(row.length <= 40, `row fits width: ${row}`);
	}
	assert.ok(rows[0]!.endsWith("(snapshot, complete)"), `jobs qualifier intact: ${rows[0]}`);
	assert.ok(rows[1]!.endsWith("(stored, partial)"), `subagent qualifier intact: ${rows[1]}`);
});

test("a wide terminal keeps the full count and qualifier unshortened", () => {
	const rows = producerFacetRows([mixedSubagents], 200, "", ascii);
	assert.equal(rows[0], "subagent runs: 1 running, 1 succeeded (stored, partial)");
});

test("the stamp is shown on the first facet row only", () => {
	const rows = producerFacetRows([mixedJobs, mixedSubagents], 200, " (as of 12:00)", ascii);
	assert.ok(rows[0]!.includes("(as of 12:00)"));
	assert.ok(!rows[1]!.includes("(as of 12:00)"));
});
