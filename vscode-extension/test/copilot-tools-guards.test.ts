// Project/App: gsd-pi
// File Purpose: Behavioral tests for the Copilot Chat tool invocation guards
// (input validation, workspace-root matching, cancellation ordering).

import test from "node:test";
import assert from "node:assert/strict";
import {
	assertActiveWorkspaceRoot,
	assertEmptyToolInput,
	awaitWithCancellation,
	type CancellationSignal,
} from "../src/copilot-tools-guards.ts";

function makeToken(initiallyCancelled = false): CancellationSignal & { cancel(): void } {
	let cancelled = initiallyCancelled;
	let listener: (() => void) | undefined;
	return {
		get isCancellationRequested() {
			return cancelled;
		},
		onCancellationRequested(cb) {
			listener = cb;
			return { dispose: () => { listener = undefined; } };
		},
		cancel() {
			cancelled = true;
			listener?.();
		},
	};
}

test("assertEmptyToolInput accepts undefined and empty object", () => {
	assert.doesNotThrow(() => assertEmptyToolInput(undefined));
	assert.doesNotThrow(() => assertEmptyToolInput({}));
});

test("assertEmptyToolInput rejects null, arrays, non-empty objects, and primitives", () => {
	assert.throws(() => assertEmptyToolInput(null));
	assert.throws(() => assertEmptyToolInput([]));
	assert.throws(() => assertEmptyToolInput({ a: 1 }));
	assert.throws(() => assertEmptyToolInput("unexpected"));
});

test("assertActiveWorkspaceRoot rejects zero or multiple workspace folders", () => {
	assert.throws(
		() => assertActiveWorkspaceRoot("/project", []),
		/exactly one workspace folder/,
	);
	assert.throws(
		() => assertActiveWorkspaceRoot("/project", ["/project", "/other"]),
		/exactly one workspace folder/,
	);
});

test("assertActiveWorkspaceRoot rejects a mismatched single workspace folder", () => {
	assert.throws(
		() => assertActiveWorkspaceRoot("/project", ["/other"]),
		/must match the connected GSD agent project|active workspace folder to match/,
	);
});

test("assertActiveWorkspaceRoot accepts a matching workspace folder, resolving path differences", () => {
	assert.doesNotThrow(() => assertActiveWorkspaceRoot("/project", ["/project/"]));
	assert.doesNotThrow(() => assertActiveWorkspaceRoot("/project/sub/..", ["/project"]));
});

test("awaitWithCancellation never invokes a lazy operation when already cancelled", async () => {
	const token = makeToken(true);
	let invocations = 0;
	const operation = () => {
		invocations += 1;
		return Promise.resolve("unused");
	};

	await assert.rejects(() => awaitWithCancellation(operation, token), /cancelled/);
	assert.equal(invocations, 0);
});

test("awaitWithCancellation invokes the operation exactly once and resolves normally", async () => {
	const token = makeToken(false);
	let invocations = 0;
	const operation = async () => {
		invocations += 1;
		return "ok";
	};

	const result = await awaitWithCancellation(operation, token);
	assert.equal(result, "ok");
	assert.equal(invocations, 1);
});

test("awaitWithCancellation rejects on mid-flight cancellation without an unhandled rejection", async () => {
	const token = makeToken(false);
	let rejectOperation: (err: Error) => void = () => {};
	const operation = () => new Promise<string>((_resolve, reject) => {
		rejectOperation = reject;
	});

	const pending = awaitWithCancellation(operation, token);
	token.cancel();
	await assert.rejects(() => pending, /cancelled/);

	// The underlying RPC promise rejecting *after* cancellation already
	// settled the outer promise must not produce an unhandled rejection.
	rejectOperation(new Error("late rpc failure"));
});


import * as payloadGuards from "../src/copilot-tools-guards.ts";
import { LIFECYCLE_STATUSES, LIFECYCLE_STATUS_VERSION } from "../../packages/contracts/src/rpc.ts";
import { progressFixture, snapshotFixture, blockerFixture, invalidProgressFixtures, invalidSnapshotFixtures, PRIVATE_SENTINEL } from "./project-context-fixtures.ts";

for (const [kind, invalid] of [["Progress", invalidProgressFixtures()], ["Snapshot", invalidSnapshotFixtures()]] as const) {
	for (const [name, value] of invalid) {
		test(`native ${kind} guard rejects ${name} with fixed actionable error`, () => {
			const guard = (payloadGuards as any)[`assertCanonicalProject${kind}`];
			assert.equal(typeof guard, "function");
			assert.throws(() => guard(value), (error: any) => {
				assert.equal(error.message.includes(PRIVATE_SENTINEL), false);
				assert.match(error.message, /restart|retry|update/i);
				return true;
			});
		});
	}
}

test("native progress guard preserves full optional contract and zero counters", () => {
	const value = progressFixture();
	value.activeMilestone = null;
	value.requirements = { active: 0, validated: 0, deferred: 0, outOfScope: 0 };
	value.blockerRows = [blockerFixture];
	value.milestoneDetails = [{ id: "M1", title: "Milestone", status: "active", truncated: false, slices: [{ id: "S1", title: "Slice", status: "active", truncated: true, tasks: [{ id: "T1", title: "Task", status: "pending" }] }] }];
	value.milestoneDetailsTruncated = false; value.milestoneDetailsTasksTruncated = true;
	const before = JSON.stringify(value);
	(payloadGuards as any).assertCanonicalProjectProgress(value);
	assert.equal(JSON.stringify(value), before);
});

test("native snapshot guard accepts schema versions independently of lifecycle vocabulary", () => {
	const value = snapshotFixture();
	value.authority.schemaVersion = 987;
	value.blockers = [blockerFixture]; value.blockersTruncated = false;
	value.openQuestions = [{ questionId: "Q1", questionText: "Resolve", createdAt: "now" }]; value.openQuestionsTruncated = true;
	value.lifecycleStatusVersion = LIFECYCLE_STATUS_VERSION;
	for (const lifecycleStatus of [...LIFECYCLE_STATUSES, null]) {
		value.milestones.items[0].lifecycleStatus = lifecycleStatus;
		const before = JSON.stringify(value);
		(payloadGuards as any).assertCanonicalProjectSnapshot(value);
		assert.equal(JSON.stringify(value), before);
	}
});

test("native snapshot guard accepts older producers without optional lifecycle or truncation flags", () => {
	(payloadGuards as any).assertCanonicalProjectSnapshot(snapshotFixture());
});
