import assert from "node:assert/strict";
import { test } from "node:test";
import { producerFacetRows, type WidthOps } from "./producer-facet-rows.ts";

// ASCII-only width ops: exact for the ASCII text used here. The production footer
// injects the real pi-tui visibleWidth/truncateToWidth, which handle ANSI.
const ascii: WidthOps = {
	visibleWidth: (s) => s.length,
	truncateToWidth: (s, width, ellipsis) => (s.length <= width ? s : s.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis),
};

const mixedSubagents = { label: "subagent runs", text: "", qualifier: "(stored, partial)", detail: "1 running, 1 succeeded" };
const mixedJobs = { label: "async jobs", text: "", qualifier: "(snapshot, complete)", detail: "1 running, 1 completed, 1 failed" };

test("every row fits the width, from 30 to 200 columns", () => {
	for (const width of [30, 40, 60, 200]) {
		for (const row of producerFacetRows([mixedJobs, mixedSubagents], width, " (as of 12:00)", ascii)) {
			assert.ok(row.length <= width, `width ${width}: ${JSON.stringify(row)}`);
		}
	}
});

test("a timestamped mixed-state facet keeps every count and the qualifier at 40 and 60 columns", () => {
	for (const width of [40, 60]) {
		const text = producerFacetRows([mixedJobs], width, " (as of 12:00)", ascii).join("\n");
		assert.ok(text.includes("1 running"), `running kept at ${width}`);
		assert.ok(text.includes("1 completed"), `completed kept at ${width}`);
		assert.ok(text.includes("1 failed"), `failed kept at ${width}: ${text}`);
		assert.ok(text.includes("(snapshot, complete)"), `qualifier kept at ${width}`);
	}
});

test("a wide terminal keeps the single-line form and the stamp", () => {
	const rows = producerFacetRows([mixedSubagents], 200, " (as of 12:00)", ascii);
	assert.equal(rows[0], "subagent runs: 1 running, 1 succeeded (stored, partial) (as of 12:00)");
});

test("the stamp is part of the rendered first row, not only a length check", () => {
	const rows = producerFacetRows([mixedJobs, mixedSubagents], 200, " (as of 12:00)", ascii);
	assert.ok(rows[0]!.includes("(as of 12:00)"));
	assert.ok(!rows[1]!.includes("(as of 12:00)"));
});

test("timestamped rows stay within the width down to 1 column (Copilot)", () => {
	for (const width of [1, 2, 3, 4, 6, 8, 12, 20]) {
		for (const row of producerFacetRows([mixedJobs, mixedSubagents], width, " (as of 12:00)", ascii)) {
			assert.ok(row.length <= width, `width ${width}: ${JSON.stringify(row)}`);
		}
	}
});
