import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createTreeTerminatingClaudeCodeSpawn } from "../windows-process-spawn.ts";
import { buildSdkOptions } from "../stream-adapter.ts";

interface FakeChild extends EventEmitter {
	pid: number;
	stdin: PassThrough;
	stdout: PassThrough;
	stderr: PassThrough | null;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	killed: boolean;
	kill(signal?: NodeJS.Signals): boolean;
}

function makeFakeChild(stderrPiped: boolean): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.pid = 4321;
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = stderrPiped ? new PassThrough() : null;
	child.exitCode = null;
	child.signalCode = null;
	child.killed = false;
	child.kill = () => {
		throw new Error("the Windows spawn must not kill the CLI alone");
	};
	return child;
}

function harness(opts: { stderr?: (data: string) => void; env?: Record<string, string | undefined> } = {}) {
	const spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
	const terminations: Array<{ child: ChildProcess; signal: NodeJS.Signals }> = [];
	let child: FakeChild | undefined;
	const spawnFn = createTreeTerminatingClaudeCodeSpawn({
		stderr: opts.stderr,
		spawn: (command, args, options) => {
			spawnCalls.push({ command, args, options: options as Record<string, unknown> });
			const stdio = (options as { stdio: unknown[] }).stdio;
			child = makeFakeChild(stdio[2] === "pipe");
			return child as unknown as ChildProcess;
		},
		terminate: (target, signal) => {
			terminations.push({ child: target, signal });
			return true;
		},
	});
	const controller = new AbortController();
	const proc = spawnFn({
		command: "C:\\claude\\claude.exe",
		args: ["--output-format", "stream-json"],
		cwd: "C:\\repo\\.gsd-worktrees\\M003",
		env: { PATH: "C:\\Windows", ...opts.env },
		signal: controller.signal,
	});
	return { proc, controller, spawnCalls, terminations, child: () => child! };
}

describe("Claude Code Windows spawn (#3121)", () => {
	test("starts the CLI like the SDK does, but without handing Node the abort signal", () => {
		const { spawnCalls } = harness();
		assert.equal(spawnCalls.length, 1);
		const [call] = spawnCalls;
		assert.equal(call.command, "C:\\claude\\claude.exe");
		assert.deepEqual(call.args, ["--output-format", "stream-json"]);
		assert.equal(call.options.cwd, "C:\\repo\\.gsd-worktrees\\M003");
		assert.equal(call.options.windowsHide, true);
		assert.deepEqual(call.options.stdio, ["pipe", "pipe", "ignore"]);
		assert.equal((call.options.env as Record<string, string>).PATH, "C:\\Windows");
		assert.equal("signal" in call.options, false);
	});

	test("kill() stops the CLI's whole process tree with the SDK's signal", () => {
		const { proc, terminations, child } = harness();
		assert.equal(proc.killed, false);
		assert.equal(proc.kill("SIGTERM"), true);
		assert.equal(terminations.length, 1);
		assert.equal(terminations[0].child, child() as unknown as ChildProcess);
		assert.equal(terminations[0].signal, "SIGTERM");
		assert.equal(proc.killed, true, "the SDK checks `killed` before killing again");
	});

	test("an abort stops the tree once, before the SDK's own abort handler runs", () => {
		const { proc, controller, terminations } = harness();
		let sdkSawKilled: boolean | undefined;
		// The SDK registers its abort handler after spawn returns.
		controller.signal.addEventListener("abort", () => {
			sdkSawKilled = proc.killed;
			if (!proc.killed) proc.kill("SIGTERM");
		});
		controller.abort();
		assert.equal(terminations.length, 1);
		assert.equal(sdkSawKilled, true);
	});

	test("an already-aborted signal stops the tree immediately", () => {
		const terminations: NodeJS.Signals[] = [];
		const controller = new AbortController();
		controller.abort();
		createTreeTerminatingClaudeCodeSpawn({
			spawn: () => makeFakeChild(false) as unknown as ChildProcess,
			terminate: (_child, signal) => {
				terminations.push(signal);
				return true;
			},
		})({ command: "claude.exe", args: [], env: {}, signal: controller.signal });
		assert.deepEqual(terminations, ["SIGTERM"]);
	});

	test("a CLI that already exited is not killed again", () => {
		const { proc, terminations, child } = harness();
		child().exitCode = 0;
		child().emit("exit", 0, null);
		assert.equal(proc.kill("SIGKILL"), false);
		assert.equal(terminations.length, 0);
	});

	test("after exit, a later abort does nothing", () => {
		const { controller, terminations, child } = harness();
		child().exitCode = 0;
		child().emit("exit", 0, null);
		controller.abort();
		assert.equal(terminations.length, 0);
	});

	test("exitCode and exit listeners come from the CLI process", () => {
		const { proc, child } = harness();
		const exits: Array<number | null> = [];
		proc.once("exit", (code) => exits.push(code));
		child().exitCode = 3;
		child().emit("exit", 3, null);
		assert.equal(proc.exitCode, 3);
		assert.deepEqual(exits, [3]);
	});

	test("stderr goes to the SDK stderr sink", () => {
		const lines: string[] = [];
		const { spawnCalls, child } = harness({ stderr: (data) => lines.push(data) });
		assert.deepEqual(spawnCalls[0].options.stdio, ["pipe", "pipe", "pipe"]);
		child().stderr!.emit("data", Buffer.from("Background tasks still running after 600s"));
		assert.deepEqual(lines, ["Background tasks still running after 600s"]);
	});

	test("DEBUG_CLAUDE_AGENT_SDK pipes stderr as the SDK's spawn does", () => {
		const { spawnCalls } = harness({ env: { DEBUG_CLAUDE_AGENT_SDK: "1" } });
		assert.deepEqual(spawnCalls[0].options.stdio, ["pipe", "pipe", "pipe"]);
	});
});

describe("buildSdkOptions spawn selection (#3121)", () => {
	test("uses the tree-stopping spawn on Windows and the SDK's own spawn elsewhere", () => {
		const options = buildSdkOptions("claude-sonnet-4-6", "prompt");
		if (process.platform === "win32") {
			assert.equal(typeof options.spawnClaudeCodeProcess, "function");
		} else {
			assert.equal("spawnClaudeCodeProcess" in options, false);
		}
	});

	test("an explicit spawnClaudeCodeProcess from the caller wins", () => {
		const custom = () => {
			throw new Error("not called");
		};
		const options = buildSdkOptions("claude-sonnet-4-6", "prompt", undefined, { spawnClaudeCodeProcess: custom });
		assert.equal(options.spawnClaudeCodeProcess, custom);
	});
});
