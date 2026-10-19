// Project/App: gsd-pi
// File Purpose: Sidebar refresh coalescing that preserves a stronger queued
// refresh intent, plus honest progress provenance classification, shared by
// the sidebar provider and unit tests (issue #2668).

/** Minimal structural view of the read-metadata field on a progress read. */
export interface ProgressReadMetadataLike {
	source?: unknown;
	authority?: unknown;
}

export interface ProgressWithProvenance {
	readMetadata?: ProgressReadMetadataLike;
}

export type ProgressProvenance = "database" | "projection" | "unknown";

/**
 * Classifies a project-progress read by its declared provenance. Only the
 * exact canonical pairs count; anything else (older producers without the
 * field, unknown labels, null) is "unknown" and must not be presented as
 * DB-authoritative. Callers label "projection" reads so cached projection
 * data is never displayed as canonical.
 */
export function classifyProgressProvenance(progress: ProgressWithProvenance | null | undefined): ProgressProvenance {
	const metadata = progress?.readMetadata;
	if (!metadata || typeof metadata !== "object") {
		return "unknown";
	}
	if (metadata.source === "projection" && metadata.authority === "projection-fallback") {
		return "projection";
	}
	if (metadata.source === "database" && metadata.authority === "db-authoritative") {
		return "database";
	}
	return "unknown";
}

/**
 * Coalesces concurrent sidebar refreshes onto the in-flight refresh, with one
 * refinement over a plain in-flight latch: a stronger request (refresh project
 * progress) that arrives while only a weaker refresh is scheduled is not
 * swallowed. It is queued and re-run once the in-flight refresh settles, and
 * the stronger caller's promise resolves only after that queued stronger
 * refresh completes. A stronger request that arrives while a stronger refresh
 * is already scheduled joins it, as any weaker request does.
 *
 * At most one refresh runs at a time. Every caller is handed the outcome of
 * the run it participates in, including its rejection; a failed weaker
 * refresh does not cancel a queued stronger one.
 *
 * The coordinator also tracks connection generations: `bumpGeneration()`
 * marks every refresh scheduled before it as obsolete and guarantees one
 * fresh strong refresh runs for the new generation, so a response from a
 * dead connection can neither be published (compare `generation` around the
 * fetch) nor leave the new connection without a fresh read.
 */
export class SidebarRefreshCoordinator {
	private inFlight: Promise<void> | null = null;
	private activeStrong = false;
	private strongQueued = false;
	private connectionGeneration = 0;

	constructor(run: (refreshProjectProgress: boolean) => Promise<void>) {
		this.run = run;
	}

	private readonly run: (refreshProjectProgress: boolean) => Promise<void>;

	/** The connection generation reads must capture before fetching. */
	get generation(): number {
		return this.connectionGeneration;
	}

	request(refreshProjectProgress = false): Promise<void> {
		if (this.inFlight === null) {
			return this.begin(refreshProjectProgress);
		}
		// Weaker requests join whatever is scheduled; a stronger request joins
		// when the scheduled tail already covers the strong intent.
		if (!refreshProjectProgress || this.activeStrong || this.strongQueued) {
			return this.inFlight;
		}
		return this.queueStrong();
	}

	/**
	 * Records a connection change: every refresh scheduled so far is obsolete.
	 * When a refresh is in flight, exactly one fresh strong refresh is queued
	 * behind it and its promise is returned; when idle, nothing is scheduled
	 * and the caller should start a strong refresh itself.
	 */
	bumpGeneration(): Promise<void> | null {
		this.connectionGeneration++;
		if (this.inFlight === null) {
			return null;
		}
		if (!this.strongQueued) {
			this.queueStrong();
		}
		return this.inFlight;
	}

	private queueStrong(): Promise<void> {
		this.strongQueued = true;
		const prior = this.inFlight;
		if (prior === null) {
			// Defensive: queueStrong is only called with a refresh in flight.
			this.strongQueued = false;
			return this.begin(true);
		}
		const queued = prior.then(
			() => this.runQueuedStrong(),
			() => this.runQueuedStrong(),
		);
		this.inFlight = queued;
		return queued;
	}

	private runQueuedStrong(): Promise<void> {
		if (!this.strongQueued) {
			// A sibling continuation already consumed the queued strong intent;
			// its run is in flight and satisfies this caller too.
			return this.inFlight ?? Promise.resolve();
		}
		this.strongQueued = false;
		return this.begin(true);
	}

	private begin(refreshProjectProgress: boolean): Promise<void> {
		this.activeStrong = refreshProjectProgress;
		let outcome: Promise<void>;
		try {
			outcome = Promise.resolve(this.run(refreshProjectProgress));
		} catch (error) {
			outcome = Promise.reject(error);
		}
		// Separate branch: resets the state after the run settles without
		// altering the outcome every caller observes.
		const cleanup = () => {
			this.activeStrong = false;
			if (this.inFlight === outcome) {
				this.inFlight = null;
			}
		};
		outcome.then(cleanup, cleanup);
		this.inFlight = outcome;
		return outcome;
	}
}
