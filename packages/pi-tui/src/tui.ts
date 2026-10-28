/**
 * Minimal TUI implementation with differential rendering
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { isKeyRelease, matchesKey } from "./keys.js";
import { isMouseEvent, type MouseEvent, parseMouseEvent } from "./mouse.js";
import type { Terminal } from "./terminal.js";
import { isStdoutClosedError } from "./terminal.js";
import {
	deleteKittyImage,
	getCapabilities,
	isImageLine,
	parseCellSizeResponse,
	setCellDimensions,
} from "./terminal-image.js";
import {
	extractAnsiCode,
	extractSegments,
	isWhitespaceChar,
	normalizeTerminalOutput,
	sliceByColumn,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
} from "./utils.js";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

function extractKittyImageIds(line: string): number[] {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return [];

	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return [];

	const params = line.slice(paramsStart, paramsEnd);
	for (const param of params.split(",")) {
		const [key, value] = param.split("=", 2);
		if (key !== "i" || value === undefined) continue;
		const id = Number(value);
		if (Number.isInteger(id) && id > 0 && id <= 0xffffffff) {
			return [id];
		}
	}
	return [];
}

/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * Optional handler for mouse input (clicks and wheel).
	 *
	 * Coordinates are component-local and 0-based: `x` is the column and `y`
	 * the row within this component's own rendered output. Container-style
	 * components are responsible for translating coordinates before forwarding
	 * to children.
	 */
	handleMouse?(event: MouseEvent): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

const DEBUG_RENDER_LOG_LIMIT = 50;
const DEBUG_RENDER_LOG_PATTERN = /^render-\d+-[a-z0-9]+\.log$/;

export function pruneDebugRenderLogs(debugDir: string, maxFiles = DEBUG_RENDER_LOG_LIMIT): void {
	if (maxFiles < 1) return;
	let entries: { name: string; mtimeMs: number }[];
	try {
		entries = fs.readdirSync(debugDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && DEBUG_RENDER_LOG_PATTERN.test(entry.name))
			.map((entry) => {
				const fullPath = path.join(debugDir, entry.name);
				return { name: entry.name, mtimeMs: fs.statSync(fullPath).mtimeMs };
			});
	} catch {
		return;
	}

	entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
	for (const entry of entries.slice(maxFiles)) {
		try {
			fs.unlinkSync(path.join(debugDir, entry.name));
		} catch {
			// Debug log cleanup must never break rendering.
		}
	}
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Layout ===
	/**
	 * Dock the overlay below the content instead of painting over it. The content
	 * is pushed up by the overlay's height, so nothing the overlay is about to ask
	 * about (e.g. a summary the user must read before answering) is hidden. The
	 * overlay occupies the bottom rows of the screen; anchor/row/offsetY are ignored,
	 * width/col still apply. Default: false (float over the content).
	 */
	reserveSpace?: boolean;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** If true, don't capture keyboard focus when shown */
	nonCapturing?: boolean;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
	/** Focus this overlay and bring it to the visual front */
	focus(): void;
	/** Release focus to the previous target */
	unfocus(): void;
	/** Check if this overlay currently has focus */
	isFocused(): boolean;
}

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

	// Row range each child occupied at the last render, used to route mouse
	// events to the child under the pointer.
	private childRanges: { component: Component; start: number; lineCount: number }[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	/** GSD compat: detach all children without destroying them. */
	detachChildren(): Component[] {
		const detached = this.children;
		this.children = [];
		return detached;
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		this.childRanges = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			this.childRanges.push({ component: child, start: lines.length, lineCount: childLines.length });
			for (const line of childLines) {
				lines.push(line);
			}
		}
		return lines;
	}

	handleMouse(event: MouseEvent): void {
		// Children are stacked vertically at full width; find the one under the
		// pointer and forward with row-local coordinates.
		for (const range of this.childRanges) {
			if (event.y >= range.start && event.y < range.start + range.lineCount) {
				range.component.handleMouse?.({ ...event, y: event.y - range.start });
				return;
			}
		}
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	public terminal: Terminal;
	private previousLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	// High-water mark of leading lines pushed past the bottom row into terminal
	// scrollback. Advanced only by writers that actually scroll (the pristine
	// render and the differential append path); a clean repaint may start at
	// this mark but never above it, so it can only skip lines a scroll has
	// already preserved (#2415).
	private flushedLineCount = 0;
	// Terminal dimensions at which flushedLineCount was last established. The
	// mark is positional, so it only identifies flushed lines while the layout
	// that produced it is still current. Tracked separately from
	// previousWidth/previousHeight because a forced render overwrites those
	// with -1 sentinels and would otherwise hide a coalesced real resize.
	private flushedAtWidth = 0;
	private flushedAtHeight = 0;
	// Frame discarded by a forced render: requestRender(true) resets
	// previousLines to [], which would leave the shrink path (#2541) no base to
	// verify the flushed prefix against. The stashed top is the physical screen
	// top the reset wiped (previousViewportTop = 0). Both consumed by the next
	// doRender.
	private forcedRenderBaseLines?: string[];
	private forcedRenderBaseViewportTop?: number;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<InputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	/** Called once when terminal output is no longer writable (pipe closed). */
	private outputClosedHandler?: () => void;
	private outputClosedHandled = false;
	private renderRequested = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	private cursorRow = 0; // Logical cursor row (end of rendered content)
	private hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	private showHardwareCursor = process.env.PI_HARDWARE_CURSOR === "1" || process.env.TERM_PROGRAM === "WarpTerminal";
	private clearOnShrink = process.env.PI_CLEAR_ON_SHRINK === "1"; // Clear empty rows when content shrinks (default: off)
	private _shrinkDebounceActive = false;
	private maxLinesRendered = 0; // Track terminal's working area (max lines ever rendered)
	private previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves
	private fullRedrawCount = 0;
	private stopped = false;
	private readonly useSynchronizedOutput =
		process.platform !== "win32" && process.env.PI_DISABLE_SYNC_OUTPUT !== "1";
	private _lastRenderedComponents: string[] | null = null;
	private _lastFrameHadOverlays = false;
	// Number of content lines in the last rendered frame. Content is bottom-
	// aligned to the screen, so this lets dispatchMouse map a screen row back to
	// a content line for hit-testing base (non-overlay) components.
	private baseContentLineCount = 0;

	// --- Fullscreen (alternate screen) mode, slice-1 (#2946) ---
	// Opt-in: the app calls setFullscreen(true) (PI_TUI_FULLSCREEN=1 wiring).
	// Frames are written to the alternate screen buffer as a fixed grid — a
	// transcript viewport above and a pinned tail (status, editor, footer) at
	// the bottom. The alternate screen has no scrollback, so the inline
	// renderer's flushed-prefix/repair machinery is never exercised; the
	// default inline path below is untouched when the mode is off.
	private fullscreen = false;
	// True while the alternate screen is actually entered (entered in
	// setFullscreen/start, left in stop/setFullscreen) — ?1049 nests in most
	// terminals, so enter/exit must stay balanced, never doubled.
	private fullscreenActive = false;
	private startCalled = false;
	// Child at which the pinned tail starts; everything from it down stays on
	// screen. Resolved to an index per frame, so adding children before the
	// boundary keeps working. null pins nothing (whole tree scrolls).
	private fullscreenPinComponent: Component | null = null;
	// Scroll state of the transcript viewport. null = live: the viewport
	// follows new output (shows the transcript bottom). A number = frozen: the
	// absolute index of the topmost visible transcript line, pinned against
	// appends so new output never moves the viewport — it only raises the
	// "N new lines below" hint count.
	private fullscreenAnchor: number | null = null;
	// Transcript line count as laid out by the last fullscreen frame; the
	// input-time scroll clamp before the next frame renders.
	private fullscreenScrollLength = 0;
	// Last committed screen grid plus the dimensions it was laid out at; the
	// diff writer rewrites only rows that differ.
	private fullscreenGrid: string[] = [];
	private fullscreenGridWidth = 0;
	private fullscreenGridHeight = 0;
	private fullscreenKittyIds = new Set<number>();
	// Transcript viewport height as laid out by the last fullscreen frame;
	// the page-scroll step before the first frame lays one out.
	private fullscreenViewportHeight = 0;
	// Physical cursor row as the fullscreen writer last left it. Tracked
	// separately from hardwareCursorRow because requestRender(true) resets
	// that to 0 for the inline renderer; the fullscreen diff may then write
	// nothing and the real physical row would be lost.
	private fullscreenCursorRow = 0;
	// Per-child row ranges of the last fullscreen grid (grid coordinates),
	// used to route mouse clicks to the component under the pointer — the
	// children are rendered directly here, so Container's own childRanges
	// never populate.
	private fullscreenChildRanges: { component: Component; start: number; lineCount: number }[] = [];

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	private overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
		focusOrder: number;
		/** Tallest height a reserveSpace overlay has had while shown; see compositeOverlays. */
		dockedHeightHighWater?: number;
	}[] = [];

	// Screen regions (viewport-relative, 0-based) of overlays from the last
	// render, used to hit-test mouse events. Refreshed by compositeOverlays.
	private overlayRegions: {
		component: Component;
		row: number;
		col: number;
		width: number;
		height: number;
		focusOrder: number;
		capturing: boolean;
	}[] = [];

	constructor(terminal: Terminal, showHardwareCursor?: boolean) {
		super();
		this.terminal = terminal;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	get onOutputClosed(): (() => void) | undefined {
		return this.outputClosedHandler;
	}

	set onOutputClosed(handler: (() => void) | undefined) {
		this.outputClosedHandler = handler;
		if (handler && this.outputClosedHandled) {
			handler();
		}
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true (default), empty rows are cleared when content shrinks.
	 * When false, empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	isFullscreen(): boolean {
		return this.fullscreen;
	}

	/**
	 * Toggle fullscreen (alternate screen) rendering (#2946). Entering writes
	 * \x1b[?1049h (the primary buffer and its scrollback are preserved by the
	 * terminal and restored on exit); leaving writes \x1b[?1049l and forces a
	 * repaint of the primary buffer from the current components. Safe to call
	 * before start() — the enter sequence is then emitted by start() instead,
	 * keeping enter/exit balanced across suspend/resume cycles.
	 */
	setFullscreen(enabled: boolean): void {
		if (this.fullscreen === enabled) return;
		this.fullscreen = enabled;
		this.fullscreenAnchor = null;
		this.resetFullscreenGrid();
		const writable = !this.stopped && this.terminal.isTTY && !this.terminal.outputClosed && this.startCalled;
		if (writable) {
			if (enabled) {
				this.terminal.write("\x1b[?1049h\x1b[2J\x1b[1;1H");
				this.fullscreenActive = true;
			} else if (this.fullscreenActive) {
				this.terminal.write("\x1b[?1049l");
				this.fullscreenActive = false;
			}
		}
		this.requestRender(true);
	}

	/** Drop the committed fullscreen grid so the next frame rewrites the screen. */
	private resetFullscreenGrid(): void {
		this.fullscreenGrid = [];
		this.fullscreenGridWidth = 0;
		this.fullscreenGridHeight = 0;
		this.fullscreenKittyIds = new Set();
		this.fullscreenScrollLength = 0;
		// The alt screen is (about to be) cleared with the cursor homed.
		this.fullscreenCursorRow = 0;
		this.fullscreenChildRanges = [];
	}

	/**
	 * Mark the child at which the pinned tail starts: in fullscreen mode this
	 * component and every child after it stay fixed on screen while the
	 * children before it form the scrolling transcript viewport. No effect on
	 * the inline renderer.
	 */
	setFullscreenPinBoundary(component: Component): void {
		this.fullscreenPinComponent = component;
	}

	/**
	 * Scroll the fullscreen transcript viewport. Positive lines scroll up
	 * (toward older output, freezing the viewport); negative lines scroll down
	 * (toward newer; reaching the bottom unfreezes back to live).
	 */
	scrollFullscreenBy(lines: number): void {
		if (!this.fullscreen || lines === 0) return;
		const viewportRows = this.fullscreenViewportRows();
		const bottomTop = Math.max(0, this.fullscreenScrollLength - viewportRows);
		if (lines > 0) {
			// Up: freeze at an absolute top index so appends cannot move it.
			const currentTop = this.fullscreenAnchor ?? bottomTop;
			const next = currentTop - lines;
			if (next <= 0) {
				this.fullscreenAnchor = 0;
			} else {
				this.fullscreenAnchor = Math.min(next, Math.max(0, this.fullscreenScrollLength - 1));
			}
		} else {
			const currentTop = this.fullscreenAnchor ?? bottomTop;
			const next = currentTop - lines;
			if (next >= bottomTop) {
				this.fullscreenAnchor = null; // back to the live bottom
			} else {
				this.fullscreenAnchor = Math.max(0, next);
			}
		}
		this.requestRender();
	}

	/** Jump the fullscreen transcript viewport back to the live bottom. */
	jumpFullscreenToBottom(): void {
		if (!this.fullscreen || this.fullscreenAnchor === null) return;
		this.fullscreenAnchor = null;
		this.requestRender();
	}

	setFocus(component: Component | null): void {
		// Clear focused flag on old component
		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = component;

		// Set focused flag on new component
		if (isFocusable(component)) {
			component.focused = true;
		}
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: (typeof this.overlayStack)[number] = {
			component,
			options,
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
		};
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				entry.dockedHeightHighWater = undefined;
				// Update focus when hiding/showing
				if (hidden) {
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				if (this.focusedComponent !== component) {
					this.setFocus(component);
				}
				entry.focusOrder = ++this.focusOrderCounter;
				this.requestRender();
			},
			unfocus: () => {
				if (this.focusedComponent !== component) return;
				const topVisible = this.getTopmostVisibleOverlay();
				this.setFocus(topVisible && topVisible !== entry ? topVisible.component : entry.preFocus);
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack.pop();
		if (!overlay) return;
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** True when a visible overlay is docked below the content (reserveSpace). */
	private hasDockedOverlay(): boolean {
		return this.overlayStack.some((o) => o.options?.reserveSpace && this.isOverlayVisible(o));
	}

	/** Check if an overlay entry is currently visible */
	private isOverlayVisible(entry: (typeof this.overlayStack)[number]): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the topmost visible capturing overlay, if any */
	private getTopmostVisibleOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.overlayStack[i].options?.nonCapturing) continue;
			if (this.isOverlayVisible(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	override invalidate(): void {
		super.invalidate();
		this._lastRenderedComponents = null;
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(): void {
		this.stopped = false;
		this.outputClosedHandled = false;
		if (!this.terminal.isTTY) {
			return;
		}
		this.startCalled = true;
		// Re-enter the alternate screen after a stop()/start() cycle (suspend/
		// resume, external editor). ?1049 nests, so guard on fullscreenActive
		// to keep enter/exit balanced; the cleared alt screen needs a full
		// grid rewrite, not a diff against the pre-suspend frame.
		if (this.fullscreen && !this.fullscreenActive) {
			this.terminal.write("\x1b[?1049h\x1b[2J\x1b[1;1H");
			this.fullscreenActive = true;
			this.resetFullscreenGrid();
		}
		this.terminal.setOutputClosedHandler?.(() => this.notifyOutputClosed());
		this.terminal.start(
			(data) => this.handleInput(data),
			() => this.requestRender(),
		);
		this.terminal.hideCursor();
		this.queryCellSize();
		this.requestRender();
	}

	private notifyOutputClosed(): void {
		if (this.outputClosedHandled) return;
		this.outputClosedHandled = true;
		this.stopped = true;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		this.renderRequested = false;
		this.outputClosedHandler?.();
	}

	private safeDoRender(): void {
		if (this.stopped || this.terminal.outputClosed) return;
		try {
			this.doRender();
		} catch (err) {
			if (isStdoutClosedError(err)) {
				this.notifyOutputClosed();
				return;
			}
			throw err;
		}
	}

	addInputListener(listener: InputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.inputListeners.delete(listener);
	}

	private queryCellSize(): void {
		const caps = getCapabilities();
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!caps.images) {
			return;
		}
		// xterm cell-size query: CSI 16 t → reply CSI 6 ; height ; width t.
		if (!this.writeStartupQuery("\x1b[16t")) return;
		// iTerm2 does NOT answer CSI 16t — its only cell-size mechanism is the
		// proprietary OSC 1337 ; ReportCellSize query → reply
		// OSC 1337 ; ReportCellSize=height;width[;scale] ST. Without this, pi falls
		// back to a default cell size on iTerm2 and sizes inline images with the
		// wrong cell aspect (leaving trailing slack / mis-fit). Both replies are
		// handled by parseCellSizeResponse; sending both queries is harmless on
		// terminals that ignore one of them.
		if (caps.images === "iterm2") {
			this.writeStartupQuery("\x1b]1337;ReportCellSize\x07");
		}
	}

	/**
	 * Startup capability probes are TUI-owned writes. A detached terminal can
	 * close between terminal.start() and these probes, so handle only the same
	 * closed-output errors as the render loop; unrelated failures remain fatal.
	 */
	private writeStartupQuery(data: string): boolean {
		try {
			this.terminal.write(data);
			return true;
		} catch (err) {
			if (isStdoutClosedError(err)) {
				this.notifyOutputClosed();
				return false;
			}
			throw err;
		}
	}

	stop(): void {
		this.stopped = true;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		const leaveAltScreen = this.fullscreen && this.fullscreenActive;
		if (!leaveAltScreen && this.previousLines.length > 0) {
			// Move cursor to the end of the content to prevent overwriting/artifacts on exit
			const targetRow = this.previousLines.length; // Line after the last content
			const lineDiff = targetRow - this.hardwareCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write("\r\n");
		}

		this.terminal.showCursor();
		this.terminal.stop();
		if (leaveAltScreen) {
			// Leave the alternate screen AFTER terminal.stop(): keyboard/mouse
			// modes were pushed while the alt buffer was active and Kitty keeps
			// the state stacks per buffer, so the pop in terminal.stop() must
			// land before the primary buffer is restored. The primary buffer
			// (and its scrollback) then reappear exactly as preserved, which is
			// why the inline cursor dance above does not apply here.
			this.terminal.write("\x1b[?1049l");
			this.fullscreenActive = false;
		}
	}

	/**
	 * Scroll everything currently on screen into terminal scrollback and
	 * restart from a blank screen. Call before discarding the transcript — a
	 * new session clears the chat (#2637): the next frame is far shorter, and
	 * repainting it erases the visible rows in place with \x1b[2K, so
	 * whatever is on screen (usually the summary the operator has not read
	 * yet) would never reach scrollback. Scrolling it up first keeps it
	 * readable; the renderer then restarts as on its first render.
	 */
	retireScreenToScrollback(): void {
		if (this.stopped || !this.terminal.isTTY || this.terminal.outputClosed) {
			return;
		}
		if (this.fullscreen) {
			// The alternate screen has no scrollback to retire into: clearing it
			// discards the frame, which is the intended "transcript discarded"
			// behavior of the alt-buffer contract. Reset only the fullscreen
			// state; the inline renderer's state keeps describing the preserved
			// primary buffer for the exit path.
			let buffer = this.useSynchronizedOutput ? "\x1b[?2026h" : "";
			buffer += this.deleteKittyImages(this.fullscreenKittyIds);
			buffer += "\x1b[2J\x1b[1;1H";
			if (this.useSynchronizedOutput) {
				buffer += "\x1b[?2026l";
			}
			this.terminal.write(buffer);
			this.fullscreenAnchor = null;
			this.resetFullscreenGrid();
			this.requestRender();
			return;
		}
		// Only retire what is already painted. A frame still waiting for its
		// render timer is not flushed first: that frame may take a
		// full-repaint path, which would re-emit part of the flushed prefix as
		// duplicates (#2307/#2541); it renders normally after the reset
		// instead. A forced render pending on the next tick empties
		// previousLines while the screen is still painted — the discarded
		// frame lives on in forcedRenderBaseLines, so it still counts as
		// painted.
		if (this.previousLines.length === 0 && this.forcedRenderBaseLines === undefined) {
			return;
		}
		const height = this.terminal.rows;
		let buffer = this.useSynchronizedOutput ? "\x1b[?2026h" : "";
		// \x1b[2K and scrolling do not remove Kitty graphics; delete the
		// placements so images do not linger over the blank screen.
		buffer += this.deleteKittyImages(this.previousKittyImageIds);
		// From the bottom row, one newline per screen row scrolls the whole
		// screen up into scrollback; then home the cursor for the next frame.
		buffer += `\x1b[${height};1H${"\r\n".repeat(height)}\x1b[1;1H`;
		if (this.useSynchronizedOutput) {
			buffer += "\x1b[?2026l";
		}
		this.terminal.write(buffer);
		// Same state as before the first render.
		this.previousLines = [];
		this.previousKittyImageIds = new Set();
		this.previousWidth = 0;
		this.previousHeight = 0;
		this.flushedLineCount = 0;
		this.flushedAtWidth = 0;
		this.flushedAtHeight = 0;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
		this.forcedRenderBaseLines = undefined;
		this.forcedRenderBaseViewportTop = undefined;
		this._lastRenderedComponents = null;
		this._lastFrameHadOverlays = false;
		this._shrinkDebounceActive = false;
		this.overlayRegions = [];
		this.baseContentLineCount = 0;
		this.requestRender();
	}

	requestRender(force = false): void {
		if (!this.terminal.isTTY || this.terminal.outputClosed) {
			return;
		}
		if (force) {
			if (this.previousLines.length > 0) {
				this.forcedRenderBaseLines = this.previousLines;
				this.forcedRenderBaseViewportTop = this.previousViewportTop;
			}
			this.previousLines = [];
			this.previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
			this.previousHeight = -1; // -1 triggers heightChanged, forcing a full clear
			this.cursorRow = 0;
			this.hardwareCursorRow = 0;
			this.maxLinesRendered = 0;
			this.previousViewportTop = 0;
			if (this.renderTimer) {
				clearTimeout(this.renderTimer);
				this.renderTimer = undefined;
			}
			this.renderRequested = true;
			process.nextTick(() => {
				if (this.stopped || !this.renderRequested) {
					return;
				}
				this.renderRequested = false;
				this.lastRenderAt = performance.now();
				this.safeDoRender();
			});
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TUI.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.safeDoRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	private handleInput(data: string): void {
		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Mouse reports are dispatched by screen position, not to the focused
		// component as keystrokes. Handle them before anything else so the raw
		// escape sequence never leaks into a focused editor/input.
		if (isMouseEvent(data)) {
			const event = parseMouseEvent(data);
			if (event) {
				this.dispatchMouse(event);
			}
			return;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		// Fullscreen scroll keys are handled globally, before the focused
		// component: PageUp/PageDown scroll the transcript viewport (they are
		// taken from the editor in this mode), ctrl+end jumps back to the live
		// bottom. A visible overlay (menu, dialog) keeps its own keys. Pages
		// step one row short of the viewport: the frozen frame lends its bottom
		// row to the new-lines hint, and the overlap keeps paging from skipping
		// the line hiding under it.
		if (this.fullscreen && !this.hasOverlay()) {
			if (matchesKey(data, "pageUp")) {
				this.scrollFullscreenBy(Math.max(1, this.fullscreenViewportRows() - 1));
				return;
			}
			if (matchesKey(data, "pageDown")) {
				this.scrollFullscreenBy(-Math.max(1, this.fullscreenViewportRows() - 1));
				return;
			}
			if (matchesKey(data, "ctrl+end")) {
				this.jumpFullscreenToBottom();
				return;
			}
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				// No visible overlays, restore to preFocus
				this.setFocus(focusedOverlay.preFocus);
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	/**
	 * Route a mouse event to the component under the pointer.
	 *
	 * Capturing overlays (menus, settings, dialogs shown via showOverlay) render
	 * at known screen positions and take precedence: the event is hit-tested
	 * against the topmost matching region and forwarded with component-local
	 * coordinates. A capturing overlay is modal, so a miss is swallowed rather
	 * than leaking to the content beneath it.
	 *
	 * Otherwise the event targets base content. Rendered content is bottom-
	 * aligned to the screen, so a screen row maps to a content line and the
	 * event is routed through the component tree (Container/Box translate
	 * coordinates to their children). Components without handleMouse — plain text,
	 * spacers — simply ignore it.
	 */
	private dispatchMouse(event: MouseEvent): void {
		// Convert 1-based terminal coordinates to 0-based viewport coordinates.
		const screenRow = event.y - 1;
		const screenCol = event.x - 1;

		// Topmost capturing overlay first (highest focusOrder).
		const regions = this.overlayRegions
			.filter((r) => r.capturing)
			.sort((a, b) => b.focusOrder - a.focusOrder);

		for (const region of regions) {
			const within =
				screenRow >= region.row &&
				screenRow < region.row + region.height &&
				screenCol >= region.col &&
				screenCol < region.col + region.width;
			if (!within) continue;

			if (region.component.handleMouse) {
				// A press inside an overlay focuses it (mirrors keyboard focus).
				if (event.type === "press" && this.focusedComponent !== region.component) {
					this.setFocus(region.component);
				}
				region.component.handleMouse({
					...event,
					x: screenCol - region.col,
					y: screenRow - region.row,
				});
				this.requestRender();
			}
			return;
		}

		// A capturing overlay is showing but the pointer is outside it: swallow.
		if (regions.length > 0) {
			return;
		}

		// Fullscreen mode: the wheel scrolls the transcript viewport instead of
		// routing to base content (the transcript is a rendered viewport here,
		// not a bottom-anchored frame).
		if (this.fullscreen && (event.button === "wheel-up" || event.button === "wheel-down")) {
			this.scrollFullscreenBy(event.button === "wheel-up" ? 3 : -3);
			return;
		}

		// Base content: translate the screen row to a content-line row.
		if (this.baseContentLineCount <= 0) return;
		if (this.fullscreen) {
			// The fullscreen frame lays its children out directly, so route
			// clicks through the grid ranges recorded by the last frame.
			for (const range of this.fullscreenChildRanges) {
				if (screenRow >= range.start && screenRow < range.start + range.lineCount) {
					range.component.handleMouse?.({ ...event, x: screenCol, y: screenRow - range.start });
					break;
				}
			}
			this.requestRender();
			return;
		}
		const contentRow = screenRow + (this.baseContentLineCount - this.terminal.rows);
		if (contentRow < 0) return;

		// Container.handleMouse walks this.children using the row ranges recorded
		// during render, forwarding to the component under the pointer.
		this.handleMouse({ ...event, x: screenCol, y: contentRow });
		this.requestRender();
	}

	private consumeCellSizeResponse(data: string): boolean {
		// Handles both the xterm CSI 16t reply and the iTerm2 OSC 1337;ReportCellSize
		// reply (see parseCellSizeResponse). Returns false for unrelated input so it
		// flows on to the other input handlers.
		const dims = parseCellSizeResponse(data);
		if (!dims) {
			return false;
		}

		setCellDimensions(dims);
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	private compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		this.overlayRegions = [];
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];

		// Pre-render all visible overlays and calculate positions. Entries are
		// kept in focus order and painted in that same order, so a later-opened
		// overlay paints over an earlier one regardless of kind — matching the
		// topmost-region hit-test in dispatchMouse.
		const painted: {
			component: Component;
			overlayLines: string[];
			/** Floats: screen-relative row. Docks: assigned below, viewport-relative. */
			row: number;
			col: number;
			w: number;
			focusOrder: number;
			capturing: boolean;
			/** Set for docked (reserveSpace) overlays. */
			dock?: { reserved: number; actualHeight: number };
		}[] = [];
		let dockedHeight = 0;
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = component.render(width);

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			if (options?.reserveSpace) {
				// Never let docked rows exceed the screen.
				overlayLines = overlayLines.slice(0, Math.max(0, termHeight - dockedHeight));
				// Keep the docked block at its tallest height while shown: a dialog that
				// shrinks (fewer options on the next question) would shrink the whole
				// frame, and the renderer repaints a shrunken tall frame with an overlay
				// up by re-emitting scrollback. Blank rows sit above the dialog.
				const reserved = Math.min(Math.max(entry.dockedHeightHighWater ?? 0, overlayLines.length), termHeight - dockedHeight);
				entry.dockedHeightHighWater = reserved;
				const { col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
				painted.push({
					component,
					overlayLines,
					row: 0,
					col,
					w: width,
					focusOrder: entry.focusOrder,
					capturing: !options?.nonCapturing,
					dock: { reserved, actualHeight: overlayLines.length },
				});
				dockedHeight += reserved;
				continue;
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			painted.push({ component, overlayLines, row, col, w: width, focusOrder: entry.focusOrder, capturing: !options?.nonCapturing });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		// Docked overlays add their height below the content.
		const workingHeight = Math.max(result.length + dockedHeight, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Docked overlays stack below the content, in focus order (top-most last).
		// Assign each its bottom rows before painting.
		let dockRow = workingHeight - dockedHeight;
		for (const p of painted) {
			if (!p.dock) continue;
			p.row = dockRow - viewportStart;
			dockRow += p.dock.reserved;
		}

		// Composite each overlay in focus order and record the on-screen region
		// for mouse hit-testing. Overlays force the working area to at least the
		// terminal height (see above), so the viewport is bottom-aligned to the
		// screen and screen-relative rows are also viewport-relative coordinates.
		for (const { component, overlayLines, row, col, w, focusOrder, capturing, dock } of painted) {
			if (dock) {
				// The reserved block's blank padding sits above the actual rows; only
				// the component's own rows are painted and registered, so mouse
				// coordinates never map into the padding. `row` is the reserved
				// block's viewport-relative top, assigned in the stacking pass above.
				const pad = dock.reserved - dock.actualHeight;
				const top = viewportStart + row + pad;
				for (let i = 0; i < dock.actualHeight; i++) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[top + i] = this.compositeLineAt(result[top + i], truncatedOverlayLine, col, w, termWidth);
				}
				this.overlayRegions.push({
					component,
					row: top - viewportStart,
					col,
					width: w,
					height: dock.actualHeight,
					focusOrder,
					capturing,
				});
				continue;
			}
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
				}
			}
			this.overlayRegions.push({
				component,
				row,
				col,
				width: w,
				height: overlayLines.length,
				focusOrder,
				capturing,
			});
		}

		return result;
	}

	private static readonly SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

	private applyLineResets(lines: string[]): string[] {
		const reset = TUI.SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		return lines;
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	/**
	 * Whether every value in the verified window `[start, top]` has enough
	 * committed occurrences above the screen to back the new frame's demand
	 * for it. Same-index equality cannot rule out a shift masked by
	 * repetition — constant, periodic, or mixed-shift content all match
	 * row-locally — so occurrence counts are the final authority: if the
	 * committed frame holds fewer copies of a window value than the new frame
	 * displays above the screen, keeping the retained top would under-show
	 * that value. Values outside the window are deliberately not checked:
	 * rows there may be above-screen edits, and hiding such an edit is the
	 * accepted #2582 trade-off. That license is the residual boundary —
	 * repetition compounded with an above-screen edit can under-show copies
	 * of a non-window value (bounded by the overlap, at most half the
	 * screen); closing it entirely would mean refusing every above-screen
	 * edit, i.e. reverting #2582.
	 */
	private static windowMultiplicitiesBacked(
		baseLines: string[],
		newLineAt: (index: number) => string,
		start: number,
		top: number,
	): boolean {
		const windowValues = new Set<string>();
		for (let i = Math.max(0, start); i <= top; i++) {
			windowValues.add(baseLines[i] ?? "");
		}
		const unbacked = new Map<string, number>();
		for (let i = 0; i < top; i++) {
			const value = newLineAt(i);
			if (!windowValues.has(value)) {
				continue;
			}
			unbacked.set(value, (unbacked.get(value) ?? 0) + 1);
		}
		for (let i = 0; i < top; i++) {
			const value = baseLines[i] ?? "";
			const remaining = unbacked.get(value);
			if (remaining !== undefined) {
				unbacked.set(value, remaining - 1);
			}
		}
		for (const remaining of unbacked.values()) {
			if (remaining > 0) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Whether the overlap — the lines between the new viewport top and the
	 * retained screen top, i.e. exactly the lines a refill would re-emit — is
	 * unchanged (#2582). Lines above the overlap are in scrollback under both
	 * layouts and no render path repaints them, so a change there (e.g. GSD's
	 * reply header gaining its timestamp at message_end in the same frame the
	 * pinned zone is torn down) must not send the shrink back to the path that
	 * re-emits scrollback. A changed line inside the overlap refills, so the
	 * change stays visible. An all-blank overlap cannot anchor the boundary
	 * against a shifted frame, so then the whole prefix must match. Blankness
	 * is decided by visible width — committed lines carry escape sequences
	 * that .trim() would treat as content.
	 */
	private static overlapMatches(
		start: number,
		top: number,
		matches: (index: number) => boolean,
		lineAt: (index: number) => string | undefined,
	): boolean {
		const from = Math.max(0, start);
		let anchored = false;
		for (let i = from; i < top; i++) {
			if (!matches(i)) {
				return false;
			}
			if (visibleWidth(lineAt(i) ?? "") > 0) {
				anchored = true;
			}
		}
		if (anchored) {
			return true;
		}
		for (let i = 0; i < from; i++) {
			if (!matches(i)) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Repair the retained screen top when the shrink deleted lines inside the
	 * overlap (#2635): a forced repaint whose own change deleted a row there
	 * fails the unchanged-overlap check, and refilling would re-emit lines
	 * that are already in scrollback while the deleted rows themselves cannot
	 * be removed from scrollback by any path — pure duplication. If the seam
	 * row (the base frame's screen top) reappears shifted by exactly the
	 * deleted rows while every row above the aligned top is byte-identical at
	 * the same index, the repaint can start at the aligned top: it shows
	 * exactly the content that followed the seam before, nothing already in
	 * scrollback is rewritten, and only the deleted rows stay behind as stale
	 * scrollback lines. The whole skipped prefix must verify — each abandoned
	 * row then IS the flushed row at its own index, so no multiplicity can go
	 * missing — and it must contain a non-blank row, else a shift could hide
	 * inside an all-blank prefix. Returns the aligned top, or null when no
	 * confined shift verifies (an edit inside the overlap keeps the refill so
	 * the change stays visible).
	 */
	private static repairShiftedOverlap(
		baseLines: string[],
		newLines: string[],
		newTop: number,
		top: number,
	): number | null {
		const seam = baseLines[top] ?? "";
		if (visibleWidth(seam) === 0) {
			return null; // a blank seam cannot anchor a shifted frame
		}
		const budget = baseLines.length - newLines.length; // deletions in the frame
		if (budget <= 0) {
			return null;
		}
		for (let s = 1; s <= Math.min(budget, top - newTop - 1); s++) {
			const aligned = top - s;
			if ((newLines[aligned] ?? "") !== seam) {
				continue;
			}
			let anchored = false;
			let prefixMatches = true;
			for (let i = 0; i < aligned; i++) {
				if ((newLines[i] ?? "") !== (baseLines[i] ?? "")) {
					prefixMatches = false;
					break;
				}
				if (visibleWidth(newLines[i] ?? "") > 0) {
					anchored = true;
				}
			}
			if (prefixMatches && anchored) {
				return aligned;
			}
		}
		return null;
	}

	/**
	 * Whether a forced repaint of a shrinking frame can keep the retained
	 * screen top instead of repainting from the new viewport top (#2541).
	 * Repainting from the new viewport top re-writes the overlap — lines
	 * already committed to scrollback — a second time. When the overlap is
	 * unchanged (only content above the screen changed, e.g. a reply header
	 * gaining its timestamp; see overlapMatches), or changed by deletions the
	 * aligned top can absorb (see repairShiftedOverlap), or changed by
	 * deletions the two-seam compound model can absorb (see
	 * repairCompoundShrink, #2804), the freed rows can simply be left blank
	 * at the bottom, the same end state the pure-deletion path leaves.
	 * Overlaps without a verified alignment refill the screen so the
	 * blank-viewport behavior (#613) is preserved; the aligned repairs leave
	 * at most half the screen blank (the below-seam deletions alone). Unforced
	 * frames mostly do not need this path: there the differential
	 * renderer handles bottom deletions in place over the padded retained
	 * layout; an unforced shrink that also shifted rows above the screen
	 * top (which defeats that padding) calls this with the committed frame as
	 * the base.
	 *
	 * Returns the screen top to repaint from (the retained top, or the
	 * deletion-aligned top), or null when the frame must refill.
	 *
	 * The boundary is the committed physical screen top (`top`), not
	 * flushedLineCount: a clean repaint that re-committed the overlap (a reflow
	 * fallback) moves the real boundary below the mark, and painting from the
	 * mark would erase on-screen content. The mark must have caught up to at
	 * least the physical top for the skipped prefix to be verified scrollback;
	 * optimistic marks (top > flushed) reject.
	 */
	private keepsFlushedTop(
		baseLines: string[] | undefined,
		newLines: string[],
		height: number,
		top: number,
		flushed: number = this.flushedLineCount,
	): number | null {
		if (top <= 0 || top > flushed || this.overlayStack.length > 0) {
			return null;
		}
		if (!baseLines || baseLines.length <= newLines.length) {
			return null;
		}
		// Only frames still taller than the screen qualify: a frame that now
		// fits on screen is bottom-anchored and repaints from its first line.
		const newTop = newLines.length - height;
		if (newTop <= 0) {
			return null;
		}
		const overlap = top - newTop;
		if (overlap <= 0) {
			return null;
		}
		if (overlap > Math.floor(height / 2)) {
			// A shrink this large usually deleted rows far above the screen (a
			// turn's tool rows collapsing into a summary); refilling would
			// re-emit the scrollback rows now above the new viewport top, so
			// only a deletion-aligned top can help (see repairCompoundShrink).
			// The blanks it leaves at the bottom are the below-seam deletions
			// alone, still capped at half the screen (#613).
			return TUI.alignedTopWithoutImages(
				newLines,
				newTop,
				TUI.repairCompoundShrink(baseLines, newLines, newTop, top, height) ??
					TUI.firstChangeTop(baseLines, newLines, newTop, top, height),
			);
		}
		const matches = (i: number): boolean => baseLines[i] === newLines[i];
		// The seam row (`top`, the old screen top) is verified alongside the
		// overlap: it is visible but not flushed, so a deletion landing exactly
		// there would otherwise keep the top and repaint from its neighbor,
		// destroying it without it ever reaching scrollback. Window-value
		// multiplicities are checked because same-index equality cannot rule
		// out a shift masked by repetition (see windowMultiplicitiesBacked).
		if (
			TUI.overlapMatches(newTop, top, matches, (i) => newLines[i]) &&
			matches(top) &&
			TUI.windowMultiplicitiesBacked(baseLines, (i) => newLines[i] ?? "", newTop, top)
		) {
			// An image placement inside the overlap would be deleted without
			// replacement (the repaint starts below it); the refill path re-emits
			// it, so keep that behavior when images cross the boundary.
			for (let i = newTop; i < top; i++) {
				if (isImageLine(newLines[i])) {
					return null;
				}
			}
			return top;
		}
		const alignedTop =
			TUI.repairShiftedOverlap(baseLines, newLines, newTop, top) ??
			TUI.repairCompoundShrink(baseLines, newLines, newTop, top, height) ??
			TUI.firstChangeTop(baseLines, newLines, newTop, top, height);
		return TUI.alignedTopWithoutImages(newLines, newTop, alignedTop);
	}

	/**
	 * Last fallback before a refill: repaint from the frame's first changed
	 * row when that row lies inside the overlap. The repairs above model pure
	 * deletions and refuse an edit so the change stays visible, but a refill
	 * from the new viewport top shows it no better: it also re-emits every
	 * unchanged overlap row above the edit. A finished tool is exactly that
	 * shape — its card folds into a one-row phase summary (an edit plus
	 * deletions), and when the card straddles the screen top the refill
	 * printed the rows above it a second time (seen as the previous reply's
	 * last lines printed again once per finished tool) (#3000).
	 *
	 * Safe by construction: rows [0, first) equal the committed frame, which
	 * is in scrollback in order (keepsFlushedTop requires the flushed mark at
	 * least at the physical top), and every row from `first` down is painted,
	 * so the terminal shows the whole new frame. The refill leaves the same
	 * stale rows and re-emits new[newTop, first) on top. Blank rows at the
	 * bottom are capped like repairCompoundShrink's (#613). Returns null when
	 * the first change is not inside the overlap (other paths own those) or
	 * the cap would be exceeded.
	 */
	private static firstChangeTop(
		baseLines: string[],
		newLines: string[],
		newTop: number,
		top: number,
		height: number,
	): number | null {
		const limit = Math.min(top, newLines.length, baseLines.length);
		let first = 0;
		while (first < limit && newLines[first] === baseLines[first]) {
			first++;
		}
		if (first < newTop || first >= top) {
			return null;
		}
		// Removed-value guard (mirror of repairCompoundShrink's): rows
		// [newTop, first) equal the committed frame, but #2582's licensed
		// hidden above-screen edits make committed copies fictitious. When the
		// repaint overwrites an old-screen row whose value also appears in the
		// skipped prefix, the screen's last physical copy of that value could
		// sit behind a committed count a hidden edit inflated — refuse and
		// keep the loss-free refill (the refill preserves the physical copy).
		if (first > newTop) {
			const oldScreen = new Map<string, number>();
			for (let i = top; i < Math.min(baseLines.length, top + height); i++) {
				const value = baseLines[i] ?? "";
				oldScreen.set(value, (oldScreen.get(value) ?? 0) + 1);
			}
			const paintedCounts = new Map<string, number>();
			for (let i = first; i < newLines.length; i++) {
				const value = newLines[i] ?? "";
				paintedCounts.set(value, (paintedCounts.get(value) ?? 0) + 1);
			}
			const skipped = new Set<string>();
			for (let i = newTop; i < first; i++) skipped.add(newLines[i] ?? "");
			for (const [value, count] of oldScreen) {
				if (
					count - (paintedCounts.get(value) ?? 0) > 0 &&
					visibleWidth(value) > 0 &&
					skipped.has(value)
				) {
					return null;
				}
			}
		}
		const newLen = newLines.length;
		let tail = 0;
		while (tail < newLen && TUI.isVisuallyBlank(newLines[newLen - 1 - tail] ?? "")) {
			tail++;
		}
		const skip = first - newTop;
		if (skip + Math.min(tail, height - skip) > Math.floor(height / 2)) {
			return null;
		}
		return first;
	}

	/** The aligned top, or null when an image line would be skipped (the refill re-emits it). */
	private static alignedTopWithoutImages(newLines: string[], newTop: number, alignedTop: number | null): number | null {
		if (alignedTop === null) {
			return null;
		}
		for (let i = newTop; i < alignedTop; i++) {
			if (isImageLine(newLines[i])) {
				return null;
			}
		}
		return alignedTop;
	}

	/**
	 * Align the retained screen top when a forced repaint deleted rows in two
	 * places at once (#2804): far above the screen (a turn's tool rows
	 * collapsing into a summary — any amount, even more than half a screen)
	 * and below the old screen top (the pinned-zone teardown). Both index
	 * checks fail there — the unchanged-overlap guard sees shifted indices,
	 * and repairShiftedOverlap requires the whole skipped prefix
	 * byte-identical at the same index, which any above-screen deletion
	 * breaks — so the refill runs and re-emits the s rows of scrollback that
	 * now sit above the new viewport top (seen as a table's top border and
	 * header row printed twice at turn end).
	 *
	 * The frame is verified against a two-seam deletion model: above the old
	 * screen top, the skipped rows must be the rows that sat just above it,
	 * carried up by the above-screen deletions, with every window value
	 * displayed above the aligned top backed by a distinct committed copy so
	 * a repetition cannot double-book scrollback and hide a row it does not
	 * show; on the screen, every painted row must pair with a row of the old
	 * screen at the same offset until the single deleted block below the seam,
	 * then at that block's shift. An edited or inserted row anywhere in the
	 * verified region fails the model and keeps the refill, so the change
	 * stays visible. The screen keeps at most half its rows blank in total —
	 * the below-seam deletions plus the new frame's own trailing blank lines
	 * (#613); the above-screen deletions shift the retained top instead.
	 *
	 * Like every retention path, this trusts the committed frame's
	 * above-screen rows: an edit hidden there by the licensed #2582 boundary
	 * makes the committed copy counts diverge from physical scrollback, and
	 * repetition compounded with such an edit can under-show copies of a
	 * window value. That residual is inherited from windowMultiplicitiesBacked
	 * (#2725) — closing it would mean refusing every above-screen edit. The
	 * removed-value guard below narrows it: the demonstrated destruction
	 * chain (a hidden edit's value also vanishing from the visible screen)
	 * is refused outright and falls back to the loss-free refill.
	 */
	private static repairCompoundShrink(
		baseLines: string[],
		newLines: string[],
		newTop: number,
		top: number,
		height: number,
	): number | null {
		const newLen = newLines.length;
		const baseLen = baseLines.length;
		// Committed copies above the old screen top — the scrollback supply
		// that backs skipped rows. Precomputed once for all candidates.
		const supply = new Map<string, number>();
		for (let i = 0; i < top; i++) {
			const value = baseLines[i] ?? "";
			supply.set(value, (supply.get(value) ?? 0) + 1);
		}
		// Values on the old screen, for the removed-value guard below.
		const oldScreen = new Map<string, number>();
		for (let i = top; i < Math.min(baseLen, top + height); i++) {
			const value = baseLines[i] ?? "";
			oldScreen.set(value, (oldScreen.get(value) ?? 0) + 1);
		}
		// The aligned screen's trailing blanks are the padding plus the new
		// frame's own trailing visually-blank lines (space-only rows render
		// blank too, and committed lines carry reset suffixes). #613 bounds
		// their SUM at half the screen: the refill baseline shows the frame's
		// own blanks either way, so only the padding is the retention's to
		// cap.
		const half = Math.floor(height / 2);
		let tail = 0;
		while (tail < newLen && TUI.isVisuallyBlank(newLines[newLen - 1 - tail] ?? "")) {
			tail++;
		}
		// s counts both halves of the compound shrink at once: the rows deleted
		// below the old screen top (they become the blank rows at the bottom of
		// the aligned screen) and the rows the aligned repaint skips between
		// the new viewport top and the retained content. The above-screen
		// deletions only shift the retained top. s = 0 covers a pure large
		// roll-up with nothing deleted below the seam.
		const maxSkip = Math.min(half, top - newTop);
		// Values the new frame displays above the candidates, grown by one row
		// per candidate for the removed-value guard.
		const valuesAbove = new Set<string>();
		for (let i = 0; i < newTop; i++) {
			valuesAbove.add(newLines[i] ?? "");
		}
		for (let s = 0; s <= maxSkip; s++) {
			if (s + Math.min(tail, height - s) > half) {
				continue;
			}
			const aligned = newTop + s;
			if (s > 0) {
				valuesAbove.add(newLines[aligned - 1] ?? "");
			}
			let anchored = false;
			// Segment 1 — the skipped rows: the s rows just above the aligned
			// top must be the rows that sat just above the old screen top,
			// byte-identical at the deletion shift (new[newTop + t] with
			// base[top - s + t]). An edited or inserted row here fails and
			// keeps the refill, so the change stays visible.
			const windowValues = new Set<string>();
			let segmentMatches = true;
			for (let t = 0; t < s; t++) {
				const value = newLines[newTop + t] ?? "";
				if (value !== (baseLines[top - s + t] ?? "")) {
					segmentMatches = false;
					break;
				}
				windowValues.add(value);
				if (visibleWidth(value) > 0) {
					anchored = true;
				}
			}
			if (!segmentMatches) {
				continue;
			}
			// Backing (windowMultiplicitiesBacked's rule): every copy of a
			// window value the new frame displays above the aligned top claims
			// one committed copy from scrollback — not just the skipped rows'
			// copies. An above-viewport copy pairing, under repetition, with a
			// committed row the skipped rows already claim would double-book
			// it, and the aligned repaint would destroy the unflushed original
			// (#2415). The window is scoped to the skipped values so unrelated
			// above-screen edits stay licensed (#2582).
			const claimed = new Map<string, number>();
			for (let i = 0; i < aligned; i++) {
				const value = newLines[i] ?? "";
				if (windowValues.has(value)) {
					claimed.set(value, (claimed.get(value) ?? 0) + 1);
				}
			}
			for (const value of windowValues) {
				if ((supply.get(value) ?? 0) < (claimed.get(value) ?? 0)) {
					segmentMatches = false;
					break;
				}
			}
			if (!segmentMatches) {
				continue;
			}
			// Segment 2 — the screen: every painted row must pair with a row
			// of the old screen (never flushed, so repainting it duplicates
			// nothing and no unflushed row is destroyed), same offset until
			// the single deleted block below the seam (the teardown), then at
			// that block's shift. The walk consumes exactly the old screen
			// (newLen - aligned = height - s painted rows, plus the s deleted
			// rows absorbed by the promotion); a second shift, an insertion,
			// or an edit fails and keeps the refill.
			let shift = 0;
			for (let j = 0; aligned + j < newLen; j++) {
				const painted = newLines[aligned + j] ?? "";
				if (visibleWidth(painted) > 0) {
					anchored = true;
				}
				const paired = top + j + shift;
				if (paired < baseLen && painted === (baseLines[paired] ?? "")) {
					continue;
				}
				if (shift === 0 && paired + s < baseLen && painted === (baseLines[paired + s] ?? "")) {
					shift = s;
					continue;
				}
				segmentMatches = false;
				break;
			}
			if (!segmentMatches) {
				continue;
			}
			// Removed-value guard: when the candidate deletes a visible row
			// whose value still appears above the aligned top, the above-top
			// copies lean on committed scrollback copies of that value — the
			// exact place a hidden above-screen edit (#2582's licensed hide)
			// can have inflated the committed counts. The pairing above proves
			// byte-identity to the committed frame, not to physical
			// scrollback, so such a candidate could destroy the screen's last
			// physical copy under repetition. Refusing it costs only a refill
			// (loss-free, bounded duplicates); in an untainted frame the guard
			// fires only when genuinely deleted screen content repeats above
			// the boundary.
			const paintedCounts = new Map<string, number>();
			for (let i = aligned; i < newLen; i++) {
				const value = newLines[i] ?? "";
				paintedCounts.set(value, (paintedCounts.get(value) ?? 0) + 1);
			}
			let removesBackedValue = false;
			for (const [value, count] of oldScreen) {
				if (
					count - (paintedCounts.get(value) ?? 0) > 0 &&
					visibleWidth(value) > 0 &&
					valuesAbove.has(value)
				) {
					removesBackedValue = true;
					break;
				}
			}
			if (removesBackedValue) {
				continue;
			}
			if (anchored) {
				return aligned;
			}
		}
		return null;
	}

	/**
	 * Where the row that sat at the top of the screen (`top` in the committed
	 * frame) is in the new frame. The flushed mark is a row index, so it only
	 * stays true while nothing above the screen top moves. A frame that
	 * deletes rows up there (a tool card in scrollback folding into its phase
	 * summary) while it grows below — so the shrink demotion never runs —
	 * moves every on-screen row up: a clean repaint from the mark, or an
	 * in-place realign from the new viewport top, then starts below the old
	 * screen-top row and erases it without it ever reaching scrollback. Seen
	 * as a table missing one row between two identical separators (#3020).
	 *
	 * The rows are aligned with a bounded Myers diff from the first changed
	 * row. If the old screen-top row survives, its new index is returned;
	 * otherwise the row after the last surviving row above it. Rows above the
	 * returned index are scrollback (or edits hidden above the screen, as
	 * before, #2582). Returns `top` when nothing above it changed, and null
	 * when the diff exceeds `maxEdits` (callers keep their old start row).
	 */
	private static seamRowInNewFrame(
		baseLines: string[],
		newLines: string[],
		top: number,
		maxEdits = 2000,
	): number | null {
		if (top <= 0 || top >= baseLines.length) {
			return null;
		}
		const limit = Math.min(top, newLines.length);
		let common = 0;
		while (common < limit && baseLines[common] === newLines[common]) {
			common++;
		}
		if (common >= top) {
			return top;
		}
		const match = TUI.matchRows(baseLines, newLines, common, maxEdits);
		if (!match) {
			return null;
		}
		if (match[top - common] >= 0) {
			return match[top - common];
		}
		for (let i = top - 1; i >= common; i--) {
			if (match[i - common] >= 0) {
				return match[i - common] + 1;
			}
		}
		return common;
	}

	/**
	 * Myers shortest edit script between a[from..] and b[from..]. Returns, per
	 * row of a from `from`, the index in b it is kept at, or -1 if deleted;
	 * null when more than `maxEdits` edits are needed.
	 */
	private static matchRows(a: string[], b: string[], from: number, maxEdits: number): Int32Array | null {
		const n = a.length - from;
		const m = b.length - from;
		const max = Math.min(n + m, maxEdits);
		const offset = max + 1;
		const v = new Int32Array(2 * max + 3);
		const trace: Int32Array[] = [];
		for (let d = 0; d <= max; d++) {
			// Snapshot of k in [-d-1, d+1] before step d, for the backtrack.
			trace.push(v.slice(offset - d - 1, offset + d + 2));
			for (let k = -d; k <= d; k += 2) {
				let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
				let y = x - k;
				while (x < n && y < m && a[from + x] === b[from + y]) {
					x++;
					y++;
				}
				v[offset + k] = x;
				if (x >= n && y >= m) {
					const match = new Int32Array(n).fill(-1);
					let bx = n;
					let by = m;
					for (let e = d; e > 0; e--) {
						const snap = trace[e];
						const at = (kk: number) => snap[kk + e + 1];
						const kk = bx - by;
						const prevK = kk === -e || (kk !== e && at(kk - 1) < at(kk + 1)) ? kk + 1 : kk - 1;
						const prevX = at(prevK);
						const prevY = prevX - prevK;
						while (bx > prevX && by > prevY) {
							match[--bx] = from + --by;
						}
						bx = prevX;
						by = prevY;
					}
					while (bx > 0 && by > 0) {
						match[--bx] = from + --by;
					}
					return match;
				}
			}
		}
		return null;
	}

	/** Whether a rendered line shows nothing — no visible non-blank cell. */
	private static isVisuallyBlank(line: string): boolean {
		if (isImageLine(line)) {
			return false;
		}
		for (let i = 0; i < line.length; ) {
			const ansi = extractAnsiCode(line, i);
			if (ansi) {
				i += ansi.length;
				continue;
			}
			// Read whole code points: each UTF-16 surrogate of an astral char
			// is zero-width alone, but the char it forms is visible content.
			const ch = String.fromCodePoint(line.codePointAt(i) ?? 0);
			// Whitespace renders blank; zero-width characters (U+200B, combining
			// marks) occupy no cells and render blank too.
			if (!isWhitespaceChar(ch) && visibleWidth(ch) > 0) {
				return false;
			}
			i += ch.length;
		}
		return true;
	}

	/**
	 * Record the lines committed in the frame we just rendered. We snapshot the
	 * Kitty image ids here (not just at the start of the next render) because a
	 * forced full render resets previousLines to [] before doRender runs — the
	 * persistent previousKittyImageIds set is what lets the full-repaint paths
	 * delete the prior frame's GPU placements even after that reset.
	 */
	private commitRenderedLines(newLines: string[]): void {
		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private expandLastChangedForKittyImages(firstChanged: number, lastChanged: number): number {
		let expandedLastChanged = lastChanged;
		for (let i = firstChanged; i < this.previousLines.length; i++) {
			if (extractKittyImageIds(this.previousLines[i]).length > 0) {
				expandedLastChanged = Math.max(expandedLastChanged, i);
			}
		}
		return expandedLastChanged;
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (isImageLine(baseLine)) return baseLine;

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = TUI.SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	private extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	/** Transcript viewport height as laid out by the last fullscreen frame. */
	private fullscreenViewportRows(): number {
		return this.fullscreenViewportHeight > 0 ? this.fullscreenViewportHeight : Math.max(1, this.terminal.rows - 1);
	}

	/**
	 * Render one fullscreen (alternate screen) frame (#2946). The child tree is
	 * split at the pin boundary: children before it render into the scrolling
	 * transcript viewport; the boundary child and everything after it render
	 * into the pinned tail that owns the bottom rows. The frame is a diff over
	 * the previously committed screen grid — the alternate screen has no
	 * scrollback, so none of the inline renderer's flushed-prefix machinery
	 * applies here.
	 */
	private doRenderFullscreen(): void {
		const width = this.terminal.columns;
		const height = this.terminal.rows;

		// A width change re-wraps the transcript, so a frozen top index into
		// the wrapped lines no longer points at the content it pinned — drop
		// the reading position and return to the live bottom rather than land
		// somewhere arbitrary (#2946 review: slice-1 keeps this simple).
		if (this.fullscreenGrid.length > 0 && this.fullscreenGridWidth !== width) {
			this.fullscreenAnchor = null;
		}

		const resolvedPin = this.fullscreenPinComponent
			? this.children.indexOf(this.fullscreenPinComponent)
			: this.children.length;
		const pinIndex = resolvedPin >= 0 ? resolvedPin : this.children.length;
		const scrollChildren = this.children.slice(0, pinIndex);
		const pinnedChildren = this.children.slice(pinIndex);

		// The pinned tail owns the bottom rows; if it alone outgrows the screen
		// its top is truncated so the tail's end (editor, footer) stays visible.
		// Note the app keeps widgets-below small: a tail whose END is not the
		// editor can still crowd it out — the renderer cannot know which child
		// holds the caret.
		const pinnedSpans: { component: Component; offset: number; lineCount: number }[] = [];
		let pinnedLines: string[] = [];
		for (const child of pinnedChildren) {
			const childLines = child.render(width);
			pinnedSpans.push({ component: child, offset: pinnedLines.length, lineCount: childLines.length });
			pinnedLines.push(...childLines);
		}
		const pinnedCut = Math.max(0, pinnedLines.length - (height - 1));
		if (pinnedCut > 0) {
			pinnedLines = pinnedLines.slice(pinnedCut);
			for (const span of pinnedSpans) {
				span.lineCount = Math.max(0, span.offset + span.lineCount - pinnedCut);
				span.offset = Math.max(0, span.offset - pinnedCut);
			}
		}
		const viewportHeight = Math.max(1, height - pinnedLines.length);
		this.fullscreenViewportHeight = viewportHeight;

		// Render the full transcript, then window it. A frozen (scrolled-up)
		// viewport pins an absolute top index: appends leave the window in
		// place and only raise the new-lines count below it.
		const scrollSpans: { component: Component; offset: number; lineCount: number }[] = [];
		const scrollLines: string[] = [];
		for (const child of scrollChildren) {
			const childLines = child.render(width);
			scrollSpans.push({ component: child, offset: scrollLines.length, lineCount: childLines.length });
			scrollLines.push(...childLines);
		}
		const maxAnchor = Math.max(0, scrollLines.length - 1);
		if (this.fullscreenAnchor !== null && this.fullscreenAnchor > maxAnchor) {
			this.fullscreenAnchor = maxAnchor;
		}
		const anchor = this.fullscreenAnchor;
		const frozen = anchor !== null;
		const start = frozen ? anchor : Math.max(0, scrollLines.length - viewportHeight);
		const viewport = scrollLines.slice(start, start + viewportHeight);
		while (viewport.length < viewportHeight) {
			viewport.push("");
		}
		this.fullscreenScrollLength = scrollLines.length;

		// Frozen with output still below: the bottom viewport row becomes the
		// new-lines hint.
		const newBelow = scrollLines.length - (start + viewportHeight);
		if (frozen && newBelow > 0) {
			viewport[viewport.length - 1] = `\x1b[2m ↓ ${newBelow} new line${newBelow === 1 ? "" : "s"} below · ctrl+end for latest \x1b[22m`;
		}

		// Grid-coordinate row ranges of the children visible on screen, for
		// mouse click routing (the children are rendered directly here, so
		// Container's childRanges never populate).
		this.fullscreenChildRanges = [];
		for (const span of scrollSpans) {
			const from = Math.max(span.offset, start);
			const to = Math.min(span.offset + span.lineCount, start + viewportHeight);
			if (to > from) {
				this.fullscreenChildRanges.push({ component: span.component, start: from - start, lineCount: to - from });
			}
		}
		for (const span of pinnedSpans) {
			if (span.lineCount > 0) {
				this.fullscreenChildRanges.push({
					component: span.component,
					start: viewportHeight + span.offset,
					lineCount: span.lineCount,
				});
			}
		}

		let grid = [...viewport, ...pinnedLines];

		// Overlays composite onto the grid exactly as the inline renderer does:
		// with the grid already screen-height, floating overlays are
		// screen-relative. A docked (reserveSpace) overlay grows the result and
		// pushes the viewport up, so keep the bottom `height` rows — the dialog
		// takes focus anyway; it covering the pinned tail is accepted slice-1
		// behavior.
		if (this.overlayStack.length > 0) {
			grid = this.compositeOverlays(grid, width, height);
			if (grid.length > height) {
				grid = grid.slice(grid.length - height);
			}
		} else {
			this.overlayRegions = [];
		}
		this.baseContentLineCount = grid.length;

		let cursorPos = this.extractCursorPosition(grid, height);
		grid = this.applyLineResets(grid);

		// Diff against the committed grid; rewrite only changed rows.
		const fullRewrite =
			this.fullscreenGridWidth !== width ||
			this.fullscreenGridHeight !== height ||
			this.fullscreenGrid.length !== height;
		const changed: number[] = [];
		for (let row = 0; row < height; row++) {
			if (fullRewrite || (this.fullscreenGrid[row] ?? "") !== (grid[row] ?? "")) {
				changed.push(row);
			}
		}

		let kittyBuffer = "";
		if (changed.length > 0) {
			const ids = new Set<number>();
			if (fullRewrite) {
				for (const id of this.fullscreenKittyIds) ids.add(id);
			} else {
				// \x1b[2K does not remove Kitty placements. Scan from the first
				// change down: a multi-row placement can overwrite rows below it,
				// so image rows at or below the first change are rewritten too
				// (mirrors the inline expandLastChangedForKittyImages).
				for (let row = changed[0]; row < height; row++) {
					for (const id of extractKittyImageIds(this.fullscreenGrid[row] ?? "")) {
						ids.add(id);
						if (!changed.includes(row)) {
							changed.push(row);
						}
					}
				}
				changed.sort((a, b) => a - b);
			}
			kittyBuffer = this.deleteKittyImages(ids);
		}

		let buffer = this.useSynchronizedOutput ? "\x1b[?2026h" : "";
		buffer += kittyBuffer;
		let lastWrittenRow = -2;
		for (const row of changed) {
			if (row === lastWrittenRow + 1) {
				// Consecutive row: \r pins column 1 and \x1b[1B steps down without
				// scrolling (CUD clamps at the screen bottom), so the fixed grid
				// can never spill into a buffer.
				buffer += "\r\x1b[1B";
			} else {
				buffer += `\x1b[${row + 1};1H`;
			}
			buffer += "\x1b[2K";
			let line = grid[row] ?? "";
			if (!isImageLine(line) && visibleWidth(line) > width) {
				line = truncateToWidth(line, width);
			}
			buffer += line;
			lastWrittenRow = row;
		}
		if (changed.length > 0) {
			if (this.useSynchronizedOutput) buffer += "\x1b[?2026l";
			this.terminal.write(buffer);
		}

		// Commit the grid and reposition the hardware cursor for IME. The
		// physical cursor sits at the end of the last rewritten row — or where
		// the last frame left it when nothing was written. Tracked in
		// fullscreenCursorRow because requestRender(true) zeroes the inline
		// renderer's hardwareCursorRow even though the fullscreen grid (and the
		// physical cursor) did not move.
		this.fullscreenGrid = grid;
		this.fullscreenGridWidth = width;
		this.fullscreenGridHeight = height;
		this.fullscreenKittyIds = this.collectKittyImageIds(grid);
		this.cursorRow = height - 1;
		this.hardwareCursorRow = changed.length > 0 ? changed[changed.length - 1] : this.fullscreenCursorRow;
		this.positionHardwareCursor(cursorPos, height);
		this.fullscreenCursorRow = this.hardwareCursorRow;
	}

	private doRender(): void {
		if (this.stopped) return;
		if (this.fullscreen) {
			// Frames may only be written once the alternate screen is actually
			// entered: between setFullscreen(true) and start() there can be
			// awaited app work, and a scheduled render that fired before the
			// ?1049h would paint absolute-positioned rows over the user's
			// primary buffer.
			if (this.fullscreenActive) {
				this.doRenderFullscreen();
			}
			return;
		}
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const getViewportTop = (lineCount: number): number => lineCount - height;
		let viewportTop = getViewportTop(this.maxLinesRendered);
		let prevViewportTop = this.previousViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;

		// Render all components to get new lines
		let newLines = this.render(width);

		// A kept-flushed-top commit (#2541) leaves the physical screen top above
		// the bottom-aligned position, with blank rows at the bottom. Pad the
		// frame with trailing blanks so the bottom-aligned invariant
		// (length - height == screen top) keeps holding for every consumer —
		// overlay compositing, cursor extraction, mouse mapping, differential
		// math — while the freed rows persist. Only small overlaps stay
		// retained (larger shrinks refill the screen, #613); the overlap lines
		// above the new viewport top must still match the committed frame
		// (overlapMatches, #2582) — lines further up are in scrollback and no
		// path repaints them, so a change there must not drop the retention —
		// else it is stale and the next repaint re-anchors naturally. A forced
		// render has no committed frame to compare against (previousLines is
		// reset), so it never pads here — the kept-top writer handles that
		// path.
		// Docked (reserveSpace) overlays add their rows after this padding, so the
		// frame is not shorter than the retained top; padding too would count them
		// twice.
		const retainedTop = this.previousViewportTop;
		if (
			!this.hasDockedOverlay() &&
			retainedTop > 0 &&
			retainedTop <= this.flushedLineCount &&
			this.flushedAtWidth === width &&
			this.flushedAtHeight === height &&
			newLines.length < retainedTop + height &&
			retainedTop + height - newLines.length <= Math.floor(height / 2) &&
			this.previousLines.length >= retainedTop
		) {
			// Committed lines carry the segment-reset suffix (applyLineResets),
			// so compare the new lines in the same committed form. Window-value
			// multiplicities are checked alongside: pinning the retained layout
			// over a shift masked by repetition would route the differential's
			// clean repaint from the retained mark and abandon rows the
			// scrollback cannot back (windowMultiplicitiesBacked).
			const committedLines = this.previousLines;
			const newCommittedAt = (i: number): string => {
				const line = newLines[i];
				return isImageLine(line) ? line : normalizeTerminalOutput(line) + TUI.SEGMENT_RESET;
			};
			const prefixMatches =
				TUI.overlapMatches(newLines.length - height, retainedTop, (i) => {
					return committedLines[i] === newCommittedAt(i);
				}, (i) => newLines[i]) &&
				TUI.windowMultiplicitiesBacked(
					committedLines,
					newCommittedAt,
					newLines.length - height,
					retainedTop,
				);
			if (prefixMatches) {
				newLines = [
					...newLines,
					...Array.from({ length: retainedTop + height - newLines.length }, () => ""),
				];
			}
		}

		if (
			newLines === this._lastRenderedComponents &&
			this.overlayStack.length === 0 &&
			!this._lastFrameHadOverlays &&
			!widthChanged &&
			!heightChanged
		) {
			return;
		}
		this._lastRenderedComponents = newLines;
		this._lastFrameHadOverlays = this.overlayStack.length > 0;

		// Composite overlays into the rendered lines (before differential compare)
		if (this.overlayStack.length > 0) {
			newLines = this.compositeOverlays(newLines, width, height);
		} else {
			this.overlayRegions = [];
		}
		this.baseContentLineCount = newLines.length;

		// Extract cursor position before applying line resets (marker must be found first)
		let cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);

		// A shrunken frame shifts the positional meaning of the flushed mark:
		// deletions move content up, so lines the mark claims are flushed may
		// now sit at other indices. Demote the mark to the viewport top — the
		// only boundary still plausible for the new layout — so later clean
		// repaints cannot skip content that took its place (#2415). A forced
		// render that keeps the retained top (#2541) never demotes here: its
		// previousLines were reset, so the shrink condition is false.
		const forcedRender = this.previousLines.length === 0;
		const forcedRenderBaseLines = this.forcedRenderBaseLines;
		this.forcedRenderBaseLines = undefined;
		// requestRender(true) wipes previousViewportTop alongside the frame;
		// the physical screen top it discarded is what the kept-top path needs.
		const forcedBaseTop = this.forcedRenderBaseViewportTop;
		this.forcedRenderBaseViewportTop = undefined;
		const keptTop = forcedBaseTop ?? 0;
		const alignedKeptTop =
			forcedRender && this.flushedAtWidth === width && this.flushedAtHeight === height
				? this.keepsFlushedTop(forcedRenderBaseLines, newLines, height, keptTop)
				: null;
		// The mark before the shrink demotion below: the tall→tall shrink path
		// verifies its retained top against it (keepsFlushedTop).
		const flushedBeforeShrink = this.flushedLineCount;
		if (newLines.length < this.previousLines.length) {
			this.flushedLineCount = Math.min(this.flushedLineCount, Math.max(0, newLines.length - height));
		}
		// The committed frame and its physical screen top: every clean repaint
		// starts no lower than where the old screen-top row went (see
		// seamRowInNewFrame). Computed once, on first use.
		const seamBase = forcedRender ? forcedRenderBaseLines : this.previousLines;
		const seamTop = forcedRender ? keptTop : prevViewportTop;
		let seamRow: number | null | undefined;
		const shiftedSeamRow = (): number | null => {
			if (seamRow === undefined) {
				seamRow =
					seamBase && seamBase.length > 0 && this.flushedAtWidth === width && this.flushedAtHeight === height
						? TUI.seamRowInNewFrame(seamBase, newLines, seamTop)
						: null;
			}
			return seamRow;
		};

		// Shared epilogue for every frame-writing path: record the frame the
		// terminal now shows and reposition the hardware cursor. Every writer
		// must land here so the commit bookkeeping has one home.
		// maxLines: "set" resets the working-area high-water mark to the frame
		// length (clean repaints), "grow" only raises it (differential appends),
		// "keep" leaves it alone (pure deletions). hardwareCursorRow defaults to
		// the end of the content; the differential path overrides it with the row
		// its partial repaint actually left the cursor on.
		const commitFrame = (maxLines: "set" | "grow" | "keep", hardwareCursorRow?: number): void => {
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = hardwareCursorRow ?? this.cursorRow;
			if (maxLines === "set") {
				this.maxLinesRendered = newLines.length;
			} else if (maxLines === "grow") {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			this.previousViewportTop = getViewportTop(this.maxLinesRendered);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.commitRenderedLines(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
		};

		// Clear the viewport and repaint. A clean repaint (clear === true) may
		// only skip lines that were already flushed into scrollback: \x1b[2K
		// cannot reach scrollback, so rewriting the already-flushed prefix would
		// re-commit it as duplicates (#2307). Where that flushed prefix ends is
		// tracked by flushedLineCount — enforced here via firstLine, not assumed
		// (#2415). Anything from firstLine down is written below; if that region
		// is taller than the screen the overflow scrolls the never-flushed part
		// into scrollback instead of erasing it. The pristine first render
		// (clear === false) keeps the unbounded write — it is what seeds
		// scrollback with the transcript.
		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			let buffer = this.useSynchronizedOutput ? "\x1b[?2026h" : "";
			// Delete every Kitty placement from the previous frame before repainting.
			// \x1b[2J cleared graphics on Ghostty (but NOT on upstream Kitty), and the
			// no-clear branch never erases graphics at all — so an unconditional
			// delete of the prior frame's image ids is the only terminal-agnostic way
			// to stop placements from lingering/stacking across a full repaint. We use
			// previousKittyImageIds (not previousLines) because a forced full render
			// resets previousLines to [] before we get here, but the GPU placements
			// from the prior frame are still on screen and must be cleared. Any image
			// still in the rewritten lines is re-emitted below and replaces its
			// (now-deleted) prior placement via its stable id.
			buffer += this.deleteKittyImages(this.previousKittyImageIds);
			let firstLine = clear ? Math.min(this.flushedLineCount, Math.max(0, newLines.length - height)) : 0;
			// Rows deleted above the screen top moved the on-screen rows up, past
			// the index the mark still names: start at the old screen-top row so
			// it is repainted rather than erased (#3020).
			const seam = firstLine > 0 ? shiftedSeamRow() : null;
			if (seam !== null && seam < firstLine) {
				firstLine = seam;
			}
			const startRow = Math.max(1, height - Math.max(1, newLines.length - firstLine) + 1);
			if (clear) {
				// Erase line-by-line instead of \x1b[2J: 2J erases the screen in
				// place without scrolling, destroying lines that were never written
				// to the terminal (#2415). Same visible result — the rows above the
				// rewritten region are cleared first, each written row carries its
				// own \x1b[2K, and the rows below are cleared after — but an
				// oversized region scrolls naturally instead of being erased.
				buffer += "\x1b[1;1H";
				for (let row = 1; row < startRow; row++) {
					buffer += "\x1b[2K\r\n";
				}
			} else if (startRow > 1) {
				buffer += `\x1b[${startRow};1H`;
			}
			for (let i = firstLine; i < newLines.length; i++) {
				if (i > firstLine) buffer += "\r\n";
				if (clear) buffer += "\x1b[2K";
				let line = newLines[i];
				if (!isImageLine(line) && visibleWidth(line) > width) {
					line = truncateToWidth(line, width);
				}
				buffer += line;
			}
			if (clear) {
				// Clear any rows left below the rewritten region (content shorter
				// than the screen). \r pins column 1 and \x1b[1B parks on the
				// bottom row without scrolling, so this never pushes rows into
				// scrollback and never leaves a partial erasure behind.
				for (let row = startRow + (newLines.length - firstLine); row <= height; row++) {
					buffer += "\r\x1b[1B\x1b[2K";
				}
			}
			if (this.useSynchronizedOutput) buffer += "\x1b[?2026l";
			this.terminal.write(buffer);
			// Everything from firstLine down has now been written; when the region
			// overflowed the screen, its top scrolled into scrollback, so the
			// flushed high-water advances to the new viewport top — established
			// against the current dimensions.
			this.flushedLineCount = Math.max(this.flushedLineCount, newLines.length - height);
			this.flushedAtWidth = width;
			this.flushedAtHeight = height;
			commitFrame(clear ? "set" : "grow");
		};

		const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const logPath = path.join(os.homedir(), ".pi", "agent", "pi-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			fs.appendFileSync(logPath, msg);
		};

		// Repaint with the flushed prefix as the screen top (#2541): the frame
		// shrank but the scrollback prefix is untouched, so the viewport is
		// drawn from the committed physical screen top down (or, when the
		// shrink deleted overlap rows, from the deletion-aligned top,
		// #2635) and the freed rows are left blank at the bottom — the same
		// end state the pure-deletion path leaves. Later appends fill them
		// in; nothing already in scrollback is re-committed. The TUI owns the
		// whole screen here (the frame once overflowed it).
		const repaintFromFlushedTop = (top: number): void => {
			let buffer = this.useSynchronizedOutput ? "\x1b[?2026h" : "";
			// This full-screen repaint clears rows with \x1b[2K only; delete the
			// prior frame's Kitty placements so displaced images don't linger.
			buffer += this.deleteKittyImages(this.previousKittyImageIds);
			buffer += "\x1b[1;1H";
			for (let row = 0; row < height; row++) {
				if (row > 0) buffer += "\r\n";
				buffer += "\x1b[2K";
				let line = newLines[top + row] ?? "";
				if (!isImageLine(line) && visibleWidth(line) > width) {
					line = truncateToWidth(line, width);
				}
				buffer += line;
			}
			if (this.useSynchronizedOutput) buffer += "\x1b[?2026l";
			this.terminal.write(buffer);
			// The flushed mark must never claim rows the physical screen still
			// shows. A deletion-aligned repaint (#2635) starts below the old
			// kept top, so the mark demotes to the new screen top — an
			// optimistic mark would let a later clean repaint skip the
			// screen-top row and destroy it without it ever reaching
			// scrollback. For the unaligned keep-top (top == keptTop) the mark
			// already sits at the screen top, so the demotion is a no-op.
			this.flushedLineCount = Math.min(this.flushedLineCount, top);
			// Commit the frame padded with the freed rows so the bottom-aligned
			// invariant (length - height == screen top) keeps holding for every
			// consumer while the blanks persist (#2541).
			newLines = [...newLines, ...Array.from({ length: top + height - newLines.length }, () => "")];
			this.baseContentLineCount = newLines.length;
			// A cursor marker above the retained top is not on screen; positioning
			// the hardware cursor there would record an unreachable row (the
			// movement clamps at the screen top) and mis-aim later writes.
			if (cursorPos && cursorPos.row < top) {
				cursorPos = null;
			}
			this._shrinkDebounceActive = false;
			commitFrame("set", top + height - 1);
		};

		const repaintBottomAnchoredShortBlock = (): void => {
			const startRow = Math.max(1, height - Math.max(1, newLines.length) + 1);
			let buffer = this.useSynchronizedOutput ? "\x1b[?2026h" : "";
			// Same rationale as fullRender: this path repaints whole lines with
			// \x1b[2K, which does not remove Kitty graphics. Delete the prior frame's
			// placements so re-emitted images replace rather than stack.
			buffer += this.deleteKittyImages(this.previousKittyImageIds);
			buffer += `\x1b[${startRow};1H`;
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += "\x1b[2K";
				let line = newLines[i];
				if (!isImageLine(line) && visibleWidth(line) > width) {
					line = truncateToWidth(line, width);
				}
				buffer += line;
			}
			if (this.useSynchronizedOutput) buffer += "\x1b[?2026l";
			this.terminal.write(buffer);
			commitFrame("grow");
		};

		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		if (alignedKeptTop !== null) {
			logRedraw(
				`shrink keeps flushed top (${alignedKeptTop}${alignedKeptTop !== keptTop ? `, aligned from ${keptTop}` : ""}) instead of re-emitting scrollback`,
			);
			repaintFromFlushedTop(alignedKeptTop);
			return;
		}

		if (widthChanged || heightChanged) {
			// A resize re-anchors what the terminal holds: a width change re-wraps
			// the transcript, and a height change moves the viewport/scrollback
			// boundary itself (scrollback gives lines back on grow and takes more
			// on shrink). A mark established under other dimensions no longer
			// identifies flushed lines — invalidate it and repaint from the first
			// line, loss-free at the cost of re-committing a bounded duplicate of
			// the visible region (#2415). Forced renders reach this branch through
			// the -1 sentinels without touching flushedAt*, so a forced repaint
			// with no real resize behind it stays viewport-bounded and
			// duplicate-free (#2307).
			if (this.flushedAtWidth !== width || this.flushedAtHeight !== height) {
				this.flushedLineCount = 0;
			}
			logRedraw(`terminal size changed (${this.previousWidth}x${this.previousHeight} -> ${width}x${height})`);
			fullRender(true);
			return;
		}

		if (
			newLines.length < this.previousLines.length &&
			(newLines.length <= height || this.previousLines.length <= height)
		) {
			logRedraw(`bottom-anchored short block shrunk (${this.previousLines.length} -> ${newLines.length})`);
			fullRender(true);
			return;
		}

		if (
			this.previousLines.length > height &&
			newLines.length > height &&
			newLines.length < this.previousLines.length &&
			this.overlayStack.length === 0
		) {
			// A shrink that also moved rows above the physical screen top fails the
			// padding check at the top of doRender (the overlap no longer matches by
			// index), e.g. a tool card straddling the seam folding into its one-row
			// phase summary mid-turn. Realigning to the new viewport top would then
			// repaint scrollback rows a second time. The forced-repaint alignment
			// applies unchanged: the committed frame is the base, the physical top
			// the seam (#3000). When the overlap still matches by index the realign
			// is exact — keep it (a below-seam deletion with a visible-region edit,
			// which keepsFlushedTop's above-screen model would mis-anchor).
			let overlapMatchesByIndex = true;
			for (let i = newLines.length - height; i < Math.min(prevViewportTop, newLines.length); i++) {
				if (this.previousLines[i] !== newLines[i]) {
					overlapMatchesByIndex = false;
					break;
				}
			}
			const alignedTop =
				overlapMatchesByIndex ||
				this.flushedAtWidth !== width ||
				this.flushedAtHeight !== height
					? null
					: this.keepsFlushedTop(this.previousLines, newLines, height, prevViewportTop, flushedBeforeShrink);
			if (alignedTop !== null) {
				logRedraw(`tall→tall shrink keeps flushed top (${alignedTop}, retained ${prevViewportTop}) instead of re-emitting scrollback`);
				// Rows above the aligned top are verified scrollback; the repaint
				// demotes the mark to that top, not to the shrunken viewport top.
				this.flushedLineCount = flushedBeforeShrink;
				repaintFromFlushedTop(alignedTop);
				return;
			}
			// More rows went above the screen top than the frame lost: the old
			// screen-top row now sits above the new viewport top, and an in-place
			// realign would erase it. A clean repaint from it scrolls the rows up
			// to the new viewport top into scrollback instead (#3020).
			const seam = shiftedSeamRow();
			if (seam !== null && seam < getViewportTop(newLines.length)) {
				logRedraw(`tall→tall shrink moved the screen top above the viewport (${seam}) — clean repaint from it`);
				fullRender(true);
				return;
			}
			logRedraw(`tall→tall shrink viewport realign (${this.previousLines.length} -> ${newLines.length})`);
			const newViewportTop = getViewportTop(newLines.length);
			const currentScreenRow = Math.max(0, hardwareCursorRow - prevViewportTop);
			let buffer = this.useSynchronizedOutput ? "\x1b[?2026h" : "";
			// This viewport repaint also clears lines with \x1b[2K only; delete prior
			// Kitty placements so images displaced by the realign don't linger/stack.
			buffer += this.deleteKittyImages(this.previousKittyImageIds);
			if (currentScreenRow > 0) {
				buffer += `\x1b[${currentScreenRow}A`;
			}
			buffer += "\r";
			for (let i = 0; i < height; i++) {
				const idx = newViewportTop + i;
				if (i > 0) buffer += "\r\n";
				buffer += "\x1b[2K";
				let line = newLines[idx] ?? "";
				if (!isImageLine(line) && visibleWidth(line) > width) {
					line = truncateToWidth(line, width);
				}
				buffer += line;
			}
			if (this.useSynchronizedOutput) buffer += "\x1b[?2026l";
			this.terminal.write(buffer);
			commitFrame("set");
			this._shrinkDebounceActive = false;
			return;
		}

		if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {
			if (!this._shrinkDebounceActive) {
				this._shrinkDebounceActive = true;
				logRedraw(`clearOnShrink deferred (maxLinesRendered=${this.maxLinesRendered})`);
			} else {
				this._shrinkDebounceActive = false;
				logRedraw(`clearOnShrink committed (maxLinesRendered=${this.maxLinesRendered})`);
				fullRender(true);
				return;
			}
		} else {
			this._shrinkDebounceActive = false;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			lastChanged = this.expandLastChangedForKittyImages(firstChanged, lastChanged);
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = getViewportTop(this.maxLinesRendered);
			this.previousHeight = height;
			return;
		}

		if (appendedLines && this.previousLines.length <= height && newLines.length <= height) {
			repaintBottomAnchoredShortBlock();
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = this.useSynchronizedOutput ? "\x1b[?2026h" : "";
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				if (extraLines > 0) {
					buffer += "\x1b[1B";
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				if (extraLines > 0) {
					buffer += `\x1b[${extraLines}A`;
				}
				if (this.useSynchronizedOutput) buffer += "\x1b[?2026l";
				this.terminal.write(buffer);
			}
			commitFrame("keep");
			return;
		}

		const previousContentViewportTop = prevViewportTop;
		if (firstChanged < previousContentViewportTop) {
			// A mid-buffer reflow (for example markdown code-fence borders or prose word-wrap)
			// shifted a line across the scrollback/viewport boundary. Clamping would leave
			// the displaced line frozen in scrollback and re-emit it in the live region,
			// producing a verbatim duplicate. Fall back to a clean repaint; the repaint is
			// viewport-bounded (see fullRender), so it never re-commits the flushed prefix.
			// The physical screen top (previousViewportTop, not
			// previousLines.length - height) is the boundary that matters: a
			// kept-flushed-top shrink (#2541) leaves blank rows at the bottom, so
			// the two differ and the length-based estimate would aim the cursor
			// above the screen.
			logRedraw(
				`firstChanged < viewportTop (${firstChanged} < ${previousContentViewportTop}) — full repaint to avoid duplicate`,
			);
			fullRender(true);
			return;
		}

		let buffer = this.useSynchronizedOutput ? "\x1b[?2026h" : "";
		// Free any Kitty image placements that lived on the changed lines before we
		// repaint them. Kitty/Ghostty placements are GPU-side graphics that text
		// erasure (\x1b[2K) does NOT remove; without an explicit delete the old
		// placement lingers while the redraw adds a new one, stacking copies over
		// the chat and footer. Stable placement ids (see encodeKitty) make the
		// common in-place redraw replace rather than stack, but a line whose image
		// is being replaced by different content (or a different image id) still
		// needs the prior id explicitly deleted.
		buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += "\x1b[2K"; // Clear current line
			let line = newLines[i];
			const isImage = isImageLine(line);
			if (!isImage && visibleWidth(line) > width) {
				line = truncateToWidth(line, width);
			}
			buffer += line;
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		if (this.previousLines.length > newLines.length) {
			const renderEndScreenRow = renderEnd - viewportTop;
			const ghostLinesVisible = renderEndScreenRow < height - 1;
			if (ghostLinesVisible) {
				if (renderEnd < newLines.length - 1) {
					const moveDown = newLines.length - 1 - renderEnd;
					buffer += `\x1b[${moveDown}B`;
					finalCursorRow = newLines.length - 1;
				}
				const extraLines = this.previousLines.length - newLines.length;
				for (let i = newLines.length; i < this.previousLines.length; i++) {
					buffer += "\r\n\x1b[2K";
				}
				buffer += `\x1b[${extraLines}A`;
			}
		}

		if (this.useSynchronizedOutput) buffer += "\x1b[?2026l";

		if (process.env.PI_TUI_DEBUG === "1") {
			const debugDir = path.join(os.tmpdir(), "tui");
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				JSON.stringify(buffer),
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
			pruneDebugRenderLogs(debugDir);
		}

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Writing down to finalCursorRow scrolled every line above the new
		// viewport top past the bottom row, so the flushed high-water advances
		// with the cursor (no-op when the frame never reached the bottom row) —
		// established against the current dimensions.
		this.flushedLineCount = Math.max(this.flushedLineCount, finalCursorRow - height + 1);
		this.flushedAtWidth = width;
		this.flushedAtHeight = height;

		commitFrame("grow", finalCursorRow);
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.showHardwareCursor) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
