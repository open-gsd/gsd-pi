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
	return lines.map((l, i) => {
		const head = i === 0 ? stamp : "";
		const qualifier = l.qualifier ?? "";
		const detail = l.detail ?? l.text;
		const prefix = `${l.label}: `;
		const fixed = ops.visibleWidth(prefix) + ops.visibleWidth(qualifier) + ops.visibleWidth(head) + 1;
		const detailBudget = Math.max(0, width - fixed);
		const shortDetail = detailBudget >= ops.visibleWidth(detail) ? detail : ops.truncateToWidth(detail, detailBudget, "…");
		return `${prefix}${shortDetail}${qualifier ? ` ${qualifier}` : ""}${head}`;
	});
}

