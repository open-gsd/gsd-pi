import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setKittyProtocolActive } from "./keys.js";
import { DISABLE_MOUSE, ENABLE_MOUSE } from "./mouse.js";
import { StdinBuffer } from "./stdin-buffer.js";

const cjsRequire = createRequire(import.meta.url);

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";

export function shouldEnableMouseReporting(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_TUI_MOUSE === "1";
}

/** True when stdout is no longer writable (pipe closed, terminal detached). */
export function isStdoutClosedError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const errno = err as NodeJS.ErrnoException;
	if (errno.code === "EPIPE") return true;
	if (errno.code === "EIO" && errno.syscall === "write") return true;
	const message = err.message;
	return message === "write EOF" || message === "read EOF" || message === "write EIO";
}

/**
 * Minimal terminal interface for TUI
 */
export interface Terminal {
	// Whether the terminal is interactive
	readonly isTTY: boolean;

	// Start the terminal with input and resize handlers
	start(onInput: (data: string) => void, onResize: () => void): void;

	// Stop the terminal and restore state
	stop(): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// Write output to terminal
	write(data: string): void;

	// Get terminal dimensions
	get columns(): number;
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	// Clear operations
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Title operations
	setTitle(title: string): void; // Set terminal window title

	// Progress indicator (OSC 9;4)
	setProgress(active: boolean): void;

	/** True after stdout became unwritable (pipe closed). */
	readonly outputClosed?: boolean;

	/** Called once when stdout is no longer writable. */
	setOutputClosedHandler?(handler: () => void): void;
}

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _kittyProtocolActive = false;
	private _modifyOtherKeysActive = false;
	private _mouseActive = false;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private progressInterval?: ReturnType<typeof setInterval>;
	private _outputClosed = false;
	private outputClosedHandler?: () => void;
	private writeLogPath = (() => {
		const env = process.env.PI_TUI_WRITE_LOG || "";
		if (!env) return "";
		try {
			if (fs.statSync(env).isDirectory()) {
				const now = new Date();
				const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
				return path.join(env, `tui-${ts}-${process.pid}.log`);
			}
		} catch {
			// Not an existing directory - use as-is (file path)
		}
		return env;
	})();

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	get isTTY(): boolean {
		return Boolean(process.stdout.isTTY);
	}

	get outputClosed(): boolean {
		return this._outputClosed;
	}

	setOutputClosedHandler(handler: () => void): void {
		this.outputClosedHandler = handler;
		if (this._outputClosed) {
			handler();
		}
	}

	private writeStdout(data: string | Uint8Array): void {
		if (this._outputClosed) return;
		try {
			process.stdout.write(data);
		} catch (err) {
			if (isStdoutClosedError(err)) {
				this.markOutputClosed();
				return;
			}
			throw err;
		}
	}

	private markOutputClosed(): void {
		if (this._outputClosed) return;
		this._outputClosed = true;
		this.clearProgressInterval();
		const handler = this.outputClosedHandler;
		this.outputClosedHandler = undefined;
		handler?.();
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		// Idempotency guard: if start() is called again without an intervening
		// stop() (e.g. a mis-paired suspend/resume cycle), detach any stale
		// listeners first so they don't accumulate on the long-lived
		// process.stdin/stdout and trip MaxListenersExceededWarning. No-op on a
		// fresh start since all handles are undefined.
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		if (!this.isTTY) {
			this.inputHandler = onInput;
			this.resizeHandler = onResize;
			return;
		}

		this.inputHandler = onInput;
		this.resizeHandler = onResize;

		// Save previous state and enable raw mode
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		this.writeStdout("\x1b[?2004h");

		// Mouse reporting lets clicks and the wheel reach the TUI, but terminal
		// mouse capture prevents native click-drag text selection in most
		// emulators. Keep native selection as the default; set PI_TUI_MOUSE=1 to
		// opt into mouse reporting.
		if (shouldEnableMouseReporting()) {
			this.writeStdout(ENABLE_MOUSE);
			this._mouseActive = true;
		}

		// Set up resize handler immediately
		process.stdout.on("resize", this.resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run AFTER setRawMode(true)
		// since that resets console mode flags.
		this.enableWindowsVTInput();

		// Query and enable Kitty keyboard protocol
		// The query handler intercepts input temporarily, then installs the user's handler
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.queryAndEnableKittyProtocol();
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	private setupStdinBuffer(): void {
		this.stdinBuffer = new StdinBuffer({ timeout: 10 });

		// Kitty protocol response pattern: \x1b[?<flags>u
		const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

		// Forward individual sequences to the input handler
		this.stdinBuffer.on("data", (sequence) => {
			// Check for Kitty protocol response (only if not already enabled)
			if (!this._kittyProtocolActive) {
				const match = sequence.match(kittyResponsePattern);
				if (match) {
					this._kittyProtocolActive = true;
					setKittyProtocolActive(true);

					// Enable Kitty keyboard protocol (push flags)
					// Flag 1 = disambiguate escape codes
					// Flag 2 = report event types (press/repeat/release)
					// Flag 4 = report alternate keys (shifted key, base layout key)
					// Base layout key enables shortcuts to work with non-Latin keyboard layouts
					this.writeStdout("\x1b[>7u");
					return; // Don't forward protocol response to TUI
				}
			}

			if (this.inputHandler) {
				this.inputHandler(sequence);
			}
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.stdinDataHandler = (data: string) => {
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable if available.
	 *
	 * Sends CSI ? u to query current flags. If terminal responds with CSI ? <flags> u,
	 * it supports the protocol and we enable it with CSI > 1 u.
	 *
	 * If no Kitty response arrives shortly after startup, fall back to enabling
	 * xterm modifyOtherKeys mode 2. This is needed for tmux, which can forward
	 * modified enter keys as CSI-u when extended-keys is enabled, but may not
	 * answer the Kitty protocol query.
	 *
	 * The response is detected in setupStdinBuffer's data handler, which properly
	 * handles the case where the response arrives split across multiple stdin events.
	 */
	private queryAndEnableKittyProtocol(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		this.writeStdout("\x1b[?u");
		setTimeout(() => {
			if (!this._kittyProtocolActive && !this._modifyOtherKeysActive) {
				this.writeStdout("\x1b[>4;2m");
				this._modifyOtherKeysActive = true;
			}
		}, 150);
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
	 * console handle so the terminal sends VT sequences for modified keys
	 * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
	 * discards modifier state and Shift+Tab arrives as plain \t.
	 */
	private enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		try {
			const arch = process.arch;
			if (arch !== "x64" && arch !== "arm64") return;

			// Dynamic require so non-Windows and bundled/browser paths never load the
			// native helper. In the npm package native/ is next to dist/; in compiled
			// binary archives native/ is copied next to the executable.
			const moduleDir = path.dirname(fileURLToPath(import.meta.url));
			const nativePath = path.join("native", "win32", "prebuilds", `win32-${arch}`, "win32-console-mode.node");
			const candidates = [
				path.join(moduleDir, "..", nativePath),
				path.join(moduleDir, nativePath),
				path.join(path.dirname(process.execPath), nativePath),
			];
			for (const modulePath of candidates) {
				try {
					const helper = cjsRequire(modulePath) as { enableVirtualTerminalInput?: () => boolean };
					helper.enableVirtualTerminalInput?.();
					return;
				} catch {
					// Try the next possible packaging location.
				}
			}
		} catch {
			// Native helper not available — Shift+Tab won't be distinguishable from Tab.
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		if (this._kittyProtocolActive) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			this.writeStdout("\x1b[<u");
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this._modifyOtherKeysActive) {
			this.writeStdout("\x1b[>4;0m");
			this._modifyOtherKeysActive = false;
		}
		if (this._mouseActive) {
			this.writeStdout(DISABLE_MOUSE);
			this._mouseActive = false;
		}

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	stop(): void {
		if (this.clearProgressInterval()) {
			this.writeStdout(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		// Disable bracketed paste mode
		this.writeStdout("\x1b[?2004l");

		// Disable mouse reporting if not already done by drainInput()
		if (this._mouseActive) {
			this.writeStdout(DISABLE_MOUSE);
			this._mouseActive = false;
		}

		// Disable Kitty keyboard protocol if not already done by drainInput()
		if (this._kittyProtocolActive) {
			this.writeStdout("\x1b[<u");
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this._modifyOtherKeysActive) {
			this.writeStdout("\x1b[>4;0m");
			this._modifyOtherKeysActive = false;
		}

		// Clean up StdinBuffer
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	write(data: string): void {
		this.writeStdout(data);
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	get columns(): number {
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}

	get rows(): number {
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			this.writeStdout(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			this.writeStdout(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		this.writeStdout("\x1b[?25l");
	}

	showCursor(): void {
		this.writeStdout("\x1b[?25h");
	}

	clearLine(): void {
		this.writeStdout("\x1b[K");
	}

	clearFromCursor(): void {
		this.writeStdout("\x1b[J");
	}

	clearScreen(): void {
		this.writeStdout("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		this.writeStdout(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		if (active) {
			// OSC 9;4;3 - indeterminate progress
			this.writeStdout(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.progressInterval) {
				this.progressInterval = setInterval(() => {
					this.writeStdout(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
			}
		} else {
			this.clearProgressInterval();
			// OSC 9;4;0 - clear progress
			this.writeStdout(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	private clearProgressInterval(): boolean {
		if (!this.progressInterval) return false;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		return true;
	}
}
