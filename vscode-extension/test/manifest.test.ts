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

test("project progress uses the existing RPC client and one sidebar refresh loop", () => {
	const clientSource = readSource("gsd-client.ts");
	const sidebarSource = readSource("sidebar.ts");

	assert.match(clientSource, /type: "get_project_progress"/);
	assert.match(clientSource, /async getProjectProgress\(\): Promise<ProjectProgress \| null>/);
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
	assert.match(sidebarSource, /stored\[id\] === 'open'/);
	assert.equal((sidebarSource.match(/setInterval\(/g) ?? []).length, 1);
});

test("Copilot read tools are contributed and registered against the existing RPC client", () => {
	const pkg = readPackage();
	const extensionSource = readSource("extension.ts");
	const toolSource = readSource("copilot-tools.ts");
	const clientSource = readSource("gsd-client.ts");
	const tools = pkg.contributes.languageModelTools ?? [];

	assert.equal(tools.length, 2);
	assert.deepEqual(tools.map((tool) => tool.name), ["gsd_project_progress", "gsd_project_snapshot"]);

	for (const tool of tools) {
		assert.equal(typeof tool.displayName, "string");
		assert.equal(typeof tool.modelDescription, "string");
		assert.equal(tool.canBeReferencedInPrompt, true);
		assert.equal(tool.inputSchema, undefined);
		assert.equal("readOnlyHint" in tool, false);
	}

	assert.deepEqual(tools.map((tool) => tool.toolReferenceName), ["gsdProjectProgress", "gsdProjectSnapshot"]);
	assert.match(extensionSource, /registerCopilotTools\(context, client\)/);
	assert.match(toolSource, /vscode\.lm\.registerTool\("gsd_project_progress", new ProjectProgressTool\(client\)\)/);
	assert.match(toolSource, /vscode\.lm\.registerTool\("gsd_project_snapshot", new ProjectSnapshotTool\(client\)\)/);
	assert.match(toolSource, /The result is read-only, but it will be sent to the active chat\/model context/);
	assert.match(toolSource, /GSD project read tools do not accept input parameters/);
	assert.match(toolSource, /GSD project read tools require exactly one workspace folder/);
	assert.match(toolSource, /GSD project read was cancelled/);
	assert.match(toolSource, /GSD agent is not connected/);
	assert.match(toolSource, /this\.client\.getProjectProgress\(\)/);
	assert.match(toolSource, /this\.client\.getProjectSnapshot\(\)/);
	assert.doesNotMatch(toolSource, /new GsdClient/);
	assert.match(clientSource, /async getProjectSnapshot\(\): Promise<ProjectSnapshot \| null>/);
	assert.match(clientSource, /type: "get_project_snapshot"/);
});

test("agent git helpers scope git output to tracked agent files", () => {
	const files = ["src/app.ts", "README.md"];

	assert.deepEqual(buildAgentGitAddArgs(files), ["add", "src/app.ts", "README.md"]);
	assert.deepEqual(buildAgentGitDiffArgs(files), ["diff", "--", "src/app.ts", "README.md"]);
	assert.deepEqual(buildAgentGitStatusArgs(files), ["status", "--short", "--", "src/app.ts", "README.md"]);
});
