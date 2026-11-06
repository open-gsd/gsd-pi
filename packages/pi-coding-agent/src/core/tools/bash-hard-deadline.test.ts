/**
 * Unit test for the hard-deadline force-resolve in createLocalBashOperations.
 *
 * A true D-state (uninterruptible-sleep) child never emits `close`/`exit` even
 * after SIGKILL, so `await waitForChildProcess(child)` would hang the sync bash
 * path forever. The graceful-kill ladder sends the signals but cannot
 * force-resolve the awaiting caller — the hard deadline must live in the caller.
 *
 * Reproducing a real D-state portably is impractical, so we simulate the exact
 * symptom (child never closes before the deadline) deterministically: a
 * SIGTERM-ignoring child combined with a LARGE killGraceMs (so the SIGKILL
 * escalation never fires inside the test window) and a SHORT forceResolveDelayMs.
 * The child therefore stays open past the hard deadline, forcing the caller to
 * force-resolve — proving the no-hang guarantee and the (force-killed) marker.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool, createLocalBashOperations } from "./bash.js";

const isWin = process.platform === "win32";

// Wall-clock guard: reject if the call has not settled by `ms`. Proves no-hang
// independently of the assertions on timing/markers.
function wallClockGuard<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			const t = setTimeout(() => reject(new Error(`Call did not settle within ${ms}ms (hang)`)), ms);
			if (typeof t === "object" && "unref" in t) t.unref();
		}),
	]);
}

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n") ?? ""
	);
}

// Clean up the detached SIGTERM-ignoring child (and its process group) that the
// large killGraceMs intentionally leaves alive.
function cleanupByPidFile(pidFile: string): void {
	if (!existsSync(pidFile)) return;
	const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
	if (!Number.isFinite(pid) || pid <= 0) return;
	if (isWin) {
		// Best-effort; not exercised on win32 (test is skipped there).
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
}

test(
	"createLocalBashOperations: non-closing (SIGTERM-ignoring) child force-resolves via hard deadline without hanging",
	{ skip: isWin ? "Unix-primary graceful semantics; force-resolve covered on POSIX" : false, timeout: 20_000 },
	async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "bash-hard-deadline-"));
		const pidFile = join(dir, "child.pid");
		t.after(() => {
			cleanupByPidFile(pidFile);
			rmSync(dir, { recursive: true, force: true });
		});

		// Timing seams: SIGKILL never fires in-window (graceMs huge), so the only way
		// the call can settle is the hard deadline -> proves the caller-side deadline.
		const KILL_GRACE_MS = 30_000;
		const FORCE_RESOLVE_DELAY_MS = 800;
		// Generous timeout so the SIGTERM trap is reliably installed before the kill
		// fires, even under heavy parallel test load. With a too-tight timeout the
		// kill can land before `trap '' TERM` runs, SIGTERM takes its default action,
		// the child closes on SIGTERM, and the force-resolve path never runs.
		const TIMEOUT_SECS = 2; // when the kill is initiated

		// Install the SIGTERM trap FIRST so the shell is already immune by the time
		// the kill fires; then record the shell's PID (process-group leader) for
		// cleanup and print partial output. The shell loops forever holding its
		// stdout pipe open. A single SIGTERM kills the current inner `sleep`, but the
		// loop re-spawns it and bash itself ignores TERM and never exits -> `close`
		// never fires -> waitForChildProcess hangs -> the caller's hard deadline must
		// resolve.
		const command =
			`trap '' TERM; printf 'PARTIAL_OUTPUT\\n'; echo $$ > '${pidFile}'; while true; do sleep 1; done`;

		const bashTool = createBashTool(dir, {
			operations: createLocalBashOperations({
				killGraceMs: KILL_GRACE_MS,
				forceResolveDelayMs: FORCE_RESOLVE_DELAY_MS,
			}),
		});

		const start = Date.now();
		let settledText = "";
		await wallClockGuard(
			(async () => {
				try {
					const result = await bashTool.execute("hard-deadline-test", {
					command,
					timeout_ms: TIMEOUT_SECS * 1000,
				});
					// Should not reach here — a non-closing child must force-resolve via throw.
					settledText = getTextOutput(result as any);
					throw new Error(`Expected force-resolve throw, but resolved with: ${settledText}`);
				} catch (err) {
					if (err instanceof Error) settledText = err.message;
					else throw err;
				}
			})(),
			15_000,
		);
		const elapsed = Date.now() - start;

		// (a) Did not hang and settled via the hard deadline, NOT via SIGKILL: the
		//     SIGKILL grace is 30s, so settling well under it proves the caller-side
		//     force-resolve fired (not the kill ladder). Bound is the force-resolve
		//     band plus generous CI slack, kept below the 15s wallClockGuard.
		assert.ok(
			elapsed < TIMEOUT_SECS * 1000 + FORCE_RESOLVE_DELAY_MS + 8_000,
			`Expected force-resolve well before SIGKILL grace (${KILL_GRACE_MS}ms), but took ${elapsed}ms`,
		);
		// (b) Settled roughly at timeout + forceResolveDelay (give generous slack).
		const expectedFloor = TIMEOUT_SECS * 1000; // kill initiated no earlier than this
		assert.ok(
			elapsed >= expectedFloor && elapsed <= expectedFloor + FORCE_RESOLVE_DELAY_MS + 8_000,
			`Expected settle near ${expectedFloor + FORCE_RESOLVE_DELAY_MS}ms, but took ${elapsed}ms`,
		);
		// (c) Rendered text preserves partial output AND carries the force-killed marker.
		assert.match(settledText, /PARTIAL_OUTPUT/, `Expected partial output in:\n${settledText}`);
		assert.match(settledText, /force-killed/, `Expected force-killed marker in:\n${settledText}`);
	},
);
