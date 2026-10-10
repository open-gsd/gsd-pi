// gsd-pi — Google CLI readiness: cached PATH lookup, never one process per call.
//
// `isGeminiCliReady()` / `isAntigravityCliReady()` are provider `isReady`
// hooks, called once per model on every availability check. They used to run
// `where gemini` / `where agy` with spawnSync on every single call.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	clearGoogleCliReadinessCache,
	createCommandReadiness,
	isAntigravityCliReady,
	isGeminiCliReady,
	settleAntigravityCliReadiness,
	settleGeminiCliReadiness,
} from "../resources/extensions/google-cli/readiness.ts";

/** Let the cache's deferred lookup start (it yields once before probing). */
async function flushMicrotasks(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("google-cli readiness cache", () => {
	test("many isReady() calls share one PATH lookup instead of one per call", async () => {
		const lookups: string[] = [];
		const readiness = createCommandReadiness("gemini", async (command) => {
			lookups.push(command);
			return true;
		});

		// One availability check asks once per model; a model list has dozens.
		for (let i = 0; i < 50; i++) {
			assert.equal(readiness.isReady(), false, "cold cache answers false, immediately");
		}
		assert.deepEqual(lookups, [], "no lookup ran on the caller's stack");

		assert.equal(await readiness.settle(), true);
		for (let i = 0; i < 50; i++) {
			assert.equal(readiness.isReady(), true);
		}
		await flushMicrotasks();
		assert.deepEqual(lookups, ["gemini"], "100 calls, one lookup");
	});

	test("a stale answer is returned immediately and refreshed by one background lookup", async (t) => {
		t.mock.timers.enable({ apis: ["Date"] });
		let installed = true;
		let lookups = 0;
		const readiness = createCommandReadiness("agy", async () => {
			lookups += 1;
			return installed;
		});

		assert.equal(await readiness.settle(), true);
		assert.equal(lookups, 1);

		installed = false;
		t.mock.timers.tick(31_000);
		for (let i = 0; i < 50; i++) {
			assert.equal(readiness.isReady(), true, "stale cache still answers with the last known value");
		}
		await flushMicrotasks();
		assert.equal(lookups, 2, "one refresh for the whole stale window");
		assert.equal(readiness.isReady(), false, "the async refresh updated the cached value");
	});

	test("prime() starts the first lookup without anyone asking", async () => {
		let lookups = 0;
		const readiness = createCommandReadiness("gemini", async () => {
			lookups += 1;
			return true;
		});

		readiness.prime();
		await flushMicrotasks();
		assert.equal(lookups, 1);
		assert.equal(readiness.isReady(), true, "the first real question already has an answer");
		assert.equal(lookups, 1);
	});

	test("a command that is not on PATH is not ready", async () => {
		const readiness = createCommandReadiness("gsd-definitely-not-a-real-cli");
		assert.equal(await readiness.settle(), false);
		assert.equal(readiness.isReady(), false);
	});
});

/** The real providers, driven through the real `where`/`which` lookup. */
const GOOGLE_CLIS = [
	{ provider: "google-gemini-cli", binary: "gemini", isReady: isGeminiCliReady, settle: settleGeminiCliReadiness },
	{ provider: "google-antigravity", binary: "agy", isReady: isAntigravityCliReady, settle: settleAntigravityCliReadiness },
];

for (const cli of GOOGLE_CLIS) {
	describe(`${cli.provider} readiness against a real PATH`, () => {
		let fixtureDir: string;
		let savedPath: string | undefined;

		function install(): void {
			if (process.platform === "win32") {
				writeFileSync(join(fixtureDir, `${cli.binary}.cmd`), "@echo off\r\necho mock\r\n");
			} else {
				writeFileSync(join(fixtureDir, cli.binary), "#!/bin/sh\necho mock\n", { mode: 0o755 });
			}
		}

		function uninstall(): void {
			rmSync(join(fixtureDir, process.platform === "win32" ? `${cli.binary}.cmd` : cli.binary), { force: true });
		}

		beforeEach(() => {
			fixtureDir = mkdtempSync(join(tmpdir(), "google-cli-readiness-"));
			savedPath = process.env.PATH;
			// Only the fixture plus what the lookup itself needs, so a CLI that
			// happens to be installed on this machine cannot leak into the test.
			const systemDirs = process.platform === "win32"
				? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
				: ["/usr/bin", "/bin"];
			process.env.PATH = [fixtureDir, ...systemDirs].join(delimiter);
			install();
			clearGoogleCliReadinessCache();
		});

		afterEach(() => {
			clearGoogleCliReadinessCache();
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
			rmSync(fixtureDir, { recursive: true, force: true });
		});

		test(`cold cache answers false immediately, then the async lookup finds ${cli.binary}`, async () => {
			assert.equal(cli.isReady(), false, "unknown must not be reported as ready");
			assert.equal(await cli.settle(), true);
			assert.equal(cli.isReady(), true);
		});

		test("stale cache returns the last answer; the async refresh notices the CLI is gone", async (t) => {
			t.mock.timers.enable({ apis: ["Date"] });
			assert.equal(await cli.settle(), true);

			uninstall();
			t.mock.timers.tick(31_000);

			for (let i = 0; i < 25; i++) {
				assert.equal(cli.isReady(), true, "stale cache still answers with the last known value");
			}
			assert.equal(await cli.settle(), false, "the refresh picked up the removal");
			assert.equal(cli.isReady(), false);
		});

		test("clearGoogleCliReadinessCache() makes the next answer cold and re-probes", async () => {
			uninstall();
			assert.equal(await cli.settle(), false);

			// The user installs the CLI; clearing the cache picks it up at once.
			install();
			assert.equal(cli.isReady(), false, "still the cached answer inside the window");
			clearGoogleCliReadinessCache();
			assert.equal(cli.isReady(), false, "cold again");
			assert.equal(await cli.settle(), true);
			assert.equal(cli.isReady(), true);
		});

		test(`reports not ready when ${cli.binary} is not on PATH`, async () => {
			uninstall();
			assert.equal(await cli.settle(), false);
			assert.equal(cli.isReady(), false);
		});
	});
}
