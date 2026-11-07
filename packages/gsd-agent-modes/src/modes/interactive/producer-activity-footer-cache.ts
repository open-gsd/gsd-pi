import type { NativeProducerRead, RuntimeReader } from "./producer-activity-read.js";
import { PRODUCER_READ_NAMES, readProducer } from "./producer-activity-read.js";
import { formatProducerFacets, type ActivityFacetLine } from "./producer-activity-format.js";

/**
 * Synchronous footer cache for producer activity facets (#2936).
 *
 * The footer render path is synchronous, while producer reads are async. This
 * cache is filled by an explicit async refresh and read synchronously by render.
 * A refresh is only applied when it still belongs to the current session, so a
 * late response from a previous session never overwrites the current view.
 */

export interface ProducerActivityCache {
	readonly lines: readonly ActivityFacetLine[];
	readonly refreshedAt: number | null;
}

export class ProducerActivityFooterCache {
	private lines: ActivityFacetLine[] = [];
	private refreshedAt: number | null = null;
	private generation = 0;
	private ticket = 0;

	/** Current view for the synchronous footer render. Never performs I/O. */
	snapshot(): ProducerActivityCache {
		return { lines: this.lines, refreshedAt: this.refreshedAt };
	}

	/** Invalidate pending refreshes, e.g. on session switch or teardown. */
	invalidate(): void {
		this.generation += 1;
	}

	/**
	 * Session transition: drop the previous session's view and invalidate any
	 * in-flight refresh. Until the next refresh applies, the footer shows
	 * "pending" rather than another session's facets.
	 */
	reset(): void {
		this.generation += 1;
		this.lines = [];
		this.refreshedAt = null;
	}

	/**
	 * Refresh from the runner. Results are applied only if no invalidation happened
	 * while the reads were in flight. Returns whether the refresh was applied.
	 */
	async refresh(runner: RuntimeReader | null, nowMs: number): Promise<boolean> {
		// Each refresh takes its own ticket. Only the most recently started refresh
		// may publish, so an older read that finishes last cannot overwrite a newer
		// session view, even when both were started in the same generation.
		this.ticket += 1;
		const myTicket = this.ticket;
		const gen = this.generation;
		const isCurrent = () => gen === this.generation && myTicket === this.ticket;
		const reads: NativeProducerRead[] = [];
		for (const name of PRODUCER_READ_NAMES) {
			reads.push(await readProducer(runner, name, isCurrent));
		}
		if (!isCurrent()) return false;
		this.lines = formatProducerFacets(reads);
		this.refreshedAt = nowMs;
		return true;
	}
}
