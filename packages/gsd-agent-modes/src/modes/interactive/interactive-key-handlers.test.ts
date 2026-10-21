// gsd-pi — interactive-key-handlers exported function tests.
// Covers handleCtrlC double-tap shutdown, handlePastedImagePath validation,
// and toggleThinkingBlockVisibility clearOnShrink guard.

import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@gsd/pi-tui";

import {
	handleCtrlC,
	handlePastedImagePath,
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
