import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDescendants } from "@gsd/native";
import { type TerminableChild, terminateProcessTree } from "./terminate-process-tree.js";

function fakeChild(pid: number, calls: string[], state: { exitCode?: number | null } = {}): TerminableChild {
	return {
		pid,
		exitCode: state.exitCode ?? null,
		signalCode: null,
		kill(signal) {
			calls.push(`kill ${pid} ${String(signal)}`);
			return true;
		},
	};
}

describe("terminateProcessTree off Windows", () => {
	for (const platform of ["linux", "darwin"] as const) {
		test(`${platform}: a handle gets exactly child.kill(signal) and nothing else`, () => {
			const calls: string[] = [];
			const result = terminateProcessTree(fakeChild(4242, calls), "SIGTERM", {
				platform,
				trustHandle: true,
				listDescendants: () => {
					calls.push("list");
					return [5000];
				},
				killDescendant: (pid) => calls.push(`descendant ${pid}`),
			});
			assert.equal(result, true);
			assert.deepEqual(calls, ["kill 4242 SIGTERM"]);
		});
	}

	test("linux: a PID gets exactly process.kill(pid, signal), and its error reaches the caller", (t) => {
		const calls: Array<[number, unknown]> = [];
		const originalKill = process.kill;
		process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
			calls.push([pid, signal]);
			const error = new Error("no such process") as NodeJS.ErrnoException;
			error.code = "ESRCH";
			throw error;
		}) as typeof process.kill;
		t.after(() => {
			process.kill = originalKill;
		});
		assert.throws(
			() => terminateProcessTree(424_242, "SIGKILL", { platform: "linux", listDescendants: () => [1] }),
			{ code: "ESRCH" },
		);
		assert.deepEqual(calls, [[424_242, "SIGKILL"]]);
	});
});

describe("terminateProcessTree on Windows", () => {
	test("lists descendants before the kill, makes the same kill call, then ends each descendant", () => {
		const calls: string[] = [];
		const result = terminateProcessTree(fakeChild(100, calls), "SIGTERM", {
			platform: "win32",
			trustHandle: true,
			listDescendants: (pid) => {
				calls.push(`list ${pid}`);
				return [200, 300, 400];
			},
			killDescendant: (pid) => calls.push(`descendant ${pid}`),
		});
		assert.equal(result, true);
		assert.deepEqual(calls, [
			"list 100",
			"kill 100 SIGTERM",
			"descendant 200",
			"descendant 300",
			"descendant 400",
			"list 100",
		]);
	});

	test("a second pass ends processes started while the first pass ran", () => {
		const ended: number[] = [];
		let listCalls = 0;
		terminateProcessTree(fakeChild(100, []), "SIGKILL", {
			platform: "win32",
			trustHandle: true,
			listDescendants: () => (++listCalls === 1 ? [200] : [200, 201]),
			killDescendant: (pid) => ended.push(pid),
		});
		assert.deepEqual(ended, [200, 201]);
	});

	test("never ends the current process, even if it is listed", () => {
		const ended: number[] = [];
		terminateProcessTree(fakeChild(100, []), "SIGTERM", {
			platform: "win32",
			trustHandle: true,
			listDescendants: () => [process.pid, 200],
			killDescendant: (pid) => ended.push(pid),
		});
		assert.deepEqual(ended, [200]);
	});

	test("a descendant that is already gone does not stop the others", () => {
		const ended: number[] = [];
		terminateProcessTree(fakeChild(100, []), "SIGTERM", {
			platform: "win32",
			trustHandle: true,
			listDescendants: () => [200, 300],
			killDescendant: (pid) => {
				if (pid === 200) throw Object.assign(new Error("gone"), { code: "ESRCH" });
				ended.push(pid);
			},
		});
		assert.deepEqual(ended, [300]);
	});

	test("an unavailable native engine falls back to the target-only kill", () => {
		const calls: string[] = [];
		const result = terminateProcessTree(fakeChild(100, calls), "SIGTERM", {
			platform: "win32",
			trustHandle: true,
			listDescendants: () => {
				throw new Error("native engine unavailable");
			},
			killDescendant: (pid) => calls.push(`descendant ${pid}`),
		});
		assert.equal(result, true);
		assert.deepEqual(calls, ["kill 100 SIGTERM"]);
	});

	test("a child that already exited is not walked: its PID may belong to another process now", () => {
		const calls: string[] = [];
		terminateProcessTree(fakeChild(100, calls, { exitCode: 0 }), "SIGTERM", {
			platform: "win32",
			trustHandle: true,
			listDescendants: () => {
				calls.push("list");
				return [200];
			},
			killDescendant: (pid) => calls.push(`descendant ${pid}`),
		});
		assert.deepEqual(calls, ["kill 100 SIGTERM"]);
	});

	test("a handle that is not a real ChildProcess only gets its own kill", () => {
		const calls: string[] = [];
		terminateProcessTree(fakeChild(100, calls), "SIGTERM", {
			platform: "win32",
			listDescendants: () => {
				calls.push("list");
				return [200];
			},
			killDescendant: (pid) => calls.push(`descendant ${pid}`),
		});
		assert.deepEqual(calls, ["kill 100 SIGTERM"]);
	});

	test("a PID target keeps its process.kill call and also loses its descendants", (t) => {
		const calls: string[] = [];
		const originalKill = process.kill;
		process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
			calls.push(`process.kill ${pid} ${String(signal)}`);
			return true;
		}) as typeof process.kill;
		t.after(() => {
			process.kill = originalKill;
		});
		terminateProcessTree(424_244, "SIGTERM", {
			platform: "win32",
			listDescendants: (pid) => (pid === 424_244 ? [424_248] : []),
		});
		assert.deepEqual(calls, ["process.kill 424244 SIGTERM", "process.kill 424248 SIGKILL"]);
	});
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return check();
}

const windowsOnly = process.platform === "win32" ? false : "Windows process-tree behaviour";

test("Windows: stopping an agent leaves none of its tool processes holding the directory (#3121)", { skip: windowsOnly }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gsd-terminate-tree-"));
	// Stands in for an agent CLI whose shell tool runs a native program in the
	// worktree. ping keeps running on its own, as the reported python3 did, and
	// its output file shows when it has started.
	const agentScript = [
		"const { spawn } = require('node:child_process');",
		"spawn('cmd.exe', ['/d', '/c', 'ping -n 120 127.0.0.1 > ping.out'], { stdio: 'ignore', windowsHide: true });",
		"setInterval(() => {}, 1000);",
	].join("\n");
	const pingOutput = join(dir, "ping.out");
	const agent = spawn(process.execPath, ["-e", agentScript], { cwd: dir, stdio: "ignore", windowsHide: true });
	let seen: number[] = [];
	t.after(() => {
		for (const pid of [agent.pid ?? 0, ...seen]) {
			try {
				if (pid > 0) process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
		rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
	});

	const pid = agent.pid;
	assert.ok(pid, "agent started");
	assert.ok(
		await waitFor(() => existsSync(pingOutput) && statSync(pingOutput).size > 0, 15_000),
		"the agent's tool process started",
	);
	seen = listDescendants(pid);

	const exited = new Promise((resolve) => agent.once("exit", resolve));
	terminateProcessTree(agent, "SIGTERM");
	await exited;

	assert.ok(await waitFor(() => seen.every((descendant) => !isAlive(descendant)), 10_000), "no tool process survives");
	rmSync(dir, { recursive: true, force: true });
	assert.equal(existsSync(dir), false, "the directory can be removed");
});
