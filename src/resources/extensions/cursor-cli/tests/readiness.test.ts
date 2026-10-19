import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	buildCursorAgentSpawnInvocation,
	clearCursorAgentReadinessCache,
	getCursorAgentCommandCandidates,
	isCursorAgentApiKeyValue,
	isCursorAgentBinaryPresent,
	isCursorAgentReady,
	parseCursorAgentStatus,
	probeCursorAgentReadyUncached,
	settleCursorAgentReadiness,
} from "../readiness.ts";

test("getCursorAgentCommandCandidates includes Windows shims", () => {
	assert.deepEqual(getCursorAgentCommandCandidates("win32"), ["cursor-agent.cmd", "cursor-agent.exe", "cursor-agent"]);
	assert.deepEqual(getCursorAgentCommandCandidates("linux"), ["cursor-agent"]);
});

test("buildCursorAgentSpawnInvocation uses cmd /c on Windows", () => {
	assert.deepEqual(buildCursorAgentSpawnInvocation("cursor-agent.cmd", ["--version"], "win32"), {
		command: "cmd",
		args: ["/c", "cursor-agent.cmd", "--version"],
	});
});

test("parseCursorAgentStatus recognizes auth status output", () => {
	assert.equal(parseCursorAgentStatus('{"authenticated":true}'), true);
	assert.equal(parseCursorAgentStatus('{"loggedIn":false}'), false);
	assert.equal(parseCursorAgentStatus("Authenticated as user@example.com"), true);
	assert.equal(parseCursorAgentStatus("not authenticated"), false);
	assert.equal(parseCursorAgentStatus(""), null);
});

test("isCursorAgentApiKeyValue rejects external CLI sentinel values", () => {
	assert.equal(isCursorAgentApiKeyValue("cursor-token"), true);
	assert.equal(isCursorAgentApiKeyValue("cli"), false);
	assert.equal(isCursorAgentApiKeyValue("  "), false);
});

test("readiness checks only the supported status command", async () => {
	const fixtureDir = mkdtempSync(join(tmpdir(), "cursor-readiness-"));
	const logPath = join(fixtureDir, "invocations.log");
	const commandPath = join(fixtureDir, process.platform === "win32" ? "cursor-agent.cmd" : "cursor-agent");
	const originalPath = process.env.PATH;
	const originalApiKey = process.env.CURSOR_API_KEY;
	const originalLogPath = process.env.CURSOR_AGENT_TEST_LOG;

	if (process.platform === "win32") {
		writeFileSync(commandPath, [
			"@echo off",
			"echo %*>>\"%CURSOR_AGENT_TEST_LOG%\"",
			"if \"%1\"==\"--version\" (echo 1.0.0 & exit /b 0)",
			"if \"%1\"==\"status\" (echo Not authenticated & exit /b 0)",
			"exit /b 1",
		].join("\r\n"));
	} else {
		writeFileSync(commandPath, [
			"#!/bin/sh",
			"printf '%s\\n' \"$*\" >> \"$CURSOR_AGENT_TEST_LOG\"",
			"[ \"$1\" = \"--version\" ] && { echo 1.0.0; exit 0; }",
			"[ \"$1\" = \"status\" ] && { echo 'Not authenticated'; exit 0; }",
			"exit 1",
		].join("\n"), { mode: 0o755 });
	}

	try {
		process.env.PATH = `${fixtureDir}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
		process.env.CURSOR_AGENT_TEST_LOG = logPath;
		delete process.env.CURSOR_API_KEY;

		assert.equal(await probeCursorAgentReadyUncached(), false);
		assert.deepEqual(readFileSync(logPath, "utf8").trim().split(/\r?\n/), ["--version", "status"]);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalApiKey === undefined) delete process.env.CURSOR_API_KEY;
		else process.env.CURSOR_API_KEY = originalApiKey;
		if (originalLogPath === undefined) delete process.env.CURSOR_AGENT_TEST_LOG;
		else process.env.CURSOR_AGENT_TEST_LOG = originalLogPath;
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

describe("cursor-agent readiness cache", () => {
	const ENV_KEYS = ["PATH", "CURSOR_API_KEY", "CURSOR_AGENT_TEST_LOG", "CURSOR_AGENT_TEST_AUTH"] as const;
	let fixtureDir: string;
	let logPath: string;
	let savedEnv: Record<string, string | undefined>;

	function invocations(): string[] {
		if (!existsSync(logPath)) return [];
		return readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => line.trim());
	}

	beforeEach(() => {
		fixtureDir = mkdtempSync(join(tmpdir(), "cursor-readiness-cache-"));
		logPath = join(fixtureDir, "invocations.log");
		// Fake cursor-agent: `status` reports CURSOR_AGENT_TEST_AUTH ("in" or
		// "out"); any other value fails the status probe (soft-fail).
		if (process.platform === "win32") {
			writeFileSync(join(fixtureDir, "cursor-agent.cmd"), [
				"@echo off",
				"echo %*>>\"%CURSOR_AGENT_TEST_LOG%\"",
				"if \"%1\"==\"--version\" (echo 1.0.0 & exit /b 0)",
				"if not \"%1\"==\"status\" exit /b 1",
				"if \"%CURSOR_AGENT_TEST_AUTH%\"==\"in\" (echo Authenticated as user@example.com & exit /b 0)",
				"if \"%CURSOR_AGENT_TEST_AUTH%\"==\"out\" (echo Not authenticated & exit /b 0)",
				"exit /b 1",
			].join("\r\n"));
		} else {
			writeFileSync(join(fixtureDir, "cursor-agent"), [
				"#!/bin/sh",
				"printf '%s\n' \"$*\" >> \"$CURSOR_AGENT_TEST_LOG\"",
				"[ \"$1\" = \"--version\" ] && { echo 1.0.0; exit 0; }",
				"[ \"$1\" = \"status\" ] || exit 1",
				"[ \"$CURSOR_AGENT_TEST_AUTH\" = \"in\" ] && { echo 'Authenticated as user@example.com'; exit 0; }",
				"[ \"$CURSOR_AGENT_TEST_AUTH\" = \"out\" ] && { echo 'Not authenticated'; exit 0; }",
				"exit 1",
			].join("\n"), { mode: 0o755 });
		}
		savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		process.env.PATH = `${fixtureDir}${delimiter}${savedEnv.PATH ?? ""}`;
		process.env.CURSOR_AGENT_TEST_LOG = logPath;
		process.env.CURSOR_AGENT_TEST_AUTH = "in";
		delete process.env.CURSOR_API_KEY;
		clearCursorAgentReadinessCache();
	});

	afterEach(() => {
		clearCursorAgentReadinessCache();
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	test("cold cache answers false immediately without running the CLI, then the async probe fills it", async () => {
		assert.equal(isCursorAgentReady(), false, "unknown must not be reported as ready");
		assert.equal(isCursorAgentBinaryPresent(), false);
		assert.deepEqual(invocations(), [], "a synchronous probe would already have run the CLI");

		assert.equal(await settleCursorAgentReadiness(), true);
		assert.equal(isCursorAgentReady(), true);
		assert.equal(isCursorAgentBinaryPresent(), true);
		assert.deepEqual(invocations(), ["--version", "status"], "one probe, and a fresh cache does not re-probe");
	});

	test("stale cache returns the last answer without running the CLI; the async refresh updates it", async (t) => {
		t.mock.timers.enable({ apis: ["Date"] });
		assert.equal(await settleCursorAgentReadiness(), true);

		process.env.CURSOR_AGENT_TEST_AUTH = "out";
		t.mock.timers.tick(31_000);

		for (let i = 0; i < 25; i++) {
			assert.equal(isCursorAgentReady(), true, "stale cache still answers with the last known value");
		}
		assert.equal(invocations().length, 2, "no CLI ran on the caller's stack");

		assert.equal(await settleCursorAgentReadiness(), false, "the refresh picked up the new auth state");
		assert.equal(isCursorAgentReady(), false);
		assert.equal(isCursorAgentBinaryPresent(), true);
		assert.deepEqual(invocations().slice(2), ["--version", "status"], "25 stale calls produced exactly one refresh");
	});

	test("a soft-failing status probe keeps the known-good auth state", async (t) => {
		t.mock.timers.enable({ apis: ["Date"] });
		assert.equal(await settleCursorAgentReadiness(), true);

		process.env.CURSOR_AGENT_TEST_AUTH = "broken";
		t.mock.timers.tick(31_000);

		assert.equal(await settleCursorAgentReadiness(), true, "an inconclusive probe must not clobber a known login");
		assert.equal(isCursorAgentReady(), true);
	});

	test("an inconclusive status probe on a cold cache is not ready", async () => {
		process.env.CURSOR_AGENT_TEST_AUTH = "broken";

		assert.equal(await settleCursorAgentReadiness(), false);
		assert.equal(isCursorAgentBinaryPresent(), true);
		assert.equal(isCursorAgentReady(), false);
	});

	test("CURSOR_API_KEY authenticates without asking the CLI for its status", async () => {
		process.env.CURSOR_AGENT_TEST_AUTH = "out";
		process.env.CURSOR_API_KEY = "cursor-token";

		assert.equal(await settleCursorAgentReadiness(), true);
		assert.deepEqual(invocations(), ["--version"]);
	});

	test("clearCursorAgentReadinessCache() makes the next answer cold and re-probes", async () => {
		assert.equal(await settleCursorAgentReadiness(), true);

		clearCursorAgentReadinessCache();
		assert.equal(isCursorAgentReady(), false, "cold again");
		assert.equal(await settleCursorAgentReadiness(), true);
		assert.equal(invocations().length, 4, "the cleared cache was re-probed");
	});

	test("reports not ready when no cursor-agent binary resolves", async (t) => {
		const emptyDir = mkdtempSync(join(tmpdir(), "cursor-readiness-empty-"));
		t.after(() => rmSync(emptyDir, { recursive: true, force: true }));
		process.env.PATH = emptyDir;

		assert.equal(await settleCursorAgentReadiness(), false);
		assert.equal(isCursorAgentBinaryPresent(), false);
		assert.equal(isCursorAgentReady(), false);
	});
});
