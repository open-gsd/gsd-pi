import assert from "node:assert/strict";
import test from "node:test";

import {
	assertProgressResult,
	assertSnapshotResult,
	parseToolTextPayload,
} from "../mcp-host-smoke.mjs";

const progress = {
	activeMilestone: { id: "M001", title: "Authority Fixture" },
	activeSlice: null,
	activeTask: null,
	phase: "execute",
		milestones: { total: 1, done: 0, active: 1, pending: 0, parked: 0 },
	slices: { total: 0, done: 0, active: 0, pending: 0 },
		tasks: { total: 0, done: 0, pending: 0 },
	requirements: null,
	blockers: [],
	nextAction: "Continue",
	readMetadata: { source: "database", authority: "db-authoritative" },
};

const snapshot = {
	authority: { projectId: "project-1", schemaVersion: 1, revision: 42, authorityEpoch: 2 },
	current: { activeMilestone: null, activeSlice: null, activeTask: null, phase: "execute", nextAction: "Continue" },
	progress: {
		milestones: { total: 1, done: 0, active: 1, pending: 0, parked: 0 },
		slices: { total: 0, done: 0, active: 0, pending: 0 },
		tasks: { total: 0, done: 0, pending: 0 },
	},
	blockers: [],
	blockersTruncated: false,
	openQuestions: [],
	openQuestionsTruncated: false,
	verification: { assessments: { total: 0, pass: 0, fail: 0 }, evidence: { total: 0, passed: 0, failed: 0 } },
		milestones: { items: [{ id: "M001", title: "Authority Fixture", status: "active", sequence: 1 }], truncated: false },
	capturedAt: "2026-09-11T00:00:00.000Z",
};

function resultFor(payload, structuredContent = undefined) {
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		...(structuredContent === undefined ? {} : { structuredContent }),
	};
}

function reverseObjectKeys(value) {
	if (Array.isArray(value)) return value.map(reverseObjectKeys);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseObjectKeys(value[key])]));
}

function expectFailure(fn, message) {
	assert.throws(fn, (error) => error instanceof Error && error.message.includes(message));
}

test("import exposes assertions without starting the MCP runtime", () => {
	assert.deepEqual(parseToolTextPayload(resultFor({ ok: true }), "test"), { ok: true });
});

test("progress accepts current DB provenance and additive fields", () => {
	assert.deepEqual(assertProgressResult(resultFor({ ...progress, futureField: true })), { ...progress, futureField: true });
});

test("progress rejects errors, malformed text, null/array payloads, and projection provenance", () => {
	expectFailure(() => assertProgressResult({ isError: true, content: [{ type: "text", text: "{}" }] }), "MCP error envelope");
	expectFailure(() => assertProgressResult({ content: [{ type: "text", text: "{}" }], structuredContent: { operation: "read_progress", error: "db_unavailable" } }), "structured canonical error");
	expectFailure(() => assertProgressResult({ content: [{ type: "text", text: JSON.stringify(progress) }], structuredContent: { error: null } }), "malformed structured canonical error");
	expectFailure(() => parseToolTextPayload({ content: [{ type: "text", text: "{}" }, { type: "text", text: "{" }] }, "progress"), "exactly one text content block");
	expectFailure(() => parseToolTextPayload({ content: [{ type: "json", text: "{}" }] }, "progress"), "exactly one text content block");
	expectFailure(() => parseToolTextPayload({ content: [{ type: "text", text: "{" }] }, "progress"), "invalid JSON");
	expectFailure(() => parseToolTextPayload(resultFor(null), "progress"), "non-null object");
	expectFailure(() => parseToolTextPayload(resultFor([]), "progress"), "non-null object");
	expectFailure(() => assertProgressResult(resultFor({ ...progress, readMetadata: { source: "projection", authority: "projection-fallback" } })), "readMetadata.source");
	expectFailure(() => assertProgressResult(resultFor({ ...progress, readMetadata: { source: "database", authority: "projection-fallback" } })), "readMetadata.authority");
});

test("snapshot validates envelope metadata, caps, and deep text/structured parity independent of object key order", () => {
	const reordered = reverseObjectKeys(snapshot);
	const structured = { snapshot: reordered, revision: 42, operation: "read_project_snapshot", additive: "ok" };
	assert.deepEqual(assertSnapshotResult(resultFor(snapshot, structured)), snapshot);

	const differentValue = { ...structured, snapshot: { ...reordered, current: { ...reordered.current, phase: "plan" } } };
	expectFailure(() => assertSnapshotResult(resultFor(snapshot, differentValue)), "deep value parity mismatch");
});

test("snapshot rejects invalid authority, operation, revision, truncation, and output caps", () => {
	expectFailure(() => assertSnapshotResult(resultFor({ ...snapshot, authority: { ...snapshot.authority, revision: "42" } }, { operation: "read_project_snapshot", revision: 42, snapshot })), "authority.revision");
	expectFailure(() => assertSnapshotResult(resultFor({ ...snapshot, authority: { ...snapshot.authority, revision: -1 } }, { operation: "read_project_snapshot", revision: -1, snapshot })), "non-negative");
	expectFailure(() => assertSnapshotResult(resultFor(snapshot, { operation: "wrong", revision: 42, snapshot })), "operation");
	expectFailure(() => assertSnapshotResult(resultFor(snapshot, { operation: "read_project_snapshot", revision: 41, snapshot })), "structuredContent.revision");
	const { blockersTruncated, openQuestionsTruncated, ...withoutTruncation } = snapshot;
	expectFailure(() => assertSnapshotResult(resultFor({ ...withoutTruncation, openQuestions: [] }, { operation: "read_project_snapshot", revision: 42, snapshot })), "blockersTruncated");
	expectFailure(() => assertSnapshotResult(resultFor({ ...snapshot, openQuestionsTruncated: undefined }, { operation: "read_project_snapshot", revision: 42, snapshot })), "openQuestionsTruncated");
	expectFailure(() => assertSnapshotResult(resultFor({ ...snapshot, blockersTruncated: "no" }, { operation: "read_project_snapshot", revision: 42, snapshot })), "blockersTruncated");
	expectFailure(() => assertSnapshotResult(resultFor({ ...snapshot, capturedAt: "September 11, 2026" }, { operation: "read_project_snapshot", revision: 42, snapshot })), "ISO-8601");
	expectFailure(() => assertSnapshotResult(resultFor({ ...snapshot, capturedAt: "2026-02-30T00:00:00.000Z" }, { operation: "read_project_snapshot", revision: 42, snapshot })), "ISO-8601");
	expectFailure(() => assertSnapshotResult(resultFor({ ...snapshot, current: {} }, { operation: "read_project_snapshot", revision: 42, snapshot })), "current.activeMilestone");
	expectFailure(() => assertSnapshotResult(resultFor({ ...snapshot, milestones: { items: [null], truncated: false } }, { operation: "read_project_snapshot", revision: 42, snapshot })), "object items");
	expectFailure(() => assertProgressResult(resultFor({ ...progress, milestones: {} })), "gsd_progress.milestones.total");
	expectFailure(() => assertProgressResult(resultFor({ ...progress, blockers: [42] })), "string array");
	expectFailure(() => assertSnapshotResult(resultFor({ ...snapshot, milestones: { items: Array(51).fill({}), truncated: true } }, { operation: "read_project_snapshot", revision: 42, snapshot })), "output cap");
});
