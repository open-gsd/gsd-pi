/**
 * Transport-level stall deadline for streamed provider responses (#2644).
 *
 * A provider that accepts a request and then goes silent (wedged connection,
 * stuck local server) otherwise hangs the turn indefinitely: SDK request
 * timeouts do not cover an open stream body. The idle deadline races each
 * chunk against a reset-on-arrival timer; on expiry it aborts the request via
 * the caller-supplied callback so the pending read fails, and throws a plain
 * error. The provider stream functions' existing catch converts that into a
 * normal `stopReason: "error"` assistant message — the same classified,
 * retryable provider failure the recovery ladder already handles. It is
 * explicitly NOT a user abort: the caller's own signal is never touched.
 */

/** Default gap between chunks before a stream is declared stalled: 10 minutes. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 600_000;

/**
 * Resolve the idle-chunk deadline from `GSD_STREAM_IDLE_TIMEOUT_MS`:
 * unset/invalid → default (10 min), `0` → disabled, otherwise the value in ms.
 */
export function resolveStreamIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.GSD_STREAM_IDLE_TIMEOUT_MS;
	if (raw === undefined || raw === "") return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	return parsed;
}

/** Error thrown when no chunk arrived within the idle deadline. */
export class StreamIdleTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(label: string, timeoutMs: number) {
		const seconds = Math.round(timeoutMs / 1000);
		super(
			`${label}: no stream data received for ${seconds}s (idle deadline ${timeoutMs}ms, GSD_STREAM_IDLE_TIMEOUT_MS)`,
		);
		this.name = "StreamIdleTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Wrap an async iterable so that a gap longer than `timeoutMs` between
 * consecutive items aborts the request via `onStall()` and throws
 * {@link StreamIdleTimeoutError}. `timeoutMs <= 0` disables the deadline and
 * yields the source unchanged (no timers).
 *
 * `onStall()` (typically aborting the request signal) makes the pending
 * `next()` reject like any aborted fetch. That losing rejection is detached
 * so it can never surface as an unhandled rejection after the idle error has
 * been thrown; a genuine transport error losing no race propagates normally.
 */
export async function* withIdleDeadline<T>(input: {
	source: AsyncIterable<T>;
	timeoutMs: number;
	onStall: () => void;
	label: string;
}): AsyncGenerator<T> {
	const { source, timeoutMs, onStall, label } = input;
	if (!(timeoutMs > 0)) {
		yield* source;
		return;
	}

	const iterator = source[Symbol.asyncIterator]();
	let inFlight: Promise<IteratorResult<T>> | undefined;

	try {
		while (true) {
			let timer: NodeJS.Timeout | undefined;
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					onStall();
					reject(new StreamIdleTimeoutError(label, timeoutMs));
				}, timeoutMs);
				// A stalled-stream watchdog must never hold the process open.
				timer.unref?.();
			});

			inFlight = iterator.next();
			let result: IteratorResult<T>;
			try {
				result = await Promise.race([inFlight, deadline]);
			} catch (error) {
				clearTimeout(timer);
				// Deadline fired (or the read itself failed): detach the
				// in-flight read so its abort rejection cannot become unhandled.
				void inFlight.catch(() => {});
				throw error;
			}
			clearTimeout(timer);
			inFlight = undefined;
			if (result.done) return;
			yield result.value;
		}
	} finally {
		// Consumer broke early or we threw with a read still pending.
		if (inFlight) void inFlight.catch(() => {});
	}
}
