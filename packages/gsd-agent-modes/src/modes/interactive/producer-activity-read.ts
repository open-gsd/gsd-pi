/**
 * Native read path for producer activity snapshots (#2936).
 *
 * Reads host-only runtime capabilities through the public extension runner. It
 * never imports a producer implementation. Any missing capability, thrown error,
 * or invalid response becomes an explicit `unavailable` snapshot, never zero.
 * A response that arrives after the session that asked has changed is discarded.
 */

export type ReadStatus = "available" | "unavailable";

export interface RuntimeReader {
	getRuntimeReadHandler(name: string): ((input: unknown) => Promise<unknown>) | undefined;
}

export interface NativeProducerRead {
	name: string;
	status: ReadStatus;
	snapshot: unknown;
}

export const PRODUCER_READ_NAMES = ["async_jobs_snapshot", "subagent_runs_snapshot"] as const;

/**
 * Read one producer. `isCurrent` lets the caller reject a late response after a
 * session switch or teardown; such a response is reported as unavailable so it
 * can never change another session's view.
 */
export async function readProducer(
	runner: RuntimeReader | null,
	name: (typeof PRODUCER_READ_NAMES)[number],
	isCurrent: () => boolean,
): Promise<NativeProducerRead> {
	const unavailable = (reason: string): NativeProducerRead => ({
		name,
		status: "unavailable",
		snapshot: { availability: "unavailable", completeness: "unknown", reason },
	});

	if (!runner) return unavailable("no-runner");
	const handler = runner.getRuntimeReadHandler(name);
	if (!handler) return unavailable("capability-missing");

	let raw: unknown;
	try {
		raw = await handler({});
	} catch {
		return unavailable("read-threw");
	}
	if (!isCurrent()) return unavailable("stale-response");
	if (!isSnapshotShape(raw)) return unavailable("invalid-response");
	return { name, status: "available", snapshot: raw };
}

/** Minimal structural check of the public snapshot envelope. Not a trust decision. */
export function isSnapshotShape(v: unknown): boolean {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	if (o.schemaVersion !== 1 || typeof o.readAt !== "string") return false;
	if (o.availability === "unavailable") return o.completeness === "unknown" && typeof o.reason === "string";
	if (o.availability === "available") {
		return (
			(o.completeness === "complete" || o.completeness === "partial") &&
			Array.isArray(o.items) &&
			Array.isArray(o.gaps)
		);
	}
	return false;
}
