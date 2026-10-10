// gsd-pi — Claude Code readiness cache: never blocks, refreshes asynchronously.
//
// Regression coverage for the Windows TUI freeze: `isClaudeCodeReady()` is the
// provider `isReady` hook, called once per model from the model selector and
// from auto mode. It used to run `claude --version` + `claude auth status`
// with execFileSync whenever its 30 s cache expired, freezing the UI for
// seconds. These tests drive the real module against a fake `claude` on PATH.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	clearReadinessCache,
	isClaudeBinaryPresent,
	isClaudeCodeAuthed,
	isClaudeCodeReady,
	settleClaudeCodeReadiness,
} from "../readiness.ts";

const ENV_KEYS = ["PATH", "CLAUDE_TEST_LOG", "CLAUDE_TEST_AUTH"] as const;

/**
 * Fake Claude CLI. Logs every invocation, answers `--version`, and answers
 * `auth status` according to CLAUDE_TEST_AUTH: "in", "out", or anything else
 * to fail the auth probe (soft-fail).
 */
function writeFakeClaude(dir: string): void {
	if (process.platform === "win32") {
		writeFileSync(join(dir, "claude.cmd"), [
			"@echo off",
			"echo %*>>\"%CLAUDE_TEST_LOG%\"",
			"if \"%1\"==\"--version\" (echo 1.0.0 & exit /b 0)",
			"if not \"%1\"==\"auth\" exit /b 1",
			"if \"%CLAUDE_TEST_AUTH%\"==\"in\" (echo Logged in as user@example.com & exit /b 0)",
			"if \"%CLAUDE_TEST_AUTH%\"==\"out\" (echo Not logged in & exit /b 0)",
			"exit /b 1",
		].join("\r\n"));
		return;
	}
	writeFileSync(join(dir, "claude"), [
		"#!/bin/sh",
		"printf '%s\\n' \"$*\" >> \"$CLAUDE_TEST_LOG\"",
		"[ \"$1\" = \"--version\" ] && { echo 1.0.0; exit 0; }",
		"[ \"$1\" = \"auth\" ] || exit 1",
		"[ \"$CLAUDE_TEST_AUTH\" = \"in\" ] && { echo 'Logged in as user@example.com'; exit 0; }",
		"[ \"$CLAUDE_TEST_AUTH\" = \"out\" ] && { echo 'Not logged in'; exit 0; }",
		"exit 1",
	].join("\n"), { mode: 0o755 });
}

describe("claude-code readiness cache", () => {
	let fixtureDir: string;
	let logPath: string;
	let savedEnv: Record<string, string | undefined>;

	function invocations(): string[] {
		if (!existsSync(logPath)) return [];
		return readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => line.trim());
	}

	beforeEach(() => {
		fixtureDir = mkdtempSync(join(tmpdir(), "claude-readiness-"));
		logPath = join(fixtureDir, "invocations.log");
		writeFakeClaude(fixtureDir);
		savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		process.env.PATH = `${fixtureDir}${delimiter}${savedEnv.PATH ?? ""}`;
		process.env.CLAUDE_TEST_LOG = logPath;
		process.env.CLAUDE_TEST_AUTH = "in";
		clearReadinessCache();
	});

	afterEach(() => {
		clearReadinessCache();
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	test("cold cache answers false immediately without running the CLI, then the async probe fills it", async () => {
		assert.equal(isClaudeCodeReady(), false, "unknown must not be reported as ready");
		assert.equal(isClaudeBinaryPresent(), false);
		assert.equal(isClaudeCodeAuthed(), false);
		assert.deepEqual(invocations(), [], "a synchronous probe would already have run the CLI");

		assert.equal(await settleClaudeCodeReadiness(), true);
		assert.deepEqual(invocations(), ["--version", "auth status --json"]);
		assert.equal(isClaudeCodeReady(), true);
		assert.equal(isClaudeBinaryPresent(), true);
		assert.deepEqual(invocations(), ["--version", "auth status --json"], "a fresh cache does not re-probe");
	});

	test("stale cache returns the last answer without running the CLI; the async refresh updates it", async (t) => {
		t.mock.timers.enable({ apis: ["Date"] });
		assert.equal(await settleClaudeCodeReadiness(), true);
		const probesBefore = invocations().length;

		// The user logs out of the CLI; the cache window then expires.
		process.env.CLAUDE_TEST_AUTH = "out";
		t.mock.timers.tick(31_000);

		for (let i = 0; i < 25; i++) {
			assert.equal(isClaudeCodeReady(), true, "stale cache still answers with the last known value");
		}
		assert.equal(invocations().length, probesBefore, "no CLI ran on the caller's stack");

		assert.equal(await settleClaudeCodeReadiness(), false, "the refresh picked up the new auth state");
		assert.equal(isClaudeCodeReady(), false);
		assert.equal(isClaudeBinaryPresent(), true);
		assert.deepEqual(
			invocations().slice(probesBefore),
			["--version", "auth status --json"],
			"25 stale calls produced exactly one refresh",
		);
	});

	test("a soft-failing auth probe keeps the known-good auth state", async (t) => {
		t.mock.timers.enable({ apis: ["Date"] });
		assert.equal(await settleClaudeCodeReadiness(), true);

		process.env.CLAUDE_TEST_AUTH = "broken";
		t.mock.timers.tick(31_000);

		assert.equal(await settleClaudeCodeReadiness(), true, "an inconclusive probe must not clobber a known login");
		assert.equal(isClaudeCodeReady(), true);
		assert.deepEqual(invocations().slice(-2), ["auth status --json", "auth status"], "both auth forms were tried");
	});

	test("an inconclusive auth probe on a cold cache is not ready", async () => {
		process.env.CLAUDE_TEST_AUTH = "broken";

		assert.equal(await settleClaudeCodeReadiness(), false);
		assert.equal(isClaudeBinaryPresent(), true);
		assert.equal(isClaudeCodeReady(), false);
	});

	test("clearReadinessCache() makes the next answer cold and re-probes", async () => {
		assert.equal(await settleClaudeCodeReadiness(), true);
		const probesBefore = invocations().length;

		clearReadinessCache();
		assert.equal(isClaudeCodeReady(), false, "cold again");
		assert.equal(await settleClaudeCodeReadiness(), true);
		assert.equal(invocations().length, probesBefore + 2, "the cleared cache was re-probed");
	});

	test("reports not ready when no claude binary resolves", async (t) => {
		const emptyDir = mkdtempSync(join(tmpdir(), "claude-readiness-empty-"));
		t.after(() => rmSync(emptyDir, { recursive: true, force: true }));
		process.env.PATH = emptyDir;

		assert.equal(await settleClaudeCodeReadiness(), false);
		assert.equal(isClaudeBinaryPresent(), false);
		assert.equal(isClaudeCodeReady(), false);
	});
});
