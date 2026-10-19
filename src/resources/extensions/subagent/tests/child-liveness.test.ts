// gsd-pi + Subagent child liveness revalidation (#2364).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import subagentExtension from "../index.js";
import { createInitialRunRecord, isProcessAlive, SubagentRunStore } from "../run-store.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/dies-holding-stdout.cjs", import.meta.url));

function makeTool() {
	let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
	subagentExtension({
		on: () => {},
		registerCommand: () => {},
		registerTool: (definition: any) => {
			tool = definition;
		},
		sendMessage: () => Promise.resolve(),
	} as any);
	assert.ok(tool, "subagent tool was not registered");
	return (params: Record<string, unknown>) => tool!.execute("tool-call-1", params, undefined, undefined, {
		cwd: process.env.GSD_CODING_AGENT_DIR!,
		hasUI: false,
	});
}

async function spawnDeadPid(): Promise<number> {
	const pid = await new Promise<number>((resolve, reject) => {
		const proc = spawn(process.execPath, ["-e", ""]);
		proc.on("exit", () => resolve(proc.pid!));
		proc.on("error", reject);
	});
	assert.equal(isProcessAlive(pid), false, "pid should be reaped and provably dead");
	return pid;
}

describe("subagent child liveness", () => {
	const savedAgentDir = process.env.GSD_CODING_AGENT_DIR;
	const savedBinPath = process.env.GSD_BIN_PATH;
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		if (savedAgentDir === undefined) delete process.env.GSD_CODING_AGENT_DIR;
		else process.env.GSD_CODING_AGENT_DIR = savedAgentDir;
		if (savedBinPath === undefined) delete process.env.GSD_BIN_PATH;
		else process.env.GSD_BIN_PATH = savedBinPath;
	});

	function freshEnv(): string {
		dir = mkdtempSync(join(tmpdir(), "gsd-subagent-liveness-"));
		process.env.GSD_CODING_AGENT_DIR = dir;
		return dir;
	}

	it("isProcessAlive treats only a provably dead pid as dead", async () => {
		assert.equal(isProcessAlive(process.pid), true);
		assert.equal(isProcessAlive(undefined), true, "unknown pid is conservatively alive");
		assert.equal(isProcessAlive(await spawnDeadPid()), false);
	});

	it("resolves the spawn wait when a child dies holding its stdout pipe", async () => {
		const cwd = freshEnv();
		process.env.GSD_BIN_PATH = FIXTURE_PATH;
		mkdirSync(join(cwd, ".gsd", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".gsd", "agents", "dies-silently.md"),
			"---\nname: dies-silently\ndescription: dies holding its stdout pipe\n---\n",
		);

		const execute = makeTool();
		const startedAt = Date.now();
		const result = await execute({ agent: "dies-silently", task: "die holding the pipe" });
		const elapsedMs = Date.now() - startedAt;

		// The fixture grandchild holds the pipe for 8s; pre-fix the wait only
		// resolved when it died (~8s) and the exit was misattributed. The
		// exit-grace path must resolve sooner, as a failure. The floor proves
		// the fixture really spawned and the grace elapsed (an instant spawn
		// failure would settle immediately through the error handler).
		assert.ok(elapsedMs > 4000, `wait should have elapsed the death grace, took ${elapsedMs}ms`);
		assert.ok(elapsedMs < 7500, `wait should resolve before the grandchild exits, took ${elapsedMs}ms`);
		assert.equal(result.details.results[0].exitCode, 1);

		const store = new SubagentRunStore(join(process.env.GSD_CODING_AGENT_DIR!, "subagent-runs"));
		const records = store.list();
		assert.equal(records.length, 1);
		assert.equal(records[0].status, "failed");
		assert.ok(typeof records[0].children[0].pid === "number", "child pid is persisted on the run record");
	});

	it("status revalidates a silent running record whose child pid is dead", async () => {
		freshEnv();
		const store = new SubagentRunStore(join(process.env.GSD_CODING_AGENT_DIR!, "subagent-runs"));
		const deadPid = await spawnDeadPid();
		store.create(createInitialRunRecord({
			runId: "orphaned-run",
			mode: "single",
			contextMode: "fresh",
			cwd: "/repo",
			children: [{ agent: "gone-agent", task: "outlived by a harness restart" }],
		}));
		store.update("orphaned-run", (record) => ({
			...record,
			children: record.children.map((child) => ({ ...child, pid: deadPid })),
		}));
		// Age the record past one poll interval: silence is part of the death
		// evidence, so in-flight funnel work is never condemned.
		const recordPath = join(store.getBaseDir(), "orphaned-run.json");
		const aged = JSON.parse(readFileSync(recordPath, "utf-8"));
		aged.updatedAt = new Date(Date.now() - 120_000).toISOString();
		writeFileSync(recordPath, `${JSON.stringify(aged, null, 2)}\n`);

		const execute = makeTool();
		const result = await execute({ action: "status", runId: "orphaned-run" });

		assert.ok(!result.isError);
		assert.match(result.content[0].text, /failed/i, "status should report the healed terminal status");
		assert.match(result.content[0].text, /liveness revalidation/);
		const healed = store.get("orphaned-run");
		assert.equal(healed?.status, "failed");
		assert.ok(healed?.completedAt);
	});

	it("status does not heal a running record with an active pidless sibling", async () => {
		freshEnv();
		const store = new SubagentRunStore(join(process.env.GSD_CODING_AGENT_DIR!, "subagent-runs"));
		const deadPid = await spawnDeadPid();
		store.create(createInitialRunRecord({
			runId: "mixed-run",
			mode: "parallel",
			contextMode: "fresh",
			cwd: "/repo",
			children: [
				{ agent: "spawned-agent", task: "died with a persisted pid" },
				{ agent: "cmux-agent", task: "alive without a persisted pid" },
			],
		}));
		store.update("mixed-run", (record) => ({
			...record,
			children: record.children.map((child, index) =>
				index === 0 ? { ...child, pid: deadPid } : child,
			),
		}));
		const recordPath = join(store.getBaseDir(), "mixed-run.json");
		const aged = JSON.parse(readFileSync(recordPath, "utf-8"));
		aged.updatedAt = new Date(Date.now() - 120_000).toISOString();
		writeFileSync(recordPath, `${JSON.stringify(aged, null, 2)}\n`);

		const execute = makeTool();
		const result = await execute({ action: "status", runId: "mixed-run" });

		assert.match(result.content[0].text, /running/, "missing death evidence for one child blocks the heal");
		assert.equal(store.get("mixed-run")?.status, "running");
	});

	it("status prefers a completion that lands during the revalidation grace", async () => {
		freshEnv();
		const store = new SubagentRunStore(join(process.env.GSD_CODING_AGENT_DIR!, "subagent-runs"));
		const deadPid = await spawnDeadPid();
		store.create(createInitialRunRecord({
			runId: "finisher-run",
			mode: "single",
			contextMode: "fresh",
			cwd: "/repo",
			children: [{ agent: "merging-agent", task: "funnel work outlives the child" }],
		}));
		store.update("finisher-run", (record) => ({
			...record,
			children: record.children.map((child) => ({ ...child, pid: deadPid })),
		}));
		const recordPath = join(store.getBaseDir(), "finisher-run.json");
		const aged = JSON.parse(readFileSync(recordPath, "utf-8"));
		aged.updatedAt = new Date(Date.now() - 120_000).toISOString();
		writeFileSync(recordPath, `${JSON.stringify(aged, null, 2)}\n`);

		const execute = makeTool();
		const statusPromise = execute({ action: "status", runId: "finisher-run" });
		// Mid-grace the owning dispatch finishes its funnel work and persists a
		// terminal status — that fresh truth must win over the heal.
		await new Promise((resolve) => setTimeout(resolve, 500));
		store.update("finisher-run", (record) => ({
			...record,
			status: "succeeded",
			completedAt: new Date().toISOString(),
			children: record.children.map((child) => ({ ...child, status: "succeeded" as const })),
		}));
		const result = await statusPromise;

		assert.match(result.content[0].text, /succeeded/);
		const final = store.get("finisher-run");
		assert.equal(final?.status, "succeeded");
		assert.equal(final?.failure, undefined);
	});

	it("status leaves a running record with live pids untouched", async () => {
		freshEnv();
		const store = new SubagentRunStore(join(process.env.GSD_CODING_AGENT_DIR!, "subagent-runs"));
		store.create(createInitialRunRecord({
			runId: "healthy-run",
			mode: "single",
			contextMode: "fresh",
			cwd: "/repo",
			children: [{ agent: "long-runner", task: "healthy long run" }],
		}));
		store.update("healthy-run", (record) => ({
			...record,
			children: record.children.map((child) => ({ ...child, pid: process.pid })),
		}));

		const execute = makeTool();
		const result = await execute({ action: "status", runId: "healthy-run" });

		assert.match(result.content[0].text, /running/, "healthy long runs are never marked dead");
		assert.match(result.content[0].text, new RegExp(`pid ${process.pid}`));
		const untouched = store.get("healthy-run");
		assert.equal(untouched?.status, "running");
		assert.equal(untouched?.completedAt, undefined);
	});

	it("status without persisted pids keeps reporting the stored record", async () => {
		freshEnv();
		const store = new SubagentRunStore(join(process.env.GSD_CODING_AGENT_DIR!, "subagent-runs"));
		store.create(createInitialRunRecord({
			runId: "pidless-run",
			mode: "single",
			contextMode: "fresh",
			cwd: "/repo",
			children: [{ agent: "cmux-agent", task: "cmux path has no pid yet" }],
		}));

		const execute = makeTool();
		const result = await execute({ action: "status", runId: "pidless-run" });
		assert.match(result.content[0].text, /running/);
		assert.equal(store.get("pidless-run")?.status, "running");
	});
});
