// Project/App: gsd-pi
// File Purpose: Regression tests for the shared gsd_exec/gsd_uat_exec TUI rendering (issue #2914 slice 1).
//
// Covers: purpose surfacing (explicit, runtime-label fallback, neutral invalid),
// output-log pointers with full original paths, bounded digest preview labeled
// as a tail (not the full log), structured run_not_recorded visibility without
// scanning content for warning markers, legacy fail-soft fallback, control-
// sequence sanitization, and the additive purpose/digest executor details.

import test from "node:test";
import assert from "node:assert/strict";

import { registerExecTools } from "../bootstrap/exec-tools.ts";
import { executeGsdExec, executeUatExec } from "../tools/exec-tool.ts";
import type { ExecSandboxRequest, ExecSandboxResult } from "../exec-sandbox.ts";

function makeMockPi() {
	const tools: any[] = [];
	return {
		registerTool: (tool: any) => tools.push(tool),
		tools,
	} as any;
}

const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => `<i>${text}</i>`,
};

function getTool(name: string) {
	const pi = makeMockPi();
	registerExecTools(pi);
	const tool = pi.tools.find((t: any) => t.name === name);
	assert.ok(tool, `${name} should be registered`);
	return tool;
}

function renderText(component: any): string {
	assert.ok(component, "renderer should return a component");
	return component.render(200).join("\n");
}

function makeExecResult(overrides: Partial<ExecSandboxResult> = {}): ExecSandboxResult {
	return {
		id: "exec-1",
		runtime: "bash",
		exit_code: 0,
		signal: null,
		timed_out: false,
		aborted: false,
		force_resolved: false,
		duration_ms: 12,
		stdout_bytes: 12,
		stderr_bytes: 0,
		stdout_truncated: false,
		stderr_truncated: false,
		stdout_path: ".gsd/exec/exec-1.stdout",
		stderr_path: ".gsd/exec/exec-1.stderr",
		meta_path: ".gsd/exec/exec-1.meta.json",
		digest: "check passed",
		...overrides,
	};
}

// ─── renderCall ───────────────────────────────────────────────────────────────

test("gsd_exec renderCall shows an explicit purpose in muted italic", () => {
	const tool = getTool("gsd_exec");
	const args = { runtime: "bash", script: "echo hi", purpose: "grep failing tests" };
	const text = renderText(tool.renderCall(args, fakeTheme));
	assert.ok(text.includes("Exec (Sandboxed)"), `label missing: ${text}`);
	assert.ok(text.includes("grep failing tests"), `purpose missing: ${text}`);
	assert.ok(text.includes("<i>grep failing tests</i>"), `purpose not italic: ${text}`);
});

test("gsd_exec renderCall falls back to a runtime label when purpose is omitted", () => {
	const tool = getTool("gsd_exec");
	assert.ok(renderText(tool.renderCall({ runtime: "python3", script: "print(1)" }, fakeTheme)).includes("Python script"));
	assert.ok(renderText(tool.renderCall({ script: "echo hi" }, fakeTheme)).includes("Bash script"));
});

test("gsd_exec renderCall uses a neutral script label for invalid runtime values", () => {
	const tool = getTool("gsd_exec");
	const text = renderText(tool.renderCall({ runtime: "ruby", script: "puts 1" }, fakeTheme));
	assert.match(text, /\bscript\b/i, `neutral label missing: ${text}`);
	assert.ok(!text.includes("Ruby"), `invented label for invalid runtime: ${text}`);
});

test("gsd_exec renderCall treats whitespace-only runtime as the bash default and never leaks prototype names", () => {
	const tool = getTool("gsd_exec");
	assert.ok(renderText(tool.renderCall({ runtime: "   ", script: "echo hi" }, fakeTheme)).includes("Bash script"));
	const proto = renderText(tool.renderCall({ runtime: "constructor", script: "echo hi" }, fakeTheme));
	assert.ok(!/function|\[object Object\]/.test(proto), `inherited property leaked: ${proto}`);
	const protoPath = renderText(tool.renderCall({ runtime: "__proto__", script: "echo hi" }, fakeTheme));
	assert.ok(!/\[object Object\]/.test(protoPath), `prototype leaked: ${protoPath}`);
});

test("gsd_exec renderCall display-normalizes purpose without mutating args", () => {
	const tool = getTool("gsd_exec");
	const args: any = { script: "echo hi", purpose: "  run\t\ntests  " };
	const text = renderText(tool.renderCall(args, fakeTheme));
	assert.ok(text.includes("run tests"), `normalized purpose missing: ${text}`);
	assert.equal(args.purpose, "  run\t\ntests  ", "original args.purpose must not be mutated");
});

test("gsd_uat_exec renderCall derives a running purpose from UAT metadata", () => {
	const tool = getTool("gsd_uat_exec");
	const args = { milestoneId: "M001", sliceId: "S01", checkId: "UAT-01", intent: "uat-runtime-check", script: "echo hi" };
	const text = renderText(tool.renderCall(args, fakeTheme));
	assert.ok(text.includes("UAT Exec"), `label missing: ${text}`);
	assert.ok(text.includes("UAT M001/S01/UAT-01 (uat-runtime-check)"), `derived purpose missing: ${text}`);
});

test("gsd_uat_exec renderCall prefers an explicit purpose over the derived one", () => {
	const tool = getTool("gsd_uat_exec");
	const args = {
		milestoneId: "M001",
		sliceId: "S01",
		checkId: "UAT-01",
		intent: "uat-runtime-check",
		purpose: "probe service health",
		script: "echo hi",
	};
	const text = renderText(tool.renderCall(args, fakeTheme));
	assert.ok(text.includes("probe service health"), `explicit purpose missing: ${text}`);
});

// ─── renderResult ─────────────────────────────────────────────────────────────

function successResult(details: Record<string, unknown>, contentText?: string) {
	return {
		content: [{ type: "text", text: contentText ?? "gsd_exec[exec-1] runtime=bash exit=0\n--- digest ---\ncheck passed" }],
		details,
		isError: false,
	};
}

test("gsd_exec renderResult shows status, byte counts, and full original output paths", () => {
	const tool = getTool("gsd_exec");
	const stdoutPath = "/tmp/gsd exec dir/run é\xff.stdout";
	const result = successResult({
		operation: "gsd_exec",
		id: "exec-1",
		runtime: "bash",
		exit_code: 0,
		signal: null,
		timed_out: false,
		duration_ms: 250,
		stdout_bytes: 1234,
		stderr_bytes: 0,
		stdout_truncated: false,
		stderr_truncated: false,
		stdout_path: stdoutPath,
		stderr_path: "/tmp/gsd exec dir/run é.stderr",
		meta_path: "/tmp/gsd exec dir/run é.meta.json",
		digest: "check passed",
	});
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(text.includes("exit 0"), `status missing: ${text}`);
	assert.ok(text.includes("1234B"), `stdout bytes missing: ${text}`);
	assert.ok(text.includes("0B"), `stderr zero-byte count not distinct from missing: ${text}`);
	assert.ok(text.includes(stdoutPath), `full original stdout path not preserved: ${text}`);
	assert.ok(text.includes("/tmp/gsd exec dir/run é.stderr"), `full original stderr path not preserved: ${text}`);
	assert.ok(!text.includes("undefined"), `undefined leaked: ${text}`);
});

test("gsd_exec renderResult labels the digest as a bounded tail preview from structured details", () => {
	const tool = getTool("gsd_exec");
	const result = successResult(
		{
			operation: "gsd_exec",
			id: "exec-1",
			exit_code: 0,
			stdout_bytes: 5000,
			stderr_bytes: 0,
			stdout_path: ".gsd/exec/exec-1.stdout",
			stderr_path: ".gsd/exec/exec-1.stderr",
			digest: "tail of stdout here",
		},
		"gsd_exec[exec-1] runtime=bash exit=0",
	);
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(text.includes("tail of stdout here"), `digest preview missing: ${text}`);
	assert.ok(/preview/i.test(text), `preview not labeled as a preview: ${text}`);
	assert.ok(/not the full log/i.test(text), `preview not distinguished from the full log: ${text}`);
	assert.ok(!/tail of stdout,/.test(text), `preview label must be stream-neutral (stderr-tail digests exist): ${text}`);
});

test("gsd_exec renderResult keeps a stderr-tail digest renderable without mislabeling it as stdout", () => {
	const tool = getTool("gsd_exec");
	const result = successResult({
		operation: "gsd_exec",
		id: "exec-1",
		exit_code: 0,
		stdout_bytes: 0,
		stderr_bytes: 40,
		stdout_path: ".gsd/exec/exec-1.stdout",
		stderr_path: ".gsd/exec/exec-1.stderr",
		digest: "[no stdout — tail of stderr]\nerr line",
	});
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(text.includes("err line"), `stderr-tail digest lost: ${text}`);
	assert.ok(!text.includes("tail of stdout"), `stderr tail mislabeled as stdout: ${text}`);
});

test("gsd_exec renderResult distinguishes truncated captures from complete ones", () => {
	const tool = getTool("gsd_exec");
	const result = successResult({
		operation: "gsd_exec",
		id: "exec-1",
		exit_code: 0,
		stdout_bytes: 999999,
		stdout_truncated: true,
		stderr_bytes: 0,
		stderr_truncated: false,
		stdout_path: ".gsd/exec/exec-1.stdout",
		stderr_path: ".gsd/exec/exec-1.stderr",
		digest: "partial",
	});
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(text.includes("(truncated)"), `truncation flag missing: ${text}`);
});

test("gsd_exec renderResult omits output rows when metadata is missing and does not throw", () => {
	const tool = getTool("gsd_exec");
	const result = successResult({ operation: "gsd_exec", exit_code: 0 });
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(!text.includes("stdout "), `stdout row invented without metadata: ${text}`);
	assert.ok(!text.includes("undefined"), `undefined leaked: ${text}`);
});

test("gsd_exec renderResult surfaces run_not_recorded from structured details only", () => {
	const tool = getTool("gsd_exec");
	const markerOutput = "all tests passed\n--- warning ---\nmarker-like ordinary output";
	const withWarning = successResult(
		{
			operation: "gsd_exec",
			exit_code: 0,
			stdout_bytes: 60,
			stderr_bytes: 0,
			stdout_path: ".gsd/exec/exec-1.stdout",
			stderr_path: ".gsd/exec/exec-1.stderr",
			digest: markerOutput,
		},
		markerOutput,
	);
	const clean = renderText(tool.renderResult(withWarning, {}, fakeTheme));
	assert.ok(!clean.includes("not recorded"), `digest text misclassified as a recording warning: ${clean}`);

	const recorded = successResult(
		{
			operation: "gsd_exec",
			exit_code: 0,
			stdout_bytes: 12,
			stderr_bytes: 0,
			stdout_path: ".gsd/exec/exec-1.stdout",
			stderr_path: ".gsd/exec/exec-1.stderr",
			digest: "check passed",
			run_not_recorded: "workflow database locked",
		},
	);
	const warned = renderText(tool.renderResult(recorded, {}, fakeTheme));
	assert.ok(warned.includes("not recorded"), `structured warning missing: ${warned}`);
	assert.ok(warned.includes("workflow database locked"), `warning reason missing: ${warned}`);
});

test("gsd_exec renderResult keeps genuine warning visibility for legacy rows without details", () => {
	const tool = getTool("gsd_exec");
	const legacyText =
		"gsd_exec[exec-9] runtime=bash exit=0\n" +
		"--- warning ---\nThe command ran, but the host did not record this run: workflow database locked.";
	const result = { content: [{ type: "text", text: legacyText }], isError: false };
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(text.includes("did not record this run"), `legacy warning lost: ${text}`);
	assert.ok(!text.includes("undefined"), `undefined leaked: ${text}`);
});

test("gsd_exec renderResult keeps recorded output visible for historical rows that have details but no digest", () => {
	const tool = getTool("gsd_exec");
	// Pre-slice result shape: details already carried status/paths, the output
	// only existed in content text.
	const historical = successResult(
		{
			operation: "gsd_exec",
			id: "exec-1",
			runtime: "bash",
			exit_code: 0,
			signal: null,
			timed_out: false,
			duration_ms: 5,
			stdout_bytes: 30,
			stderr_bytes: 0,
			stdout_truncated: false,
			stderr_truncated: false,
			stdout_path: ".gsd/exec/exec-1.stdout",
			stderr_path: ".gsd/exec/exec-1.stderr",
			meta_path: ".gsd/exec/exec-1.meta.json",
		},
		"gsd_exec[exec-1] runtime=bash exit=0 duration=5ms\n--- digest ---\nthe actual recorded output",
	);
	const text = renderText(tool.renderResult(historical, {}, fakeTheme));
	assert.ok(text.includes("the actual recorded output"), `historical content dropped: ${text}`);
	assert.ok(text.includes("exit 0"), `historical status lost: ${text}`);
});

test("gsd_exec renderResult keeps structured recording warnings visible on execution failures", () => {
	const tool = getTool("gsd_exec");
	const longDigest = Array.from({ length: 30 }, (_, i) => `out ${i}`).join("\n");
	const contentText =
		`gsd_exec[exec-1] runtime=bash exit=1 duration=9ms\n--- digest ---\n${longDigest}\n` +
		"--- warning ---\nThe command ran, but the host did not record this run: db locked.";
	const result = {
		content: [{ type: "text", text: contentText }],
		details: {
			operation: "gsd_exec",
			id: "exec-1",
			exit_code: 1,
			timed_out: false,
			stdout_bytes: 200,
			stderr_bytes: 0,
			stdout_path: ".gsd/exec/exec-1.stdout",
			stderr_path: ".gsd/exec/exec-1.stderr",
			run_not_recorded: "db locked",
		},
		isError: true,
	};
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(text.includes("not recorded"), `structured warning hidden on failure: ${text}`);
	assert.ok(text.includes("db locked"), `warning reason hidden on failure: ${text}`);
	assert.ok(text.includes("exit=1"), `failure content lost: ${text}`);
});

test("gsd_exec renderResult bounds the legacy content fallback", () => {
	const tool = getTool("gsd_exec");
	const longText = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
	const result = { content: [{ type: "text", text: longText }], isError: false };
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	const rows = text.split("\n").length;
	assert.ok(rows < 40, `legacy fallback not bounded: ${rows} rows`);
});

test("gsd_exec renderResult shows errors without throwing on missing fields", () => {
	const tool = getTool("gsd_exec");
	const result = {
		content: [{ type: "text", text: "Error: script is required and must be a non-empty string" }],
		details: { operation: "gsd_exec", error: "invalid_params" },
		isError: true,
	};
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(text.includes("script is required"), `error text missing: ${text}`);
	assert.ok(!text.includes("undefined"), `undefined leaked: ${text}`);

	const bare = { content: [], isError: true };
	const bareText = renderText(tool.renderResult(bare, {}, fakeTheme));
	assert.ok(!bareText.includes("undefined"), `undefined leaked on bare error: ${bareText}`);
});

test("gsd_exec renderResult strips terminal escapes and control sequences from displayed text", () => {
	const tool = getTool("gsd_exec");
	const dirtyDigest = "\x1b[31mred\x1b[0m output\x07 with\x08controls";
	const result = successResult({
		operation: "gsd_exec",
		exit_code: 0,
		stdout_bytes: 40,
		stderr_bytes: 0,
		stdout_path: ".gsd/exec/exec-1.stdout",
		stderr_path: ".gsd/exec/exec-1.stderr",
		digest: dirtyDigest,
	});
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(text.includes("red"), `sanitized text content lost: ${JSON.stringify(text)}`);
	assert.ok(!text.includes("\x1b"), `ANSI escape survived: ${JSON.stringify(text)}`);
	assert.ok(!text.includes("\x07"), `bell control survived: ${JSON.stringify(text)}`);
	assert.ok(!text.includes("\x08"), `backspace control survived: ${JSON.stringify(text)}`);
});

test("gsd_exec renderResult strips OSC and CSI sequence payloads, not just their ESC byte", () => {
	const tool = getTool("gsd_exec");
	const dirty = "\u001B]8;;http://evil.example\u0007link\u001B]8;;\u0007 and \u001B[2Jready";
	const result = successResult({
		operation: "gsd_exec",
		exit_code: 0,
		stdout_bytes: 60,
		stderr_bytes: 0,
		stdout_path: ".gsd/exec/exec-1.stdout",
		stderr_path: ".gsd/exec/exec-1.stderr",
		digest: dirty,
	});
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(text.includes("link"), ` OSC-wrapped text lost: ${JSON.stringify(text)}`);
	assert.ok(text.includes("ready"), `post-CSI text lost: ${JSON.stringify(text)}`);
	assert.ok(!text.includes("http://evil.example"), `OSC payload survived: ${JSON.stringify(text)}`);
	assert.ok(!text.includes("[2J"), `CSI fragment survived: ${JSON.stringify(text)}`);
});

test("gsd_exec renderResult sanitizes untrusted metadata strings (paths, reasons)", () => {
	const tool = getTool("gsd_exec");
	const result = successResult({
		operation: "gsd_exec",
		exit_code: 0,
		stdout_bytes: 4,
		stderr_bytes: 0,
		stdout_path: "/tmp/\u001B[31mx/.gsd/exec/exec-1.stdout",
		stderr_path: ".gsd/exec/exec-1.stderr",
		digest: "ok",
		run_not_recorded: "reason\u0007with bell",
	});
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(!text.includes("\u001B"), `path escape survived: ${JSON.stringify(text)}`);
	assert.ok(!text.includes("\u0007"), `reason bell survived: ${JSON.stringify(text)}`);
	assert.ok(text.includes("reasonwith bell"), `sanitized reason text lost: ${JSON.stringify(text)}`);
});

// ─── executor details (additive purpose/digest) ───────────────────────────────

async function runExecutor(params: any) {
	let request: ExecSandboxRequest | undefined;
	const result = await executeGsdExec(params, {
		baseDir: "/tmp/gsd-exec-renderer-test",
		preferences: null,
		run: async (req) => {
			request = req;
			return makeExecResult();
		},
	});
	return { result, request };
}

	test("executeGsdExec records purpose and digest in details without changing content", async () => {
	const { result, request } = await runExecutor({ runtime: "bash", script: "printf ok", purpose: "grep failing tests" });
	assert.equal(result.isError, false);
	assert.equal(result.details?.purpose, "grep failing tests");
	assert.equal(result.details?.digest, "check passed");
	assert.equal(request?.purpose, "grep failing tests", "original purpose must be forwarded unchanged");
	// Byte-for-byte: the summary format must be identical to the pre-slice shape.
	assert.equal(
		result.content[0]?.text,
		"gsd_exec[exec-1] runtime=bash exit=0 duration=12ms\n" +
			"  stdout: 12B → .gsd/exec/exec-1.stdout\n" +
			"  stderr: 0B → .gsd/exec/exec-1.stderr\n" +
			"--- digest ---\n" +
			"check passed",
	);
	assert.ok(!result.content[0]?.text.includes("grep failing tests"), "purpose must not be appended to content text");
});

test("executeGsdExec omits the purpose detail (absent, not null) when not provided", async () => {
	const { result } = await runExecutor({ runtime: "bash", script: "printf ok" });
	assert.equal(result.details?.digest, "check passed");
	assert.ok(!("purpose" in (result.details ?? {})), `purpose should be absent, got: ${result.details?.purpose}`);
});

test("executeUatExec records the synthesized purpose in details", async () => {
	const result = await executeUatExec(
		{ milestoneId: "M001", sliceId: "S01", checkId: "UAT-PRE", intent: "artifact", runtime: "bash", script: "printf ok" },
		{
			baseDir: "/tmp/gsd-uat-renderer-test",
			preferences: null,
			run: async (request) => makeExecResult(request),
		},
	);
	assert.equal(result.isError, false);
	assert.equal(result.details?.purpose, "UAT M001/S01/UAT-PRE (uat-artifact-check)");
	assert.equal(result.details?.digest, "check passed");
});

// ─── Failed-execution stderr diagnostics (issue #2927) ───────────────────────
test("gsd_exec renderResult builds the structured failure card with both previews and the warning", () => {
	const tool = getTool("gsd_exec");
	const longDigest = Array.from({ length: 30 }, (_, i) => `out ${i}`).join("\n");
	const contentText =
		`gsd_exec[exec-1] runtime=bash exit=1 duration=9ms\n--- digest ---\n${longDigest}\n` +
		"--- stderr (tail) ---\nError: real cause detected\n" +
		"--- warning ---\nThe command ran, but the host did not record this run: db locked.";
	const result = {
		content: [{ type: "text", text: contentText }],
		details: {
			operation: "gsd_exec",
			id: "exec-1",
			exit_code: 1,
			timed_out: false,
			duration_ms: 9,
			stdout_bytes: 199,
			stderr_bytes: 27,
			stdout_path: ".gsd/exec/exec-1.stdout",
			stderr_path: ".gsd/exec/exec-1.stderr",
			digest: longDigest,
			stderr_excerpt: "Error: real cause detected",
			run_not_recorded: "db locked",
		},
		isError: true,
	};
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	// A long stdout digest must not push the stderr diagnostics or the
	// recording warning out of the fixed error budget.
	assert.ok(text.includes("Error: real cause detected"), `stderr diagnostics hidden by long digest: ${text}`);
	assert.ok(text.includes("failure diagnostics"), `labeled stderr section missing: ${text}`);
	assert.ok(text.includes("out 0"), `stdout preview missing: ${text}`);
	assert.ok(text.includes("not recorded"), `structured warning hidden: ${text}`);
	assert.ok(text.includes("exit 1"), `status missing: ${text}`);
	assert.ok(text.includes(".gsd/exec/exec-1.stderr"), `persisted path missing: ${text}`);
	const rows = text.split("\n").length;
	assert.ok(rows < 40, `error card not bounded: ${rows} rows`);
});

test("gsd_exec renderResult falls back to bounded content for failures without preview fields", () => {
	const tool = getTool("gsd_exec");
	const result = {
		content: [{ type: "text", text: "Error: gsd_exec failed — spawn boom" }],
		details: { operation: "gsd_exec", error: "spawn_boom" },
		isError: true,
	};
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(text.includes("spawn boom"), `content fallback lost: ${text}`);
	assert.ok(!text.includes("failure diagnostics"), `unexpected structured card: ${text}`);
});

test("gsd_exec renderResult keeps the final stderr lines visible for multiline tails", () => {
	const tool = getTool("gsd_exec");
	const excerpt = Array.from({ length: 12 }, (_, i) => `context ${i}`).join("\n") + "\nError: final cause";
	const result = {
		content: [{ type: "text", text: `gsd_exec[exec-1] runtime=bash exit=1 duration=9ms\n--- digest ---\nout\n--- stderr (tail) ---\n${excerpt}` }],
		details: {
			operation: "gsd_exec",
			id: "exec-1",
			exit_code: 1,
			digest: "out",
			stderr_excerpt: excerpt,
		},
		isError: true,
	};
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(text.includes("Error: final cause"), `final diagnostic elided away: ${text}`);
	assert.ok(text.includes("more lines hidden"), `elision marker missing: ${text}`);
	const rows = text.split("\n").length;
	assert.ok(rows < 40, `error card not bounded: ${rows} rows`);
});

test("gsd_exec renderResult skips the stderr panel for whitespace-only excerpts", () => {
	const tool = getTool("gsd_exec");
	const result = {
		content: [{ type: "text", text: "gsd_exec[exec-1] runtime=bash exit=1 duration=9ms\n--- digest ---\nout" }],
		details: {
			operation: "gsd_exec",
			id: "exec-1",
			exit_code: 1,
			digest: "out",
			stderr_excerpt: "  \n\t\n",
		},
		isError: true,
	};
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(!text.includes("failure diagnostics"), `blank stderr panel rendered: ${text}`);
	assert.ok(text.includes("out"), `stdout preview missing: ${text}`);
});

test("gsd_exec renderResult keeps the final lines of a stderr-only marker digest visible", () => {
	const tool = getTool("gsd_exec");
	const stderrTail = Array.from({ length: 12 }, (_, i) => `context ${i}`).join("\n") + "\nError: final cause";
	const digest = `[no stdout — tail of stderr]\n${stderrTail}`;
	const result = {
		content: [{ type: "text", text: `gsd_exec[exec-1] runtime=bash exit=1 duration=9ms\n--- digest ---\n${digest}` }],
		details: {
			operation: "gsd_exec",
			id: "exec-1",
			exit_code: 1,
			digest,
		},
		isError: true,
	};
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(text.includes("Error: final cause"), `marker-digest final diagnostic elided: ${text}`);
	assert.ok(text.includes("no stdout — tail of stderr"), `marker label missing: ${text}`);
	const rows = text.split("\n").length;
	assert.ok(rows < 40, `error card not bounded: ${rows} rows`);
});

test("gsd_exec renderResult never surfaces a stderr section on success rows", () => {
	const tool = getTool("gsd_exec");
	// Successes have no stderr_excerpt by construction; even if stale details
	// carry one, the success card renders the stdout digest preview only.
	const result = {
		content: [{ type: "text", text: "gsd_exec[exec-1] runtime=bash exit=0 duration=5ms\n--- digest ---\nok" }],
		details: {
			operation: "gsd_exec",
			id: "exec-1",
			exit_code: 0,
			digest: "ok",
			stderr_excerpt: "stale",
		},
		isError: false,
	};
	const text = renderText(tool.renderResult(result, {}, fakeTheme));
	assert.ok(!text.includes("failure diagnostics"), `success row gained a stderr section: ${text}`);
	assert.ok(text.includes("ok"), `digest preview missing: ${text}`);
});
