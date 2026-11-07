/**
 * Read-only activity facet projection for #2936 (native-first, facets kept separate).
 *
 * This module never mutates producers, never persists state, and never computes a
 * single combined "work total". Each facet reports its own source and availability.
 * A facet whose producer is not individually verified is reported as `unavailable`,
 * never as zero.
 */

export type FacetAvailability = "available" | "unavailable";

export type AssistantFacet =
	| { availability: "available"; state: "idle" | "working" | "waiting-question" | "waiting-gate" | "done"; source: "turn-status" }
	| { availability: "unavailable"; reason: string };

export type WorkerFacet =
	| { availability: "available"; running: number; source: "session-status" }
	| { availability: "unavailable"; reason: string };

export type ProducerUnavailableFacet = { availability: "unavailable"; reason: string };

export interface ActivityFacets {
	assistant: AssistantFacet;
	workers: WorkerFacet;
	/** Async jobs have no producer read-contract yet (see #2936 decision record). */
	asyncJobs: ProducerUnavailableFacet;
	/** Subagent runs are persisted best-effort observations, not a live inventory. */
	subagents: ProducerUnavailableFacet;
}

export interface TurnStateSource {
	getState(): "idle" | "working" | "waiting-question" | "waiting-gate" | "done";
}

export interface SessionStatusSource {
	/** Returns null when the source could not be read. A null read is never zero. */
	readRunningWorkerCount(): number | null;
}

/**
 * Build the facet snapshot from the producers that have verified read paths.
 *
 * `turn` may be absent (no tracker bound); that yields an unavailable assistant
 * facet rather than an invented idle state. `sessions` returning null means the
 * read failed, which is reported as unavailable rather than zero running workers.
 */
export function projectActivityFacets(input: {
	turn: TurnStateSource | null;
	sessions: SessionStatusSource | null;
}): ActivityFacets {
	const assistant: AssistantFacet = input.turn
		? { availability: "available", state: input.turn.getState(), source: "turn-status" }
		: { availability: "unavailable", reason: "no turn tracker bound" };

	let workers: WorkerFacet;
	if (!input.sessions) {
		workers = { availability: "unavailable", reason: "no session-status source bound" };
	} else {
		const count = input.sessions.readRunningWorkerCount();
		workers =
			count === null
				? { availability: "unavailable", reason: "session-status read failed" }
				: { availability: "available", running: count, source: "session-status" };
	}

	return {
		assistant,
		workers,
		asyncJobs: {
			availability: "unavailable",
			reason: "no producer-owned read contract for async jobs yet",
		},
		subagents: {
			availability: "unavailable",
			reason: "persisted run records are not a live session inventory",
		},
	};
}
