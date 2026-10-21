// Background status reports (#2928): authored reports from background subagent
// runs render through the same Markdown renderer as ordinary results, while
// lifecycle facts and raw diagnostics stay plain source — never reinterpreted
// as report prose. The status view must serve collapsed and expanded alike.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initTheme } from "@gsd/pi-coding-agent";

import subagentExtension from "../index.js";
import { type SubagentRunRecord, SubagentRunStore, createInitialRunRecord } from "../run-store.js";

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

const AUTHORED_REPORT = "# Survey\n\n- finding one\n- finding two\n\n```js\nconst x = 1;\n```";

function succeededChild(overrides: Record<string, unknown> = {}) {
	return {
		index: 0,
		agent: "scout",
		trackingName: "quiet-atlas",
		task: "survey the module",
		status: "succeeded",
		exitCode: 0,
		model: "glm-4.6",
		sessionFile: "/tmp/sessions/scout.json",
		output: AUTHORED_REPORT,
		...overrides,
	};
}

function makeRecord(children: unknown[], overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
	return {
		schemaVersion: 1,
		runId: "run-2928",
		mode: "single",
		contextMode: "fresh",
		status: "succeeded",
		cwd: "/repo",
		startedAt: "2026-10-20T00:00:00.000Z",
		updatedAt: "2026-10-20T00:01:00.000Z",
		children: children as SubagentRunRecord["children"],
		...overrides,
	};
}

describe("background status report rendering (#2928)", () => {
	const tool = registerSubagentTool();

	before(() => {
		initTheme();
	});

	function renderStatusCard(record: SubagentRunRecord, expanded = true): string {
		return renderComponent(
			tool.renderResult(
				{
					content: [{ type: "text", text: `Run ${record.runId}: ${record.status}` }],
					details: { mode: "single", agentScope: "both", projectAgentsDir: null, results: [], runRecord: record },
				},
				{ expanded },
				fakeTheme,
			) as { render: (width: number) => string[] },
		);
	}

	it("renders an authored completed report as markdown, separate from lifecycle facts", () => {
		const text = renderStatusCard(makeRecord([succeededChild()]));
		assert.ok(text.includes("Run run-2928: succeeded"), "run lifecycle header stays visible");
		assert.match(text, /- \[succeeded\] quiet-atlas \/ scout/, "child status bullet stays visible");
		assert.ok(text.includes("session: /tmp/sessions/scout.json"), "resume handle stays a lifecycle fact");
		assert.ok(text.includes("Survey"), "authored report heading text renders");
		assert.ok(text.includes("finding one"), "authored report list items render");
		assert.ok(text.includes("const x = 1;"), "authored report code renders");
		assert.ok(!text.includes("# Survey"), "heading marker must be consumed by the markdown renderer, not dumped raw");
		assert.doesNotMatch(text, /- \[succeeded\] quiet-atlas \/ scout: /, "lifecycle bullet must not inline the report prose");
	});

	it("keeps the authored report inspectable in the collapsed view too", () => {
		const text = renderStatusCard(makeRecord([succeededChild()]), false);
		assert.ok(text.includes("Survey"), "collapsed status view still renders the authored report");
		assert.ok(!text.includes("# Survey"), "collapsed view goes through the markdown renderer as well");
	});

	it("renders an empty or still-running report as lifecycle facts only", () => {
		const text = renderStatusCard(makeRecord([succeededChild({ status: "running", output: undefined, exitCode: undefined })], { status: "running" }));
		assert.match(text, /- \[running\] quiet-atlas \/ scout/, "running child status bullet stays visible");
		assert.ok(text.includes("survey the module"), "assignment text stands in when no report exists");
		assert.ok(!text.includes("─── Report:"), "no report section without authored output");
	});

	it("keeps raw stderr and error diagnostics as source, never inferred markdown", () => {
		const raw = "# crash log\n```\nraw stack frame\n```";
		const record = makeRecord([succeededChild({
			status: "failed",
			exitCode: 1,
			output: undefined,
			errorMessage: "Child exited 1",
			stderr: raw,
		})], { status: "failed" });
		const text = renderStatusCard(record);
		assert.ok(text.includes("# crash log"), "raw stderr keeps its literal source bytes");
		assert.ok(text.includes("```"), "raw stderr keeps fence characters as source");
		assert.ok(text.includes("Child exited 1"), "error message stays visible");
		assert.doesNotMatch(text, /quiet-atlas \/ scout: # crash log/, "diagnostics must not be inlined into the status bullet");
	});

	it("covers partial runs: interrupted child facts plus only the succeeded child's report", () => {
		const record = makeRecord(
			[
				succeededChild({ index: 0 }),
				{
					index: 1,
					agent: "reviewer",
					task: "review the diff",
					status: "interrupted",
					stopReason: "aborted",
				},
			],
			{ status: "interrupted", failure: { type: "interrupted", message: "Subagent run was interrupted" } },
		);
		const text = renderStatusCard(record);
		assert.match(text, /- \[succeeded\] quiet-atlas \/ scout/, "succeeded child fact stays");
		assert.match(text, /- \[interrupted\] reviewer/, "interrupted child fact stays");
		assert.ok(text.includes("Failure: Subagent run was interrupted"), "run failure stays a lifecycle fact");
		assert.equal([...text.matchAll(/─── Report:/g)].length, 1, "only the child with an authored report gets a report section");
	});

	it("keeps the resume handle visible for a resumed run's source record", () => {
		const text = renderStatusCard(makeRecord([succeededChild({ sessionFile: "/tmp/sessions/resumed.json" })]));
		assert.ok(text.includes("session: /tmp/sessions/resumed.json"), "sessionFile stays inspectable for resume");
	});

	it("shows the outcome diagnostic alongside a partial authored report", () => {
		const text = renderStatusCard(makeRecord([succeededChild({
			status: "failed",
			exitCode: 1,
			errorMessage: "Patch merge failed: conflict",
		})], { status: "failed" }));
		assert.ok(text.includes("Patch merge failed: conflict"), "diagnostic must not be swallowed by the report");
		assert.ok(text.includes("Survey"), "the partial authored report still renders");
	});

	it("treats whitespace-only output as no authored report", () => {
		const text = renderStatusCard(makeRecord([succeededChild({ output: "   \n  " })]));
		assert.ok(!text.includes("─── Report:"), "whitespace-only output must not open a report section");
		assert.ok(text.includes("survey the module"), "assignment text stands in instead");
	});

	it("passes the authored source to the markdown renderer unchanged", () => {
		// Leading indentation is meaningful markdown: a 4-space-indented first
		// line is a code block, and trimming it would flip `# literal` into a
		// heading (#2928 codex finding).
		const text = renderStatusCard(makeRecord([succeededChild({ output: "    # literal code" })]));
		assert.ok(text.includes("# literal code"), "indented first line stays a literal code block");
	});
});

describe("status action carries the run record to the renderer (#2928)", () => {
	const tool = registerSubagentTool();
	const savedAgentDir = process.env.GSD_CODING_AGENT_DIR;
	let dir: string | undefined;

	after(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		if (savedAgentDir === undefined) delete process.env.GSD_CODING_AGENT_DIR;
		else process.env.GSD_CODING_AGENT_DIR = savedAgentDir;
	});

	it("status returns the snapshot in details while the content text stays the model-facing dump", async () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-subagent-report-"));
		process.env.GSD_CODING_AGENT_DIR = dir;
		const record = createInitialRunRecord({
			runId: "run-wired-2928",
			mode: "single",
			contextMode: "fresh",
			cwd: dir,
			children: [{ agent: "scout", task: "survey the module" }],
		});
		record.status = "succeeded";
		record.children[0] = { ...record.children[0], status: "succeeded", exitCode: 0, output: AUTHORED_REPORT };
		new SubagentRunStore().create(record);

		const result: any = await tool.execute(
			"tool-call-1",
			{ action: "status", runId: record.runId },
			undefined,
			undefined,
			{ cwd: dir, hasUI: false },
		);
		assert.equal(result.details?.runRecord?.runId, record.runId, "details carry the run record snapshot");
		assert.ok(result.content[0].text.includes("# Survey"), "model-facing content text keeps the record dump");

		const text = renderComponent(tool.renderResult(result, { expanded: true }, fakeTheme) as { render: (width: number) => string[] });
		assert.ok(text.includes("Survey"), "the rendered card shows the authored report");
		assert.ok(!text.includes("# Survey"), "the rendered card goes through the markdown renderer");
	});
});
