// gsd-pi — subagent tool-contract tests: model-facing disclosures (#2759).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

	it("discloses that background is single-mode-only before invocation (#2759)", () => {
		const tool = registerSubagentTool();
		const background = tool.parameters.properties.background?.description ?? "";
		assert.match(
			background,
			/single-mode run \(\{ agent, task \}\)/i,
			"background description must tie background to the { agent, task } single mode",
		);
		assert.match(background, /tasks or chain/, "background description must name the tasks/chain conflict");
		assert.match(tool.description, /background/i, "tool description must mention background");
		assert.match(
			tool.description,
			/single-mode run \(\{ agent, task \}\)/i,
			"tool description must tie background to the { agent, task } single mode",
		);
		assert.match(
			tool.description,
			/not supported with tasks or chain/,
			"tool description must state background cannot combine with tasks or chain",
		);
	});

	it("rejects background + tasks/chain before launching any child (#2759)", async () => {
		const cwd = freshAgentDir();
		const harness = makeContractHarness();

		for (const invalid of [
			{ action: "launch", background: true, tasks: [{ agent: "contract-fixture", task: "b" }] },
			{ action: "launch", background: true, chain: [{ agent: "contract-fixture", task: "b" }] },
		]) {
			const result = await harness.execute(invalid, cwd);
			assert.equal(result.isError, true, `expected isError for ${JSON.stringify(invalid)}`);
			const text: string = result.content[0].text;
			assert.doesNotMatch(text, /Started background subagent run/, "no run may start");
			assert.match(text, /single mode/i, "rejection must name the single-mode requirement");
			assert.match(
				text,
				/tasks or chain/,
				"rejection must name the conflicting modes so the model can self-correct",
			);
			assert.match(text, /Remove background/, "rejection must state the recovery");
		}

		// The rejection rides the synchronous validation path: the persisted run
		// records must show the contract failure, not results from launched children.
		assert.ok(existsSync(harness.runStoreDir), "run store dir expected");
		const records = readdirSync(harness.runStoreDir).filter((f) => f.endsWith(".json"));
		assert.equal(records.length, 2, "one record per rejected dispatch");
		for (const file of records) {
			const record = JSON.parse(readFileSync(join(harness.runStoreDir, file), "utf-8"));
			assert.equal(record.status, "failed");
			assert.match(
				record.children[0]?.errorMessage ?? "",
				/tasks or chain/,
				"recorded failure must be the contract rejection, not a child run",
			);
		}

		// Give any (incorrect) child launch + wake a moment to land, then assert silence.
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(harness.sendAttempts.count, 0, "no child may launch and wake the session");
	});
});
