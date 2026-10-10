// gsd-pi — interactive-key-handlers exported function tests.
// Covers handleCtrlC double-tap shutdown, handlePastedImagePath validation,
// and toggleThinkingBlockVisibility clearOnShrink guard.

import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@gsd/pi-tui";

import {
	handleCtrlC,
	handlePastedImagePath,
	setupKeyHandlers,
	shutdown,
	toggleThinkingBlockVisibility,
} from "./interactive-key-handlers.js";
import {
	MIME_BY_EXT,
	matchesImageSignature,
} from "./interactive-mode-class-constants.js";

// ── helpers ──────────────────────────────────────────────────────────

function makeHost(extra: Record<string, unknown> = {}): any {
	const chatContainer = new Container();
	return {
		hideThinkingBlock: false,
		settingsManager: {
			setHideThinkingBlock(val: boolean) {
				this._hideThinkingBlock = val;
			},
			get _hideThinkingBlock() {
				return this.__hide ?? false;
			},
			set _hideThinkingBlock(val: boolean) {
				this.__hide = val;
			},
			__hide: false,
			flush: async () => {},
		},
		ui: {
			terminal: { drainInput: async () => {} },
			requestRender() {},
			getClearOnShrink() {
				return this._clearOnShrink ?? true;
			},
			setClearOnShrink(val: boolean) {
				this._clearOnShrink = val;
			},
			_clearOnShrink: true,
		},
		chatContainer,
		rebuildChatFromMessages() {},
		streamingComponent: null,
		streamingMessage: null,
		showStatus() {},
		showError() {},
		showWarning() {},
		options: {},
		isShuttingDown: false,
		session: {
			extensionRunner: null,
			isStreaming: false,
			isCompacting: false,
			abortCompaction() {},
			abortRetry() {},
		},
		isBashMode: false,
		updateEditorBorderColor() {},
		keybindings: {},
		pendingImages: [],
		lastSigintTime: 0,
		lastEscapeTime: 0,
		lastEscapeHandler: null,
		...extra,
	} as any;
}

// ── handleCtrlC ──────────────────────────────────────────────────────

test("handleCtrlC: first tap clears editor and records timestamp", () => {
	const host = makeHost();
	host.clearEditor = () => {
		host._editorCleared = true;
	};

	handleCtrlC(host);

	assert.equal(host._editorCleared, true, "editor must be cleared");
	assert.ok(
		Date.now() - host.lastSigintTime < 100,
		"lastSigintTime must be updated to now",
	);
	assert.equal(host._shutdownCalled, undefined, "shutdown must NOT be called");
});

test("handleCtrlC: double-tap within 500 ms triggers shutdown", async () => {
	const host = makeHost();
	let shutdownCalled = false;
	host.shutdown = async () => {
		shutdownCalled = true;
	};
	host.lastSigintTime = Date.now() - 200; // already within 500 ms

	handleCtrlC(host);

	assert.equal(shutdownCalled, true, "shutdown must be called on double-tap");
});

test("handleCtrlC: second tap after 500 ms only clears editor", async () => {
	const host = makeHost();
	let shutdownCalled = false;
	host.shutdown = async () => {
		shutdownCalled = true;
	};
	host.clearEditor = () => {};
	host.lastSigintTime = Date.now() - 600; // outside 500 ms window

	handleCtrlC(host);

	assert.equal(shutdownCalled, false, "shutdown must NOT be called");
	assert.ok(
		Date.now() - host.lastSigintTime < 100,
		"lastSigintTime must be updated",
	);
});

// ── handlePastedImagePath ────────────────────────────────────────────

test("handlePastedImagePath: unsupported extension inserts raw path", () => {
	const host = makeHost();
	const inserted: string[] = [];
	host.editor = {
		insertTextAtCursor(text: string) {
			inserted.push(text);
		},
	};

	handlePastedImagePath(host, "/some/path/file.xyz");

	assert.equal(inserted.length, 1);
	assert.equal(inserted[0], "/some/path/file.xyz", "raw path must be inserted for unsupported extension");
});

test("handlePastedImagePath: unsupported extensions list is correct", () => {
	assert.ok("png" in MIME_BY_EXT, "png must be supported");
	assert.ok("jpg" in MIME_BY_EXT, "jpg must be supported");
	assert.ok("jpeg" in MIME_BY_EXT, "jpeg must be supported");
	assert.ok("gif" in MIME_BY_EXT, "gif must be supported");
	assert.ok("webp" in MIME_BY_EXT, "webp must be supported");
	assert.equal(MIME_BY_EXT["xyz"], undefined, "xyz must not be supported");
});

// ── shutdown hard-exit watchdog (#2515) ──────────────────────────────

type TeardownEvent =
	| { kind: "exit"; code: number }
	| { kind: "kill"; pid: number; signal: string }
	| { kind: "terminal-stop" };

interface ProcessTeardownRecorder {
	events: TeardownEvent[];
}

/**
 * Stub process.exit/process.kill to record into one ordered event log
 * instead of terminating/signaling; restored via t.after.
 */
function recordProcessTeardown(t: { after: (fn: () => void) => void }): ProcessTeardownRecorder {
	const recorder: ProcessTeardownRecorder = { events: [] };
	const originalExit = process.exit;
	const originalKill = process.kill;
	(process as unknown as { exit: (code?: number) => never }).exit = ((exitCode?: number) => {
		recorder.events.push({ kind: "exit", code: exitCode ?? 0 });
		return undefined as never;
	}) as never;
	(process as unknown as { kill: (pid: number, signal?: string) => unknown }).kill = (pid: number, signal?: string) => {
		recorder.events.push({ kind: "kill", pid, signal: signal ?? "SIGTERM" });
		return true;
	};
	t.after(() => {
		process.exit = originalExit;
		process.kill = originalKill;
	});
	return recorder;
}

test("shutdown force-exits when an extension session_shutdown handler hangs", async (t) => {
	const orphanPid = process.pid + 987_654;
	const host = makeHost({
		stop() {},
		session: {
			extensionRunner: {
				hasHandlers: () => true,
				// runner.emit awaits handlers with no deadline; a wedged handler
				// (dead MCP child, hung parallel-worker stop) never resolves.
				emit: () => new Promise(() => {}),
			},
		},
	});
	const recorder = recordProcessTeardown(t);
	host.ui.terminal.stop = () => {
		recorder.events.push({ kind: "terminal-stop" });
	};

	const pending = shutdown(host, {
		hardExitMs: 50,
		listDescendants: () => [orphanPid],
	});
	pending.catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 500));
	// One ordered log proves terminal cleanup and the SIGKILL both land
	// BEFORE the forced exit.
	assert.deepEqual(recorder.events, [
		{ kind: "terminal-stop" },
		{ kind: "kill", pid: orphanPid, signal: "SIGKILL" },
		{ kind: "exit", code: 0 },
	]);
});

test("exit_process shutdown completes and exits exactly once", async (t) => {
	const host = makeHost({ stop() {} });
	let stopCalled = false;
	host.stop = () => {
		stopCalled = true;
	};
	const recorder = recordProcessTeardown(t);

	await shutdown(host, { hardExitMs: 100, listDescendants: () => [] });
	assert.equal(stopCalled, true, "graceful teardown must still run host.stop()");
	assert.deepEqual(recorder.events, [{ kind: "exit", code: 0 }]);
	// Past the (shortened) watchdog deadline nothing further may fire — the
	// graceful completion must have cancelled the timer.
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.deepEqual(recorder.events, [{ kind: "exit", code: 0 }]);
});

test("stop_ui shutdown rethrows teardown errors without exiting", async (t) => {
	const host = makeHost({
		stop() {},
		options: { shutdownBehavior: "stop_ui" },
	});
	host.stop = () => {
		throw new Error("widget disposer exploded");
	};
	const recorder = recordProcessTeardown(t);

	await assert.rejects(
		shutdown(host, { hardExitMs: 5_000, listDescendants: () => [] }),
		/widget disposer exploded/,
		"stop_ui must propagate the original teardown error",
	);
	assert.deepEqual(recorder.events, [], "stop_ui must never terminate the embedding process");
});

test("stop_ui shutdown never arms the hard-exit watchdog", async (t) => {
	const host = makeHost({
		stop() {},
		options: { shutdownBehavior: "stop_ui" },
	});
	// Hang a teardown step: the pre-fix unconditional watchdog fired
	// process.exit(0) inside the embedding process from this exact state.
	host.settingsManager.flush = () => new Promise(() => {});
	let stopCalled = false;
	host.stop = () => {
		stopCalled = true;
	};
	const recorder = recordProcessTeardown(t);

	const pending = shutdown(host, { hardExitMs: 20 });
	pending.catch(() => {});
	// Regression guard for an unconditional-watchdog variant of this fix
	// (review round 1): it armed a process.exit(0) timer even for stop_ui and
	// fired it here while the flush hung, killing the embedding process.
	// Post-fix no timer is armed for stop_ui, so the window records nothing.
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.deepEqual(recorder.events, [], "stop_ui must never terminate the embedding process");
	assert.equal(stopCalled, false, "hung flush must not be raced by a forced stop");
});

test("shutdown still exits when a teardown step throws", async (t) => {
	const orphanPid = process.pid + 987_654;
	const host = makeHost({});
	let stopCalled = false;
	host.stop = () => {
		stopCalled = true;
		throw new Error("widget disposer exploded");
	};
	const recorder = recordProcessTeardown(t);
	host.ui.terminal.stop = () => {
		recorder.events.push({ kind: "terminal-stop" });
	};

	const pending = shutdown(host, { hardExitMs: 5_000, listDescendants: () => [orphanPid] });
	pending.catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(stopCalled, true, "the throwing teardown step must have been reached");
	// Full ordered sequence for the forced-exit catch path: terminal cleanup,
	// then the orphan SIGKILL, then exit. The recording stub returns where
	// real process.exit terminates, so the catch falls through to the final
	// exit — the first exit(0) is the guarantee, the second is stub fallout.
	assert.deepEqual(recorder.events, [
		{ kind: "terminal-stop" },
		{ kind: "kill", pid: orphanPid, signal: "SIGKILL" },
		{ kind: "exit", code: 0 },
		{ kind: "exit", code: 0 },
	]);
});

test("handlePastedImagePath: logic flow for known extension — valid PNG", () => {
	// matchesImageSignature requires buf.length >= 12
	const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
	assert.equal(matchesImageSignature(pngBuffer, "image/png"), true, "valid PNG signature");
	assert.equal(pngBuffer.length, 16, "buffer length");
});

test("handlePastedImagePath: logic flow — JPEG mismatch on .png", () => {
	const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
	assert.equal(matchesImageSignature(jpegBuffer, "image/png"), false, "JPEG bytes fail PNG check");
});

test("handlePastedImagePath: logic flow — valid JPEG signature", () => {
	const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
	assert.equal(matchesImageSignature(jpegBuffer, "image/jpeg"), true, "valid JPEG signature");
});

test("handlePastedImagePath: logic flow — valid GIF signature", () => {
	const gifBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
	assert.equal(matchesImageSignature(gifBuffer, "image/gif"), true, "valid GIF signature");
});

test("handlePastedImagePath: logic flow — valid WebP signature", () => {
	const webpBuffer = Buffer.from("RIFF\x00\x00\x00\x00WEBP");
	assert.equal(matchesImageSignature(webpBuffer, "image/webp"), true, "valid WebP signature");
});

test("handlePastedImagePath: logic flow — too-short buffer rejected", () => {
	const shortBuffer = Buffer.from("\x89PN");
	assert.equal(matchesImageSignature(shortBuffer, "image/png"), false, "short buffer rejected");
});

// ── toggleThinkingBlockVisibility ────────────────────────────────────

test("toggleThinkingBlockVisibility: toggles hideThinkingBlock and calls setClearOnShrink", () => {
	const host = makeHost();
	let setClearCalls: boolean[] = [];
	host.ui.setClearOnShrink = (val: boolean) => {
		setClearCalls.push(val);
		host.ui._clearOnShrink = val;
	};

	toggleThinkingBlockVisibility(host);

	assert.equal(host.hideThinkingBlock, true, "hideThinkingBlock must be toggled to true");
	assert.ok(setClearCalls.includes(false), "setClearOnShrink(false) must be called during rebuild");
	assert.equal(host.settingsManager.__hide, true, "settings must be persisted");
});

test("toggleThinkingBlockVisibility: restores previous clearOnShrink after rebuild", () => {
	const host = makeHost();
	const previousValue = true; // simulate a non-default previous value
	host.ui._clearOnShrink = previousValue;

	toggleThinkingBlockVisibility(host);

	// After toggle, clearOnShrink must be restored to the previous value
	assert.equal(host.ui._clearOnShrink, previousValue, "clearOnShrink must be restored after rebuild");
	assert.equal(host.hideThinkingBlock, true, "hideThinkingBlock must be toggled");
});

test("toggleThinkingBlockVisibility: restores clearOnShrink even when rebuild throws (try/finally)", () => {
	const host = makeHost();
	host.ui._clearOnShrink = true;

	// Make rebuildChatFromMessages throw to verify try/finally behavior
	host.rebuildChatFromMessages = () => {
		throw new Error("simulated rebuild failure");
	};

	assert.throws(
		() => toggleThinkingBlockVisibility(host),
		{ message: "simulated rebuild failure" },
		"rebuildChatFromMessages error must propagate",
	);

	// clearOnShrink must still be restored despite the error
	assert.equal(
		host.ui._clearOnShrink,
		true,
		"clearOnShrink must be restored via try/finally even when rebuild throws",
	);
});

test("toggleThinkingBlockVisibility: re-adds streaming component when present", () => {
	const host = makeHost();
	const chatContainer = host.chatContainer;
	const mockComponent = { setHideThinkingBlock() {}, updateContent() {} };
	host.streamingComponent = mockComponent;
	host.streamingMessage = { role: "assistant", content: [] };

	toggleThinkingBlockVisibility(host);

	// The streaming component should still be referenced
	assert.equal(host.streamingComponent, mockComponent);
	assert.equal(host.streamingComponent?.setHideThinkingBlock?.called, undefined);
	// The key assertion is that no error is thrown and the component survives the rebuild
});

// ── Escape ───────────────────────────────────────────────────────────

/** Host with the editor surface `setupKeyHandlers` wires, recording interrupt requests. */
function makeEscapeHost(extra: Record<string, unknown> = {}): any {
	const interrupts: Array<{ abort?: boolean } | undefined> = [];
	const host = makeHost({
		defaultEditor: { onAction() {} },
		editor: { getText: () => "", setText() {} },
		settingsManager: { getDoubleEscapeAction: () => "none" },
		restoreQueuedMessagesToEditor(options?: { abort?: boolean }) {
			interrupts.push(options);
			return 0;
		},
		...extra,
	});
	host.session.isBashRunning = false;
	setupKeyHandlers(host);
	return { host, interrupts };
}

test("Escape interrupts the turn while the default loader is shown", () => {
	const { host, interrupts } = makeEscapeHost({ loadingAnimation: { stop() {} } });

	host.defaultEditor.onEscape();

	assert.deepEqual(interrupts, [{ abort: true }]);
});

test("Escape interrupts the turn when an extension replaced the loader with the activity indicator", () => {
	// GSD auto-mode calls setWorkingMessage(null) for every unit: the default
	// loader is gone and only the activity indicator marks the turn in flight.
	const { host, interrupts } = makeEscapeHost({ loadingAnimation: undefined, activityLoader: { stop() {} } });

	host.defaultEditor.onEscape();

	assert.deepEqual(interrupts, [{ abort: true }]);
});

test("Escape interrupts nothing when no turn is in flight", () => {
	const { host, interrupts } = makeEscapeHost();

	host.defaultEditor.onEscape();

	assert.deepEqual(interrupts, []);
});
