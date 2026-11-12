/** Regression for #2916 F3: retain the SDK's authoritative tool-error carrier. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import mcpClientExtension, { _resetMcpClientStateForTest } from "../index.js";

// Model the SDK carrier boundary reported by native-external-mcp-host-013.
// These deterministic unit fixtures do not rerun or claim host acceptance.
const cases = [
	{
		name: "exit_7",
		response: {
			content: [{ type: "text", text: '{"stdout":"","stderr":"fixture failure\\n","exitCode":7}' }],
			isError: true,
		},
	},
	{
		name: "timeout",
		response: {
			content: [{ type: "text", text: '{"stdout":"","stderr":"","exitCode":null,"timedOut":true}' }],
			isError: true,
		},
	},
	{ name: "success_false", response: { content: [{ type: "text", text: "ok" }], isError: false } },
	{ name: "success_absent", response: { content: [{ type: "text", text: "ok" }] } },
	{
		name: "error_text_absent",
		response: { content: [{ type: "text", text: "Error: timeout; stderr: failure; exitCode: 7" }] },
	},
	{
		name: "error_text_false",
		response: {
			content: [{ type: "text", text: "Error: timeout; stderr: failure; exitCode: 7" }],
			isError: false,
		},
	},
	{ name: "empty_error", response: { content: [], isError: true } },
] as const;

test("mcp_call retains only explicit true error carriers from SDK responses", async (t) => {
	const previousGsdHome = process.env.GSD_HOME;
	const originalCwd = process.cwd();
	const projectDir = mkdtempSync(join(tmpdir(), "mcp-call-error-project-"));
	const gsdHomeDir = mkdtempSync(join(tmpdir(), "mcp-call-error-home-"));

	try {
		process.env.GSD_HOME = gsdHomeDir;
		process.chdir(projectDir);
		mkdirSync(join(projectDir, ".gsd"), { recursive: true });
		const require = createRequire(import.meta.url);
		const mcpUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
		const stdioUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
		const serverPath = join(projectDir, "error-carrier-server.mjs");
		writeFileSync(serverPath, [
			`const { McpServer } = await import(${JSON.stringify(mcpUrl)});`,
			`const { StdioServerTransport } = await import(${JSON.stringify(stdioUrl)});`,
			'const server = new McpServer({ name: "error-carrier", version: "1.0.0" });',
			...cases.map(({ name, response }) =>
				`server.tool(${JSON.stringify(name)}, {}, async () => (${JSON.stringify(response)}));`),
			'server.tool("disconnect", {}, async () => { process.exit(0); });',
			'await server.connect(new StdioServerTransport());',
		].join("\n"), "utf-8");
		writeFileSync(join(projectDir, ".mcp.json"), JSON.stringify({
			mcpServers: { "error-carrier": { command: process.execPath, args: [serverPath] } },
		}), "utf-8");

		const tools = new Map<string, any>();
		mcpClientExtension({ on() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
		const mcpCall = tools.get("mcp_call");
		assert.ok(mcpCall, "mcp_call must be registered");
		const ctx = { hasUI: true, ui: { confirm: async () => true } };

		for (const { name, response } of cases) {
			await t.test(name, async () => {
				const result = await mcpCall.execute(`call_${name}`, {
					server: "error-carrier", tool: name, args: {},
				}, new AbortController().signal, () => {}, ctx);
				const text = response.content.map((c) => c.text).join("\n");
				assert.deepEqual(result, {
					content: [{ type: "text", text }],
					details: {
						server: "error-carrier", tool: name, charCount: text.length,
						truncated: false, totalBytes: Buffer.byteLength(text), outputBytes: Buffer.byteLength(text),
					},
					...("isError" in response && response.isError === true ? { isError: true } : {}),
				});
			});
		}

		await t.test("transport disconnect still rejects", async () => {
			await assert.rejects(mcpCall.execute("call_disconnect", {
				server: "error-carrier", tool: "disconnect",
			}, new AbortController().signal, () => {}, ctx), /MCP call failed: error-carrier\.disconnect[\s\S]*Connection closed/i);
		});

		await t.test("connection failures still reject", async () => {
			await assert.rejects(mcpCall.execute("call_unknown", {
				server: "missing", tool: "noop",
			}, new AbortController().signal, () => {}, ctx), /Unknown MCP server/);
		});
	} finally {
		await _resetMcpClientStateForTest();
		process.chdir(originalCwd);
		if (previousGsdHome === undefined) delete process.env.GSD_HOME;
		else process.env.GSD_HOME = previousGsdHome;
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(gsdHomeDir, { recursive: true, force: true });
	}
});

test("mcp_call renderResult shows an error marker and bounded error preview while collapsed", async () => {
	const tools = new Map<string, { renderResult: (...args: unknown[]) => { render(width: number): string[] } }>();
	mcpClientExtension({
		on() {},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool as never);
		},
	} as never);
	const tool = tools.get("mcp_call");
	assert.ok(tool, "mcp_call must be registered");
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const longLine = "exit 7 ".repeat(200);
	const result = {
		content: [{ type: "text", text: `${longLine}\nsecond line\nthird line\nfourth line` }],
		isError: true,
		details: { server: "fixture", tool: "fail", charCount: 1400, truncated: false },
	};
	const rendered = tool.renderResult(result, { expanded: false }, theme).render(120).join("\n");
	// The error marker replaces the success checkmark, and the diagnostic is visible without expanding.
	assert.match(rendered, /✗ fixture\.fail/);
	assert.doesNotMatch(rendered, /✓ fixture\.fail/);
	assert.match(rendered, /exit 7/);
	assert.ok(rendered.length < longLine.length, "collapsed error preview must be bounded");
});
