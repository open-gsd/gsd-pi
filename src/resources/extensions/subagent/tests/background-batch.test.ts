// gsd-pi — background batch dispatch: parallel and chain batches launch
// detached through the shared executors (#2820).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import subagentExtension from "../index.js";

const ECHO_FIXTURE = fileURLToPath(new URL("./fixtures/echo-task.cjs", import.meta.url));

interface SentMessage {
	message: { customType: string; content: string; display: boolean; details?: unknown };
	options: { triggerTurn?: boolean };
}

interface Harness {
	sent: SentMessage[];
	attemptsNow: number;
	execute: (params: Record<string, unknown>, ctx?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;
	runStoreDir: string;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 15000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error("condition not met before timeout");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function makeHarness(): Harness {
	const sent: SentMessage[] = [];
	const attempts = { count: 0 };
	let tool: { execute: (...args: any[]) => Promise<unknown> } | undefined;
	subagentExtension({
		on: () => {},
		registerCommand: () => {},
		registerTool: (definition: any) => {
			tool = definition;
		},
		sendMessage: (message: any, sendMessageOptions: any) => {
			attempts.count++;
			sent.push({ message, options: sendMessageOptions });
			return Promise.resolve();
		},
	} as any);
	assert.ok(tool, "subagent tool was not registered");
	return {
		sent,
		// Live view of the counter, not the value at harness-build time.
		get attemptsNow() {
			return attempts.count;
		},
		execute: (params, ctx = { hasUI: true }, signal) =>
			tool!.execute("tool-call-1", params, signal, undefined, ctx),
		runStoreDir: join(process.env.GSD_CODING_AGENT_DIR!, "subagent-runs"),
	};
}

describe("background batch dispatch", () => {
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
		dir = mkdtempSync(join(tmpdir(), "gsd-subagent-bg-batch-"));
		const agentsDir = join(dir, ".gsd", "agents");
		mkdirSync(agentsDir, { recursive: true });
		for (const name of ["echo-a", "echo-b"]) {
			writeFileSync(
				join(agentsDir, `${name}.md`),
				`---\nname: ${name}\ndescription: echo fixture ${name}\n---\n`,
			);
		}
		process.env.GSD_CODING_AGENT_DIR = dir;
		process.env.GSD_BIN_PATH = ECHO_FIXTURE;
		return dir;
	}

	function readRecord(harness: Harness, runId: string): any {
		return JSON.parse(readFileSync(join(harness.runStoreDir, `${runId}.json`), "utf-8"));
	}

	it("launches a parallel batch detached with per-child tracking and one aggregate wake", async () => {
		const cwd = freshEnv();
		const harness = makeHarness();

		const result: any = await harness.execute(
			{
				action: "launch",
				background: true,
				tasks: [
					{ agent: "echo-a", task: "alpha" },
					{ agent: "echo-b", task: "beta" },
				],
			},
			{ cwd, hasUI: true },
		);

		const text: string = result.content[0].text;
		assert.equal(result.isError, undefined, "a valid batch must not be rejected");
		assert.doesNotMatch(text, /Background launch requires single mode/, "the old rejection must not fire");
		const runId = /Started background subagent run (\S+)\./.exec(text)?.[1];
		assert.ok(runId, `tool return should carry the runId, got: ${text}`);

		// The persisted record carries the batch identity before any child lands.
		const early = readRecord(harness, runId);
		assert.equal(early.mode, "parallel");
		assert.equal(early.children.length, 2);
		assert.equal(early.status, "running");

		const wake = await waitFor(() => harness.sent[0]);
		assert.equal(harness.attemptsNow, 1, "exactly one wake per detached batch");
		assert.equal(wake.options.triggerTurn, true);
		assert.equal(wake.message.customType, "subagent_completed");
		assert.ok(wake.message.content.includes(runId), "wake content carries the runId");
		assert.ok(wake.message.content.includes("2 succeeded"), `wake should aggregate, got: ${wake.message.content}`);
		assert.equal((wake.message.details as any)?.mode, "parallel");

		const record = await waitFor(() => {
			const current = readRecord(harness, runId);
			return current.status === "succeeded" ? current : undefined;
		});
		assert.equal(record.children[0].status, "succeeded");
		assert.equal(record.children[1].status, "succeeded");
		assert.equal(record.children[0].output, "echo:alpha");
		assert.equal(record.children[1].output, "echo:beta");
		assert.ok(typeof record.children[0].pid === "number", "child pid persisted for liveness revalidation");
		assert.ok(typeof record.children[1].pid === "number", "child pid persisted for liveness revalidation");
	});

	it("launches a chain detached, preserving order and {previous} handoff", async () => {
		const cwd = freshEnv();
		const harness = makeHarness();

		const result: any = await harness.execute(
			{
				action: "launch",
				background: true,
				chain: [
					{ agent: "echo-a", task: "first" },
					{ agent: "echo-b", task: "second after {previous}" },
				],
			},
			{ cwd, hasUI: true },
		);

		const text: string = result.content[0].text;
		assert.equal(result.isError, undefined);
		assert.doesNotMatch(text, /Background launch requires single mode/);
		const runId = /Started background subagent run (\S+)\./.exec(text)?.[1];
		assert.ok(runId);

		const record = await waitFor(() => {
			const current = readRecord(harness, runId);
			return current.status === "succeeded" ? current : undefined;
		});
		assert.equal(record.mode, "chain");
		assert.equal(record.children.length, 2);
		// Ordering: step 2 received step 1's output through {previous}.
		assert.equal(record.children[0].status, "succeeded");
		assert.equal(record.children[0].task, "first");
		assert.equal(record.children[0].output, "echo:first");
		assert.equal(record.children[1].status, "succeeded");
		assert.equal(record.children[1].task, "second after echo:first");
		assert.equal(record.children[1].output, "echo:second after echo:first");

		const wake = await waitFor(() => harness.sent[0]);
		assert.equal(harness.attemptsNow, 1, "exactly one wake per detached batch");
		assert.ok(wake.message.content.includes("2 succeeded"), `wake should aggregate, got: ${wake.message.content}`);
	});

	it("detached batch children survive the dispatching turn's cancellation signal", async () => {
		const cwd = freshEnv();
		const harness = makeHarness();
		const controller = new AbortController();

		const result: any = await harness.execute(
			{
				action: "launch",
				background: true,
				tasks: [
					{ agent: "echo-a", task: "alpha" },
					{ agent: "echo-b", task: "beta" },
				],
			},
			{ cwd, hasUI: true },
			controller.signal,
		);
		const runId = /Started background subagent run (\S+)\./.exec(result.content[0].text)?.[1];
		assert.ok(runId);

		// Aborting after the launch is the turn-cancellation shape: a synchronous
		// dispatch would kill its children; the detached batch must outlive it.
		controller.abort();

		const record = await waitFor(() => {
			const current = readRecord(harness, runId);
			return current.status === "succeeded" ? current : undefined;
		});
		assert.equal(record.children[0].status, "succeeded");
		assert.equal(record.children[1].status, "succeeded");
		await waitFor(() => (harness.attemptsNow === 1 ? true : undefined));
	});

	it("a thrown launch fails only its child; the batch finalizes after every sibling settles", async () => {
		const cwd = freshEnv();
		const harness = makeHarness();

		// context: "fork" without a parent session manager throws during launch
		// setup — the injectable per-task throw.
		const result: any = await harness.execute(
			{
				action: "launch",
				background: true,
				tasks: [
					{ agent: "echo-a", task: "alpha", context: "fork" },
					{ agent: "echo-b", task: "beta" },
				],
			},
			{ cwd, hasUI: true },
		);
		const runId = /Started background subagent run (\S+)\./.exec(result.content[0].text)?.[1];
		assert.ok(runId);

		// One wake, sent once the whole batch settled — not the premature
		// "0 succeeded, 2 failed" a fail-fast finalize would announce while the
		// sibling is still running.
		const wake = await waitFor(() => harness.sent[0]);
		assert.equal(harness.attemptsNow, 1, "exactly one wake for the settled batch");
		assert.ok(wake.message.content.includes("1 succeeded, 1 failed"), `wake should aggregate, got: ${wake.message.content}`);

		const record = readRecord(harness, runId);
		assert.equal(record.status, "failed");
		assert.equal(record.children[0].status, "failed");
		assert.match(record.children[0].errorMessage ?? "", /[Ff]orked subagent context/);
		assert.equal(record.children[0].stopReason, "error");
		assert.equal(record.children[1].status, "succeeded");

		// The settled terminal status is stable: stragglers must not resurrect it.
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(readRecord(harness, runId).status, "failed", "terminal record must stay terminal");
	});

	it("detached failure synthesis ignores the dispatching turn's cancellation", async () => {
		const cwd = freshEnv();
		const harness = makeHarness();
		const controller = new AbortController();
		controller.abort();

		// An already-aborted turn signal plus a chain step that throws during
		// launch: the detached run executed with no signal, so the failure is an
		// error, not an abort, and the record is failed, not interrupted.
		const result: any = await harness.execute(
			{
				action: "launch",
				background: true,
				chain: [{ agent: "echo-a", task: "first", context: "fork" }],
			},
			{ cwd, hasUI: true },
			controller.signal,
		);
		const runId = /Started background subagent run (\S+)\./.exec(result.content[0].text)?.[1];
		assert.ok(runId);

		const record = await waitFor(() => {
			const current = readRecord(harness, runId);
			return current.status === "failed" ? current : undefined;
		});
		assert.equal(record.status, "failed", "a detached launch failure is not an interruption");
		assert.equal(record.children[0].status, "failed");
		assert.equal(record.children[0].stopReason, "error");
		assert.match(record.children[0].errorMessage ?? "", /[Ff]orked subagent context/);
		await waitFor(() => (harness.attemptsNow === 1 ? true : undefined));
	});

	it("a failing chain step stops the detached chain and marks queued children", async () => {
		const cwd = freshEnv();
		const harness = makeHarness();

		const result: any = await harness.execute(
			{
				action: "launch",
				background: true,
				chain: [
					{ agent: "echo-a", task: "first" },
					{ agent: "missing-agent", task: "never runs" },
					{ agent: "echo-b", task: "third" },
				],
			},
			{ cwd, hasUI: true },
		);
		const runId = /Started background subagent run (\S+)\./.exec(result.content[0].text)?.[1];
		assert.ok(runId);

		const record = await waitFor(() => {
			const current = readRecord(harness, runId);
			return current.status === "failed" ? current : undefined;
		});
		assert.equal(record.mode, "chain");
		assert.equal(record.children[0].status, "succeeded");
		assert.equal(record.children[1].status, "failed");
		// An unknown agent fails in runSingleAgent before any launch; the message
		// rides stderr, not errorMessage.
		assert.match(record.children[1].stderr ?? "", /[Uu]nknown agent/);
		// The step after the failure never ran; it is terminal, not queued.
		assert.equal(record.children[2].status, "failed");
		assert.match(record.children[2].errorMessage ?? "", /ended before this child completed/);

		const wake = await waitFor(() => harness.sent[0]);
		assert.equal(harness.attemptsNow, 1);
		// The wake counts executed steps (the chain stopped at the failed one);
		// the never-run step's failure is visible in the record above.
		assert.ok(wake.message.content.includes("1 succeeded, 1 failed"), `wake should aggregate, got: ${wake.message.content}`);
	});
});
