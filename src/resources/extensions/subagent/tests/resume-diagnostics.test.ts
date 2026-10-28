// Resume preflight diagnostics (#2973): fresh children are launched with
// --no-session on purpose, so "no recorded child session" is a design fact —
// not a selector mistake. Every rejection must name its actual cause instead
// of collapsing into the generic agent-selector error, and the tool surface
// must return those diagnostics without launching any child.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import subagentExtension from "../index.js";
import { resolveResumeChild } from "../index.js";
import { type SubagentChildArtifact, type SubagentRunRecord, SubagentRunStore } from "../run-store.js";

function child(overrides: Partial<SubagentChildArtifact> = {}): SubagentChildArtifact {
	return {
		index: 0,
		agent: "scout",
		trackingName: "quiet-atlas",
		task: "survey the module",
		status: "succeeded",
		exitCode: 0,
		...overrides,
	};
}

function makeRecord(children: SubagentChildArtifact[], overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
	return {
		schemaVersion: 1,
		runId: "run-2973",
		mode: "single",
		contextMode: "fresh",
		status: "succeeded",
		cwd: "/repo",
		startedAt: "2026-10-20T00:00:00.000Z",
		updatedAt: "2026-10-20T00:01:00.000Z",
		children,
		...overrides,
	};
}

describe("resolveResumeChild diagnostics (#2973)", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	function persistedSessionFile(name: string): string {
		dir ??= mkdtempSync(join(tmpdir(), "gsd-subagent-resume-"));
		const filePath = join(dir, name);
		writeFileSync(filePath, "{}\n");
		return filePath;
	}

	it("reports a successful fresh child as sessionless by design, not a selector error", () => {
		const preflight = resolveResumeChild(makeRecord([child({ sessionFile: undefined })]));
		assert.equal(preflight.ok, false);
		if (preflight.ok) return;
		assert.equal(preflight.reason, "no_persisted_child_session");
		assert.match(preflight.message, /--no-session/, "the fresh-mode cause must be stated");
		assert.match(preflight.message, /context: "fork"/, "the supported continuation must be named");
		assert.doesNotMatch(preflight.message, /Available resumable agents/, "must not prescribe a selector that cannot help");
		assert.match(preflight.message, /no_persisted_child_session/, "reason code stays machine-findable");
	});

	it("reports a correctly selected but sessionless child as sessionless, naming the child", () => {
		const preflight = resolveResumeChild(
			makeRecord([child({ sessionFile: undefined })]),
			"scout",
		);
		assert.equal(preflight.ok, false);
		if (preflight.ok) return;
		assert.equal(preflight.reason, "selected_child_sessionless");
		assert.match(preflight.message, /quiet-atlas \/ scout/, "the matched child must be named");
		assert.match(preflight.message, /context: "fork"/);
		assert.doesNotMatch(preflight.message, /Available resumable agents/);
	});

	it("keeps the genuine no-selector ambiguity error with the resumable list", () => {
		const preflight = resolveResumeChild(makeRecord([
			child({ agent: "tester", trackingName: "swift-mesa", sessionFile: persistedSessionFile("a.json") }),
			child({ agent: "reviewer", trackingName: "calm-ridge", sessionFile: persistedSessionFile("b.json") }),
		]));
		assert.equal(preflight.ok, false);
		if (preflight.ok) return;
		assert.equal(preflight.reason, "ambiguous_selector");
		assert.match(preflight.message, /Resume requires exactly one child session or an agent selector/);
		assert.match(preflight.message, /swift-mesa \/ tester/);
		assert.match(preflight.message, /calm-ridge \/ reviewer/);
	});

	it("resumes the one resumable fork child among sessionless siblings", () => {
		const sessionFile = persistedSessionFile("fork.json");
		const preflight = resolveResumeChild(makeRecord([
			child({ sessionFile: undefined }),
			child({ agent: "reviewer", trackingName: "calm-ridge", sessionFile }),
		]));
		assert.equal(preflight.ok, true);
		if (!preflight.ok) return;
		assert.equal(preflight.child.sessionFile, sessionFile);
	});

	it("selects the one resumable child when the selector matches sessionless siblings too", () => {
		const sessionFile = persistedSessionFile("fork.json");
		const preflight = resolveResumeChild(makeRecord([
			child({ sessionFile: undefined }),
			child({ trackingName: "calm-ridge", sessionFile }),
		]), "scout");
		assert.equal(preflight.ok, true);
		if (!preflight.ok) return;
		assert.equal(preflight.child.sessionFile, sessionFile);
	});

	it("reports an unknown agent distinctly from the sessionless case", () => {
		const preflight = resolveResumeChild(
			makeRecord([child({ sessionFile: undefined })]),
			"ghost",
		);
		assert.equal(preflight.ok, false);
		if (preflight.ok) return;
		assert.equal(preflight.reason, "unknown_agent");
		assert.match(preflight.message, /no child agent "ghost"/);
		assert.match(preflight.message, /quiet-atlas \/ scout/, "recorded children stay visible");
	});

	it("reports same-agent multi-session ambiguity instead of guessing", () => {
		const preflight = resolveResumeChild(makeRecord([
			child({ trackingName: "swift-mesa", sessionFile: persistedSessionFile("a.json") }),
			child({ trackingName: "calm-ridge", sessionFile: persistedSessionFile("b.json") }),
		]), "scout");
		assert.equal(preflight.ok, false);
		if (preflight.ok) return;
		assert.equal(preflight.reason, "ambiguous_selector");
		assert.match(preflight.message, /matches 2 persisted child sessions/);
	});

	it("reports all-vanished sessions as missing, not as ambiguous available agents", () => {
		const missingPath = join(tmpdir(), "gsd-subagent-resume-does-not-exist.json");
		const preflight = resolveResumeChild(makeRecord([
			child({ trackingName: "swift-mesa", sessionFile: missingPath }),
			child({ trackingName: "calm-ridge", sessionFile: missingPath }),
		]));
		assert.equal(preflight.ok, false);
		if (preflight.ok) return;
		assert.equal(preflight.reason, "missing_session_file");
		assert.doesNotMatch(preflight.message, /Available resumable agents/, "gone sessions must not be listed as available");
	});

	it("proceeds when only one of several recorded sessions survives on disk", () => {
		const sessionFile = persistedSessionFile("survivor.json");
		const missingPath = join(tmpdir(), "gsd-subagent-resume-does-not-exist.json");
		const preflight = resolveResumeChild(makeRecord([
			child({ trackingName: "swift-mesa", sessionFile: missingPath }),
			child({ trackingName: "calm-ridge", sessionFile }),
		]));
		assert.equal(preflight.ok, true);
		if (!preflight.ok) return;
		assert.equal(preflight.child.sessionFile, sessionFile);
	});

	it("reports a recorded session file that vanished from disk", () => {
		const preflight = resolveResumeChild(makeRecord([
			child({ sessionFile: join(tmpdir(), "gsd-subagent-resume-does-not-exist.json") }),
		]));
		assert.equal(preflight.ok, false);
		if (preflight.ok) return;
		assert.equal(preflight.reason, "missing_session_file");
		assert.match(preflight.message, /no longer exists on disk/);
	});

	it("reports a record with no children at all", () => {
		const preflight = resolveResumeChild(makeRecord([]));
		assert.equal(preflight.ok, false);
		if (preflight.ok) return;
		assert.equal(preflight.reason, "no_children");
	});
});

describe("resume action surfaces the true state (#2973)", () => {
	const savedAgentDir = process.env.GSD_CODING_AGENT_DIR;
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		if (savedAgentDir === undefined) delete process.env.GSD_CODING_AGENT_DIR;
		else process.env.GSD_CODING_AGENT_DIR = savedAgentDir;
	});

	function makeHarness() {
		let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
		subagentExtension({
			on: () => {},
			registerCommand: () => {},
			registerTool: (definition: any) => {
				tool = definition;
			},
			sendMessage: () => Promise.resolve(),
		} as any);
		assert.ok(tool, "subagent tool was not registered");
		return {
			execute: (params: Record<string, unknown>, cwd: string) =>
				tool!.execute("tool-call-1", params, undefined, undefined, { cwd, hasUI: true }),
		};
	}

	function makeSchemaProbe(): { parameters: { properties: Record<string, { description?: string }> } } {
		let tool: { parameters: { properties: Record<string, { description?: string }> } } | undefined;
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

	function freshAgentDir(): string {
		dir = mkdtempSync(join(tmpdir(), "gsd-subagent-resume-tool-"));
		process.env.GSD_CODING_AGENT_DIR = dir;
		return dir;
	}

	it("a completed fresh run reports no_persisted_child_session, not the selector error", async () => {
		const cwd = freshAgentDir();
		const record = makeRecord([child({ sessionFile: undefined })], { runId: "run-fresh-2973" });
		new SubagentRunStore().create(record);
		const harness = makeHarness();

		const result = await harness.execute({ action: "resume", runId: record.runId, followUp: "continue" }, cwd);
		const text: string = result.content[0].text;
		assert.equal(result.isError, true);
		assert.match(text, /no_persisted_child_session/);
		assert.match(text, /--no-session/);
		assert.doesNotMatch(text, /Resume requires exactly one child session or an agent selector/);
	});

	it("a correctly selected sessionless child names the child instead of the selector error", async () => {
		const cwd = freshAgentDir();
		const record = makeRecord([child({ sessionFile: undefined })], { runId: "run-selected-2973" });
		new SubagentRunStore().create(record);
		const harness = makeHarness();

		const result = await harness.execute(
			{ action: "resume", runId: record.runId, agent: "scout", followUp: "continue" },
			cwd,
		);
		const text: string = result.content[0].text;
		assert.equal(result.isError, true);
		assert.match(text, /selected_child_sessionless/);
		assert.match(text, /quiet-atlas \/ scout/);
		assert.doesNotMatch(text, /Resume requires exactly one child session or an agent selector/);
	});

	it("the genuine no-selector ambiguity keeps its selector list on the tool surface", async () => {
		const cwd = freshAgentDir();
		// Session fixtures live under the suite dir so afterEach cleanup removes
		// them (no leaked temp files).
		const sessionDir = join(dir!, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const record = makeRecord([
			child({ agent: "tester", trackingName: "swift-mesa", sessionFile: join(sessionDir, "a.json") }),
			child({ agent: "reviewer", trackingName: "calm-ridge", sessionFile: join(sessionDir, "b.json") }),
		], { runId: "run-ambiguous-2973" });
		writeFileSync(join(sessionDir, "a.json"), "{}\n");
		writeFileSync(join(sessionDir, "b.json"), "{}\n");
		new SubagentRunStore().create(record);
		const harness = makeHarness();

		const result = await harness.execute({ action: "resume", runId: record.runId, followUp: "continue" }, cwd);
		const text: string = result.content[0].text;
		assert.equal(result.isError, true);
		assert.match(text, /Resume requires exactly one child session or an agent selector/);
		assert.match(text, /swift-mesa \/ tester/);
		assert.match(text, /calm-ridge \/ reviewer/);
	});

	it("status states per-child resumability instead of omitting the field", async () => {
		const cwd = freshAgentDir();
		const survivingSession = join(dir!, "survivor.json");
		writeFileSync(survivingSession, "{}\n");
		const vanishedSession = join(dir!, "gone.json");
		const record = makeRecord([
			child({ sessionFile: undefined, trackingName: "quiet-atlas" }),
			child({ agent: "reviewer", trackingName: "calm-ridge", sessionFile: survivingSession }),
			child({ agent: "auditor", trackingName: "keen-forge", sessionFile: vanishedSession }),
		], { runId: "run-status-2973" });
		new SubagentRunStore().create(record);
		const harness = makeHarness();

		const result = await harness.execute({ action: "status", runId: record.runId }, cwd);
		const text: string = result.content[0].text;
		assert.match(text, /session: none \(no persisted child session on record; fresh children run with --no-session\)/);
		assert.ok(text.includes(`  session: ${survivingSession}\n`), "an existing session file stays a plain path");
		assert.ok(
			text.includes(`  session: ${vanishedSession} (missing on disk; not resumable)`),
			"a vanished session file is flagged, not shown as available",
		);
	});

	it("the tool schema discloses fresh-mode ephemerality and fork-only resume", () => {
		const tool = makeSchemaProbe();
		const actionDescription = String(tool.parameters.properties.action?.description ?? "");
		const contextDescription = String(tool.parameters.properties.context?.description ?? "");
		assert.match(actionDescription, /--no-session/);
		assert.match(actionDescription, /context: "fork"/);
		assert.match(contextDescription, /ephemeral/);
		assert.match(contextDescription, /action: "resume"/);
	});
});
