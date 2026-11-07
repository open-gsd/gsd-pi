/**
 * Producer read snapshots for #2936. Pure DTO mapping: no live objects, no I/O.
 *
 * A snapshot describes one producer's own source and scope only. `unavailable`
 * means the producer could not be read, never zero. `partial` means some records
 * were skipped. A complete snapshot does not claim complete session activity.
 */

export type ReadGap = "not-initialized" | "read-failed" | "invalid-record" | "unsupported-version" | "bounded-scan";

export type SnapshotCompleteness = "complete" | "partial" | "unknown";

export type ReadSnapshot<T> =
	| {
			schemaVersion: 1;
			readAt: string;
			availability: "available";
			completeness: "complete" | "partial";
			basis: "memory" | "persisted";
			items: readonly T[];
			gaps: readonly ReadGap[];
	  }
	| {
			schemaVersion: 1;
			readAt: string;
			availability: "unavailable";
			completeness: "unknown";
			reason: ReadGap;
	  };

export interface AsyncJobDto {
	id: string;
	type: "bash";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	startTime: number;
}

/** A job is copied to scalar fields only. No AbortController, promise, output, or delivery flags. */
export function projectAsyncJobs(
	jobs: readonly { id: string; type: string; status: string; label: string; startTime: number }[] | null,
	readAt: string,
): ReadSnapshot<AsyncJobDto> {
	if (jobs === null) {
		return { schemaVersion: 1, readAt, availability: "unavailable", completeness: "unknown", reason: "not-initialized" };
	}
	const items: AsyncJobDto[] = [];
	const gaps: ReadGap[] = [];
	for (const j of jobs) {
		if (!isJobStatus(j.status) || typeof j.id !== "string" || typeof j.label !== "string" || !Number.isFinite(j.startTime)) {
			gaps.push("invalid-record");
			continue;
		}
		items.push({ id: j.id, type: "bash", status: j.status, label: j.label, startTime: j.startTime });
	}
	return {
		schemaVersion: 1,
		readAt,
		availability: "available",
		completeness: gaps.length > 0 ? "partial" : "complete",
		basis: "memory",
		items,
		gaps,
	};
}

function isJobStatus(s: string): s is AsyncJobDto["status"] {
	return s === "running" || s === "completed" || s === "failed" || s === "cancelled";
}
