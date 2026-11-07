import type { NativeProducerRead } from "./producer-activity-read.ts";

/**
 * Native presentation of producer activity facets (#2936). Pure formatting.
 *
 * Facets stay separate and labelled. There is no combined count and no
 * running/done bit. `unavailable` is shown as unavailable, never as zero.
 */

export interface ActivityFacetLine {
	label: string;
	text: string;
}

export function formatProducerFacets(reads: readonly NativeProducerRead[]): ActivityFacetLine[] {
	return reads.map((r) => formatOne(r));
}

function formatOne(r: NativeProducerRead): ActivityFacetLine {
	const label = r.name === "async_jobs_snapshot" ? "async jobs" : "subagent runs";
	const s = r.snapshot as Record<string, unknown>;
	if (r.status === "unavailable" || s.availability === "unavailable") {
		const reason = typeof s.reason === "string" ? s.reason : "unknown";
		return { label, text: `unavailable (${reason})` };
	}
	const items = Array.isArray(s.items) ? (s.items as Array<{ status?: unknown }>) : [];
	const completeness = s.completeness === "partial" ? "partial" : "complete";
	const basis = r.name === "subagent_runs_snapshot" ? "stored" : "live";
	const count = items.length;
	return { label, text: `${count} ${basis}, ${completeness}` };
}
