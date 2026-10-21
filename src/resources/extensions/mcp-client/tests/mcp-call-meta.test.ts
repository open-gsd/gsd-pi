/**
 * Regression test for #1792 — mcp_call must attach replay-stable request _meta
 * on CallTool so servers that require io.opengsd/idempotency-key or
 * claudecode/toolUseId can accept mutations.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import mcpClientExtension, { _resetMcpClientStateForTest } from "../index.js";

function createMockPi(): { pi: unknown; tools: Map<string, any> } {
	const tools = new Map<string, any>();
	return {
		tools,
		pi: {
			on() {},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
		},
	};
}

test("mcp_call CallTool request params include replay-stable _meta (#1792)", async () => {
	const previousGsdHome = process.env.GSD_HOME;
	const originalCwd = process.cwd();
	const projectDir = mkdtempSync(join(tmpdir(), "mcp-call-meta-project-"));
	const gsdHomeDir = mkdtempSync(join(tmpdir(), "mcp-call-meta-home-"));

	try {
		process.env.GSD_HOME = gsdHomeDir;
		process.chdir(projectDir);
		mkdirSync(join(projectDir, ".gsd"), { recursive: true });

		const require = createRequire(import.meta.url);
		const mcpModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
		const stdioModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
		const serverPath = join(projectDir, "echo-meta-mcp-server.mjs");
		writeFileSync(
			serverPath,
			[
				`const { McpServer } = await import(${JSON.stringify(mcpModuleUrl)});`,
				`const { StdioServerTransport } = await import(${JSON.stringify(stdioModuleUrl)});`,
				'const server = new McpServer({ name: "echo-meta", version: "1.0.0" }, { capabilities: { tools: {} } });',
				'server.tool("echo_meta", "Echo request _meta", {}, async (_args, extra) => ({',
				'  content: [{ type: "text", text: JSON.stringify(extra?._meta ?? null) }],',
				"}));",
				"await server.connect(new StdioServerTransport());",
			].join("\n"),
			"utf-8",
		);
		writeFileSync(
			join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					"echo-meta": { command: process.execPath, args: [serverPath] },
				},
			}),
			"utf-8",
		);

		const { pi, tools } = createMockPi();
		mcpClientExtension(pi as any);
		const mcpCall = tools.get("mcp_call");
		assert.ok(mcpCall, "mcp_call must be registered");

		const ctx = {
			hasUI: true,
			ui: {
				confirm: async () => true,
			},
		};
		const toolCallId = "tool-call-1792";
		const result = await mcpCall.execute(
			toolCallId,
			{ server: "echo-meta", tool: "echo_meta", args: {} },
			new AbortController().signal,
			() => {},
			ctx,
		);

		const meta = JSON.parse(result.content[0]?.text ?? "");
		assert.notEqual(meta, null);
		assert.equal(typeof meta, "object");
		assert.equal(meta["claudecode/toolUseId"], toolCallId);
		assert.equal(meta["io.opengsd/idempotency-key"], `pi:${toolCallId}`);
	} finally {
		await _resetMcpClientStateForTest();
		process.chdir(originalCwd);
		if (previousGsdHome === undefined) delete process.env.GSD_HOME;
		else process.env.GSD_HOME = previousGsdHome;
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(gsdHomeDir, { recursive: true, force: true });
	}
});
