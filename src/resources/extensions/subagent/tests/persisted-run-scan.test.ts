import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scanPersistedSubagentRuns } from "../persisted-run-scan.ts";

const readAt = "2026-11-07T12:00:00.000Z";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "run-scan-"));
}

test("missing store is unavailable and the scanner does not create it", () => {
	const base = path.join(tmpDir(), "does-not-exist");
	const scan = scanPersistedSubagentRuns(base, readAt);
	assert.equal(scan.availability, "unavailable");
	assert.equal(scan.completeness, "unknown");
	assert.equal(fs.existsSync(base), false, "scanner must not mkdir");
});

test("empty existing store is complete with zero items", () => {
	const base = tmpDir();
	const scan = scanPersistedSubagentRuns(base, readAt);
	assert.equal(scan.availability, "available");
	if (scan.availability !== "available") return;
	assert.equal(scan.completeness, "complete");
	assert.equal(scan.items.length, 0);
});

test("persisted running is reported as stored and is not revalidated or rewritten", () => {
	const base = tmpDir();
	const file = path.join(base, "r1.json");
	const record = {
		schemaVersion: 1,
		runId: "r1",
		mode: "single",
		contextMode: "fresh",
		status: "running",
		cwd: "/x",
		startedAt: "2026-11-07T10:00:00.000Z",
		updatedAt: "2026-11-07T10:00:01.000Z",
		children: [{ index: 0, agent: "scout", task: "t", status: "running", pid: 999999 }],
	};
	fs.writeFileSync(file, JSON.stringify(record, null, 2));
	const before = fs.readFileSync(file, "utf-8");

	const scan = scanPersistedSubagentRuns(base, readAt);
	assert.equal(scan.availability, "available");
	if (scan.availability !== "available") return;
	assert.equal(scan.items[0]?.status, "running");
	assert.equal(fs.readFileSync(file, "utf-8"), before, "scanner must not write");
});

test("a corrupt record is skipped and makes the scan partial, never silently complete", () => {
	const base = tmpDir();
	fs.writeFileSync(path.join(base, "bad.json"), "{not json");
	fs.writeFileSync(
		path.join(base, "ok.json"),
		JSON.stringify({ runId: "ok", mode: "single", status: "succeeded", startedAt: "a", updatedAt: "b", children: [] }),
	);
	const scan = scanPersistedSubagentRuns(base, readAt);
	assert.equal(scan.availability, "available");
	if (scan.availability !== "available") return;
	assert.equal(scan.items.length, 1);
	assert.equal(scan.completeness, "partial");
	assert.deepEqual(scan.gaps, ["invalid-record"]);
});

test("the scan is bounded and says so", () => {
	const base = tmpDir();
	for (let i = 0; i < 205; i++) {
		fs.writeFileSync(
			path.join(base, `r${i}.json`),
			JSON.stringify({ runId: `r${i}`, mode: "single", status: "succeeded", startedAt: "a", updatedAt: "b", children: [] }),
		);
	}
	const scan = scanPersistedSubagentRuns(base, readAt);
	assert.equal(scan.availability, "available");
	if (scan.availability !== "available") return;
	assert.equal(scan.items.length, 200);
	assert.equal(scan.completeness, "partial");
	assert.ok(scan.gaps.includes("bounded-scan"));
});

test("a null child rejects only that record; the scan completes with an invalid-record gap", () => {
	const base = tmpDir();
	fs.writeFileSync(
		path.join(base, "nullchild.json"),
		JSON.stringify({ runId: "nc", mode: "single", status: "running", startedAt: "a", updatedAt: "b", children: [null] }),
	);
	fs.writeFileSync(
		path.join(base, "ok.json"),
		JSON.stringify({ runId: "ok", mode: "single", status: "succeeded", startedAt: "a", updatedAt: "b", children: [] }),
	);
	const scan = scanPersistedSubagentRuns(base, readAt);
	assert.equal(scan.availability, "available");
	if (scan.availability !== "available") return;
	assert.equal(scan.items.length, 1);
	assert.equal(scan.items[0]?.runId, "ok");
	assert.equal(scan.completeness, "partial");
	assert.deepEqual(scan.gaps, ["invalid-record"]);
});

test("a child missing required fields is rejected, not filled with defaults", () => {
	const base = tmpDir();
	fs.writeFileSync(
		path.join(base, "partialchild.json"),
		JSON.stringify({ runId: "pc", mode: "single", status: "running", startedAt: "a", updatedAt: "b", children: [{ index: 0 }] }),
	);
	const scan = scanPersistedSubagentRuns(base, readAt);
	assert.equal(scan.availability, "available");
	if (scan.availability !== "available") return;
	assert.equal(scan.items.length, 0);
	assert.deepEqual(scan.gaps, ["invalid-record"]);
});
