/**
 * Regression tests for #2967 — mcp_call must not deliver an oversized
 * single-line response as zero body bytes. Before the fix, the complete-line
 * truncation policy reduced such responses to a bare
 * "[Output truncated: 0/1 lines (0B of ...)]" notice.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import mcpClientExtension, { _resetMcpClientStateForTest } from "../index.js";

const CAP = 50 * 1024; // DEFAULT_MAX_BYTES

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

async function withMcpServer(
	serverName: string,
	toolDefinitions: Array<{ name: string; description: string; body: string }>,
	run: (mcpCall: any, ctx: unknown) => Promise<void>,
): Promise<void> {
	const previousGsdHome = process.env.GSD_HOME;
	const originalCwd = process.cwd();
	const projectDir = mkdtempSync(join(tmpdir(), "mcp-oversized-project-"));
	const gsdHomeDir = mkdtempSync(join(tmpdir(), "mcp-oversized-home-"));

	try {
		process.env.GSD_HOME = gsdHomeDir;
		process.chdir(projectDir);
		mkdirSync(join(projectDir, ".gsd"), { recursive: true });

		const require = createRequire(import.meta.url);
		const mcpModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
		const stdioModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
		const serverPath = join(projectDir, "oversized-mcp-server.mjs");
		const toolDefs = toolDefinitions
			.map((t) => `server.tool(${JSON.stringify(t.name)}, ${JSON.stringify(t.description)}, {}, async () => ({ ${t.body} }));`)
			.join("\n");
		writeFileSync(
			serverPath,
			[
				`const { McpServer } = await import(${JSON.stringify(mcpModuleUrl)});`,
				`const { StdioServerTransport } = await import(${JSON.stringify(stdioModuleUrl)});`,
				'const server = new McpServer({ name: "oversized", version: "1.0.0" }, { capabilities: { tools: {} } });',
				toolDefs,
				"await server.connect(new StdioServerTransport());",
			].join("\n"),
			"utf-8",
		);
		writeFileSync(
			join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					[serverName]: { command: process.execPath, args: [serverPath] },
				},
			}),
			"utf-8",
		);

		const { pi, tools } = createMockPi();
		mcpClientExtension(pi as any);
		const mcpCall = tools.get("mcp_call");
		assert.ok(mcpCall, "mcp_call must be registered");

		const ctx = { hasUI: true, ui: { confirm: async () => true } };
		await run(mcpCall, ctx);
	} finally {
		await _resetMcpClientStateForTest();
		process.chdir(originalCwd);
		if (previousGsdHome === undefined) delete process.env.GSD_HOME;
		else process.env.GSD_HOME = previousGsdHome;
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(gsdHomeDir, { recursive: true, force: true });
	}
}

function call(mcpCall: any, ctx: unknown, id: string) {
	return mcpCall.execute(
		id,
		{ server: "oversized", tool: id, args: {} },
		new AbortController().signal,
		() => {},
		ctx,
	);
}

test("mcp_call delivers an oversized single-line response as a labeled nonzero-byte prefix (#2967)", async () => {
	await withMcpServer(
		"oversized",
		[
			{
				name: "big_line",
				description: "Returns one giant single-line JSON response",
				body: `content: [{ type: "text", text: JSON.stringify({ items: [{ body: "x".repeat(60 * 1024) }] }) }]`,
			},
			{
				name: "small_line",
				description: "Returns a small response",
				body: `content: [{ type: "text", text: "hello ok" }]`,
			},
		],
		async (mcpCall, ctx) => {
			const result = await call(mcpCall, ctx, "big_line");
			const text = result.content[0]?.text ?? "";
			const lines = text.split("\n");
			const body = lines[1] ?? "";

			// The body must actually arrive: nonzero bytes, starting with the response.
			assert.ok(body.startsWith('{"items":'), `expected response body after label, got: ${lines[0]}`);
			const bodyBytes = Buffer.byteLength(body);
			assert.ok(bodyBytes > 0, "oversized response must not be delivered as zero body bytes");
			assert.ok(bodyBytes <= CAP, "prefix must stay within the byte cap");

			// Clearly labeled as a partial prefix, not parseable complete JSON.
			assert.match(lines[0], /^\[Output truncated: 0\/1 lines/);
			assert.match(lines[0], /not parseable as complete JSON/);

			// Metadata distinguishes original size from emitted size.
			const d = result.details as Record<string, unknown>;
			assert.equal(d.truncated, true);
			const totalBytes = d.totalBytes as number;
			const outputBytes = d.outputBytes as number;
			assert.ok(totalBytes > CAP);
			assert.equal(outputBytes, bodyBytes);
			assert.ok(outputBytes < totalBytes);
			assert.equal(d.charCount, text.length);

			// Smaller responses stay byte-identical and untruncated.
			const small = await call(mcpCall, ctx, "small_line");
			assert.equal(small.content[0]?.text, "hello ok");
			const sd = small.details as Record<string, unknown>;
			assert.equal(sd.truncated, false);
			assert.equal(sd.totalBytes, Buffer.byteLength("hello ok"));
			assert.equal(sd.outputBytes, sd.totalBytes);
		},
	);
});

test("mcp_call error propagation is unchanged (#2967)", async () => {
	await withMcpServer(
		"oversized",
		[
			{
				name: "ok_tool",
				description: "No-op",
				body: `content: [{ type: "text", text: "fine" }]`,
			},
		],
		async (mcpCall, ctx) => {
			// Unconfigured server surfaces as a rejected call through the
			// wrapper's error path (MCP SDK returns unknown tools as isError
			// results, which resolve rather than reject).
			await assert.rejects(
				() =>
					mcpCall.execute(
						"unknown-server",
						{ server: "does_not_exist", tool: "whatever", args: {} },
						new AbortController().signal,
						() => {},
						ctx,
					),
				/MCP call failed[\s\S]*Unknown MCP server/,
			);
		},
	);
});
