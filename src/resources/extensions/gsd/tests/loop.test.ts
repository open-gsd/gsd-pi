import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autoLoop, runLegacyAutoLoop, runUokKernelLoop } from "../auto/loop.js";

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
		verificationRetryFailureHashes: new Map(),
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

test("auto loop entrypoints return immediately for inactive sessions", async () => {
	const basePath = mkdtempSync(join(tmpdir(), "gsd-auto-loop-test-"));
	const calls: string[] = [];
	const ctx = { ui: { notify: () => calls.push("notify") } };
	const pi = {};
	try {
		await autoLoop(ctx as never, pi as never, createInactiveSession(basePath) as never, createLoopDeps(calls) as never);
		await runLegacyAutoLoop(
			ctx as never,
			pi as never,
			createInactiveSession(basePath) as never,
			createLoopDeps(calls) as never,
		);
		await runUokKernelLoop(
			ctx as never,
			pi as never,
			createInactiveSession(basePath) as never,
			createLoopDeps(calls) as never,
		);
		assert.deepEqual(calls, []);
	} finally {
		rmSync(basePath, { recursive: true, force: true });
	}
});
