// gsd-pi — subagent tool-contract tests: model-facing disclosures (#2759).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import subagentExtension from "../index.js";

interface RegisteredTool {
	name: string;
	description: string;
	parameters: {
		properties: Record<string, { description?: string } | undefined>;
	};
}

interface ContractHarness {
	sendAttempts: { count: number };
	execute: (params: Record<string, unknown>, cwd: string) => Promise<any>;
	runStoreDir: string;
}

function registerSubagentTool(): RegisteredTool {
	let tool: RegisteredTool | undefined;
	subagentExtension({
		on: () => {},
		registerCommand: () => {},
		registerTool: (definition: any) => {
			tool = definition;
		},
		sendMessage: () => Promise.resolve(),
	} as any);
	assert.ok(tool, "subagent tool was not registered");
	return tool!;
}

function makeContractHarness(): ContractHarness {
	const sendAttempts = { count: 0 };
	let tool: { execute: (...args: any[]) => Promise<unknown> } | undefined;
	subagentExtension({
		on: () => {},
		registerCommand: () => {},
		registerTool: (definition: any) => {
			tool = definition;
		},
		sendMessage: () => {
			sendAttempts.count++;
			return Promise.resolve();
		},
	} as any);
	assert.ok(tool, "subagent tool was not registered");
	// hasUI: true so a wrongly launched child would eventually wake the session —
	// the zero-wake assertion below is only meaningful with wake delivery enabled.
	return {
		sendAttempts,
		execute: (params, cwd) =>
			tool!.execute("tool-call-1", params, undefined, undefined, { cwd, hasUI: true }),
		runStoreDir: join(process.env.GSD_CODING_AGENT_DIR!, "subagent-runs"),
	};
}

describe("subagent tool contract disclosure", () => {
	const savedAgentDir = process.env.GSD_CODING_AGENT_DIR;
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		if (savedAgentDir === undefined) delete process.env.GSD_CODING_AGENT_DIR;
		else process.env.GSD_CODING_AGENT_DIR = savedAgentDir;
	});

	function freshAgentDir(): string {
		dir = mkdtempSync(join(tmpdir(), "gsd-subagent-contract-"));
		// A real fixture agent: a guard regression that ignored tasks/chain would
		// actually launch this agent instead of rejecting, so the assertions below
		// discriminate the contract rather than an agent-lookup failure.
		const agentsDir = join(dir, ".gsd", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "contract-fixture.md"),
			"---\nname: contract-fixture\ndescription: Fixture agent for tool-contract tests\n---\nFixture body.\n",
		);
		process.env.GSD_CODING_AGENT_DIR = dir;
		return dir;
	}

	it("discloses background support for every valid dispatch mode (#2820)", () => {
		const tool = registerSubagentTool();
		const background = tool.parameters.properties.background?.description ?? "";
		assert.match(background, /single \(\{ agent, task \}\)/, "background description must name single mode");
		assert.match(background, /parallel \(\{ tasks \}\)/, "background description must name parallel mode");
		assert.match(background, /chain \(\{ chain \}\)/, "background description must name chain mode");
		assert.match(tool.description, /background/i, "tool description must mention background");
		assert.match(
			tool.description,
			/parallel \(\{ tasks \}\), or chain \(\{ chain \}\)/,
			"tool description must state background works with batches",
		);
		assert.doesNotMatch(
			tool.description,
			/not supported with tasks or chain/,
			"the single-mode-only restriction is gone",
		);
	});

	it("still rejects invalid mixed modes before launching any child (#2820)", async () => {
		const cwd = freshAgentDir();
		const harness = makeContractHarness();

		// Pure batches are now valid background dispatches; what must still fail
		// before launch is a mixed dispatch (more than one mode).
		const invalid = {
			action: "launch",
			background: true,
			agent: "contract-fixture",
			task: "a",
			tasks: [{ agent: "contract-fixture", task: "b" }],
		};
		const result = await harness.execute(invalid, cwd);
		const text: string = result.content[0].text;
		assert.doesNotMatch(text, /Started background subagent run/, "no run may start");
		assert.match(text, /Provide exactly one mode/, "mixed modes must be rejected");

		// The mode-count guard rides the synchronous validation path before the
		// run record is created: no persisted records, no children, no wake.
		assert.ok(!existsSync(harness.runStoreDir), "no run record may be created for a rejected dispatch");
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(harness.sendAttempts.count, 0, "no child may launch and wake the session");
	});
});
