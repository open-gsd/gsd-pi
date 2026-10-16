// gsd-pi + cmux-split stdout tailing (#2835): the wrapper pipeline tees child
// stdout to a file, and the parent tails it while the child runs so activity
// and provider usage reach the parent before completion. Consumed bytes are
// tracked by offset, so the completion drain processes only the unconsumed
// tail — every record is processed exactly once.

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { runSingleAgentInCmuxSplit } from "../index.js";
import type { AgentConfig } from "../agents.js";
import type { CmuxClient } from "../../cmux/index.js";

function makeAgent(dir: string): AgentConfig {
	return {
		name: "cmux-agent",
		description: "drives the cmux stdout-tail tests",
		systemPrompt: "",
		source: "project",
		filePath: join(dir, ".gsd", "agents", "cmux-agent.md"),
	};
}

interface BankedSnapshot {
	key: string;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

interface ObservedUpdate {
	messageCount: number;
	totalInput: number;
}

interface ScenarioPaths {
	pidPath: string;
	stdoutPath: string;
	exitPath: string;
}

interface ScenarioResult {
	result: { exitCode: number; messages: unknown[]; usage: { input: number } };
	paths: ScenarioPaths;
	banked: BankedSnapshot[];
	updates: ObservedUpdate[];
}

/**
 * Drive the cmux dispatch with a fake surface whose `sendSurface` launches a
 * concurrent `simulate` continuation: `simulate` receives the launched script
 * and its paths, appends to the teed stdout file at chosen points, and its
 * failure is rethrown after the dispatch settles (fail loud, never a hang).
 * sendSurface itself resolves immediately so the dispatch's tailer starts
 * while the simulated child is still running.
 */
async function runTailScenario(
	dir: string,
	simulate: (paths: ScenarioPaths, observers: { updates: ObservedUpdate[]; banked: BankedSnapshot[] }) => Promise<void>,
): Promise<ScenarioResult> {
	process.env.GSD_BIN_PATH = join(dir, "never-executed-bin");
	const banked: BankedSnapshot[] = [];
	const updates: ObservedUpdate[] = [];
	let paths: ScenarioPaths | undefined;
	let simulateError: unknown;
	const client = {
		createSplit: async () => "surface-under-test",
		sendSurface: async (_surfaceId: string, command: string) => {
			paths = {
				pidPath: pidPathFromScript(command),
				stdoutPath: stdoutPathFromScript(command),
				exitPath: exitPathFor(pidPathFromScript(command)),
			};
			void simulate(paths, { updates, banked }).catch((err) => {
				simulateError = err;
			});
			return true;
		},
		sendInterrupt: async () => {},
	} as unknown as CmuxClient;
	const result = await runSingleAgentInCmuxSplit(
		client,
		"right",
		dir,
		[makeAgent(dir)],
		"cmux-agent",
		"stream while running",
		undefined,
		undefined,
		AbortSignal.timeout(10_000),
		(partial) => {
			const first = (partial.details as { results: { messages: unknown[]; usage: { input: number } }[] }).results[0];
			updates.push({ messageCount: first.messages.length, totalInput: first.usage.input });
		},
		(results) => ({ mode: "single", agentScope: "both" as const, projectAgentsDir: null, results }),
		{
			contextMode: "fresh",
			parentSessionManager: {
				addExternalUsage: (key: string, usage: BankedSnapshot["usage"]) => {
					banked.push({ key, usage });
				},
			},
		} as never,
	);
	if (simulateError) throw simulateError;
	return { result, paths: paths!, banked, updates };
}

/** The inner script publishes its wrapper pid first: `printf '%s' "$$" > '<path>'; cd ...`. */
function pidPathFromScript(script: string): string {
	const match = script.match(/ > '\\''([^']*)'\\''; cd /);
	assert.ok(match, `wrapper script must publish its pid, got: ${script}`);
	return match[1]!;
}

/** The piped tee target: `... | tee '<stdoutPath>'`. */
function stdoutPathFromScript(script: string): string {
	const match = script.match(/\| tee '\\''([^']*)'\\''/);
	assert.ok(match, `wrapper script must tee stdout, got: ${script}`);
	return match[1]!;
}

function exitPathFor(pidPath: string): string {
	return join(pidPath, "..", "exit.code");
}

/** Publish a live wrapper pid so the exit wait never takes the death path. */
function publishLiveWrapperPid(paths: ScenarioPaths): void {
	writeFileSync(paths.pidPath, String(process.pid), "utf-8");
}

/** An assistant message_end event whose usage the child reports for one turn. */
function assistantEvent(text: string, input: number): string {
	return `${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 }, totalTokens: input + 100 },
		},
	})}\n`;
}

async function waitForUpdate(updates: ObservedUpdate[], atLeast: number): Promise<void> {
	const started = Date.now();
	while (updates.length < atLeast) {
		if (Date.now() - started > 10_000) {
			assert.fail(`no live update arrived within 10s (got ${updates.length})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("cmux-split stdout tailing", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		delete process.env.GSD_BIN_PATH;
	});

	it("streams activity and usage to the parent before the child completes", async () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-cmux-tail-"));
		const { result, banked, updates } = await runTailScenario(dir, async (paths, { updates, banked }) => {
			// Live child: publish the pid, emit one billable turn, and only
			// complete after the parent has seen it. Pre-fix nothing can
			// observe the event before completion — the teed file is parsed
			// only once the exit file exists.
			publishLiveWrapperPid(paths);
			appendFileSync(paths.stdoutPath, assistantEvent("turn one", 100), "utf-8");
			await waitForUpdate(updates, 1);
			assert.equal(updates[0]!.messageCount, 1);
			assert.equal(updates[0]!.totalInput, 100);
			assert.ok(banked.length > 0, "live usage is reconciled into the parent session before completion");
			writeFileSync(paths.exitPath, "0", "utf-8");
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.messages.length, 1, "the event lands exactly once across tail and drain");
		assert.equal(result.usage.input, 100);
		assert.equal(updates[0]!.totalInput, 100);
		assert.equal(Math.max(...banked.map((s) => s.usage.input)), 100, "reconciled snapshots never exceed the real cumulative usage");
	});

	it("buffers a record split across writes and never loses or duplicates it", async () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-cmux-tail-"));
		const { result, banked } = await runTailScenario(dir, async (paths, { updates }) => {
			publishLiveWrapperPid(paths);
			const event = assistantEvent("split turn", 40);
			const splitAt = Math.floor(event.length / 2);
			appendFileSync(paths.stdoutPath, event.slice(0, splitAt), "utf-8");
			// Let a tail tick observe the partial record before the rest lands.
			await new Promise((resolve) => setTimeout(resolve, 400));
			appendFileSync(paths.stdoutPath, event.slice(splitAt) + assistantEvent("whole turn", 60), "utf-8");
			await waitForUpdate(updates, 2);
			writeFileSync(paths.exitPath, "0", "utf-8");
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.messages.length, 2, "the split record and the whole record both survive");
		assert.equal(result.usage.input, 100, "split-record usage is counted once, not doubled");
		assert.equal(Math.max(...banked.map((s) => s.usage.input)), 100);
	});

	it("drains a trailing record buffered by a poll exactly once", async () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-cmux-tail-"));
		const { result, banked } = await runTailScenario(dir, async (paths, { updates }) => {
			publishLiveWrapperPid(paths);
			// The complete record streams live; the unterminated one lands in
			// the tailer's partial buffer during polling. The completion drain
			// must flush it even though no new bytes arrive afterwards.
			appendFileSync(paths.stdoutPath, assistantEvent("complete turn", 30), "utf-8");
			appendFileSync(paths.stdoutPath, assistantEvent("trailing turn", 50).trimEnd(), "utf-8");
			await waitForUpdate(updates, 1);
			writeFileSync(paths.exitPath, "0", "utf-8");
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.messages.length, 2, "the buffered unterminated record is flushed by the drain");
		assert.equal(result.usage.input, 80);
		assert.equal(Math.max(...banked.map((s) => s.usage.input)), 80);
	});

	it("reassembles a record whose multi-byte UTF-8 character is split across writes", async () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-cmux-tail-"));
		const { result } = await runTailScenario(dir, async (paths, { updates }) => {
			publishLiveWrapperPid(paths);
			const bytes = Buffer.from(assistantEvent("emoji \u2705 turn", 40), "utf-8");
			// Split two bytes into the multi-byte character \u2014 a naive string-chunk
			// tailer would corrupt the record; the raw-byte buffer must not.
			const splitAt = bytes.indexOf(Buffer.from("\u2705", "utf-8")) + 2;
			appendFileSync(paths.stdoutPath, bytes.subarray(0, splitAt));
			// Let a tail tick observe and buffer the partial bytes.
			await new Promise((resolve) => setTimeout(resolve, 400));
			appendFileSync(paths.stdoutPath, bytes.subarray(splitAt));
			await waitForUpdate(updates, 1);
			writeFileSync(paths.exitPath, "0", "utf-8");
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.messages.length, 1);
		const text = (result.messages[0] as { content: { type: string; text: string }[] }).content[0]!.text;
		assert.equal(text, "emoji \u2705 turn", "the split code point decodes intact");
		assert.equal(result.usage.input, 40);
	});

	it("retains usage a failed child already reported", async () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-cmux-tail-"));
		const { result, banked } = await runTailScenario(dir, async (paths, { updates }) => {
			publishLiveWrapperPid(paths);
			appendFileSync(paths.stdoutPath, assistantEvent("billable turn", 70), "utf-8");
			// The usage is observed live before the child fails, so retention
			// is proven across live polling and a failed exit.
			await waitForUpdate(updates, 1);
			writeFileSync(paths.exitPath, "1", "utf-8");
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.usage.input, 70, "reported usage survives a failed exit");
		assert.equal(Math.max(...banked.map((s) => s.usage.input)), 70);
	});
});
