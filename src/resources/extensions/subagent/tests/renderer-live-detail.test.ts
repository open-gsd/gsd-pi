// Subagent live-inspection boundaries (#2834): Ctrl+O must expose the complete
// untruncated assignment for every child — in the tool call summary and in the
// parallel detail container — while the batch is still running, with the live
// activity tail inside the expanded container. The collapsed overview stays
// compact per the batch-overview contract.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import subagentExtension from "../index.js";

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

function renderComponent(component: { render: (width: number) => string[] }): string {
	return component.render(400).join("\n");
}

function parallelDetails(results: unknown[]) {
	return { mode: "parallel", agentScope: "both", projectAgentsDir: null, results };
}

const LONG_TASK =
	"review the full bot-review-gate module from line 500 to 649 and report every regression you find";

describe("subagent tool call summary full task display (#2834)", () => {
	const tool = registerSubagentTool();

	it("lists every parallel task untruncated when expanded", () => {
		const args = {
			tasks: [
				{ agent: "scout", task: LONG_TASK },
				{ agent: "researcher", task: "short one" },
				{ agent: "reviewer", task: "third task" },
				{ agent: "implementer", task: "fourth task" },
			],
		};

		const text = renderComponent(tool.renderCall(args, fakeTheme, { expanded: true }));
		assert.ok(text.includes(LONG_TASK), "expanded call summary must show the full task text");
		for (const agent of ["scout", "researcher", "reviewer", "implementer"]) {
			assert.ok(text.includes(agent), `expanded call summary must list ${agent}`);
		}
		assert.doesNotMatch(text, /\+\d+ more/);
	});

	it("keeps the collapsed parallel summary compact (three entries, 40-char preview)", () => {
		const args = {
			tasks: [
				{ agent: "scout", task: LONG_TASK },
				{ agent: "researcher", task: "short one" },
				{ agent: "reviewer", task: "third task" },
				{ agent: "implementer", task: "fourth task" },
			],
		};

		const text = renderComponent(tool.renderCall(args, fakeTheme, { expanded: false }));
		assert.ok(!text.includes(LONG_TASK), "collapsed summary must not dump the full task");
		assert.ok(text.includes(`${LONG_TASK.slice(0, 40)}...`), "collapsed summary keeps the 40-char preview");
		assert.ok(text.includes("scout"));
		assert.ok(!text.includes("implementer"), "collapsed summary lists only the first three entries");
		assert.match(text, /\+1 more/);
	});

	it("lists every chain step untruncated when expanded and cleans {previous}", () => {
		const args = {
			chain: Array.from({ length: 5 }, (_, i) => ({
				agent: `step-${i}-agent`,
				task: i === 0 ? LONG_TASK : `{previous} then refine step ${i} with the complete untruncated instructions`,
			})),
		};

		const text = renderComponent(tool.renderCall(args, fakeTheme, { expanded: true }));
		assert.ok(text.includes(LONG_TASK));
		assert.ok(!text.includes("{previous}"), "{previous} placeholder stays cleaned when expanded");
		assert.ok(!text.includes("+2 more"));
		for (let i = 1; i <= 5; i++) {
			assert.ok(text.includes(`${i}.`), `expanded chain summary must list step ${i}`);
		}

		const collapsed = renderComponent(tool.renderCall(args, fakeTheme, { expanded: false }));
		assert.match(collapsed, /\+2 more/);
		assert.ok(!collapsed.includes("4."), "collapsed chain summary lists only the first three steps");
	});

	it("renders partially streamed chain args without throwing when expanded", () => {
		const args = {
			chain: [
				{ agent: "a", task: "complete step with the full untruncated instructions" },
				{ agent: "b", task: "second complete step with instructions" },
				{ agent: "c", task: "third complete step with instructions" },
				{ agent: "d" }, // still streaming: no task yet
			],
		};

		const text = renderComponent(tool.renderCall(args, fakeTheme, { expanded: true }));
		assert.ok(text.includes("d"), "the streaming entry still lists its agent");
		assert.ok(!text.includes("undefined"));
	});

	it("parallel entries without a task render without a literal undefined", () => {
		const args = {
			tasks: [{ agent: "scout" }, { agent: "researcher", task: "present task" }],
		};

		const text = renderComponent(tool.renderCall(args, fakeTheme, { expanded: true }));
		assert.ok(!text.includes("undefined"));
		assert.ok(text.includes("present task"));
	});

	it("a chain task of only {previous} keeps its raw text instead of going blank", () => {
		const args = { chain: [{ agent: "polish", task: "{previous}" }] };

		const text = renderComponent(tool.renderCall(args, fakeTheme, { expanded: true }));
		assert.ok(text.includes("{previous}"), "all-placeholder tasks fall back to the raw text");
	});
});

describe("parallel detail container while running (#2834)", () => {
	const tool = registerSubagentTool();

	const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });

	const runningChild = {
		agent: "scout",
		trackingName: "quiet-atlas",
		agentSource: "project",
		task: LONG_TASK,
		exitCode: -1,
		running: true,
		startedAt: Date.now() - 61_000,
		model: "glm-4.6",
		messages: [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", name: "read", arguments: { file_path: "/repo/bot-review-gate.mjs", offset: 500, limit: 150 } },
				],
			},
		],
		stderr: "",
		usage: { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 0, turns: 1 },
	};

	const doneChild = {
		agent: "researcher",
		agentSource: "project",
		task: "search the official docs",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "the docs confirm the contract" }] }],
		stderr: "",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 },
	};

	function renderCard(results: unknown[], expanded: boolean): string {
		const rendered = tool.renderResult(
			{
				content: [{ type: "text", text: "Parallel: 1/2 done, 1 running..." }],
				details: parallelDetails(results),
			},
			{ expanded },
			fakeTheme,
		) as { render: (width: number) => string[] };
		return renderComponent(rendered);
	}

	it("exposes the full task and live activity before batch completion", () => {
		const text = renderCard([runningChild], true);
		assert.ok(text.includes(LONG_TASK), "expanded running detail must show the full task text");
		assert.match(text, /bot-review-gate\.mjs/, "expanded running detail must show live child activity");
		assert.match(text, /running/, "running child identity stays visible");
	});

	it("keeps the collapsed running overview compact with the expand hint", () => {
		const text = renderCard([runningChild], false);
		assert.ok(!text.includes(LONG_TASK), "collapsed overview must not dump the full task");
		assert.match(text, /Ctrl\+O to expand/);
		assert.match(text, /bot-review-gate\.mjs/, "collapsed overview still shows the activity tail");
	});

	it("mixed batch: done child keeps final output, running child stays live", () => {
		const text = renderCard([doneChild, runningChild], true);
		assert.ok(text.includes("the docs confirm the contract"), "done child final output stays in the container");
		assert.ok(text.includes(LONG_TASK), "running child task shows in full");
		assert.match(text, /bot-review-gate\.mjs/, "running child activity stays live");
		assert.doesNotMatch(text, /pending usage/, "every child reported usage, so no pending suffix");
	});

	it("running subtotal keeps the pending-usage suffix inside the container", () => {
		const pending = { ...runningChild, usage: zeroUsage(), model: undefined };
		const text = renderCard([pending], true);
		assert.match(text, /pending usage/);
	});

	it("a running child with no output yet renders a quiet placeholder, not an empty detail", () => {
		const quiet = { ...runningChild, messages: [] };
		const text = renderCard([quiet], true);
		assert.match(text, /\(running\.\.\.\)/);
		assert.ok(text.includes(LONG_TASK), "full task text still renders with no activity yet");
	});
});

describe("single-child renderer running state (#3044)", () => {
	const tool = registerSubagentTool();

	const usage = { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 0, turns: 1 };

	function renderCard(result: unknown, expanded: boolean): string {
		const rendered = tool.renderResult(
			{
				content: [{ type: "text", text: "(running...)" }],
				details: { mode: "single", agentScope: "both", projectAgentsDir: null, results: [result] },
			},
			{ expanded },
			fakeTheme,
		) as { render: (width: number) => string[] };
		return renderComponent(rendered);
	}

	it("renders a running child with stopReason toolUse as in progress, not failed", () => {
		const running = {
			agent: "reviewer",
			agentSource: "project",
			task: "review the module",
			exitCode: -1,
			running: true,
			stopReason: "toolUse",
			startedAt: Date.now() - 5_000,
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: { file_path: "/repo/mod.mjs" } }],
				},
			],
			stderr: "",
			usage,
		};
		for (const expanded of [false, true]) {
			const text = renderCard(running, expanded);
			assert.match(text, /⏳/, "running child shows the in-progress mark");
			assert.doesNotMatch(text, /✗/, "running child must not render the failure mark");
			assert.doesNotMatch(text, /\[toolUse\]/, "a normal tool-call stop reason is not an error suffix");
			assert.doesNotMatch(text, /Error:/, "running child shows no error line");
		}
	});

	it("terminal success still renders ✓", () => {
		const done = {
			agent: "reviewer",
			agentSource: "project",
			task: "review the module",
			exitCode: 0,
			running: false,
			stopReason: "stop",
			messages: [{ role: "assistant", content: [{ type: "text", text: "all clear" }] }],
			stderr: "",
			usage,
		};
		const text = renderCard(done, false);
		assert.match(text, /✓/);
		assert.doesNotMatch(text, /✗/);
		assert.doesNotMatch(text, /⏳/);
	});

	it("terminal failure still renders ✗ with the stop reason suffix", () => {
		const failed = {
			agent: "reviewer",
			agentSource: "project",
			task: "review the module",
			exitCode: 1,
			running: false,
			stopReason: "error",
			errorMessage: "child crashed",
			messages: [],
			stderr: "boom",
			usage,
		};
		const text = renderCard(failed, false);
		assert.match(text, /✗/);
		assert.match(text, /\[error\]/);
		assert.match(text, /Error: child crashed/);
		assert.doesNotMatch(text, /⏳/);
	});
});
