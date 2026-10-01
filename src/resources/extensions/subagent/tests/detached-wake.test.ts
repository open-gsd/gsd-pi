// gsd-pi + Detached subagent completion must re-invoke the session (#2363).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import subagentExtension, { truncateDiagnostic } from "../index.js";

interface SentMessage {
	message: { customType: string; content: string; display: boolean; details?: unknown };
	options: { triggerTurn?: boolean };
}

interface Harness {
	sent: SentMessage[];
	attemptsNow: number;
	execute: (params: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;
	runStoreDir: string;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error("condition not met before timeout");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function makeHarness(options: {
	hasUI?: boolean | (() => boolean);
	sendMessageThrows?: boolean;
	sendMessageRejects?: boolean;
} = {}): Harness {
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
			if (options.sendMessageThrows) throw new Error("wake channel is down");
			if (options.sendMessageRejects) return Promise.reject(new Error("wake channel refused"));
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
		execute: (params, ctx) => tool!.execute("tool-call-1", params, undefined, undefined, ctx),
		runStoreDir: join(process.env.GSD_CODING_AGENT_DIR!, "subagent-runs"),
	};
}

describe("detached subagent completion wake", () => {
	const savedAgentDir = process.env.GSD_CODING_AGENT_DIR;
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		if (savedAgentDir === undefined) delete process.env.GSD_CODING_AGENT_DIR;
		else process.env.GSD_CODING_AGENT_DIR = savedAgentDir;
	});

	function freshAgentDir(): string {
		dir = mkdtempSync(join(tmpdir(), "gsd-subagent-wake-"));
		process.env.GSD_CODING_AGENT_DIR = dir;
		return dir;
	}

	async function waitForTerminalRecord(harness: Harness, runId: string) {
		return waitFor(() => {
			if (!existsSync(join(harness.runStoreDir, `${runId}.json`))) return undefined;
			const record = JSON.parse(readFileSync(join(harness.runStoreDir, `${runId}.json`), "utf-8"));
			return record.status === "failed" ? record : undefined;
		});
	}

	it("wakes the session once with triggerTurn when a detached run completes", async () => {
		const cwd = freshAgentDir();
		const harness = makeHarness({ hasUI: true });

		const result: any = await harness.execute(
			{ action: "launch", background: true, agent: "missing-agent", task: "inspect the void" },
			{ cwd, hasUI: true },
		);
		const text: string = result.content[0].text;
		const runId = /Started background subagent run (\S+)\./.exec(text)?.[1];
		assert.ok(runId, `tool return should carry the runId, got: ${text}`);

		const wake = await waitFor(() => harness.sent[0]);
		assert.equal(harness.attemptsNow, 1, "exactly one wake per dispatch");
		assert.equal(wake.options.triggerTurn, true);
		assert.equal(wake.message.customType, "subagent_completed");
		assert.equal(wake.message.display, true);
		assert.ok(wake.message.content.includes(runId), "wake content carries the runId");
		assert.ok(wake.message.content.includes("missing-agent"), "wake content names the agent");

		const record = await waitForTerminalRecord(harness, runId);
		assert.equal(record.status, "failed", "persistence is unaffected by the wake");
	});

	it("does not wake headless sessions", async () => {
		const cwd = freshAgentDir();
		const harness = makeHarness({ hasUI: false });

		const result: any = await harness.execute(
			{ action: "launch", background: true, agent: "missing-agent", task: "inspect the void" },
			{ cwd, hasUI: false },
		);
		const runId = /Started background subagent run (\S+)\./.exec(result.content[0].text)?.[1];
		assert.ok(runId);

		// The detached funnel still runs (record reaches a terminal status); only
		// the wake must be absent.
		await waitForTerminalRecord(harness, runId!);
		// Give any (incorrect) wake a moment to land, then assert silence.
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(harness.attemptsNow, 0, "headless sessions must not be woken");
	});

	it("a rejected wake delivery never affects persistence", async () => {
		const cwd = freshAgentDir();
		const harness = makeHarness({ hasUI: true, sendMessageRejects: true });

		const result: any = await harness.execute(
			{ action: "launch", background: true, agent: "missing-agent", task: "inspect the void" },
			{ cwd, hasUI: true },
		);
		const runId = /Started background subagent run (\S+)\./.exec(result.content[0].text)?.[1];
		assert.ok(runId);

		// Delivery was attempted (the .catch containment, not a skipped wake)…
		await waitFor(() => (harness.attemptsNow === 1 ? true : undefined));
		// …the rejection must not surface as an unhandled rejection, and the
		// record still reaches a terminal status.
		await waitForTerminalRecord(harness, runId!);
	});

	it("a synchronously throwing send never affects persistence", async () => {
		const cwd = freshAgentDir();
		const harness = makeHarness({ hasUI: true, sendMessageThrows: true });

		const result: any = await harness.execute(
			{ action: "launch", background: true, agent: "missing-agent", task: "inspect the void" },
			{ cwd, hasUI: true },
		);
		const runId = /Started background subagent run (\S+)\./.exec(result.content[0].text)?.[1];
		assert.ok(runId);

		await waitFor(() => (harness.attemptsNow === 1 ? true : undefined));
		await waitForTerminalRecord(harness, runId!);
	});

	it("a stale-runtime hasUI getter never escapes the detached IIFE", async () => {
		const cwd = freshAgentDir();
		const harness = makeHarness({});

		const result: any = await harness.execute(
			{ action: "launch", background: true, agent: "missing-agent", task: "inspect the void" },
			{
				cwd,
				get hasUI() {
					throw new Error("Extension runtime replaced");
				},
			},
		);
		const runId = /Started background subagent run (\S+)\./.exec(result.content[0].text)?.[1];
		assert.ok(runId);

		// node:test surfaces unhandled rejections as failures, so completing this
		// test is itself the containment proof.
		await waitForTerminalRecord(harness, runId!);
		assert.equal(harness.attemptsNow, 0);
	});

	it("does not wake for the synchronous background validation failure", async () => {
		const cwd = freshAgentDir();
		const harness = makeHarness({ hasUI: true });

		const result: any = await harness.execute(
			{ action: "launch", background: true, tasks: [{ agent: "a", task: "b" }] },
			{ cwd, hasUI: true },
		);
		assert.equal(result.isError, true);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(harness.attemptsNow, 0, "sync failures ride the pending tool call; no wake");
	});

	it("bounds wake diagnostics from a noisy child", () => {
		const noisy = "x".repeat(1024 * 1024);
		const bounded = truncateDiagnostic(noisy, 300);
		assert.ok(bounded.length < 1024, `diagnostic should be bounded, got ${bounded.length}`);
		assert.ok(bounded.startsWith("x".repeat(300)));
		assert.ok(bounded.includes("[truncated"));
		assert.equal(truncateDiagnostic("short", 300), "short");
	});
});
