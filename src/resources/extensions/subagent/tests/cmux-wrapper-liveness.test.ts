// gsd-pi + Cmux-split wrapper liveness (#2652).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, it } from "node:test";

import { runSingleAgentInCmuxSplit } from "../index.js";
import { isProcessAlive } from "../run-store.js";
import type { AgentConfig } from "../agents.js";
import type { CmuxClient } from "../../cmux/index.js";

function makeAgent(dir: string): AgentConfig {
	return {
		name: "cmux-agent",
		description: "drives the cmux liveness tests",
		systemPrompt: "",
		source: "project",
		filePath: join(dir, ".gsd", "agents", "cmux-agent.md"),
	};
}

/** Dead pid that stays dead (reaped), the same way child-liveness.test.ts proves it. */
async function spawnDeadPid(): Promise<number> {
	const pid = await new Promise<number>((resolve, reject) => {
		const proc = spawn(process.execPath, ["-e", ""]);
		proc.on("exit", () => resolve(proc.pid!));
		proc.on("error", reject);
	});
	assert.equal(isProcessAlive(pid), false);
	return pid;
}

interface FakeSurface {
	script: string | null;
	interrupted: boolean;
}

function makeFakeCmuxClient(surface: FakeSurface, onScript: (script: string) => void): CmuxClient {
	return {
		createSplit: async () => "surface-under-test",
		sendSurface: async (_surfaceId: string, command: string) => {
			surface.script = command;
			onScript(command);
			return true;
		},
		sendInterrupt: async () => {
			surface.interrupted = true;
		},
	} as unknown as CmuxClient;
}

/** The inner script publishes its wrapper pid first: `printf '%s' "$$" > '<path>'; cd ...`. */
function pidPathFromScript(script: string): string {
	// shellEscape wraps every token in '\''…'\'' (escaped single quotes).
	const match = script.match(/ > '\\''([^']*)'\\''; cd /);
	assert.ok(match, `wrapper script must publish its pid, got: ${script}`);
	return match[1]!;
}

function exitPathFor(pidPath: string): string {
	return join(pidPath, "..", "exit.code");
}

describe("cmux-split wrapper liveness", () => {
	const savedBinPath = process.env.GSD_BIN_PATH;
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		if (savedBinPath === undefined) delete process.env.GSD_BIN_PATH;
		else process.env.GSD_BIN_PATH = savedBinPath;
	});

	it("fails the dispatch when the wrapper shell dies without writing exit.code", async () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-cmux-liveness-"));
		process.env.GSD_BIN_PATH = join(dir, "never-executed-bin");
		const surface: FakeSurface = { script: null, interrupted: false };
		const client = makeFakeCmuxClient(surface, () => {});

		const waitPromise = runSingleAgentInCmuxSplit(
			client,
			"right",
			dir,
			[makeAgent(dir)],
			"cmux-agent",
			"outlive the wrapper",
			undefined,
			undefined,
			AbortSignal.timeout(60_000),
			undefined,
			() => ({}) as never,
			{ contextMode: "fresh" },
		);
		// The wrapper publishes its pid, then dies before its pipeline
		// completes — the exact no-exit-file condition.
		await new Promise((resolve) => setTimeout(resolve, 100));
		const pidPath = pidPathFromScript(surface.script!);
		const deadPid = await spawnDeadPid();
		const startedAt = Date.now();
		writeFileSync(pidPath, String(deadPid), "utf-8");
		const failed = await waitPromise;
		const elapsedMs = Date.now() - startedAt;

		assert.equal(failed.exitCode, 1);
		assert.match(failed.stderr ?? "", /died without writing an exit code/);
		assert.ok(elapsedMs > 4_000, `wait should have elapsed the death grace, took ${elapsedMs}ms`);
		assert.ok(elapsedMs < 15_000, `wait should resolve long before the ceiling, took ${elapsedMs}ms`);
		assert.equal(surface.interrupted, true, "the surface is interrupted best-effort after death");
	});

	it("resolves with the real exit code when the wrapper completes normally", async () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-cmux-liveness-"));
		process.env.GSD_BIN_PATH = join(dir, "never-executed-bin");
		const surface: FakeSurface = { script: null, interrupted: false };
		const client = makeFakeCmuxClient(surface, (script) => {
			const pidPath = pidPathFromScript(script);
			// Wrapper alive (our pid) and its pipeline finished: exit.code lands.
			writeFileSync(pidPath, String(process.pid), "utf-8");
			writeFileSync(exitPathFor(pidPath), "3", "utf-8");
		});

		const result = await runSingleAgentInCmuxSplit(
			client,
			"right",
			dir,
			[makeAgent(dir)],
			"cmux-agent",
			"finish normally",
			undefined,
			undefined,
			AbortSignal.timeout(60_000),
			undefined,
			() => ({}) as never,
			{ contextMode: "fresh" },
		);

		assert.equal(result.exitCode, 3, "the wrapper's real exit code is honored");
		assert.doesNotMatch(result.stderr ?? "", /died without writing an exit code/);
		assert.equal(surface.interrupted, false);
	});

	it("publishes the wrapper pid through onChildSpawned so status can revalidate it", async () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-cmux-liveness-"));
		process.env.GSD_BIN_PATH = join(dir, "never-executed-bin");
		const surface: FakeSurface = { script: null, interrupted: false };
		const client = makeFakeCmuxClient(surface, (script) => {
			const pidPath = pidPathFromScript(script);
			writeFileSync(pidPath, String(process.pid), "utf-8");
			writeFileSync(exitPathFor(pidPath), "1", "utf-8");
		});
		const observed: number[] = [];

		const result = await runSingleAgentInCmuxSplit(
			client,
			"right",
			dir,
			[makeAgent(dir)],
			"cmux-agent",
			"publish pid",
			undefined,
			undefined,
			AbortSignal.timeout(60_000),
			undefined,
			() => ({}) as never,
			{ contextMode: "fresh", onChildSpawned: (pid) => { if (pid !== undefined) observed.push(pid); } },
		);

		assert.deepEqual(observed, [process.pid], "the wrapper pid is reported exactly once");
		assert.ok(isProcessAlive(observed[0]!));
		assert.equal(result.running, false);
	});

	it("keeps the timeout path when no pid file ever appears and the signal aborts", async () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-cmux-liveness-"));
		process.env.GSD_BIN_PATH = join(dir, "never-executed-bin");
		const surface: FakeSurface = { script: null, interrupted: false };
		const client = makeFakeCmuxClient(surface, () => {});

		const result = await runSingleAgentInCmuxSplit(
			client,
			"right",
			dir,
			[makeAgent(dir)],
			"cmux-agent",
			"never writes anything",
			undefined,
			undefined,
			AbortSignal.timeout(300),
			undefined,
			() => ({}) as never,
			{ contextMode: "fresh" },
		);

		assert.equal(result.exitCode, 1);
		assert.equal(result.stderr, "cmux split execution timed out or was aborted");
		assert.equal(surface.interrupted, true);
	});
});
