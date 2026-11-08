import { producerFacetRows, type WidthOps } from "./producer-facet-rows.js";
import type { ProducerActivityCache } from "./producer-activity-footer-cache.js";

/**
 * Pure footer block for producer activity (#2936). The footer calls this with the
 * cache snapshot it already holds; no I/O, no runner access. Returns no rows when
 * there is no producer state, so the footer keeps its original single row.
 *
 * Rules, each covered by producer-footer-rows.test.ts:
 * - unavailable facets are rendered as unavailable, never as zero;
 * - the "as of" stamp is shown only on the first facet, and only when the cache
 *   has a refresh time;
 * - each facet is bounded to the width on its own (see producerFacetRows).
 */
export function producerFooterRows(
	snapshot: ProducerActivityCache | undefined,
	width: number,
	ops: WidthOps,
	formatStamp: (refreshedAt: number) => string,
): string[] {
	if (!snapshot || snapshot.lines.length === 0) return [];
	const stamp = snapshot.refreshedAt != null ? ` (${formatStamp(snapshot.refreshedAt)})` : "";
	return producerFacetRows(snapshot.lines, width, stamp, ops);
}
