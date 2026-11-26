import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteKittyImage, isImageLine } from "./terminal-image.js";
import { SEGMENT_RESET, type TUI, TuiBase, type TuiStopOptions } from "./tui.js";
import { keepsFlushedTop, overlapMatches, seamRowInNewFrame, windowMultiplicitiesBacked } from "./tui-main-screen-alignment.js";
import { normalizeTerminalOutput, truncateToWidth, visibleWidth } from "./utils.js";

/** OSC 133 prompt markers at the start of a rendered line. Fullscreen uses them for prompt navigation. */
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

const KITTY_SEQUENCE_PREFIX = "\x1b_G";
const MAX_RENDER_WRITE_CHARS = 1024 * 1024;

/**
 * Streams terminal output in 1 MiB chunks so a full render never forms one string large enough to exceed V8's limit.
 *
 * `append()` fills the current chunk and flushes it when full. Oversized input is split at chunk boundaries, preserving
 * surrogate pairs so each write remains valid UTF-16. Callers append synchronized-output begin/end sequences themselves;
 * the final `flush()` writes any remainder, including the end sequence.
 */
class BoundedTerminalWriter {
	private buffer = "";
	private writtenChars = 0;
	private readonly write: (data: string) => void;

	constructor(write: (data: string) => void) {
		this.write = write;
	}

	/**
	 * Append terminal data, flushing full chunks as needed. Callers must call `flush()` after the final append.
	 * @param value Terminal data to write in order; oversized values are split without splitting surrogate pairs.
	 */
	append(value: string): void {
		let offset = 0;
		while (offset < value.length) {
			const capacity = MAX_RENDER_WRITE_CHARS - this.buffer.length;
			if (capacity === 0) {
				this.flush();
				continue;
			}

			let end = Math.min(value.length, offset + capacity);
			if (
				end < value.length &&
				value.charCodeAt(end - 1) >= 0xd800 &&
				value.charCodeAt(end - 1) <= 0xdbff &&
				value.charCodeAt(end) >= 0xdc00 &&
				value.charCodeAt(end) <= 0xdfff
			) {
				end--;
			}
			if (end === offset) {
				this.flush();
				continue;
			}

			this.buffer += value.slice(offset, end);
			offset = end;
			if (this.buffer.length === MAX_RENDER_WRITE_CHARS) {
				this.flush();
			}
		}
	}

	/** Write the current chunk, if any, and retain only its character count for debug output. */
	flush(): void {
		if (!this.buffer) return;
		this.write(this.buffer);
		this.writtenChars += this.buffer.length;
		this.buffer = "";
	}

	get length(): number {
		return this.writtenChars + this.buffer.length;
	}
}

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;
	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") ids.push(numberValue);
		else if (key === "r") rows = numberValue;
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

export interface TuiMainScreenRenderState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
}

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements TUI {
	readonly mode = "regular" as const;
	private previousLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private maxLinesRendered = 0;
	private previousViewportTop = 0;
	private flushedLineCount = 0;
	private flushedAtWidth = 0;
	private flushedAtHeight = 0;
	private forcedRenderBaseLines?: string[];
	private forcedRenderBaseViewportTop?: number;
	private _shrinkDebounceActive = false;
	private _lastRenderedComponents: string[] | null = null;
	private _lastFrameHadOverlays = false;
	private baseContentLineCount = 0;

	captureRenderState(): TuiMainScreenRenderState {
		return {
			previousLines: [...this.previousLines],
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
		};
	}

	restoreRenderState(state: TuiMainScreenRenderState): void {
		this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
		this.previousKittyImageIds = new Set();
		this.previousWidth = state.previousWidth;
		this.previousHeight = state.previousHeight;
		this.cursorRow = state.cursorRow;
		this.hardwareCursorRow = state.hardwareCursorRow;
		this.maxLinesRendered = state.maxLinesRendered;
		this.previousViewportTop = state.previousViewportTop;
	}

	protected override resetRenderState(): void {
		this.previousLines = [];
		this.previousWidth = -1;
		this.previousHeight = -1;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
		this.flushedLineCount = 0;
		this.flushedAtWidth = 0;
		this.flushedAtHeight = 0;
		this.forcedRenderBaseLines = undefined;
		this.forcedRenderBaseViewportTop = undefined;
		this._lastRenderedComponents = null;
		this._lastFrameHadOverlays = false;
		this._shrinkDebounceActive = false;
		this.baseContentLineCount = 0;
	}

	protected override beforeTerminalStop(options: TuiStopOptions): void {
		if (options.preserveScreen || this.previousLines.length === 0) return;
		this.terminal.write(" ");
		const targetRow = this.previousLines.length;
		const lineDiff = targetRow - this.hardwareCursorRow;
		if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
		else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
		this.terminal.write("\r\n");
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

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): { firstChanged: number; lastChanged: number } {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (lines: string[]): void => {
			for (let i = 0; i < lines.length; i++) {
				if (extractKittyImageIds(lines[i]).length === 0) continue;
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines);
		expandForLines(newLines);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
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

	private writeRenderBuffer(buffer: string): void {
		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append(buffer);
		output.flush();
	}

	private commitRenderedLines(newLines: string[]): void {
		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
	}


	protected doRender(): void {
		if (this.stopped) return;
		const redrawLogDirectory = process.env.PI_TUI_DEBUG_REDRAW === "1" ? this.logDirectory : undefined;
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
		let newLines = this.resolveFakeCursors(this.render(width).map((line) => line.replace(OSC133_ZONE_PREFIX, "")));

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
				return isImageLine(line) ? line : normalizeTerminalOutput(line) + SEGMENT_RESET;
			};
			const prefixMatches =
				overlapMatches(newLines.length - height, retainedTop, (i) => {
					return committedLines[i] === newCommittedAt(i);
				}, (i) => newLines[i]) &&
				windowMultiplicitiesBacked(
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
			!this.hasOverlayEntries &&
			!this._lastFrameHadOverlays &&
			!widthChanged &&
			!heightChanged
		) {
			return;
		}
		this._lastRenderedComponents = newLines;
		this._lastFrameHadOverlays = this.hasOverlayEntries;

		// Composite overlays into the rendered lines (before differential compare)
		if (this.hasOverlayEntries) {
			newLines = this.compositeOverlays(newLines, width, height);
		} else {
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
				? keepsFlushedTop(this.hasOverlayEntries, this.flushedLineCount, forcedRenderBaseLines, newLines, height, keptTop)
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
						? seamRowInNewFrame(seamBase, newLines, seamTop)
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
			let buffer = "\x1b[?2026h";
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
			buffer += "\x1b[?2026l";
			this.writeRenderBuffer(buffer);
			// Everything from firstLine down has now been written; when the region
			// overflowed the screen, its top scrolled into scrollback, so the
			// flushed high-water advances to the new viewport top — established
			// against the current dimensions.
			this.flushedLineCount = Math.max(this.flushedLineCount, newLines.length - height);
			this.flushedAtWidth = width;
			this.flushedAtHeight = height;
			commitFrame(clear ? "set" : "grow");
		};

		const debugRedraw = redrawLogDirectory !== undefined;
		const logRedraw = (reason: string): void => {
			if (redrawLogDirectory === undefined) return;
			const logPath = path.join(redrawLogDirectory, "pi-tui-debug.log");
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
			let buffer = "\x1b[?2026h";
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
			buffer += "\x1b[?2026l";
			this.writeRenderBuffer(buffer);
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
			let buffer = "\x1b[?2026h";
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
			buffer += "\x1b[?2026l";
			this.writeRenderBuffer(buffer);
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
			!this.hasOverlayEntries
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
					: keepsFlushedTop(this.hasOverlayEntries, this.flushedLineCount, this.previousLines, newLines, height, prevViewportTop, flushedBeforeShrink);
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
			let buffer = "\x1b[?2026h";
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
			buffer += "\x1b[?2026l";
			this.writeRenderBuffer(buffer);
			commitFrame("set");
			this._shrinkDebounceActive = false;
			return;
		}

		if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
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
			lastChanged = this.expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines).lastChanged
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
				let buffer = "\x1b[?2026h";
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
				buffer += "\x1b[?2026l";
				this.writeRenderBuffer(buffer);
			}
			// This path never scrolls and keeps the working area, so the screen top stays at
			// prevViewportTop while the shrink demotion lowered the mark to newLines.length - height.
			// Every row above both the screen top and the first change is unchanged and already in
			// scrollback: the mark may claim it (see the differential epilogue below).
			this.flushedLineCount = Math.max(this.flushedLineCount, Math.min(firstChanged, prevViewportTop));
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

		let buffer = "\x1b[?2026h";
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

		buffer += "\x1b[?2026l";

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
			
		}

		// Write entire buffer at once
		this.writeRenderBuffer(buffer);

		// Writing down to finalCursorRow scrolled every line above the new
		// viewport top past the bottom row, so the flushed high-water advances
		// with the cursor (no-op when the frame never reached the bottom row) —
		// established against the current dimensions.
		this.flushedLineCount = Math.max(this.flushedLineCount, finalCursorRow - height + 1);
		// A shrink drawn here (a docked overlay is open, so the tall→tall path was skipped) clears
		// the freed rows in place and keeps the working area: the screen top stays at prevViewportTop
		// although the shrink demotion lowered the mark to newLines.length - height. The differential
		// only runs when firstChanged >= the screen top, so every row above the screen top is
		// unchanged and already in scrollback, and the mark may claim it. Left demoted, the next tall
		// shrink (the overlay closing, the loader going) rejects the kept top as "top > flushed" and
		// its realign repaints from newLines.length - height, re-emitting the rows in between.
		this.flushedLineCount = Math.max(this.flushedLineCount, Math.min(firstChanged, prevViewportTop));
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
		if (this.getShowHardwareCursor()) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
