#!/usr/bin/env node
// Project/App: gsd-pi
// File Purpose: Automated GSD-side probe for MCP-host smoke evidence (issue #2173).
// Boots the packaged MCP server over stdio, verifies gsd_progress and
// gsd_project_snapshot discovery + invocation against a seeded fixture, and
// prints a per-check PASS/FAIL table. Proves the server side is contract-correct
// before any host (VS Code Copilot, Cursor, Claude Code, Codex) is involved.
//
// Run from the repo root:
//   node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types scripts/mcp-host-smoke.mjs
// Optional: --project <absolute dir> to probe a real project instead of the fixture.

import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const cliJs = resolve(repoRoot, "packages/mcp-server/dist/cli.js");

if (!existsSync(cliJs)) {
	console.error("Packaged MCP server not built. Run: pnpm run build:core");
	process.exit(1);
}

// gsd_progress serves DbProgressResult (bridge path) — 10 keys; optional
// hierarchy extensions from #2143 are additive and not asserted here.
const PROGRESS_KEYS = [
	"activeMilestone", "activeSlice", "activeTask", "phase",
	"milestones", "slices", "tasks", "requirements",
	"blockers", "nextAction",
].sort();

const SNAPSHOT_KEYS = [
	"authority", "current", "progress", "blockers", "openQuestions",
	"verification", "milestones", "capturedAt",
].sort();

const results = [];
function record(name, ok, detail) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function keysetOf(value) {
	return value && typeof value === "object" ? Object.keys(value).sort() : null;
}

function sameMembers(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

// Resolve a seeded fixture in-process (same loader runs this file).
const { createWorkflowAuthorityFixture } = await import(
	"../src/resources/extensions/gsd/tests/workflow-authority-fixture.ts"
);

const argProject = process.argv.includes("--project")
	? process.argv[process.argv.indexOf("--project") + 1]
	: null;

const fixture = argProject
	? null
	: await createWorkflowAuthorityFixture();
const projectDir = argProject
	? realpathSync(argProject)
	: fixture.root;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

const client = new Client({ name: "gsd-mcp-host-smoke", version: "0.0.0" });
const transport = new StdioClientTransport({
	command: process.execPath,
	args: [cliJs],
	cwd: projectDir,
	env: {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		TMPDIR: realpathSync(tmpdir()),
		GSD_NON_INTERACTIVE: "1",
	},
	stderr: "pipe",
});

try {
	await client.connect(transport);

	// --- Discovery -----------------------------------------------------------
	const listed = await client.listTools();
	const names = listed.tools.map((t) => t.name);
	record("tools/list: gsd_progress advertised", names.includes("gsd_progress"));
	record("tools/list: gsd_project_snapshot advertised", names.includes("gsd_project_snapshot"));

	// --- gsd_progress invocation ----------------------------------------------
	const progress = await client.callTool({ name: "gsd_progress", arguments: { projectDir } });
	const progressPayload = JSON.parse(progress.content[0].text);
	record(
		"gsd_progress: exact keyset",
		!progress.isError && sameMembers(keysetOf(progressPayload), PROGRESS_KEYS),
		`keys=${keysetOf(progressPayload)?.join(",")}`,
	);
	record(
		"gsd_progress: payload is DB-authoritative (phase present, no projection fallback)",
		typeof progressPayload.phase === "string" && progressPayload.phase.length > 0,
		`phase=${progressPayload.phase}`,
	);

	// --- gsd_project_snapshot invocation ---------------------------------------
	const snapshot = await client.callTool({ name: "gsd_project_snapshot", arguments: { projectDir } });
	const snapshotPayload = JSON.parse(snapshot.content[0].text);
	const structured = snapshot.structuredContent;
	record(
		"gsd_project_snapshot: exact keyset",
		!snapshot.isError && sameMembers(keysetOf(snapshotPayload), SNAPSHOT_KEYS),
		`keys=${keysetOf(snapshotPayload)?.join(",")}`,
	);
	record(
		"gsd_project_snapshot: structuredContent mirrors details",
		structured?.operation === "read_project_snapshot"
			&& structured?.snapshot
			&& sameMembers(keysetOf(structured.snapshot), SNAPSHOT_KEYS),
		`operation=${structured?.operation}`,
	);
	record(
		"gsd_project_snapshot: authority revision is numeric",
		Number.isSafeInteger(snapshotPayload.authority?.revision),
		`revision=${snapshotPayload.authority?.revision}`,
	);
	record(
		"gsd_project_snapshot: milestone registry bounded with truncated flag",
		Array.isArray(snapshotPayload.milestones?.items)
			&& snapshotPayload.milestones.items.length <= 50
			&& typeof snapshotPayload.milestones.truncated === "boolean",
		`items=${snapshotPayload.milestones?.items?.length}, truncated=${snapshotPayload.milestones?.truncated}`,
	);
} catch (err) {
	record("probe completed without transport/protocol error", false, err.message);
} finally {
	await client.close().catch(() => {});
	fixture?.cleanup();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
