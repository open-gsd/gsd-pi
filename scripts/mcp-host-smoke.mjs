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
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const MAX_OUTPUT_ITEMS = 50;

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describe(value) {
	return value === undefined ? "missing" : JSON.stringify(value);
}

function requireRecord(value, name) {
	if (!isRecord(value)) throw new Error(`${name}: expected object, got ${describe(value)}`);
	return value;
}

function requireString(value, name) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${name}: expected non-empty string, got ${describe(value)}`);
	}
}

function requireBoolean(value, name) {
	if (typeof value !== "boolean") throw new Error(`${name}: expected boolean, got ${describe(value)}`);
}

function requireSafeInteger(value, name) {
	if (!Number.isSafeInteger(value)) throw new Error(`${name}: expected safe integer, got ${describe(value)}`);
}

function requireNonNegativeSafeInteger(value, name) {
	requireSafeInteger(value, name);
	if (value < 0) throw new Error(`${name}: expected non-negative safe integer, got ${describe(value)}`);
}

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function parseToolTextPayload(result, name) {
	if (!isRecord(result) || !Array.isArray(result.content) || result.content.length === 0) {
		throw new Error(`${name}: missing content envelope`);
	}
	const text = result.content.find((block) => isRecord(block) && typeof block.text === "string")?.text;
	if (text === undefined) throw new Error(`${name}: missing text content`);
	let payload;
	try {
		payload = JSON.parse(text);
	} catch (error) {
		throw new Error(`${name}: invalid JSON text (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!isRecord(payload)) throw new Error(`${name}: payload must be a non-null object`);
	return payload;
}

export function assertSuccessEnvelope(result, name) {
	if (!isRecord(result)) throw new Error(`${name}: result must be an object`);
	if (result.isError === true) throw new Error(`${name}: MCP error envelope`);
	if (result.isError !== undefined && typeof result.isError !== "boolean") {
		throw new Error(`${name}: isError must be boolean when present`);
	}
	if (isRecord(result.structuredContent) && typeof result.structuredContent.error === "string") {
		throw new Error(`${name}: structured canonical error (${result.structuredContent.error})`);
	}
	return result;
}

export function assertProgressPayload(payload) {
	const progress = requireRecord(payload, "gsd_progress payload");
	for (const field of ["activeMilestone", "activeSlice", "activeTask"]) {
		if (progress[field] !== null) requireRecord(progress[field], `gsd_progress.${field}`);
	}
	requireString(progress.phase, "gsd_progress.phase");
	requireRecord(progress.milestones, "gsd_progress.milestones");
	requireRecord(progress.slices, "gsd_progress.slices");
	requireRecord(progress.tasks, "gsd_progress.tasks");
	if (progress.requirements !== null) requireRecord(progress.requirements, "gsd_progress.requirements");
	if (!Array.isArray(progress.blockers)) throw new Error("gsd_progress.blockers: expected array");
	requireString(progress.nextAction, "gsd_progress.nextAction");
	const metadata = requireRecord(progress.readMetadata, "gsd_progress.readMetadata");
	if (metadata.source !== "database") {
		throw new Error(`gsd_progress.readMetadata.source: expected database, got ${describe(metadata.source)}`);
	}
	if (metadata.authority !== "db-authoritative") {
		throw new Error(`gsd_progress.readMetadata.authority: expected db-authoritative, got ${describe(metadata.authority)}`);
	}
	return progress;
}

function assertBoundedCollection(value, name) {
	const collection = requireRecord(value, name);
	if (!Array.isArray(collection.items)) throw new Error(`${name}.items: expected array`);
	if (collection.items.length > MAX_OUTPUT_ITEMS) {
		throw new Error(`${name}.items: exceeds output cap ${MAX_OUTPUT_ITEMS}`);
	}
	requireBoolean(collection.truncated, `${name}.truncated`);
}

export function assertSnapshotPayload(payload, structuredContent) {
	const snapshot = requireRecord(payload, "gsd_project_snapshot payload");
	const authority = requireRecord(snapshot.authority, "gsd_project_snapshot.authority");
	requireString(authority.projectId, "gsd_project_snapshot.authority.projectId");
	if (authority.schemaVersion !== null) requireNonNegativeSafeInteger(authority.schemaVersion, "gsd_project_snapshot.authority.schemaVersion");
	requireNonNegativeSafeInteger(authority.revision, "gsd_project_snapshot.authority.revision");
	requireNonNegativeSafeInteger(authority.authorityEpoch, "gsd_project_snapshot.authority.authorityEpoch");
	requireRecord(snapshot.current, "gsd_project_snapshot.current");
	requireRecord(snapshot.progress, "gsd_project_snapshot.progress");
	if (!Array.isArray(snapshot.blockers)) throw new Error("gsd_project_snapshot.blockers: expected array");
	if (snapshot.blockers.length > MAX_OUTPUT_ITEMS) throw new Error("gsd_project_snapshot.blockers: exceeds output cap 50");
	requireBoolean(snapshot.blockersTruncated, "gsd_project_snapshot.blockersTruncated");
	if (!Array.isArray(snapshot.openQuestions)) throw new Error("gsd_project_snapshot.openQuestions: expected array");
	if (snapshot.openQuestions.length > MAX_OUTPUT_ITEMS) throw new Error("gsd_project_snapshot.openQuestions: exceeds output cap 50");
	requireBoolean(snapshot.openQuestionsTruncated, "gsd_project_snapshot.openQuestionsTruncated");
	requireRecord(snapshot.verification, "gsd_project_snapshot.verification");
	assertBoundedCollection(snapshot.milestones, "gsd_project_snapshot.milestones");
	requireString(snapshot.capturedAt, "gsd_project_snapshot.capturedAt");
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshot.capturedAt) || Number.isNaN(Date.parse(snapshot.capturedAt))) {
		throw new Error("gsd_project_snapshot.capturedAt: expected ISO-8601 UTC timestamp");
	}

	const envelope = requireRecord(structuredContent, "gsd_project_snapshot structuredContent");
	if (envelope.operation !== "read_project_snapshot") {
		throw new Error(`gsd_project_snapshot structuredContent.operation: expected read_project_snapshot, got ${describe(envelope.operation)}`);
	}
	if (envelope.revision !== authority.revision) {
		throw new Error(`gsd_project_snapshot structuredContent.revision: expected ${authority.revision}, got ${describe(envelope.revision)}`);
	}
	if (!isRecord(envelope.snapshot)) throw new Error("gsd_project_snapshot structuredContent.snapshot: expected object");
	if (JSON.stringify(canonicalize(envelope.snapshot)) !== JSON.stringify(canonicalize(snapshot))) {
		throw new Error("gsd_project_snapshot structuredContent.snapshot: deep value parity mismatch");
	}
	return snapshot;
}

export function assertProgressResult(result) {
	assertSuccessEnvelope(result, "gsd_progress");
	return assertProgressPayload(parseToolTextPayload(result, "gsd_progress"));
}

export function assertSnapshotResult(result) {
	assertSuccessEnvelope(result, "gsd_project_snapshot");
	const payload = parseToolTextPayload(result, "gsd_project_snapshot");
	return assertSnapshotPayload(payload, result.structuredContent);
}

async function main() {
	const cliJs = resolve(repoRoot, "packages/mcp-server/dist/cli.js");
	if (!existsSync(cliJs)) {
		console.error("Packaged MCP server not built. Run: pnpm run build:core");
		process.exitCode = 1;
		return;
	}

	const { createWorkflowAuthorityFixture } = await import(
		"../src/resources/extensions/gsd/tests/workflow-authority-fixture.ts"
	);
	const argProject = process.argv.includes("--project")
		? process.argv[process.argv.indexOf("--project") + 1]
		: null;
	const fixture = argProject ? null : await createWorkflowAuthorityFixture();
	const projectDir = argProject ? realpathSync(argProject) : fixture.root;
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
	const client = new Client({ name: "gsd-mcp-host-smoke", version: "0.0.0" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [cliJs],
		cwd: projectDir,
		env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: realpathSync(tmpdir()), GSD_NON_INTERACTIVE: "1" },
		stderr: "pipe",
	});
	const stderrChunks = [];
	transport.stderr?.on("data", (chunk) => {
		stderrChunks.push(String(chunk));
	});
	const results = [];
	function record(name, fn) {
		try {
			fn();
			results.push({ name, ok: true });
			console.log(`PASS  ${name}`);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			results.push({ name, ok: false });
			console.log(`FAIL  ${name} — ${detail}`);
		}
	}

	try {
		await client.connect(transport);
		const listed = await client.listTools();
		const names = listed.tools.map((tool) => tool.name);
		record("tools/list: gsd_progress advertised", () => {
			if (!names.includes("gsd_progress")) throw new Error("tool missing");
		});
		record("tools/list: gsd_project_snapshot advertised", () => {
			if (!names.includes("gsd_project_snapshot")) throw new Error("tool missing");
		});
		const progress = await client.callTool({ name: "gsd_progress", arguments: { projectDir } });
		record("gsd_progress: DB-authoritative payload", () => assertProgressResult(progress));
		const snapshot = await client.callTool({ name: "gsd_project_snapshot", arguments: { projectDir } });
		record("gsd_project_snapshot: bounded authoritative parity", () => assertSnapshotResult(snapshot));
	} catch (error) {
		record("probe completed without transport/protocol error", () => {
			const detail = error instanceof Error ? error.message : String(error);
			const serverStderr = stderrChunks.join("").trim();
			throw new Error(serverStderr ? `${detail}; server stderr: ${serverStderr.slice(-2000)}` : detail);
		});
	} finally {
		await client.close().catch(() => {});
		fixture?.cleanup();
	}

	const failed = results.filter((result) => !result.ok).length;
	console.log(`\n${results.length - failed}/${results.length} checks passed`);
	process.exitCode = failed === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
