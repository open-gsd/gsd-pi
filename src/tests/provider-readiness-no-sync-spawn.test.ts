// gsd-pi — Regression guard: provider readiness must never spawn synchronously.
//
// The TUI froze on Windows because the provider `isReady` hooks (and the
// onboarding probe) decided readiness with execFileSync / spawnSync: seconds
// of blocked event loop at launch and again whenever `/model` was opened after
// the 30 s cache expired.
//
// This guard replaces every synchronous child_process API with a recorder that
// throws, then drives each readiness module through its cold, settled and
// stale paths. A module that goes back to execFileSync / spawnSync / execSync
// records a call here and fails the suite. (Behavioural on purpose: the repo
// rejects tests that grep source files.)

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import childProcess, { execFileSync, execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isClaudeBinaryInstalled, isClaudeCliReady } from "../claude-cli-check.ts";
import {
	clearReadinessCache,
	isClaudeBinaryPresent,
	isClaudeCodeAuthed,
	isClaudeCodeReady,
	primeClaudeCodeReadiness,
	settleClaudeCodeReadiness,
} from "../resources/extensions/claude-code-cli/readiness.ts";
import {
	clearCursorAgentReadinessCache,
	isCursorAgentBinaryPresent,
	isCursorAgentReady,
	primeCursorAgentReadiness,
	probeCursorAgentReadyUncached,
	readCursorAgentListModels,
	settleCursorAgentReadiness,
} from "../resources/extensions/cursor-cli/readiness.ts";
import {
	clearGoogleCliReadinessCache,
	isAntigravityCliReady,
	isGeminiCliReady,
	primeGoogleCliReadiness,
	settleAntigravityCliReadiness,
	settleGeminiCliReadiness,
} from "../resources/extensions/google-cli/readiness.ts";

const SYNC_SPAWN_APIS = ["execFileSync", "spawnSync", "execSync"] as const;
type SyncSpawnApi = (typeof SYNC_SPAWN_APIS)[number];

describe("provider readiness never spawns a synchronous child process", () => {
	const patchable = childProcess as unknown as Record<SyncSpawnApi, (...args: unknown[]) => unknown>;
	let originals: Record<SyncSpawnApi, (...args: unknown[]) => unknown>;
	let syncSpawns: string[];
	let emptyPathDir: string;
	let savedPath: string | undefined;

	beforeEach(() => {
		syncSpawns = [];
		originals = {} as Record<SyncSpawnApi, (...args: unknown[]) => unknown>;
		for (const api of SYNC_SPAWN_APIS) {
			originals[api] = patchable[api];
			patchable[api] = (...args: unknown[]) => {
				syncSpawns.push(`${api}(${String(args[0])})`);
				throw new Error(`${api} must not be used to decide provider readiness`);
			};
		}
		// Propagate the patched functions to `import { … } from "node:child_process"`.
		syncBuiltinESMExports();

		// Hermetic and fast: no real provider CLI resolves from an empty PATH.
		emptyPathDir = mkdtempSync(join(tmpdir(), "readiness-no-sync-spawn-"));
		savedPath = process.env.PATH;
		process.env.PATH = emptyPathDir;

		clearReadinessCache();
		clearCursorAgentReadinessCache();
		clearGoogleCliReadinessCache();
	});

	afterEach(() => {
		for (const api of SYNC_SPAWN_APIS) patchable[api] = originals[api];
		syncBuiltinESMExports();
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		rmSync(emptyPathDir, { recursive: true, force: true });
		clearReadinessCache();
		clearCursorAgentReadinessCache();
		clearGoogleCliReadinessCache();
	});

	test("the guard sees synchronous spawns made through named ESM imports", () => {
		assert.throws(() => execFileSync(process.execPath, ["--version"]), /must not be used/);
		assert.throws(() => spawnSync(process.execPath, ["--version"]), /must not be used/);
		assert.throws(() => execSync("node --version"), /must not be used/);
		assert.equal(syncSpawns.length, 3);
	});

	test("claude-code readiness: cold, primed, settled and stale paths", async (t) => {
		t.mock.timers.enable({ apis: ["Date"] });

		primeClaudeCodeReadiness();
		assert.equal(isClaudeCodeReady(), false);
		assert.equal(isClaudeBinaryPresent(), false);
		assert.equal(isClaudeCodeAuthed(), false);
		assert.equal(await settleClaudeCodeReadiness(), false);

		t.mock.timers.tick(31_000);
		assert.equal(isClaudeCodeReady(), false);
		assert.equal(await settleClaudeCodeReadiness(), false);

		assert.deepEqual(syncSpawns, []);
	});

	test("cursor-agent readiness: cached, uncached and list-models paths", async (t) => {
		t.mock.timers.enable({ apis: ["Date"] });

		primeCursorAgentReadiness();
		assert.equal(isCursorAgentReady(), false);
		assert.equal(isCursorAgentBinaryPresent(), false);
		assert.equal(await settleCursorAgentReadiness(), false);

		t.mock.timers.tick(31_000);
		assert.equal(isCursorAgentReady(), false);
		assert.equal(await settleCursorAgentReadiness(), false);

		assert.equal(await probeCursorAgentReadyUncached(), false);
		assert.equal(await readCursorAgentListModels(), null);

		assert.deepEqual(syncSpawns, []);
	});

	test("google-cli readiness: gemini and antigravity lookups", async (t) => {
		t.mock.timers.enable({ apis: ["Date"] });

		primeGoogleCliReadiness();
		assert.equal(isGeminiCliReady(), false);
		assert.equal(isAntigravityCliReady(), false);
		assert.equal(await settleGeminiCliReadiness(), false);
		assert.equal(await settleAntigravityCliReadiness(), false);

		t.mock.timers.tick(31_000);
		assert.equal(isGeminiCliReady(), false);
		assert.equal(isAntigravityCliReady(), false);
		assert.equal(await settleGeminiCliReadiness(), false);
		assert.equal(await settleAntigravityCliReadiness(), false);

		assert.deepEqual(syncSpawns, []);
	});

	test("onboarding claude-cli-check probes", async () => {
		assert.equal(await isClaudeBinaryInstalled(), false);
		assert.equal(await isClaudeCliReady(), false);

		assert.deepEqual(syncSpawns, []);
	});
});
