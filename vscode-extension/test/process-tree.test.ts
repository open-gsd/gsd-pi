// Project/App: gsd-pi
// File Purpose: Verifies the agent child is stopped with its whole process tree
// on Windows and with the plain kill elsewhere (#3121).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { stopChildProcessTree } from "../src/process-tree.ts";

function startChild(t: { after: (fn: () => void) => void }): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
	t.after(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
	return child;
}

describe("stopChildProcessTree (#3121)", () => {
	it("on Windows ends the child's tree before the usual kill", async (t) => {
		const child = startChild(t);
		const order: string[] = [];
		const realKill = child.kill.bind(child);
		child.kill = ((signal?: NodeJS.Signals | number) => {
			order.push(`kill ${String(signal)}`);
			return realKill(signal);
		}) as typeof child.kill;
		const exited = once(child, "exit");
		stopChildProcessTree(child, "SIGTERM", {
			platform: "win32",
			killTree: (pid) => order.push(`tree ${pid === child.pid ? "child" : pid}`),
		});
		await exited;
		assert.deepEqual(order, ["tree child", "kill SIGTERM"]);
	});

	for (const platform of ["linux", "darwin"] as const) {
		it(`on ${platform} only makes the usual kill`, async (t) => {
			const child = startChild(t);
			const trees: number[] = [];
			const exited = once(child, "exit");
			assert.equal(stopChildProcessTree(child, "SIGTERM", { platform, killTree: (pid) => trees.push(pid) }), true);
			await exited;
			assert.deepEqual(trees, []);
		});
	}

	it("does not walk a child that already exited", async (t) => {
		const child = startChild(t);
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		const trees: number[] = [];
		stopChildProcessTree(child, "SIGTERM", { platform: "win32", killTree: (pid) => trees.push(pid) });
		assert.deepEqual(trees, []);
	});

	it("passes a test double straight to its own kill", () => {
		const calls: string[] = [];
		const fake = { pid: 1234, exitCode: null, signalCode: null, kill: (signal: string) => calls.push(signal) > 0 };
		const trees: number[] = [];
		stopChildProcessTree(fake as unknown as ChildProcess, "SIGKILL", { platform: "win32", killTree: (pid) => trees.push(pid) });
		assert.deepEqual(trees, []);
		assert.deepEqual(calls, ["SIGKILL"]);
	});

	it("still makes the usual kill when the tree kill fails", async (t) => {
		const child = startChild(t);
		const exited = once(child, "exit");
		stopChildProcessTree(child, "SIGTERM", {
			platform: "win32",
			killTree: () => {
				throw new Error("taskkill missing");
			},
		});
		await exited;
		assert.notEqual(child.exitCode ?? child.signalCode, null);
	});
});

const windowsOnly = process.platform === "win32" ? false : "Windows process-tree behaviour";

it("Windows: stopping the agent frees the directory its tool processes ran in", { skip: windowsOnly }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "vscode-gsd-tree-"));
	const agentScript = [
		"const { spawn } = require('node:child_process');",
		"spawn('cmd.exe', ['/d', '/c', 'ping -n 120 127.0.0.1 > ping.out'], { stdio: 'ignore', windowsHide: true });",
		"setInterval(() => {}, 1000);",
	].join("\n");
	const agent = spawn(process.execPath, ["-e", agentScript], { cwd: dir, stdio: "ignore", windowsHide: true });
	t.after(() => {
		if (agent.exitCode === null && agent.signalCode === null) {
			spawnSync("taskkill", ["/F", "/T", "/PID", String(agent.pid)], { stdio: "ignore", windowsHide: true });
		}
		// A leftover ping ends on its own after 120 s.
		rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
	});
	const pingOutput = join(dir, "ping.out");
	const deadline = Date.now() + 15_000;
	while (!(existsSync(pingOutput) && statSync(pingOutput).size > 0) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(existsSync(pingOutput), "the agent's tool process started");

	const exited = once(agent, "exit");
	stopChildProcessTree(agent, "SIGTERM");
	await exited;

	rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	assert.equal(existsSync(dir), false);
});
