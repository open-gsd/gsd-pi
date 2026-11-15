// gsd-pi + cmux startup: transport acknowledgment is not wrapper startup.
// Emulate a bounded terminal input line and execute only a local test child;
// no real cmux surface or provider is involved.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { CmuxClient } from "../../cmux/index.js";
import type { AgentConfig } from "../agents.js";
import { runSingleAgentInCmuxSplit } from "../index.js";

const TERMINAL_LINE_BYTES = 4096;

describe("cmux-split long-command startup", () => {
	const savedEnv = { ...process.env };
	let dir: string | undefined;
	let wrapper: ChildProcess | undefined;

	afterEach(() => {
		wrapper?.kill();
		wrapper = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		for (const key of Object.keys(process.env)) {
			if (!(key in savedEnv)) delete process.env[key];
		}
		Object.assign(process.env, savedEnv);
	});

	it("starts a long quoted task through a bounded bootstrap and preserves the launch contract", async () => {
		dir = mkdtempSync(join(tmpdir(), "gsd-cmux-startup-'quoted-"));
		const fixture = join(dir, "local child.cjs");
		writeFileSync(fixture, `
const report = {
	args: process.argv.slice(2),
	cwd: process.cwd(),
	child: process.env.GSD_SUBAGENT_CHILD,
	cuaTokenPresent: "CMUX_CUA_SOCKET_AUTH_TOKEN" in process.env,
	cuaHandoffPresent: "CMUX_CUA_TEST_HANDOFF" in process.env,
};
process.stdout.write(JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant", content: [{ type: "text", text: JSON.stringify(report) }],
		stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
	},
}) + "\\n");
`);
		process.env.GSD_BIN_PATH = fixture;
		process.env.CMUX_CUA_SOCKET_AUTH_TOKEN = "synthetic-test-token";
		process.env.CMUX_CUA_TEST_HANDOFF = "synthetic-test-handoff";
		const task = "long λ 'quoted' \"double\" ; $HOME `not-a-command` ".repeat(250);
		const agent: AgentConfig = {
			name: "cmux-agent", description: "local startup regression", systemPrompt: "",
			source: "project", filePath: join(dir, ".gsd", "agents", "cmux-agent.md"),
		};
		const observedPids: number[] = [];
		let sentBytes = 0;
		let shellStderr = "";
		const client = {
			createSplit: async () => "mock-surface",
			sendSurface: async (_surfaceId: string, command: string) => {
				sentBytes = Buffer.byteLength(`${command}\n`);
				// A real send acknowledgment can precede a canonical-input truncation.
				// Fail loudly here rather than waiting 30 minutes for a missing pid.
				assert.ok(sentBytes <= TERMINAL_LINE_BYTES,
					`terminal bootstrap exceeds ${TERMINAL_LINE_BYTES} bytes: ${sentBytes}; wrapper cannot start intact`);
				wrapper = spawn("bash", ["-c", command], { stdio: ["ignore", "ignore", "pipe"] });
				wrapper.stderr!.on("data", (chunk: Buffer) => { shellStderr += chunk.toString(); });
				return true;
			},
			sendInterrupt: async () => { wrapper?.kill(); },
		} as unknown as CmuxClient;

		const result = await runSingleAgentInCmuxSplit(
			client, "right", dir, [agent], agent.name, task, undefined, undefined,
			AbortSignal.timeout(10_000), undefined, () => ({}) as never,
			{ contextMode: "fresh", onChildSpawned: (pid) => { if (pid !== undefined) observedPids.push(pid); } },
		);

		assert.equal(result.exitCode, 0, shellStderr || result.stderr);
		assert.equal(result.running, false);
		assert.equal(observedPids.length, 1, "wrapper startup is acknowledged by its pid exactly once");
		const message = result.messages.find((entry) => entry.role === "assistant");
		assert.ok(message && message.role === "assistant");
		const text = message.content.find((entry) => entry.type === "text");
		assert.ok(text && text.type === "text");
		const report = JSON.parse(text.text);
		assert.ok(report.args.includes(`Task: ${task}`), "the entire quoted task reaches the child unchanged");
		assert.ok(report.args.includes("--no-session"), "fresh mode remains isolated");
		assert.equal(report.child, "1");
		assert.equal(report.cuaTokenPresent, false);
		assert.equal(report.cuaHandoffPresent, false);
		assert.equal(report.cwd, realpathSync(dir));
		assert.ok(sentBytes <= TERMINAL_LINE_BYTES);
	});
});
