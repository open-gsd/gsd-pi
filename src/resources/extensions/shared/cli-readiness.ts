/**
 * Non-blocking readiness cache for external CLI providers.
 *
 * Provider `isReady()` hooks are synchronous and are called once per model
 * from the TUI (model selector, autocomplete) and from auto mode. Probing a
 * CLI with `execFileSync`/`spawnSync` there freezes the event loop for as
 * long as the child runs — seconds on Windows, where every probe goes
 * through cmd.exe. This module keeps the answer in a cache that is only ever
 * refreshed by asynchronous child processes:
 *
 *  - `peek()` returns the cached snapshot immediately. When the snapshot is
 *    stale (or missing) it starts one background refresh and still returns
 *    what it has (stale-while-revalidate).
 *  - `settle()` resolves with a snapshot no older than the cache window:
 *    fresh cache → immediately, otherwise it joins or starts a probe. Use it
 *    from async code that must not act on a cold or stale answer.
 *
 * A cold cache has no snapshot (`peek()` returns null); callers decide what
 * that means for them.
 */

import { execFile } from "node:child_process";

export const READINESS_CHECK_INTERVAL_MS = 30_000;

/**
 * Run a CLI probe without blocking the event loop.
 *
 * Mirrors the `execFileSync(command, args, { timeout, stdio: "pipe" })` calls
 * it replaces: resolves with stdout, rejects on spawn failure, non-zero exit
 * or timeout. No shell is involved, so DEP0190 cannot fire.
 *
 * The child is unref'd: a background refresh must never keep the process
 * alive on exit. Code that awaits a probe wraps it in keepEventLoopAlive().
 */
export function runCliProbe(command: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		try {
			const child = execFile(command, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			});
			// execFileSync handed the child an already-closed stdin; keep that so
			// a CLI that reads stdin sees EOF instead of waiting for the timeout.
			child.stdin?.end();
			child.unref();
			(child.stdout as { unref?: () => void } | null)?.unref?.();
			(child.stderr as { unref?: () => void } | null)?.unref?.();
		} catch (error) {
			reject(error);
		}
	});
}

/**
 * Hold the event loop open until `work` settles. Probe children are unref'd,
 * so without this a process with nothing else pending would exit in the
 * middle of an awaited probe.
 */
export async function keepEventLoopAlive<T>(work: Promise<T>): Promise<T> {
	const keepAlive = setInterval(() => {}, 60_000);
	try {
		return await work;
	} finally {
		clearInterval(keepAlive);
	}
}

export interface ReadinessCache<T> {
	/**
	 * Cached snapshot, or null while the cache is cold. Never spawns
	 * synchronously; starts a background refresh when the snapshot is stale.
	 */
	peek(): T | null;
	/** Snapshot from a probe no older than the cache window. */
	settle(): Promise<T>;
	/** Drop the snapshot so the next check re-probes. */
	clear(): void;
}

export interface ReadinessCacheOptions<T> {
	/**
	 * Asynchronous probe. Receives the previous snapshot (null when cold) so
	 * it can keep known-good state when a probe soft-fails. Should not reject.
	 */
	probe: (previous: T | null) => Promise<T>;
	intervalMs?: number;
}

export function createReadinessCache<T>(options: ReadinessCacheOptions<T>): ReadinessCache<T> {
	const intervalMs = options.intervalMs ?? READINESS_CHECK_INTERVAL_MS;
	let snapshot: T | null = null;
	let lastCheckMs: number | null = null;
	let inFlight: Promise<T> | null = null;
	// Bumped by clear() so a probe started before the clear cannot write its
	// (pre-clear) answer back into the cache.
	let generation = 0;

	function isFresh(): boolean {
		return lastCheckMs !== null && Date.now() - lastCheckMs < intervalMs;
	}

	function refresh(): Promise<T> {
		if (inFlight) return inFlight;
		const startedIn = generation;
		const run = (async () => {
			// Yield first: the caller of peek() gets its answer before any
			// child process is spawned.
			await null;
			try {
				const next = await options.probe(snapshot);
				if (startedIn === generation) snapshot = next;
				return next;
			} finally {
				// After a clear() this probe no longer owns the cache: leave the
				// timestamp and whichever probe replaced it alone.
				if (startedIn === generation) {
					// Stamp failures too, so a rejecting probe is retried once
					// per window instead of once per isReady() call.
					lastCheckMs = Date.now();
					inFlight = null;
				}
			}
		})();
		inFlight = run;
		return run;
	}

	return {
		peek() {
			if (!isFresh() && !inFlight) {
				refresh().catch(() => {
					// Background refresh: keep whatever snapshot we have.
				});
			}
			return snapshot;
		},
		async settle() {
			if (isFresh() && snapshot !== null && !inFlight) return snapshot;
			return keepEventLoopAlive(refresh());
		},
		clear() {
			snapshot = null;
			lastCheckMs = null;
			inFlight = null;
			generation++;
		},
	};
}
