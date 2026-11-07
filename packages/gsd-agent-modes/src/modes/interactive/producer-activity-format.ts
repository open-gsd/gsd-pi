import type { NativeProducerRead } from "./producer-activity-read.js";

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
	// Lifecycle counts stay separate so a terminal failure is never hidden behind
	// a running total. Per-status counts are taken from the snapshot items.
	const counts = new Map<string, number>();
	for (const item of items) {
		const st = typeof item.status === "string" ? item.status : "unknown";
		counts.set(st, (counts.get(st) ?? 0) + 1);
	}
	const order = ["running", "completed", "failed", "cancelled", "succeeded", "interrupted", "queued", "unknown"];
	const parts = order.filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${k}`);
	const detail = parts.length > 0 ? parts.join(", ") : `0 ${basis}`;
	return { label, text: `${detail} (${basis}, ${completeness})` };
}
