// gsd-pi + Subagent usage visibility (#2821): the parallel card shows the
// latest known aggregate subtotal while children run (pending children render
// as pending usage, not fabricated zeros), and every child's reported usage is
// reconciled into the parent session's external-usage totals so the footer
// total is `parent + children` live, idempotently, failed children included.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import subagentExtension from "../index.js";
import { getActiveWorkers, resetWorkerRegistry } from "../worker-registry.js";
import { SubagentRunStore } from "../run-store.js";
import { SessionManager } from "../../../../../packages/pi-coding-agent/src/core/session-manager.ts";

const EMITS_USAGE_FIXTURE = fileURLToPath(new URL("./fixtures/emits-usage.cjs", import.meta.url));

const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function registerSubagentTool() {
	let tool: any;
	subagentExtension({
		on: () => {},
		registerCommand: () => {},
		registerTool: (definition: any) => {
			tool = definition;
		},
		sendMessage: () => Promise.resolve(),
	} as any);
	assert.ok(tool, "subagent tool was not registered");
	return tool;
}

function zeroUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function parallelDetails(results: unknown[]) {
	return { mode: "parallel", agentScope: "both", projectAgentsDir: null, results };
}

function renderCard(tool: any, result: unknown, expanded = false): string {
	const rendered = tool.renderResult(result, { expanded }, fakeTheme) as { render: (width: number) => string[] };
	return rendered.render(400).join("\n");
}

describe("subagent parallel card usage subtotal", () => {
	const tool = registerSubagentTool();

	it("shows the reported subtotal and pending count while children run", () => {
		const text = renderCard(tool, {
			content: [{ type: "text", text: "Parallel: 0/2 done, 2 running..." }],
			details: parallelDetails([
				{
					agent: "researcher",
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.5, contextTokens: 0, turns: 2 },
				},
				{ agent: "implementer", exitCode: -1, messages: [], stderr: "", usage: zeroUsage() },
			]),
		});

		assert.match(text, /running/);
		assert.match(text, /Total: .*\$0\.5000/);
		assert.match(text, /1 pending usage/);
	});

	it("renders all-unreported children as pending usage instead of a fabricated zero", () => {
		const text = renderCard(tool, {
			content: [{ type: "text", text: "Parallel: 0/2 done, 2 running..." }],
			details: parallelDetails([
				{ agent: "a", exitCode: -1, messages: [], stderr: "", usage: zeroUsage() },
				{ agent: "b", exitCode: -1, messages: [], stderr: "", usage: zeroUsage() },
			]),
		});

		assert.match(text, /Total: 2 pending usage/);
	});

	it("keeps the completed-card total free of pending suffixes", () => {
		const text = renderCard(tool, {
			content: [{ type: "text", text: "Parallel: 2/2 succeeded" }],
			details: parallelDetails([
				{
					agent: "a",
					exitCode: 0,
					messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
					stderr: "",
					usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.25, contextTokens: 0, turns: 3 },
				},
				{
					agent: "b",
					exitCode: 1,
					messages: [],
					stderr: "boom",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.05, contextTokens: 0, turns: 1 },
				},
			]),
		});

		// The failed child's billable usage stays in the aggregate.
		assert.match(text, /Total: .*\$0\.3000/);
		assert.doesNotMatch(text, /pending usage/);
	});
});

describe("subagent parallel card per-child cost (#2822)", () => {
	const tool = registerSubagentTool();

	it("shows each child's own cost on its collapsed row, not only the aggregate", () => {
		const text = renderCard(tool, {
			content: [{ type: "text", text: "Parallel: 2/2 succeeded" }],
			details: parallelDetails([
				{
					agent: "a",
					exitCode: 0,
					messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
					stderr: "",
					startedAt: 1_000_000,
					completedAt: 1_101_000,
					usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.25, contextTokens: 0, turns: 3 },
				},
				{
					agent: "b",
					exitCode: 1,
					messages: [],
					stderr: "boom",
					startedAt: 1_000_000,
					completedAt: 1_087_000,
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.05, contextTokens: 0, turns: 1 },
				},
			]),
		});

		// Both distinct per-child costs appear on the child rows (the
		// aggregate Total is $0.3000 — neither per-child value), each riding
		// the same dim line as the child's identity.
		assert.match(text, /1m 41s · \$0\.2500/);
		assert.match(text, /failed after 1m 27s · \$0\.0500/);
		assert.match(text, /Total: .*\$0\.3000/);
	});

	it("keeps live per-child cost visible while the batch runs", () => {
		const text = renderCard(tool, {
			content: [{ type: "text", text: "Parallel: 0/2 done, 2 running..." }],
			details: parallelDetails([
				{
					agent: "researcher",
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.5, contextTokens: 0, turns: 2 },
				},
				{
					agent: "implementer",
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.2, contextTokens: 0, turns: 1 },
				},
			]),
		});

		// Each reported child's cost shows on its own row while running; the
		// aggregate is the sum, so both row values differ from the Total.
		assert.match(text, /\$0\.5000/);
		assert.match(text, /\$0\.2000/);
		assert.match(text, /Total: .*\$0\.7000/);

		// A child without a first provider report shows no cost token of its
		// own (it is still counted as pending usage at the batch level).
		const pendingOnly = renderCard(tool, {
			content: [{ type: "text", text: "Parallel: 0/1 done, 1 running..." }],
			details: parallelDetails([{ agent: "a", exitCode: -1, messages: [], stderr: "", usage: zeroUsage() }]),
		});
		assert.doesNotMatch(pendingOnly, /\$\d/);
	});

	it("omits the cost token for non-usable cost values without breaking the row", () => {
		const text = renderCard(tool, {
			content: [{ type: "text", text: "Parallel: 1/1 succeeded" }],
			details: parallelDetails([
				{
					agent: "a",
					exitCode: 0,
					messages: [],
					stderr: "",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: Number.NaN, contextTokens: 0, turns: 1 },
				},
			]),
		});

		assert.doesNotMatch(text, /\$NaN/);
		assert.doesNotMatch(text, /\$\d/);
		assert.match(text, /─── a/);
	});
});

describe("subagent usage reconciliation into the parent session", () => {
	const savedAgentDir = process.env.GSD_CODING_AGENT_DIR;
	const savedBinPath = process.env.GSD_BIN_PATH;
	const savedExitCode = process.env.FIXTURE_EXIT_CODE;
	const savedFailOnceDir = process.env.FIXTURE_FAIL_ONCE_DIR;
	const savedModelSequence = process.env.FIXTURE_MODEL_SEQUENCE;
	const savedTurnModels = process.env.FIXTURE_TURN_MODELS;
	const savedSkipSuccessEvents = process.env.FIXTURE_SKIP_SUCCESS_EVENTS;
	let dir: string | undefined;

	afterEach(() => {
		resetWorkerRegistry();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		if (savedAgentDir === undefined) delete process.env.GSD_CODING_AGENT_DIR;
		else process.env.GSD_CODING_AGENT_DIR = savedAgentDir;
		if (savedBinPath === undefined) delete process.env.GSD_BIN_PATH;
		else process.env.GSD_BIN_PATH = savedBinPath;
		if (savedExitCode === undefined) delete process.env.FIXTURE_EXIT_CODE;
		else process.env.FIXTURE_EXIT_CODE = savedExitCode;
		if (savedFailOnceDir === undefined) delete process.env.FIXTURE_FAIL_ONCE_DIR;
		else process.env.FIXTURE_FAIL_ONCE_DIR = savedFailOnceDir;
		if (savedModelSequence === undefined) delete process.env.FIXTURE_MODEL_SEQUENCE;
		else process.env.FIXTURE_MODEL_SEQUENCE = savedModelSequence;
		if (savedTurnModels === undefined) delete process.env.FIXTURE_TURN_MODELS;
		else process.env.FIXTURE_TURN_MODELS = savedTurnModels;
		if (savedSkipSuccessEvents === undefined) delete process.env.FIXTURE_SKIP_SUCCESS_EVENTS;
		else process.env.FIXTURE_SKIP_SUCCESS_EVENTS = savedSkipSuccessEvents;
	});

	function freshEnv(): string {
		dir = mkdtempSync(join(tmpdir(), "gsd-subagent-usage-"));
		process.env.GSD_CODING_AGENT_DIR = dir;
		process.env.GSD_BIN_PATH = EMITS_USAGE_FIXTURE;
		mkdirSync(join(dir, ".gsd", "agents"), { recursive: true });
		writeFileSync(
			join(dir, ".gsd", "agents", "usage-emitter.md"),
			"---\nname: usage-emitter\ndescription: emits usage events then exits\n---\n",
		);
		return dir;
	}

	function makeExecute(sessionManager: unknown, onUpdate?: (partial: any) => void) {
		let tool: any;
		subagentExtension({
			on: () => {},
			registerCommand: () => {},
			registerTool: (definition: any) => {
				tool = definition;
			},
			sendMessage: () => Promise.resolve(),
		} as any);
		assert.ok(tool, "subagent tool was not registered");
		return (params: Record<string, unknown>) =>
			tool.execute("tool-call-1", params, undefined, onUpdate, {
				cwd: process.env.GSD_CODING_AGENT_DIR!,
				hasUI: false,
				sessionManager,
			});
	}

	it("reconciles a child's cumulative per-turn usage into the session totals", async () => {
		const cwd = freshEnv();
		const session = SessionManager.inMemory(cwd);
		const execute = makeExecute(session);

		// Fixture reports turn 1 (cost 0.01) then turn 2 (cost 0.02) — the
		// cumulative snapshots reconcile to the 0.03 sum, once.
		await execute({ agent: "usage-emitter", task: "report usage" });

		const totals = session.getUsageTotals({ includeExternalUsage: true });
		assert.equal(totals.cost, 0.03);
		assert.equal(totals.input, 200);
		assert.equal(totals.output, 100);
	});

	it("keeps a failed child's reported usage in the session totals", async () => {
		const cwd = freshEnv();
		process.env.FIXTURE_EXIT_CODE = "1";
		const session = SessionManager.inMemory(cwd);
		const execute = makeExecute(session);

		const result = await execute({ agent: "usage-emitter", task: "fail after reporting" });

		assert.equal(result.details.results[0].exitCode, 1);
		assert.equal(session.getUsageTotals({ includeExternalUsage: true }).cost, 0.03);
	});

	it("parallel retry bills both attempts: session total and card agree", async () => {
		const cwd = freshEnv();
		const failOnceDir = join(cwd, "fail-once");
		mkdirSync(failOnceDir, { recursive: true });
		process.env.FIXTURE_FAIL_ONCE_DIR = failOnceDir;
		const session = SessionManager.inMemory(cwd);
		const execute = makeExecute(session);

		// Attempt 1 reports $0.03 then fails; the auto-retry reports $0.03 and
		// succeeds. Both attempts are banked (distinct child keys), and the
		// final card details carry the merged slot total instead of dropping
		// the failed attempt.
		const result = await execute({
			tasks: [{ agent: "usage-emitter", task: "fail once then succeed" }],
		});

		const slotUsage = result.details.results[0].usage;
		assert.equal(slotUsage.cost, 0.06);
		assert.equal(slotUsage.turns, 4);
		assert.equal(result.details.results[0].exitCode, 0);
		const totals = session.getUsageTotals({ includeExternalUsage: true });
		assert.equal(totals.cost, 0.06);
	});

	it("does not leak child usage into a session without a sink", async () => {
		const cwd = freshEnv();
		const execute = makeExecute(undefined);

		const result = await execute({ agent: "usage-emitter", task: "no parent session manager" });

		assert.equal(result.details.results[0].exitCode, 0);
	});

	it("shows a differing provider-reported model without replacing the requested model", async () => {
		const cwd = freshEnv();
		const liveIdentities: Array<{ model?: string; reportedModel?: string }> = [];
		const tool = registerSubagentTool();
		const execute = makeExecute(SessionManager.inMemory(cwd), (partial) => {
			const result = partial.details?.results[0];
			if (result) {
				liveIdentities.push({
					model: result.model,
					reportedModel: result.reportedModel,
				});
			}
		});

		const result = await execute({
			tasks: [{ agent: "usage-emitter", task: "report model", model: "requested-model" }],
		});

		assert.equal(result.details.results[0].model, "requested-model");
		assert.equal(result.details.results[0].reportedModel, "test-model");
		assert.match(renderCard(tool, result), /requested-model ← test-model/);
		assert.match(
			renderCard(tool, { ...result, details: { ...result.details, mode: "single" } }),
			/requested-model ← test-model/,
		);
		assert.match(
			renderCard(tool, {
				...result,
				details: {
					...result.details,
					mode: "chain",
					results: [{ ...result.details.results[0], step: 1 }],
				},
			}),
			/requested-model ← test-model/,
		);
		assert.ok(
			liveIdentities.some(
				(identity) => identity.model === "requested-model" && identity.reportedModel === "test-model",
			),
			"streaming result should expose requested and provider-reported identities",
		);
		const worker = getActiveWorkers().find((entry) => entry.task === "report model");
		assert.equal(worker?.model, "requested-model");
		assert.equal(worker?.reportedModel, "test-model");
		const storedRun = new SubagentRunStore().list().find((record) =>
			record.children.some((child) => child.task === "report model")
		);
		assert.equal(storedRun?.children[0]?.model, "requested-model");
		assert.equal(storedRun?.children[0]?.reportedModel, "test-model");
		const statusResult = await execute({ action: "status", runId: storedRun?.runId });
		assert.match(statusResult.content[0].text, /model: requested-model ← test-model/);

		const matchingResult = await execute({
			agent: "usage-emitter",
			task: "report matching model",
			model: "test-model",
		});
		assert.equal(matchingResult.details.results[0].model, "test-model");
		assert.equal(matchingResult.details.results[0].reportedModel, undefined);
	});

	it("clears a fallback identity when a later turn returns to the requested model", async () => {
		const cwd = freshEnv();
		process.env.FIXTURE_TURN_MODELS = "fallback-model|requested-model";
		const tool = registerSubagentTool();
		const execute = makeExecute(SessionManager.inMemory(cwd));

		const result = await execute({
			tasks: [{ agent: "usage-emitter", task: "return to requested model", model: "requested-model" }],
		});

		assert.equal(result.details.results[0].reportedModel, undefined);
		assert.doesNotMatch(renderCard(tool, result), /←/);
		const storedRun = new SubagentRunStore().list().find((record) =>
			record.children.some((child) => child.task === "return to requested model")
		);
		assert.equal(storedRun?.children[0]?.reportedModel, undefined);
		const statusResult = await execute({ action: "status", runId: storedRun?.runId });
		assert.doesNotMatch(statusResult.content[0].text, /←/);
	});

	it("clears a failed attempt's provider model when a retry emits no events", async () => {
		const cwd = freshEnv();
		const failOnceDir = join(cwd, "model-retry");
		mkdirSync(failOnceDir, { recursive: true });
		process.env.FIXTURE_FAIL_ONCE_DIR = failOnceDir;
		process.env.FIXTURE_MODEL_SEQUENCE = "fallback-model,requested-model";
		process.env.FIXTURE_SKIP_SUCCESS_EVENTS = "1";
		const execute = makeExecute(SessionManager.inMemory(cwd));

		const result = await execute({
			tasks: [{ agent: "usage-emitter", task: "retry model", model: "requested-model" }],
		});

		assert.equal(result.details.results[0].model, "requested-model");
		assert.equal(result.details.results[0].reportedModel, undefined);
		const worker = getActiveWorkers().find((entry) => entry.task === "retry model");
		assert.equal(worker?.model, "requested-model");
		assert.equal(worker?.reportedModel, undefined);
	});
});

describe("subagent chain card identity state (#2396)", () => {
	const tool = registerSubagentTool();

	function chainCard(expanded: boolean): string {
		// `chainUpdate` streams the active step with exitCode -1 alongside the
		// settled ones, so the card must not call a running step failed.
		return renderCard(
			tool,
			{
				content: [{ type: "text", text: "Chain: step 2 running..." }],
				details: {
					mode: "chain",
					agentScope: "both",
					projectAgentsDir: null,
					results: [
						{
							agent: "a",
							step: 1,
							task: "first",
							exitCode: 0,
							messages: [],
							stderr: "",
							usage: zeroUsage(),
							model: "requested-model",
							startedAt: 1000,
							completedAt: 4000,
						},
						{
							agent: "b",
							step: 2,
							task: "second",
							exitCode: -1,
							messages: [],
							stderr: "",
							usage: zeroUsage(),
							model: "requested-model",
							startedAt: 4000,
						},
					],
				},
			},
			expanded,
		);
	}

	for (const expanded of [false, true]) {
		it(`labels a streaming step running, not failed (${expanded ? "expanded" : "collapsed"})`, () => {
			const text = chainCard(expanded);
			assert.match(text, /running/);
			assert.doesNotMatch(text, /failed after/);
		});
	}
});
