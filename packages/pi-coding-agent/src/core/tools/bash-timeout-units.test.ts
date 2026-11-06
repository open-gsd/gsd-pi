/**
 * Issue #3095 — bash tool timeout unit contract.
 *
 * The bash tool declared `timeout` in SECONDS while every sibling exec tool on
 * the same surface (gsd_exec / gsd_uat_exec) declares `timeout_ms` in
 * MILLISECONDS. Models transferring the ms convention to bash silently armed
 * ~55-hour deadlines (`timeout: 200000` → 200000s) and the panel echoed the
 * nonsense as "(timeout 200000s)".
 *
 * These tests pin the corrected contract:
 *  1. the schema declares `timeout_ms` (milliseconds) with no ambiguous bare
 *     `timeout` parameter;
 *  2. a `timeout_ms` value is applied as milliseconds end-to-end — normalized
 *     to seconds exactly ONCE, at the BashOperations.exec boundary, which keeps
 *     its seconds contract so existing implementers (local shell, SSH, sandbox
 *     examples) are not broken;
 *  3. the call renderer prints the human form and never echoes the raw ms
 *     value with an `s` suffix ("200000ms" must not render as "200000s").
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BashOperations,
	createBashTool,
	createBashToolDefinition,
} from "./bash.js";
import { initTheme } from "../../theme/theme.js";

const isWin = process.platform === "win32";

initTheme(undefined, false);

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderCallText(def: ReturnType<typeof createBashToolDefinition>, args: unknown): string {
	const component = def.renderCall(args as any, {} as any, {
		state: {},
		executionStarted: false,
	} as any);
	return stripAnsi(component.render(400).join("\n"));
}

// ---------------------------------------------------------------------------
// 1. Schema: the parameter is `timeout_ms` (milliseconds), unambiguous.
// ---------------------------------------------------------------------------
test("bash schema declares timeout_ms in milliseconds and no bare timeout", () => {
	const def = createBashToolDefinition(tmpdir());
	const properties = (def.parameters as any)?.properties ?? {};
	assert.ok(properties.timeout_ms, "bash tool must expose a `timeout_ms` parameter");
	assert.match(
		String(properties.timeout_ms.description ?? ""),
		/millisecond/i,
		"timeout_ms description must state the unit explicitly",
	);
	assert.equal(
		properties.timeout,
		undefined,
		"the ambiguous bare `timeout` (seconds) parameter must be gone",
	);
});

// ---------------------------------------------------------------------------
// 2. Boundary: ms → s normalization happens exactly once, at BashOperations.
//    ops.exec keeps its SECONDS contract; execute() owns the single division.
// ---------------------------------------------------------------------------
test("timeout_ms is normalized to seconds exactly once at the BashOperations boundary", async () => {
	const captured: Array<number | undefined> = [];
	const ops: BashOperations = {
		exec: async (_command, _cwd, options) => {
			captured.push(options.timeout);
			return { exitCode: 0 };
		},
	};
	const bash = createBashTool(tmpdir(), { operations: ops });

	await bash.execute("t-2s", { command: "echo hi", timeout_ms: 2000 });
	await bash.execute("t-500ms", { command: "echo hi", timeout_ms: 500 });
	await bash.execute("t-none", { command: "echo hi" });

	assert.deepEqual(
		captured,
		[2, 0.5, undefined],
		"execute must hand ops.exec seconds (timeout_ms / 1000), and undefined when no timeout is given",
	);
});

// ---------------------------------------------------------------------------
// 3. Applied duration: a `timeout_ms` value really arms a millisecond deadline
//    with the local shell backend (end-to-end schema → kill).
// ---------------------------------------------------------------------------
test(
	"timeout_ms arms a real millisecond deadline (1.2s kills a 10s sleep)",
	{ skip: isWin ? "Unix-primary spawn semantics; covered on POSIX" : false, timeout: 20_000 },
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "bash-timeout-units-"));
		try {
			const bash = createBashTool(dir);
			const start = Date.now();
			let timedOut = false;
			try {
				await bash.execute("t-ms", { command: "sleep 10", timeout_ms: 1200 });
			} catch (err) {
				timedOut = /timed out/i.test(err instanceof Error ? err.message : String(err));
			}
			const elapsed = Date.now() - start;
			assert.ok(timedOut, "a 1200ms timeout must kill `sleep 10` (command resolved without timing out)");
			assert.ok(
				elapsed < 8000,
				`timeout must fire at ~1.2s, not after the 10s sleep completes (elapsed ${elapsed}ms)`,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

// ---------------------------------------------------------------------------
// 4. Renderer: human form; the raw ms value must never be echoed with `s`.
// ---------------------------------------------------------------------------
test("renderer prints 200000ms as (timeout 200s), never (timeout 200000s)", () => {
	const def = createBashToolDefinition(tmpdir());
	const rendered = renderCallText(def, { command: "echo hi", timeout_ms: 200000 });
	assert.match(rendered, /\(timeout 200s\)/, `expected human form in: ${rendered}`);
	assert.doesNotMatch(rendered, /200000s/, "raw ms value must never be echoed with an s suffix");
	assert.doesNotMatch(rendered, /200000/, "raw ms value must not appear in the call label at all");
});

test("renderer keeps sub-second timeouts in ms", () => {
	const def = createBashToolDefinition(tmpdir());
	const rendered = renderCallText(def, { command: "echo hi", timeout_ms: 500 });
	assert.match(rendered, /\(timeout 500ms\)/, `expected ms form for sub-second timeout in: ${rendered}`);
});

test("renderer omits the timeout label when no timeout is given", () => {
	const def = createBashToolDefinition(tmpdir());
	const rendered = renderCallText(def, { command: "echo hi" });
	assert.doesNotMatch(rendered, /timeout/, `no timeout label expected in: ${rendered}`);
});

// ---------------------------------------------------------------------------
// 5. Error text: timeout errors state the enforced deadline, not the raw arg.
// ---------------------------------------------------------------------------
test("timeout error message reports the deadline in seconds", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bash-timeout-units-err-"));
	try {
		const bash = createBashTool(dir);
		let message = "";
		try {
			await bash.execute("t-err", { command: "sleep 10", timeout_ms: 1200 });
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		assert.match(message, /timed out after 1\.2 seconds/i, `expected seconds-based message in: ${message}`);
		assert.doesNotMatch(message, /1200 seconds/, "raw ms value must not be reported as seconds");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
