import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildAttentionView,
	classifyWorkflowBlockerKind,
	classifyPauseKind,
	attentionIdentity,
	safeText,
	INSPECT_ONLY_NOTICE,
	type AttentionSource,
	type AttentionView,
} from "./attention-model.ts";

const row = (over: Partial<Record<string, unknown>> = {}) => ({
	blockerId: "B-1",
	blockerKind: "consent",
	resolutionOwner: "user",
	description: "Confirm the deploy target",
	requestedAction: "Reply yes or no",
	openedAt: "2026-11-15T10:00:00.000Z",
	openedProjectRevision: 7,
	...over,
});

const okSource = (rows: unknown[], extra: Partial<AttentionSource> = {}): AttentionSource => ({
	namespace: "workflow",
	status: "available",
	completeness: "complete",
	rows: rows as never,
	...extra,
});

test("canonical workflow_blockers kinds classify; unknown kinds never classify from prose", () => {
	for (const kind of ["missing_authority", "missing_access", "external_dependency", "consent", "ambiguous_intent", "subjective_uat", "user_limit"]) {
		assert.equal(classifyWorkflowBlockerKind(kind), kind);
	}
	assert.equal(classifyWorkflowBlockerKind("Consent"), null);
	assert.equal(classifyWorkflowBlockerKind("please retry this now"), null);
	assert.equal(classifyWorkflowBlockerKind(""), null);
});

test("auto-pause adds user_request and machine_fixable as its own vocabulary", () => {
	assert.equal(classifyPauseKind("user_request"), "user_request");
	assert.equal(classifyPauseKind("machine_fixable"), "machine_fixable");
	assert.equal(classifyPauseKind("consent"), "consent");
	assert.equal(classifyPauseKind("retry_now"), null);
});

test("unknown kind and unknown owner become Unclassified attention with inspect-only", () => {
	const view = buildAttentionView([okSource([row({ blockerKind: "approve_everything", resolutionOwner: "agent" })])]);
	const item = view.items[0]!;
	assert.equal(item.classification, "unclassified");
	assert.equal(item.actions.includes("inspect-blocker"), false);
	assert.equal(item.destination.kind, "details-only");
});

test("no executable approve, retry, resolve or dismiss action is ever offered", () => {
	const view = buildAttentionView([okSource([row(), row({ blockerId: "B-2", blockerKind: "user_request" })])]);
	for (const item of view.items) {
		for (const action of item.actions) {
			assert.ok(!/approve|retry|resolve|dismiss|recover|answer/i.test(action), `forbidden action ${action}`);
		}
	}
});

test("identity is namespaced: workflow blocker and auto-pause with the same raw id stay distinct", () => {
	const a = attentionIdentity({ namespace: "workflow", id: "X" });
	const b = attentionIdentity({ namespace: "auto-pause", id: "X" });
	assert.notEqual(a, b);
});

test("duplicate snapshots of one blocker collapse to one identity, not two rows", () => {
	const view = buildAttentionView([okSource([row(), row()])]);
	assert.equal(view.items.length, 1);
});

test("workflow blocker inspect is the only verified destination and is offered regardless of eligibility", () => {
	const view = buildAttentionView([okSource([row()])]);
	const item = view.items[0]!;
	assert.equal(item.destination.kind, "inspect-blocker");
	assert.equal(item.destination.blockerId, "B-1");
});

test("pending-interaction rows never get a navigable destination (no verified owner API)", () => {
	const view = buildAttentionView([
		{ namespace: "interaction", status: "available", completeness: "complete", rows: [{ id: "Q-9", text: "Pick one", createdAt: "2026-11-15T10:00:00.000Z" }] as never },
	]);
	assert.equal(view.items[0]!.destination.kind, "details-only");
});

test("unavailable source never reads as all-clear and does not erase other sources", () => {
	const view = buildAttentionView([
		okSource([row()]),
		{ namespace: "auto-pause", status: "unavailable", completeness: "unknown", rows: [] as never, reason: "no-verified-read" },
	]);
	assert.equal(view.items.length, 1);
	assert.equal(view.allClear, false);
	assert.ok(view.coverage.some((c) => c.namespace === "auto-pause" && c.status === "unavailable"));
});

test("all-clear needs every expected namespace complete; one source or partial is never enough", () => {
	const complete = (namespace: "workflow" | "auto-pause" | "interaction") => ({ namespace, status: "available" as const, completeness: "complete" as const, rows: [] as never });
	assert.equal(buildAttentionView([complete("workflow"), complete("auto-pause"), complete("interaction")]).allClear, true);
	// A single complete source is not all-clear: the other expected namespaces were not read.
	assert.equal(buildAttentionView([okSource([])]).allClear, false);
	assert.equal(buildAttentionView([okSource([], { completeness: "partial" })]).allClear, false);
	assert.equal(buildAttentionView([]).allClear, false);
});

test("truncated read is reported as partial coverage, never as complete", () => {
	const view = buildAttentionView([okSource([row()], { completeness: "partial", reason: "truncated" })]);
	assert.equal(view.coverage[0]!.completeness, "partial");
	assert.equal(view.allClear, false);
});

test("a pending completion or a missing row never resolves a blocker", () => {
	const view = buildAttentionView([okSource([])]);
	assert.equal(view.items.length, 0);
});

test("hostile text is neutralized: control, ANSI and embedded command never execute or re-classify", () => {
	const hostile = "ok\u001b[31m\nretry_now --approve\u0007 /gsd recover X";
	const view = buildAttentionView([okSource([row({ description: hostile, blockerKind: "consent" })])]);
	const item = view.items[0]!;
	assert.ok(!item.title.includes("\u001b"));
	assert.ok(!item.title.includes("\n"));
	assert.ok(!item.title.includes("\u0007"));
	assert.equal(item.classification, "consent");
	assert.equal(item.actions.includes("inspect-blocker"), true);
	assert.equal(safeText("a\u001b[2Jb\nc"), "a b c");
});

test("opening revision is historical; a different revision alone never marks a row stale", () => {
	const view = buildAttentionView([okSource([row({ openedProjectRevision: 1 })])], { currentRevision: 99 });
	assert.equal(view.items[0]!.freshness, "current");
});

test("inspect-only notice is the exact specified text", () => {
	assert.equal(INSPECT_ONLY_NOTICE, "No verified owner-controlled destination. Details only; nothing is sent or changed.");
});

test("output is a pure value: building it twice yields identical structures", () => {
	const input = [okSource([row(), row({ blockerId: "B-2", blockerKind: "user_limit" })])];
	assert.deepEqual(buildAttentionView(input), buildAttentionView(input));
});

test("a row from an unavailable source is not silently kept from a prior snapshot", () => {
	const earlier = buildAttentionView([okSource([row()])]);
	const later = buildAttentionView([
		{ namespace: "workflow", status: "unavailable", completeness: "unknown", rows: [] as never, reason: "project-switched" },
	]);
	assert.equal(earlier.items.length, 1);
	assert.equal(later.items.length, 0);
	assert.equal(later.allClear, false);
});

test("auto-pause user_request and machine_fixable keep their own namespace classification", () => {
	const view = buildAttentionView([
		{ namespace: "auto-pause", status: "available", completeness: "complete", rows: [
			row({ blockerId: "P-1", blockerKind: "user_request" }),
			row({ blockerId: "P-2", blockerKind: "machine_fixable" }),
		] as never },
	]);
	assert.deepEqual(view.items.map((i) => i.classification), ["user_request", "machine_fixable"]);
	for (const item of view.items) assert.equal(item.destination.kind, "details-only");
});
