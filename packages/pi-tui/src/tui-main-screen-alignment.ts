import { isImageLine } from "./terminal-image.js";
import { extractAnsiCode, isWhitespaceChar, visibleWidth } from "./utils.js";

export function windowMultiplicitiesBacked(
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
export function overlapMatches(
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
export function repairShiftedOverlap(
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
export function keepsFlushedTop(
	hasOverlays: boolean,
	flushedLineCount: number,
		baseLines: string[] | undefined,
		newLines: string[],
		height: number,
		top: number,
		flushed: number = flushedLineCount,
	): number | null {
		if (top <= 0 || top > flushed || hasOverlays) {
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
			return alignedTopWithoutImages(
				newLines,
				newTop,
				repairCompoundShrink(baseLines, newLines, newTop, top, height) ??
					hiddenEditTop(baseLines, newLines, newTop, top, height) ??
					firstChangeTop(baseLines, newLines, newTop, top, height),
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
			overlapMatches(newTop, top, matches, (i) => newLines[i]) &&
			matches(top) &&
			windowMultiplicitiesBacked(baseLines, (i) => newLines[i] ?? "", newTop, top)
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
			repairShiftedOverlap(baseLines, newLines, newTop, top) ??
			repairCompoundShrink(baseLines, newLines, newTop, top, height) ??
			hiddenEditTop(baseLines, newLines, newTop, top, height) ??
			firstChangeTop(baseLines, newLines, newTop, top, height);
		return alignedTopWithoutImages(newLines, newTop, alignedTop);
	}

export function hiddenEditTop(
		baseLines: string[],
		newLines: string[],
		newTop: number,
		top: number,
		height: number,
	): number | null {
		const newLen = newLines.length;
		const seam = seamRowInNewFrame(baseLines, newLines, top);
		if (seam === null || seam <= newTop || seam > top) {
			return null;
		}
		// Prefer showing the change when that prints nothing twice: when the
		// first change is inside the overlap, firstChangeTop repaints from it,
		// and that is fine unless a row it repaints reads the same as one of
		// the old rows it lands below (an unchanged row, or a re-render that
		// changed only styling), which the reader sees twice.
		const limit = Math.min(top, newLen, baseLines.length);
		let first = 0;
		while (first < limit && newLines[first] === baseLines[first]) {
			first++;
		}
		if (first >= newTop) {
			const old = new Set<string>();
			for (let i = first; i < top; i++) old.add(visibleText(baseLines[i] ?? ""));
			let readsTwice = false;
			for (let i = first; i < seam && !readsTwice; i++) {
				const text = visibleText(newLines[i] ?? "");
				readsTwice = text !== "" && old.has(text);
			}
			if (!readsTwice) {
				return null;
			}
		}
		const skip = seam - newTop;
		let tail = 0;
		while (tail < newLen && isVisuallyBlank(newLines[newLen - 1 - tail] ?? "")) {
			tail++;
		}
		if (skip + Math.min(tail, height - skip) > Math.floor(height / 2)) {
			return null;
		}
		let anchored = false;
		for (let i = seam; i < newLen && !anchored; i++) {
			anchored = visibleWidth(newLines[i] ?? "") > 0;
		}
		if (!anchored) {
			return null;
		}
		// Removed-value guard (repairCompoundShrink's): a value the repaint
		// removes from the screen that the new frame still shows above the seam
		// may exist there only as a hidden, never-printed copy, so refuse
		// rather than risk losing its last physical copy.
		const remaining = new Map<string, number>();
		for (let i = top; i < Math.min(baseLines.length, top + height); i++) {
			const value = baseLines[i] ?? "";
			remaining.set(value, (remaining.get(value) ?? 0) + 1);
		}
		for (let i = seam; i < newLen; i++) {
			const value = newLines[i] ?? "";
			remaining.set(value, (remaining.get(value) ?? 0) - 1);
		}
		const above = new Set<string>();
		for (let i = 0; i < seam; i++) above.add(newLines[i] ?? "");
		for (const [value, count] of remaining) {
			if (count > 0 && visibleWidth(value) > 0 && above.has(value)) {
				return null;
			}
		}
		return seam;
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
	 * bottom are capped like repairCompoundShrink's (#613). The first change
	 * may also be the old screen-top row itself (a card whose first row was
	 * the screen top folding into its summary): every row above it is then
	 * unchanged scrollback, and the overlap check refuses only because the
	 * seam row differs, so repainting from it prints nothing twice where the
	 * refill re-emitted the whole overlap. Returns null when the first change
	 * is outside [newTop, top] (other paths own those) or the cap would be
	 * exceeded.
	 */
export function firstChangeTop(
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
		if (first < newTop || first > top) {
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
		while (tail < newLen && isVisuallyBlank(newLines[newLen - 1 - tail] ?? "")) {
			tail++;
		}
		const skip = first - newTop;
		if (skip + Math.min(tail, height - skip) > Math.floor(height / 2)) {
			return null;
		}
		return first;
	}

	/** The aligned top, or null when an image line would be skipped (the refill re-emits it). */
export function alignedTopWithoutImages(newLines: string[], newTop: number, alignedTop: number | null): number | null {
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
export function repairCompoundShrink(
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
		while (tail < newLen && isVisuallyBlank(newLines[newLen - 1 - tail] ?? "")) {
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
export function seamRowInNewFrame(
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
		const match = matchRows(baseLines, newLines, common, maxEdits);
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
export function matchRows(a: string[], b: string[], from: number, maxEdits: number): Int32Array | null {
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

	/** What the terminal shows for a line: its text without escape sequences or trailing whitespace. */
export function visibleText(line: string): string {
		let text = "";
		for (let i = 0; i < line.length; ) {
			const ansi = extractAnsiCode(line, i);
			if (ansi) {
				i += ansi.length;
				continue;
			}
			text += line[i];
			i++;
		}
		return text.trimEnd();
	}

	/** Whether a rendered line shows nothing — no visible non-blank cell. */
export function isVisuallyBlank(line: string): boolean {
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