/**
 * One row per producer facet. The qualifier (e.g. "(stored, partial)") is kept
 * whole; only the count summary is shortened when the width runs out, so a
 * narrow terminal never drops the basis or the completeness state.
 */
export interface WidthOps {
	visibleWidth(s: string): number;
	truncateToWidth(s: string, width: number, ellipsis: string): string;
}

export function producerFacetRows(
	lines: readonly { label: string; text: string; qualifier?: string; detail?: string }[],
	width: number,
	stamp = "",
	ops: WidthOps,
): string[] {
	const rows: string[] = [];
	lines.forEach((l, i) => {
		const qualifier = l.qualifier ?? "";
		const detail = l.detail ?? l.text;
		const prefix = `${l.label}: `;
		const base = qualifier ? ` ${qualifier}` : "";
		const withStamp = i === 0 && stamp ? stamp : "";
		const fitsOneLine = ops.visibleWidth(prefix + detail + base + withStamp) <= width;
		if (fitsOneLine) {
			rows.push(`${prefix}${detail}${base}${withStamp}`);
			return;
		}
		// The count does not fit on one line with its qualifier. Keep every count by
		// wrapping: the label and qualifier on the first row, the count on the next
		// row(s) under it, so no terminal state is clipped.
		const head = `${prefix.trimEnd()}${base}`;
		const headRow = ops.visibleWidth(head) <= width ? head : ops.truncateToWidth(head, width, "…");
		rows.push(headRow);
		// The indent shrinks to fit a narrow width (never wider than the row itself),
		// and every continuation row, including the stamp, is bounded to the width.
		const indent = width >= 4 ? "  " : "";
		const avail = Math.max(1, width - indent.length);
		for (const w of wrapWords(detail, avail, ops)) rows.push(clip(`${indent}${w}`, width, ops));
		if (withStamp) rows.push(clip(`${indent}${withStamp.trim()}`, width, ops));
	});
	return rows;
}

/** Clip one row to the width. Never returns a row wider than `width`. */
function clip(row: string, width: number, ops: WidthOps): string {
	return ops.visibleWidth(row) <= width ? row : ops.truncateToWidth(row, width, "…");
}

/** Greedy word wrap by visible width. A single word wider than `width` is truncated. */
function wrapWords(text: string, width: number, ops: WidthOps): string[] {
	const words = text.split(" ");
	const out: string[] = [];
	let cur = "";
	for (const w of words) {
		const next = cur ? `${cur} ${w}` : w;
		if (ops.visibleWidth(next) <= width) {
			cur = next;
		} else {
			if (cur) out.push(cur);
			cur = ops.visibleWidth(w) <= width ? w : ops.truncateToWidth(w, width, "…");
		}
	}
	if (cur) out.push(cur);
	return out;
}
