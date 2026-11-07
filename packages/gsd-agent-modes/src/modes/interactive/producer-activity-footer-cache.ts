import type { NativeProducerRead, RuntimeReader } from "./producer-activity-read.ts";
import { PRODUCER_READ_NAMES, readProducer } from "./producer-activity-read.ts";
import { formatProducerFacets, type ActivityFacetLine } from "./producer-activity-format.ts";

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

	/** Current view for the synchronous footer render. Never performs I/O. */
	snapshot(): ProducerActivityCache {
		return { lines: this.lines, refreshedAt: this.refreshedAt };
	}

	/** Invalidate pending refreshes, e.g. on session switch or teardown. */
	invalidate(): void {
		this.generation += 1;
	}

	/**
	 * Refresh from the runner. Results are applied only if no invalidation happened
	 * while the reads were in flight. Returns whether the refresh was applied.
	 */
	async refresh(runner: RuntimeReader | null, nowMs: number): Promise<boolean> {
		const gen = this.generation;
		const isCurrent = () => gen === this.generation;
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
