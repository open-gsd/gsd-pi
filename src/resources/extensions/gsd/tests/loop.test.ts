import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autoLoop } from "../auto/loop.js";

function createInactiveSession(basePath: string) {
	return {
		active: false,
		basePath,
		originalBasePath: basePath,
		canonicalProjectRoot: basePath,
		scope: { workspace: { projectRoot: basePath } },
		currentUnit: null,
		currentMilestoneId: null,
		verificationRetryCount: new Map(),
		unclaimedUnitBudgets: new Map(),
		pendingVerificationRetry: null,
	};
}

function createLoopDeps(calls: string[]) {
	return {
		stopAuto: async () => {
			calls.push("stopAuto");
		},
		pauseAuto: async () => {
			calls.push("pauseAuto");
		},
		emitJournalEvent: () => {
			calls.push("emitJournalEvent");
		},
	};
}

test("auto loop returns immediately for an inactive session", async () => {
	const basePath = mkdtempSync(join(tmpdir(), "gsd-auto-loop-test-"));
	const calls: string[] = [];
	const ctx = { ui: { notify: () => calls.push("notify") } };
	const pi = {};
	try {
		await autoLoop(ctx as never, pi as never, createInactiveSession(basePath) as never, createLoopDeps(calls) as never);
		assert.deepEqual(calls, []);
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
});
