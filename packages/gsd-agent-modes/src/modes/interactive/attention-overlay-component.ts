import { wrapTextWithAnsi, type Component } from "@gsd/pi-tui";
import { AttentionOverlayController } from "./attention-overlay.js";
import { INSPECT_ONLY_NOTICE } from "./attention-model.js";

/** Minimal keybinding surface used by this component; the app KeybindingsManager satisfies it. */
export interface AttentionKeybindings {
	matches(data: string, action: "tui.select.cancel" | "tui.select.confirm" | "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown"): boolean;
}

/**
 * Thin native renderer over AttentionOverlayController. It holds no state of its
 * own, binds no approve/retry/resolve key, and maps only the app keybindings
 * selectCancel/selectConfirm/selectUp/selectDown into normalized actions.
 */
/**
 * Wrap one logical line to terminal display columns (wide CJK/emoji count as two,
 * combining marks as zero) using the repository's pi-tui wrapper. Never truncates.
 */
export function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const wrapped = wrapTextWithAnsi(text, width);
	return wrapped.length > 0 ? wrapped : [""];
}

/** Must match the maxHeight of the production overlay in attention-overview.ts (92%). */
export const OVERLAY_MAX_HEIGHT_FRACTION = 0.92;

export class AttentionOverlayComponent implements Component {
	/** Detail lines shown by the most recent render; used as the page size for details scrolling. */
	private lastDetailBudget = 3;
	/** Rows the safety clip would have removed in the last render. Must be 0 at every supported size. */
	lastUnclippedOverflow = 0;

	constructor(
		private readonly controller: AttentionOverlayController,
		private readonly keybindings: AttentionKeybindings,
		private readonly onClose: () => void,
		/** Terminal height in rows. Injected by the mount; defaults to the live terminal. */
		private readonly terminalRows: () => number = () => Number(process.stdout.rows) || 0,
	) {}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.cancel")) {
			this.controller.handleKey("cancel");
			if (!this.controller.state().open) this.onClose();
		} else if (kb.matches(data, "tui.select.confirm")) {
			// Enter only opens local details. Inspect is a separate explicit navigation key.
			this.controller.handleKey("open");
		} else if (data === "i" && this.controller.state().detailsOpen) {
			this.controller.requestInspect();
		} else if (kb.matches(data, "tui.select.up")) {
			this.controller.handleKey("up");
		} else if (kb.matches(data, "tui.select.down")) {
			this.controller.handleKey("down");
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.controller.scrollDetails(-this.detailPageSize());
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.controller.scrollDetails(this.detailPageSize());
		}
		// All other input is intentionally unbound.
	}

	/**
	 * One measured layout pass. Every produced line is width-bounded and counted, the
	 * list shows the largest window around the selection that fits the terminal, and the
	 * details panel is a separate scrollable block. The total never exceeds the terminal
	 * height (or a small bounded minimum when the height is unknown). No mutation control
	 * is ever produced.
	 */
	render(width: number): string[] {
		const s = this.controller.state();
		const height = this.viewHeight();

		if (s.status === "unavailable") {
			const head: string[] = [];
			for (const w of wrapText(s.notice || "Attention status unavailable. Nothing was changed.", width)) head.push(w);
			for (const c of s.coverage) {
				const reason = c.reason ? ` (${c.reason})` : "";
				for (const w of wrapText(`${c.namespace}: ${c.status}, ${c.completeness}${reason}`, width)) head.push(w);
			}
			for (const w of wrapText("Not all-clear: unread sources are unknown.", width)) head.push(w);
			return head.slice(0, height);
		}

		// Top block is chosen by priority, not by a fixed size: the selected row must fit.
		// Full coverage first; then the verdict alone; then nothing. A verdict is shown
		// whenever a list or details block is present, so unread sources are never hidden.
		const incomplete = s.coverage.some((c) => c.completeness !== "complete" || c.status !== "available");
		const verdict = incomplete ? "Not all-clear" : s.allClear ? "All read" : "Open";
		const fullTop: string[] = [];
		if (s.coverage.length > 0) {
			for (const w of wrapText("Coverage: " + s.coverage
				.map((c) => `${c.namespace} ${c.status}/${c.completeness}`).join(", "), width)) fullTop.push(w);
		}
		if (incomplete) {
			for (const w of wrapText("Coverage incomplete: not all sources were read. Not all-clear.", width)) fullTop.push(w);
		} else if (s.allClear) {
			for (const w of wrapText("No open attention. All sources read complete.", width)) fullTop.push(w);
		}
		// Narrow widths: a short verdict that keeps the unknown status honest and fits in one line.
		// These are complete verdicts, not a clipped prefix of coverage prose.
		const shortVerdict = incomplete ? "Unread" : s.allClear ? "All read" : "Open";
		const oneLine = wrapText(width < 14 ? shortVerdict : verdict, width);
		// Reserve selection, the complete counter and a usable detail BODY row together.
		// When a separate verdict cannot fit, the selected row carries the compact verdict.
		// Only the remaining rows can be spent on headers, coverage, notices or more items.
		const rowsFor = (i: number): string[] => {
			const item = s.items[i]!;
			const marker = i === s.selected ? "> " : "  ";
			return wrapText(`${marker}[${item.classification}] ${item.title}`, width);
		};
		const selectedIdx = s.items.length > 0 ? s.selected : -1;
		const selectedFull = selectedIdx >= 0 ? wrapText(`> [${s.items[selectedIdx]!.classification}] ${s.items[selectedIdx]!.title}`, width) : [];
		const selFirst = selectedFull.length > 0 ? 1 : 0;
		const detailLines = this.detailsLines(width);
		const noticeLines = s.notice ? wrapText(s.notice, width) : [];
		const counterWorst = s.items.length > 1 ? this.counterWorstRows(s.items.length, width) : 0;
		// Selected-only actual counter: the window that would be shown if only the selection were kept.
		const counterSelected = s.items.length > 1 && selectedIdx >= 0
			? wrapText(`(${selectedIdx + 1}-${selectedIdx + 1} of ${s.items.length})`, width).length
			: 0;
		// Compact selected-only counter `n/N`: admitted only when the normal forms cannot fit.
		// It always denotes the selected position, so its window is the selection alone.
		const counterCompact = s.items.length > 1 && selectedIdx >= 0
			? wrapText(`${selectedIdx + 1}/${s.items.length}`, width).length
			: 0;

		const detailFirst = detailLines.length > 0 ? 1 : 0;
		const compactSelection = wrapText(`> ${shortVerdict}`, width);
		const fallsBack = (counterRows: number): boolean => {
			const mandatory = selFirst + counterRows + detailFirst;
			return mandatory > height || (selFirst > 0 && height - mandatory < oneLine.length && compactSelection.length > 1);
		};
		const resize = (): string[] => {
			// No list/pane is claimed when their mandatory spans physically cannot fit.
			// Keep the coverage truth and an explicit resize instruction, not a false pane.
			this.controller.clampDetailScroll(0);
			this.lastDetailBudget = 0;
			this.lastUnclippedOverflow = 0;
			return [...wrapText(shortVerdict, width), ...wrapText("> Resize", width), ...wrapText(s.detailsOpen ? "details" : "overview", width)].slice(0, height);
		};
		// Candidate counter representations, strictly in preference order: the conservative
		// worst-case normal counter (unchanged normal layouts), the selected-only normal counter,
		// then the complete compact `n/N` counter. Each candidate is measured; Resize is returned
		// only when every candidate is physically impossible.
		const attempts: Array<{ reserve: number; compact: boolean }> = [{ reserve: counterWorst, compact: false }];
		if (counterSelected > 0 && counterSelected < counterWorst) attempts.push({ reserve: counterSelected, compact: false });
		if (counterCompact > 0) attempts.push({ reserve: counterCompact, compact: true });

		// Lays out the list/details with `reserve` rows reserved for the counter. In compact mode the
		// list is the selected row alone and the counter is `n/N`. Returns the emitted rows and the
		// counter rows actually emitted for the final window.
		const build = (reserve: number, compact: boolean): { out: string[]; counterRows: number } => {
			const minimum = selFirst + reserve + detailFirst;
			let rem = height - minimum;
			let top: string[] = [];
			if (oneLine.length <= rem) {
				top = oneLine;
				rem -= top.length;
			}
			const detailHeader = detailFirst ? wrapText("Details:", width) : [];
			const detailWanted = detailFirst ? Math.min(detailLines.length + detailHeader.length, Math.max(1, Math.floor(height / 3))) : 0;
			const detailSpan = detailFirst + Math.min(rem, detailWanted - detailFirst);
			rem -= detailSpan - detailFirst;
			// Decorative header is optional; it must always leave at least one body row.
			const header = detailSpan > detailHeader.length ? detailHeader : [];
			const detailBudget = detailSpan - header.length;
			if (fullTop.length > 0 && fullTop.length <= rem + top.length) {
				rem += top.length;
				top = fullTop;
				rem -= top.length;
			}
			const noticeKept = noticeLines.length > 0 && noticeLines.length <= rem;
			const notice = noticeKept ? noticeLines : [];
			if (noticeKept) rem -= notice.length;
			const listBudget = rem + selFirst;

			// Details: the clamp and the displayed view use the same budget.
			const maxDetailScroll = Math.max(0, detailLines.length - detailBudget);
			this.controller.clampDetailScroll(maxDetailScroll);
			const detailStart = Math.min(this.controller.state().detailScroll, maxDetailScroll);
			const detailView = detailLines.slice(detailStart, detailStart + detailBudget);
			this.lastDetailBudget = detailBudget;

			// The selected row may use at most listBudget; the window is measured with the same budget.
			const selectedLines = (i: number): string[] => {
				if (i !== selectedIdx) return rowsFor(i);
				const lines = selectedFull.slice(0, listBudget);
				if (top.length === 0) lines[0] = compactSelection[0]!;
				return lines;
			};
			// A namespace header is optional chrome, counted only inside the list budget.
			const headerRowsFor = (namespace: string): number => wrapText(`-- ${namespace} --`, width).length;
			const window = s.items.length === 0 ? { start: 0, end: 0, headed: new Set<number>() } : this.fitWindow(
				s.items.length,
				s.selected,
				(i) => (i === s.selected ? selectedLines(i) : rowsFor(i)),
				listBudget,
				(i) => s.items[i]!.namespace,
				headerRowsFor,
				compact,
			);

			const out: string[] = [...top];
			// The group header is shown only when there is room for it beside the selection.
			let lastNamespace = "";
			for (let i = window.start; i < window.end; i++) {
				const item = s.items[i]!;
				if (window.headed.has(i) && item.namespace !== lastNamespace) {
					for (const w of wrapText(`-- ${item.namespace} --`, width)) out.push(w);
					lastNamespace = item.namespace;
				}
				for (const row of (i === s.selected ? selectedLines(i) : rowsFor(i))) out.push(row);
			}
			// Every omitted-item window emits its complete measured counter; never skip it.
			let counterRows = 0;
			if (compact || window.start > 0 || window.end < s.items.length) {
				const counterText = compact
					? `${window.start + 1}/${s.items.length}`
					: `(${window.start + 1}-${window.end} of ${s.items.length})`;
				const counter = wrapText(counterText, width);
				counterRows = counter.length;
				for (const w of counter) out.push(w);
			}
			for (const line of header) out.push(line);
			for (const line of detailView) out.push(line);
			for (const line of notice) out.push(line);
			return { out, counterRows };
		};

		// The window's final counter may need more rows than the reservation (e.g. digit growth
		// while the window expands). Remeasure and retry with the larger reservation; never clip.
		// A compact candidate has a fixed one-row-class counter and never grows.
		for (const attempt of attempts) {
			let reserve = attempt.reserve;
			for (;;) {
				if (fallsBack(reserve)) break;
				const { out, counterRows } = build(reserve, attempt.compact);
				if (counterRows <= reserve) {
					// Safety clip only. The spans above never over-allocate; the regression tests assert it removes nothing.
					this.lastUnclippedOverflow = Math.max(0, out.length - height);
					if (out.length <= height) return out;
					const markerAt = out.findIndex((l) => l.startsWith(">"));
					return markerAt < 0 || markerAt < height
						? out.slice(0, height)
						: out.slice(Math.max(0, markerAt - height + 1), markerAt + 1);
				}
				if (attempt.compact) break;
				reserve = counterRows;
			}
		}
		return resize();
	}

	/** Worst-case rendered height of the position counter for a list of this size. */
	private counterWorstRows(total: number, width: number): number {
		const digits = String(Math.max(1, total)).length;
		return wrapText(`(${"9".repeat(digits)}-${"9".repeat(digits)} of ${total})`, width).length;
	}

	/** Lines per details page: the same block height render() uses. */
	private detailPageSize(): number {
		// The page is exactly the number of detail lines the last render showed, so no line is skipped.
		return this.lastDetailBudget;
	}

	/** Terminal rows available to the overlay; a bounded default when unknown. */
	private viewHeight(): number {
		const rows = this.terminalRows();
		if (rows <= 0) return 24;
		// The mount caps the overlay at 92% of the terminal (attention-overview.ts maxHeight).
		// Measure the same height so the rendered lines are exactly what the compositor shows.
		return Math.max(1, Math.floor(rows * OVERLAY_MAX_HEIGHT_FRACTION));
	}

	/**
	 * Largest contiguous window around the selection whose rendered rows fit the budget.
	 * Each item is measured together with the namespace header it introduces inside the
	 * window, so every line that render() emits is counted exactly once.
	 */
	private fitWindow(
		total: number,
		selected: number,
		rowsFor: (i: number) => string[],
		budget: number,
		namespaceOf: (i: number) => string,
		headerRowsFor: (namespace: string) => number,
		selectedOnly = false,
	): { start: number; end: number; headed: Set<number> } {
		// Invariant: the sum of the rows of every returned item plus the headers of exactly the
		// indexes in `headed` never exceeds `budget`. render() emits headers only for `headed`,
		// so the measured lines and the emitted lines are the same lines.
		const headed = new Set<number>();
		if (total === 0) return { start: 0, end: 0, headed };
		const costOf = (i: number, withHeader: boolean): number =>
			rowsFor(i).length + (withHeader ? headerRowsFor(namespaceOf(i)) : 0);
		const selectedRows = rowsFor(selected).length;
		if (selectedRows > budget) {
			// The selected row alone does not fit: it is returned truncated by the caller; no header.
			return { start: selected, end: selected + 1, headed };
		}
		let used = selectedRows;
		// The selected row's header is taken only together with the row itself.
		const selectedWithHeader = costOf(selected, true);
		if (selectedWithHeader <= budget) {
			used = selectedWithHeader;
			headed.add(selected);
		}
		let start = selected;
		let end = selected + 1;
		// Compact `n/N` denotes the selection alone, so the window never grows.
		if (selectedOnly) return { start, end, headed };
		let grew = true;
		while (grew) {
			grew = false;
			if (end < total) {
				const newNs = namespaceOf(end) !== namespaceOf(end - 1);
				const cost = costOf(end, newNs);
				if (used + cost <= budget) {
					end++;
					used += cost;
					if (newNs) headed.add(end - 1);
					grew = true;
				}
			}
			if (start > 0) {
				const newNs = namespaceOf(start - 1) !== namespaceOf(start);
				if (!newNs && headed.has(start)) {
					// Same namespace: the header moves to the new first included row; its cost is already counted.
					const cost = rowsFor(start - 1).length;
					if (used + cost <= budget) {
						headed.delete(start);
						headed.add(start - 1);
						start--;
						used += cost;
						grew = true;
					}
				} else {
					const cost = costOf(start - 1, newNs);
					if (used + cost <= budget) {
						start--;
						used += cost;
						if (newNs) headed.add(start);
						grew = true;
					}
				}
			}
		}
		return { start, end, headed };
	}

	/** Details block for the selected row, width-bounded. Empty when details are closed. */
	private detailsLines(width: number): string[] {
		const s = this.controller.state();
		const item = s.items[s.selected];
		if (!s.detailsOpen || !item) return [];
		const out: string[] = [];
		const add = (text: string) => { for (const w of wrapText(text, width)) out.push(w); };
		// Body only: decoration is budgeted separately and never consumes the scroll area.
		add(item.details.sourceIdentity);
		add(`  kind: ${item.details.kind}  owner: ${item.owner}  freshness: ${item.freshness}`);
		if (item.details.requestedAction) add(`  requested: ${item.details.requestedAction}`);
		add(`  text: ${item.details.text}`);
		add(item.destination.kind === "inspect-blocker"
			? "  i: Inspect blocker (read-only)"
			: `  ${INSPECT_ONLY_NOTICE}`);
		return out;
	}

	invalidate(): void {}
}
