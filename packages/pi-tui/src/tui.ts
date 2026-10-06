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
	extractSegments,
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

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	private overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
		focusOrder: number;
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
		const entry = {
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
		this.terminal.write("\x1b[16t");
		// iTerm2 does NOT answer CSI 16t — its only cell-size mechanism is the
		// proprietary OSC 1337 ; ReportCellSize query → reply
		// OSC 1337 ; ReportCellSize=height;width[;scale] ST. Without this, pi falls
		// back to a default cell size on iTerm2 and sizes inline images with the
		// wrong cell aspect (leaving trailing slack / mis-fit). Both replies are
		// handled by parseCellSizeResponse; sending both queries is harmless on
		// terminals that ignore one of them.
		if (caps.images === "iterm2") {
			this.terminal.write("\x1b]1337;ReportCellSize\x07");
		}
	}

	stop(): void {
		this.stopped = true;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		// Move cursor to the end of the content to prevent overwriting/artifacts on exit
		if (this.previousLines.length > 0) {
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

		// Base content: translate the screen row to a content-line row.
		if (this.baseContentLineCount <= 0) return;
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

		// Pre-render all visible overlays and calculate positions
		const rendered: { overlayLines: string[]; row: number; col: number; w: number }[] = [];
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

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			rendered.push({ overlayLines, row, col, w: width });
			// Record the on-screen region for mouse hit-testing. Overlays force the
			// working area to at least the terminal height (see below), so the
			// viewport is bottom-aligned to the screen and `row`/`col` are also the
			// viewport-relative screen coordinates.
			this.overlayRegions.push({
				component,
				row,
				col,
				width,
				height: overlayLines.length,
				focusOrder: entry.focusOrder,
				capturing: !options?.nonCapturing,
			});
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Composite each overlay
		for (const { overlayLines, row, col, w } of rendered) {
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
	 * Whether a forced repaint of a shrinking frame can keep the retained
	 * screen top instead of repainting from the new viewport top (#2541).
	 * Repainting from the new viewport top re-writes the overlap — lines
	 * already committed to scrollback — a second time. When the frame prefix
	 * above the retained top is byte-identical (deletions only removed content
	 * at/below the old viewport, e.g. a torn-down pinned zone) and the overlap
	 * is small, the freed rows can simply be left blank at the bottom, the
	 * same end state the pure-deletion path leaves. Larger overlaps refill the
	 * screen so the blank-viewport behavior (#613) is preserved; the pinned
	 * zone this exists for is capped at ~40% of the viewport plus borders,
	 * well under half. Unforced frames never take this path: there the
	 * differential renderer handles bottom deletions in place over the padded
	 * retained layout.
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
	): boolean {
		if (top <= 0 || top > this.flushedLineCount || this.overlayStack.length > 0) {
			return false;
		}
		if (!baseLines || baseLines.length <= newLines.length) {
			return false;
		}
		// Only frames still taller than the screen qualify: a frame that now
		// fits on screen is bottom-anchored and repaints from its first line.
		const newTop = newLines.length - height;
		if (newTop <= 0) {
			return false;
		}
		const overlap = top - newTop;
		if (overlap <= 0 || overlap > Math.floor(height / 2)) {
			return false;
		}
		for (let i = 0; i < top; i++) {
			if (baseLines[i] !== newLines[i]) {
				return false;
			}
		}
		// An image placement inside the overlap would be deleted without
		// replacement (the repaint starts below it); the refill path re-emits
		// it, so keep that behavior when images cross the boundary.
		for (let i = newTop; i < top; i++) {
			if (isImageLine(newLines[i])) {
				return false;
			}
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

	private doRender(): void {
		if (this.stopped) return;
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
		// retained (larger shrinks refill the screen, #613); the prefix above
		// the retained top must still match the committed frame, else retention
		// is stale and the next repaint re-anchors naturally. A forced render
		// has no committed frame to compare against (previousLines is reset),
		// so it never pads here — the kept-top writer handles that path.
		const retainedTop = this.previousViewportTop;
		if (
			retainedTop > 0 &&
			retainedTop <= this.flushedLineCount &&
			this.flushedAtWidth === width &&
			this.flushedAtHeight === height &&
			newLines.length < retainedTop + height &&
			retainedTop + height - newLines.length <= Math.floor(height / 2) &&
			this.previousLines.length >= retainedTop
		) {
			// Committed lines carry the segment-reset suffix (applyLineResets),
			// so compare the new lines in the same committed form.
			let prefixMatches = true;
			for (let i = 0; i < retainedTop; i++) {
				const line = newLines[i];
				const committed = isImageLine(line)
					? line
					: normalizeTerminalOutput(line) + TUI.SEGMENT_RESET;
				if (this.previousLines[i] !== committed) {
					prefixMatches = false;
					break;
				}
			}
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
		const keepFlushedTop =
			forcedRender &&
			this.flushedAtWidth === width &&
			this.flushedAtHeight === height &&
			this.keepsFlushedTop(forcedRenderBaseLines, newLines, height, keptTop);
		if (newLines.length < this.previousLines.length) {
			this.flushedLineCount = Math.min(this.flushedLineCount, Math.max(0, newLines.length - height));
		}

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
			const firstLine = clear ? Math.min(this.flushedLineCount, Math.max(0, newLines.length - height)) : 0;
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
		// drawn from the committed physical screen top down and the freed rows
		// are left blank at the bottom — the same end state the pure-deletion
		// path leaves. Later appends fill them in; nothing already in
		// scrollback is re-committed. The TUI owns the whole screen here (the
		// frame once overflowed it).
		const repaintFromFlushedTop = (): void => {
			const top = keptTop;
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

		if (keepFlushedTop) {
			logRedraw(`shrink keeps flushed top (${keptTop}) instead of re-emitting scrollback`);
			repaintFromFlushedTop();
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
