// gsd-pi + SessionManager external-usage accounting (#2821): cumulative
// child-process subagent usage reconciles into the session totals with
// positive deltas — repeated, late, or replayed updates never double count,
// and nothing (completion, worker-row expiry) ever reduces the total.
// Persistence (#2836): each high-water advance is recorded in the session
// file and reconstructed on load, so restart/resume restores prior child
// cost instead of resetting the footer to parent-only usage.

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { SessionManager } from "../../packages/pi-coding-agent/src/core/session-manager.ts";

function freshSession(): InstanceType<typeof SessionManager> {
	return SessionManager.inMemory("/tmp/gsd-pi-external-usage");
}

function combinedTotals(session: InstanceType<typeof SessionManager>) {
	return session.getUsageTotals({ includeExternalUsage: true });
}

describe("SessionManager.addExternalUsage", () => {
	it("includes external usage in getUsageTotals on top of session entries", () => {
		const session = freshSession();
		assert.deepEqual(combinedTotals(session), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.01 });

		assert.deepEqual(combinedTotals(session), {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			cost: 0.01,
		});
	});

	it("default getUsageTotals stays parent-only so child tokens never distort derived percentages", () => {
		const session = freshSession();
		session.addExternalUsage("child-a", { input: 900, output: 50, cacheRead: 900, cacheWrite: 5, cost: 0.5 });

		assert.deepEqual(session.getUsageTotals(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
		assert.equal(combinedTotals(session).cost, 0.5);
	});

	it("starting a new session drops external usage (session-scoped accounting)", () => {
		const session = freshSession();
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 2 });
		session.newSession();

		assert.deepEqual(session.getUsageTotals(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
		assert.deepEqual(
			combinedTotals(session),
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			"child spend from the previous session must not leak into the new one",
		);
	});

	it("a background child's post-switch snapshots do not bill the new session", () => {
		const session = freshSession();
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		session.newSession();
		// The old session's child keeps streaming; its next cumulative snapshot
		// must be dropped instead of billing the new session for old work.
		session.addExternalUsage("child-a", { input: 300, output: 120, cacheRead: 0, cacheWrite: 0, cost: 0.04 });

		assert.deepEqual(
			combinedTotals(session),
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		);
	});

	it("branching into a new session drops external usage", () => {
		const session = freshSession();
		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
		} as any);
		const leafId = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
		} as any);
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 2 });

		session.createBranchedSession(leafId);

		// Parent entries on the branched path are kept; the discarded session's
		// child spend is not inherited.
		assert.deepEqual(
			combinedTotals(session),
			{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
		);
	});

	it("a child registered at launch does not bill the session it first reports after a switch", () => {
		const session = freshSession();
		// Launch path binds the key with a zero snapshot before any await.
		session.addExternalUsage("child-a", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
		session.newSession();
		// First real usage arrives after the switch: dropped, not billed.
		session.addExternalUsage("child-a", { input: 300, output: 120, cacheRead: 0, cacheWrite: 0, cost: 0.04 });

		assert.deepEqual(
			combinedTotals(session),
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		);
	});

	it("switching session files drops external usage", () => {
		const session = freshSession();
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 2 });
		session.setSessionFile("/tmp/gsd-pi-external-usage-switch-does-not-exist.jsonl");

		assert.deepEqual(
			combinedTotals(session),
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		);
	});

	it("banks only the positive delta of a growing cumulative snapshot", () => {
		const session = freshSession();
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		session.addExternalUsage("child-a", { input: 300, output: 120, cacheRead: 0, cacheWrite: 0, cost: 0.04 });

		const totals = combinedTotals(session);
		assert.equal(totals.input, 300);
		assert.equal(totals.output, 120);
		assert.equal(totals.cost, 0.04);
	});

	it("is idempotent for repeated identical snapshots", () => {
		const session = freshSession();
		const snapshot = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.01 };
		session.addExternalUsage("child-a", snapshot);
		session.addExternalUsage("child-a", snapshot);
		session.addExternalUsage("child-a", snapshot);

		assert.equal(combinedTotals(session).cost, 0.01);
		assert.equal(combinedTotals(session).input, 100);
	});

	it("ignores a late lower snapshot instead of going negative or double counting", () => {
		const session = freshSession();
		session.addExternalUsage("child-a", { input: 300, output: 120, cacheRead: 0, cacheWrite: 0, cost: 0.04 });
		// A replayed earlier partial update arrives after the high-water mark.
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });

		const totals = combinedTotals(session);
		assert.equal(totals.cost, 0.04);
		assert.equal(totals.input, 300);
		assert.equal(totals.output, 120);
	});

	it("counts concurrent children once each, completed or not", () => {
		const session = freshSession();
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		session.addExternalUsage("child-b", { input: 200, output: 60, cacheRead: 0, cacheWrite: 0, cost: 0.02 });
		session.addExternalUsage("child-c", { input: 300, output: 70, cacheRead: 0, cacheWrite: 0, cost: 0.03 });
		// Out-of-order completion replays: children report again after siblings
		// already finished — their own totals must not move.
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		session.addExternalUsage("child-c", { input: 300, output: 70, cacheRead: 0, cacheWrite: 0, cost: 0.03 });

		const totals = combinedTotals(session);
		assert.equal(totals.input, 600);
		assert.equal(totals.output, 180);
		assert.equal(totals.cost, 0.06);
	});

	it("keeps a completed child's usage after its reporting stops (row expiry)", () => {
		const session = freshSession();
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		session.addExternalUsage("child-b", { input: 200, output: 60, cacheRead: 0, cacheWrite: 0, cost: 0.02 });
		// child-a completes; only child-b keeps reporting.
		session.addExternalUsage("child-b", { input: 400, output: 90, cacheRead: 0, cacheWrite: 0, cost: 0.05 });

		const totals = combinedTotals(session);
		assert.equal(totals.cost, 0.06);
		assert.equal(totals.input, 100 + 400);
	});

	it("treats non-finite reported values as zero instead of poisoning totals", () => {
		const session = freshSession();
		session.addExternalUsage("child-a", {
			input: Number.NaN,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			cost: Number.NaN,
		});
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });

		const totals = combinedTotals(session);
		assert.equal(totals.input, 100);
		assert.equal(totals.cost, 0.01);
	});

	it("ignores an empty key", () => {
		const session = freshSession();
		session.addExternalUsage("", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		assert.deepEqual(combinedTotals(session), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
	});
});

describe("SessionManager external usage persistence", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	function persistedSession(): InstanceType<typeof SessionManager> {
		dir = mkdtempSync(join(tmpdir(), "gsd-usage-persist-"));
		const session = SessionManager.create("/tmp/gsd-usage-persist-cwd", dir);
		session.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] } as any);
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
		} as any);
		return session;
	}

	it("restart/resume of the same session restores its prior child usage total", () => {
		const session = persistedSession();
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		session.addExternalUsage("child-a", { input: 300, output: 120, cacheRead: 0, cacheWrite: 0, cost: 0.04 });
		session.addExternalUsage("child-b", { input: 200, output: 60, cacheRead: 0, cacheWrite: 0, cost: 0.02 });

		const resumed = SessionManager.open(session.getSessionFile()!);

		assert.deepEqual(
			{ totals: resumed.getUsageTotals(), combined: resumed.getUsageTotals({ includeExternalUsage: true }) },
			{
				totals: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
				combined: { input: 510, output: 185, cacheRead: 0, cacheWrite: 0, cost: 0.061 },
			},
		);
	});

	it("per-key high-water marks reconcile idempotently across many durable snapshots", () => {
		const session = persistedSession();
		// Several advances plus replayed earlier partials — the file records
		// every advance; reload must sum final high-waters, not raw entries.
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		session.addExternalUsage("child-a", { input: 300, output: 120, cacheRead: 0, cacheWrite: 0, cost: 0.04 });
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		session.addExternalUsage("child-a", { input: 300, output: 120, cacheRead: 0, cacheWrite: 0, cost: 0.04 });

		const resumed = SessionManager.open(session.getSessionFile()!);
		assert.equal(resumed.getUsageTotals({ includeExternalUsage: true }).input, 310, "300 child + 10 parent, once");
		assert.equal(resumed.getUsageTotals({ includeExternalUsage: true }).cost, 0.041);
	});

	it("repeated identical snapshots do not grow the session file", () => {
		const session = persistedSession();
		const snapshot = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 };
		session.addExternalUsage("child-a", snapshot);
		const entriesAfterFirst = session.getEntries().length;
		session.addExternalUsage("child-a", snapshot);
		session.addExternalUsage("child-a", snapshot);

		assert.equal(session.getEntries().length, entriesAfterFirst, "no advance means no durable record");
	});

	it("a live child reconciles against the restored high-water after resume without double count", () => {
		const session = persistedSession();
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		session.addExternalUsage("child-a", { input: 300, output: 120, cacheRead: 0, cacheWrite: 0, cost: 0.04 });
		const file = session.getSessionFile()!;

		// In-process resume of the same file; the child keeps reporting its
		// cumulative snapshot — the restored high-water makes it a no-op.
		session.setSessionFile(file);
		assert.deepEqual(session.getUsageTotals({ includeExternalUsage: true }), {
			input: 310,
			output: 125,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.041,
		});
		session.addExternalUsage("child-a", { input: 300, output: 120, cacheRead: 0, cacheWrite: 0, cost: 0.04 });
		assert.equal(session.getUsageTotals({ includeExternalUsage: true }).input, 310);
	});

	it("a child registered at zero before launch keeps reporting after a same-session resume", () => {
		const session = persistedSession();
		// The launch path binds the key with a zero snapshot before any await
		// (#2826). That registration must be durable, or the resume leaves the
		// key on a stale tombstone and its first real report is dropped forever.
		session.addExternalUsage("child-a", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
		const file = session.getSessionFile()!;

		session.setSessionFile(file);
		session.addExternalUsage("child-a", { input: 250, output: 90, cacheRead: 0, cacheWrite: 0, cost: 0.03 });
		assert.equal(
			session.getUsageTotals({ includeExternalUsage: true }).input,
			260,
			"the resumed session accepts the registered child's first report",
		);

		// And the state is durable again: reopen includes it exactly once.
		const reopened = SessionManager.open(file);
		assert.equal(reopened.getUsageTotals({ includeExternalUsage: true }).input, 260);
	});

	it("usage advanced after a resume is durable across a second reopen", () => {
		const session = persistedSession();
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		const file = session.getSessionFile()!;

		session.setSessionFile(file);
		session.addExternalUsage("child-a", { input: 400, output: 130, cacheRead: 0, cacheWrite: 0, cost: 0.06 });

		const reopened = SessionManager.open(file);
		assert.equal(reopened.getUsageTotals({ includeExternalUsage: true }).input, 410);
		assert.equal(reopened.getUsageTotals({ includeExternalUsage: true }).cost, 0.061);
	});

	it("switching to a new session does not carry child usage into it", () => {
		const session = persistedSession();
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		const originalFile = session.getSessionFile()!;
		session.newSession();
		session.appendMessage({ role: "user", content: [{ type: "text", text: "next" }] } as any);
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } },
		} as any);

		assert.equal(session.getUsageTotals({ includeExternalUsage: true }).input, 1, "new session starts clean");
		// The original file still carries its own cost for its own resume.
		const original = SessionManager.open(originalFile);
		assert.equal(original.getUsageTotals({ includeExternalUsage: true }).input, 110);
	});

	it("branching strips durable child spend from the branched file but keeps it on the original", () => {
		const session = persistedSession();
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		// Branch from the durable usage record itself, so the record sits on
		// the copied path and the strip is actually exercised.
		const usageEntry = session.getEntries().find((e) => e.type === "custom")!;
		const originalFile = session.getSessionFile()!;

		const branchedFile = session.createBranchedSession(usageEntry.id)!;
		const branched = SessionManager.open(branchedFile);
		assert.deepEqual(
			branched.getUsageTotals({ includeExternalUsage: true }),
			{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
			"the branch inherits no child spend (#2821 isolation)",
		);
		const original = SessionManager.open(originalFile);
		assert.equal(original.getUsageTotals({ includeExternalUsage: true }).input, 110, "the original keeps its cost");
	});

	it("branching repairs parent links across stripped usage records mid-conversation", () => {
		const session = persistedSession();
		// user → usageA → assistant → usageB: usage records sit between
		// retained messages, so a naive strip would orphan their descendants.
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "after child" }],
			usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0002 } },
		} as any);
		session.addExternalUsage("child-a", { input: 200, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.02 });
		const leafEntry = session.getLeafEntry()!;
		const branchedFile = session.createBranchedSession(leafEntry.id)!;

		const branched = SessionManager.open(branchedFile);
		const retained = branched.getEntries();
		assert.deepEqual(
			retained.filter((e) => e.type === "custom").map((e) => (e as { customType: string }).customType),
			[],
			"no usage records survive in the branch",
		);
		// The chain is intact: every parentId resolves within the branch, one
		// root, and both messages are reachable from the leaf.
		const byId = new Map(retained.map((e) => [e.id, e]));
		let roots = 0;
		for (const entry of retained) {
			if (entry.parentId === null) roots++;
			else assert.ok(byId.has(entry.parentId), `dangling parent ${entry.parentId} on ${entry.id}`);
		}
		assert.equal(roots, 1, "the stripped path stays a single chain");
		const branchPath = branched.getBranch(branched.getLeafId()!);
		const messages = branchPath.filter((e) => e.type === "message");
		assert.equal(messages.length, 3, "all conversation messages survive the strip");
	});

	it("retry attempts stay separately attributable and both bill once after reload", () => {
		const session = persistedSession();
		session.addExternalUsage("subagent:task:attempt-1", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		session.addExternalUsage("subagent:task:attempt-2", { input: 150, output: 70, cacheRead: 0, cacheWrite: 0, cost: 0.02 });

		const resumed = SessionManager.open(session.getSessionFile()!);
		assert.equal(resumed.getUsageTotals({ includeExternalUsage: true }).input, 260);
		assert.equal(resumed.getUsageTotals({ includeExternalUsage: true }).cost, 0.031);
	});

	it("legacy sessions without external-usage records load normally with no fabricated cost", () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-usage-persist-"));
		const session = SessionManager.create("/tmp/gsd-usage-persist-cwd", dir);
		session.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] } as any);
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
		} as any);

		const resumed = SessionManager.open(session.getSessionFile()!);
		assert.deepEqual(resumed.getUsageTotals(), { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 });
		assert.deepEqual(
			resumed.getUsageTotals({ includeExternalUsage: true }),
			{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
		);
	});

	it("corrupt durable records produce a diagnostic, contribute nothing, and never fabricate cost", () => {
		const session = persistedSession();
		session.addExternalUsage("child-a", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		const file = session.getSessionFile()!;
		// Malformed JSON line (loader skips it) plus shape-invalid records:
		// bad key, non-object snapshot, and garbage field values.
		appendFileSync(file, "{not json\n", "utf-8");
		appendFileSync(file, `${JSON.stringify({
			type: "custom", customType: "external-usage", id: "c1", parentId: null, timestamp: "t",
			data: { snapshot: { input: 5, cost: 5 } },
		})}\n`, "utf-8");
		appendFileSync(file, `${JSON.stringify({
			type: "custom", customType: "external-usage", id: "c2", parentId: null, timestamp: "t",
			data: { key: "child-a", snapshot: "garbage" },
		})}\n`, "utf-8");
		appendFileSync(file, `${JSON.stringify({
			type: "custom", customType: "external-usage", id: "c3", parentId: null, timestamp: "t",
			data: { key: "child-a", snapshot: { input: "nope", output: Number.NaN, cacheRead: -5, cacheWrite: 0, cost: Number.NaN } },
		})}\n`, "utf-8");

		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (msg: string) => warnings.push(String(msg));
		let resumed: InstanceType<typeof SessionManager>;
		try {
			resumed = SessionManager.open(file);
		} finally {
			console.warn = originalWarn;
		}
		assert.ok(warnings.length >= 3, `each corrupt record is diagnosed, got: ${JSON.stringify(warnings)}`);
		assert.match(warnings.join("\n"), /external-usage/);
		assert.deepEqual(
			resumed.getUsageTotals({ includeExternalUsage: true }),
			{ input: 110, output: 55, cacheRead: 0, cacheWrite: 0, cost: 0.011 },
			"corrupt records restore nothing and never add fabricated child cost",
		);
	});
});

