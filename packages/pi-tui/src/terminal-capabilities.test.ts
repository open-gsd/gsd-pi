/**
 * Tests for getKeyboardCapabilities() (#2372): the modifyOtherKeys enable
 * request (CSI > 4;2m) has no reply, so confirmation must come from observing
 * the first ESC[27;<mod>;<cp>~ frame on stdin after that request — and the
 * capability answer must be exported for consumers that advertise chords.
 *
 * Lives under src/ (not test/) so the compiled package-test pipeline
 * (test:compile + run-package-tests) picks it up.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isModifyOtherKeysFrame } from "./keys.ts";
import { getKeyboardCapabilities, ProcessTerminal } from "./terminal.ts";

interface Harness {
	writes: string[];
	feed: (data: string) => void;
	/** Point feed() at the next registered stdin "data" handler (a new session). */
	useNextHandler: () => void;
	received: string[];
	terminal: ProcessTerminal;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start a ProcessTerminal against a faked TTY. Real timers are kept: the
 * 150ms modifyOtherKeys request must actually fire. The stdin "data" handlers
 * are captured (not attached) so tests can feed sequences directly; feed()
 * targets the handler selected by useNextHandler() (the current session's
 * StdinBuffer handler by default).
 */
async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
	const previousStdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const previousStdinIsRaw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
	const previousSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
	const previousSetEncoding = process.stdin.setEncoding;
	const previousResume = process.stdin.resume;
	const previousPause = process.stdin.pause;
	const previousWrite = process.stdout.write;
	const previousKill = process.kill;
	const previousOn = process.stdin.on;
	const writes: string[] = [];
	const received: string[] = [];
	const dataHandlers: Array<(data: string) => void> = [];
	let feedIndex = 0;
	let terminal: ProcessTerminal | undefined;

	try {
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "isRaw", { value: false, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
		process.stdin.setEncoding = (() => process.stdin) as typeof process.stdin.setEncoding;
		process.stdin.resume = (() => process.stdin) as typeof process.stdin.resume;
		process.stdin.pause = (() => process.stdin) as typeof process.stdin.pause;
		process.stdout.write = ((data: string | Uint8Array) => {
			writes.push(typeof data === "string" ? data : data.toString());
			return true;
		}) as typeof process.stdout.write;
		process.kill = (() => true) as typeof process.kill;
		process.stdin.on = ((event: string, handler: (...args: unknown[]) => void) => {
			if (event === "data") dataHandlers.push(handler as (data: string) => void);
			return process.stdin;
		}) as typeof process.stdin.on;

		terminal = new ProcessTerminal();
		terminal.start((data) => received.push(data), () => {});
		assert.ok(dataHandlers.length > 0, "stdin data handler is registered");
		await run({
			writes,
			received,
			feed: (data) => dataHandlers[feedIndex]!(data),
			useNextHandler: () => {
				feedIndex++;
			},
			terminal,
		});
	} finally {
		terminal?.stop();
		if (previousStdoutIsTty) {
			Object.defineProperty(process.stdout, "isTTY", previousStdoutIsTty);
		} else {
			Reflect.deleteProperty(process.stdout, "isTTY");
		}
		if (previousStdinIsRaw) {
			Object.defineProperty(process.stdin, "isRaw", previousStdinIsRaw);
		} else {
			Reflect.deleteProperty(process.stdin, "isRaw");
		}
		if (previousSetRawMode) {
			Object.defineProperty(process.stdin, "setRawMode", previousSetRawMode);
		} else {
			Reflect.deleteProperty(process.stdin, "setRawMode");
		}
		process.stdin.setEncoding = previousSetEncoding;
		process.stdin.resume = previousResume;
		process.stdin.pause = previousPause;
		process.stdout.write = previousWrite;
		process.kill = previousKill;
		process.stdin.on = previousOn;
	}
}

describe("getKeyboardCapabilities", () => {
	it("reports unknown before any observation", async () => {
		await withHarness(async () => {
			assert.deepEqual(getKeyboardCapabilities(), { kitty: false, modifyOtherKeys: "unknown" });
		});
	});

	it("confirms modifyOtherKeys on the first ESC[27;m;cp~ frame and still forwards it", async () => {
		await withHarness(async ({ writes, feed, received }) => {
			await sleep(250); // let the 150ms request fire
			assert.equal(writes.includes("\x1b[>4;2m"), true, "modifyOtherKeys enable request is sent");
			assert.deepEqual(getKeyboardCapabilities(), { kitty: false, modifyOtherKeys: "unknown" });

			feed("\x1b[27;6;110~"); // Ctrl+Shift+N in modifyOtherKeys form
			await sleep(20);
			assert.deepEqual(getKeyboardCapabilities(), { kitty: false, modifyOtherKeys: "confirmed" });
			assert.deepEqual(received, ["\x1b[27;6;110~"], "observed frame must still reach input matching");
		});
	});

	it("does not confirm frames that arrive before the enable request", async () => {
		await withHarness(async ({ feed }) => {
			feed("\x1b[27;6;110~"); // mode 2 left on by a previous app — not our evidence
			await sleep(250); // the request fires here
			assert.deepEqual(getKeyboardCapabilities(), { kitty: false, modifyOtherKeys: "unknown" });
		});
	});

	it("stays unknown when the terminal never sends a frame", async () => {
		await withHarness(async ({ writes, feed, received }) => {
			await sleep(250);
			assert.equal(writes.includes("\x1b[>4;2m"), true);
			feed("abc"); // plain input must not confirm the mode
			feed("\x1b[1;5C"); // ctrl+right legacy sequence, not a 27;~ frame
			await sleep(20);
			assert.deepEqual(received, ["a", "b", "c", "\x1b[1;5C"]);
			assert.deepEqual(getKeyboardCapabilities(), { kitty: false, modifyOtherKeys: "unknown" });
		});
	});

	it("reports absent while the Kitty protocol is active and never requests modifyOtherKeys", async () => {
		await withHarness(async ({ writes, feed, received }) => {
			feed("\x1b[?1u"); // Kitty protocol query response
			await sleep(250); // the 150ms fallback timer elapses
			assert.equal(writes.includes("\x1b[>4;2m"), false, "no modifyOtherKeys request once Kitty is active");
			assert.deepEqual(received, [], "protocol response is not forwarded to the TUI");
			assert.deepEqual(getKeyboardCapabilities(), { kitty: true, modifyOtherKeys: "absent" });
		});
	});

	it("stop() disables the mode and resets capabilities to unknown", async () => {
		await withHarness(async ({ writes, feed, terminal }) => {
			await sleep(250);
			feed("\x1b[27;5;99~");
			await sleep(20);
			assert.deepEqual(getKeyboardCapabilities(), { kitty: false, modifyOtherKeys: "confirmed" });

			terminal.stop();
			assert.equal(writes.includes("\x1b[>4;0m"), true, "disable sequence is written");
			assert.deepEqual(getKeyboardCapabilities(), { kitty: false, modifyOtherKeys: "unknown" });
		});
	});

	it("a frame arriving after drainInput() cannot resurrect confirmation", async () => {
		await withHarness(async ({ writes, feed, terminal }) => {
			await sleep(250);
			feed("\x1b[27;5;99~");
			await sleep(20);
			assert.deepEqual(getKeyboardCapabilities(), { kitty: false, modifyOtherKeys: "confirmed" });

			await terminal.drainInput(200, 20);
			assert.equal(writes.includes("\x1b[>4;0m"), true, "drain disables the mode");
			assert.deepEqual(getKeyboardCapabilities(), { kitty: false, modifyOtherKeys: "unknown" });

			feed("\x1b[27;5;99~"); // queued frame after disable — no request is pending
			await sleep(20);
			assert.deepEqual(getKeyboardCapabilities(), { kitty: false, modifyOtherKeys: "unknown" });

			terminal.stop(); // must stay unknown (reset is not gated on the disable write)
			assert.deepEqual(getKeyboardCapabilities(), { kitty: false, modifyOtherKeys: "unknown" });
		});
	});

	it("a later session can re-confirm after a previous one reset the shared answer", async () => {
		await withHarness(async ({ feed, useNextHandler, terminal }) => {
			await sleep(250);
			feed("\x1b[27;5;99~");
			await sleep(20);
			terminal.stop();
			assert.deepEqual(getKeyboardCapabilities(), { kitty: false, modifyOtherKeys: "unknown" });

			const next = new ProcessTerminal();
			next.start(() => {}, () => {});
			useNextHandler(); // feed() now targets the new session's StdinBuffer handler
			try {
				await sleep(250);
				feed("\x1b[27;6;110~");
				await sleep(20);
				assert.deepEqual(getKeyboardCapabilities(), { kitty: false, modifyOtherKeys: "confirmed" });
			} finally {
				next.stop();
			}
		});
	});
});

describe("isModifyOtherKeysFrame", () => {
	it("matches only the xterm 27;~ frame format", () => {
		assert.equal(isModifyOtherKeysFrame("\x1b[27;6;110~"), true);
		assert.equal(isModifyOtherKeysFrame("\x1b[27;5;99~"), true);
		assert.equal(isModifyOtherKeysFrame("\x1b[1;5C"), false);
		assert.equal(isModifyOtherKeysFrame("\x1b[?1u"), false);
		assert.equal(isModifyOtherKeysFrame("abc"), false);
		assert.equal(isModifyOtherKeysFrame("\x1b[27;6;110;2~"), false);
	});
});
