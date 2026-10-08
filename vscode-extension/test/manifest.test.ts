// Project/App: gsd-pi
// File Purpose: VS Code extension manifest and pure helper behavior tests.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	APPROVAL_MODES,
	describeApprovalEvent,
	nextApprovalMode,
} from "../src/approval-mode.ts";
import { buildGsdClientSpawnPlan } from "../src/gsd-client-spawn.ts";
import {
	buildAgentGitAddArgs,
	buildAgentGitDiffArgs,
	buildAgentGitStatusArgs,
} from "../src/git-args.ts";

import { createHarness } from "./copilot-test-harness.ts";
import { progressFixture } from "./project-context-fixtures.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readPackage(): {
	contributes: {
		commands: Array<{ command: string; title: string }>;
		languageModelTools?: Array<{
			name: string;
			displayName: string;
			modelDescription: string;
			userDescription?: string;
			canBeReferencedInPrompt?: boolean;
			toolReferenceName?: string;
			icon?: string;
			inputSchema?: unknown;
			readOnlyHint?: boolean;
		}>;
		views: Record<string, Array<{ id: string }>>;
		configuration: {
			properties: Record<string, unknown>;
		};
	};
	scripts: Record<string, string>;
} {
	return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function readSource(fileName: string): string {
	return readFileSync(join(root, "src", fileName), "utf8");
}

test("manifest contributes unique executable commands with titles", () => {
	const pkg = readPackage();
	const contributed = pkg.contributes.commands.map((entry) => entry.command);
	assert.equal(new Set(contributed).size, contributed.length);

	for (const entry of pkg.contributes.commands) {
		assert.equal(entry.command.startsWith("gsd."), true);
		assert.equal(typeof entry.title, "string");
		assert.ok(entry.title.length > 0);
	}
});

test("GSDClient spawn plan launches the configured binary in RPC mode with a controlled cwd", () => {
	const plan = buildGsdClientSpawnPlan("/opt/bin/gsd", "/tmp/project", { PATH: "/usr/bin" }, "linux");
	assert.equal(plan.command, "/opt/bin/gsd");
	assert.deepEqual(plan.args, ["--mode", "rpc"]);
	assert.deepEqual(plan.options, {
		cwd: "/tmp/project",
		stdio: ["pipe", "pipe", "pipe"],
		env: { PATH: "/usr/bin" },
		shell: false,
	});

	assert.equal(buildGsdClientSpawnPlan("gsd.cmd", "C:\\repo", {}, "win32").options.shell, true);
});

test("approval mode contributes settings and executable command behavior", () => {
	const pkg = readPackage();
	const commands = new Set(pkg.contributes.commands.map((entry) => entry.command));

	assert.ok(pkg.contributes.configuration.properties["gsd.approvalMode"]);
	assert.ok(commands.has("gsd.cycleApprovalMode"));
	assert.ok(commands.has("gsd.selectApprovalMode"));
	assert.deepEqual(APPROVAL_MODES, ["auto-approve", "ask", "plan-only"]);
	assert.equal(nextApprovalMode("auto-approve"), "ask");
	assert.equal(nextApprovalMode("ask"), "plan-only");
	assert.equal(nextApprovalMode("plan-only"), "auto-approve");

	assert.equal(
		describeApprovalEvent({ type: "tool_execution_start", toolName: "Write", toolInput: { file_path: "/tmp/project/src/app.ts" } }),
		"Write: project/src/app.ts",
	);
	assert.equal(
		describeApprovalEvent({ type: "tool_execution_start", toolName: "Bash", toolInput: { command: "npm run verify".repeat(10) } })?.startsWith("Execute: npm run verify"),
		true,
	);
	assert.equal(describeApprovalEvent({ type: "tool_execution_start", toolName: "Read" }), null);
});

test("checkpoint view is contributed in the extension manifest", () => {
	const pkg = readPackage();

	assert.ok(pkg.contributes.views.gsd.some((view) => view.id === "gsd-checkpoints"));
	assert.ok(pkg.contributes.commands.some((entry) => entry.command === "gsd.restoreCheckpoint"));
});

test("project progress uses the existing RPC client and one sidebar refresh loop", async (t) => {
	const h = createHarness(); await h.client.start(); t.after(() => h.client.stop());
	const payload = progressFixture(); delete payload.readMetadata;
	const read = h.client.getProjectProgress();
	assert.equal(h.processes[0].lastCommand().type, "get_project_progress");
	h.processes[0].respond(h.processes[0].lastCommand(), payload);
	assert.deepEqual(JSON.parse(JSON.stringify(await read)), payload);
	const sidebarSource = readSource("sidebar.ts");
	assert.match(sidebarSource, /case "refreshProgress":/);
	assert.match(sidebarSource, /this\.client\.getProjectProgress\(\)/);
	assert.match(sidebarSource, /data-section="project-progress"/);
	assert.match(sidebarSource, /class="section collapsed" data-section="project-progress"/);
	assert.match(sidebarSource, /Project progress unavailable/);
	assert.match(sidebarSource, /escapeHtml\(current\)/);
	assert.match(sidebarSource, /escapeHtml\(progress\.nextAction\)/);
	assert.match(sidebarSource, /progress\.milestoneDetails \?\? \[\]\)\.map/);
	assert.match(sidebarSource, /milestone\.slices\.map/);
	assert.match(sidebarSource, /slice\.tasks\.map/);
	assert.match(sidebarSource, /progress\.milestoneDetailsTasksTruncated/);
	assert.match(sidebarSource, /this\.refresh\(true\)/);
	assert.match(sidebarSource, /applySectionCollapseState\}\)\(document\.querySelectorAll/);
	assert.equal((sidebarSource.match(/setInterval\(/g) ?? []).length, 1);
});

test("Copilot read tools are contributed and registered against the existing RPC client", async () => {
	const pkg = readPackage();
	const tools = pkg.contributes.languageModelTools ?? [];

	assert.equal(tools.length, 2);
	assert.deepEqual(tools.map((tool) => tool.name), ["gsd_project_progress", "gsd_project_snapshot"]);

	for (const tool of tools) {
		assert.equal(typeof tool.displayName, "string");
		assert.equal(typeof tool.modelDescription, "string");
		assert.equal(tool.canBeReferencedInPrompt, true);
		assert.equal(tool.inputSchema, undefined);
		assert.equal("readOnlyHint" in tool, false);
		assert.equal(typeof tool.icon, "string");
	}

	assert.deepEqual(tools.map((tool) => tool.toolReferenceName), ["gsdProjectProgress", "gsdProjectSnapshot"]);
	const h = createHarness();
	const context = { subscriptions: [] as unknown[] };
	h.registerCopilotTools(context, h.client);
	assert.equal(context.subscriptions.length, 2);
	assert.deepEqual(h.registeredTools.map(entry => entry.name), tools.map(tool => tool.name));
	assert.ok(h.registeredTools[0].tool instanceof h.ProjectProgressTool);
	assert.ok(h.registeredTools[1].tool instanceof h.ProjectSnapshotTool);
	for (const { tool } of h.registeredTools) {
		const preparation = await tool.prepareInvocation();
		assert.match(preparation.confirmationMessages.message.value, /read-only.*active chat\/model context/);
	}
	(h.vscode.lm as any).registerTool = undefined;
	const unavailable = { subscriptions: [] as unknown[] };
	h.registerCopilotTools(unavailable, h.client);
	assert.equal(unavailable.subscriptions.length, 0);
});

test("web bridge treats project progress and snapshot reads as read-only while onboarding is locked", () => {
	const bridgeSource = readFileSync(join(root, "..", "src", "web", "bridge-service.ts"), "utf8");
	const allowlist = bridgeSource.match(/const READ_ONLY_RPC_COMMAND_TYPES = new Set<RpcCommand\["type"\]>\(\[([\s\S]*?)\]\);/);
	assert.ok(allowlist);
	assert.match(allowlist[1], /"get_project_progress"/);
	assert.match(allowlist[1], /"get_project_snapshot"/);
});

test("agent git helpers scope git output to tracked agent files", () => {
	const files = ["src/app.ts", "README.md"];

	assert.deepEqual(buildAgentGitAddArgs(files), ["add", "src/app.ts", "README.md"]);
	assert.deepEqual(buildAgentGitDiffArgs(files), ["diff", "--", "src/app.ts", "README.md"]);
	assert.deepEqual(buildAgentGitStatusArgs(files), ["status", "--short", "--", "src/app.ts", "README.md"]);
});
