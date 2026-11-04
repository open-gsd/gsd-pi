/**
 * Extension readiness gate for `gsd headless` — the termination race.
 *
 * Regression background (PR review): the readiness wait must not dispatch a
 * prompt into a run that has already terminated (the overall --timeout fired
 * or the run completed), and it must cancel the pending wait instead of
 * leaving it dangling. Extracted as an injectable, pure decision function
 * so the race is unit-testable without spawning a child.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { waitForExtensionReadiness } from "../headless.ts";

/** Fake waitForEvent that only settles when its abort signal fires. */
function abortOnlyWaitForEvent(): {
	waitForEvent: (timeoutMs: number, signal: AbortSignal) => Promise<boolean>;
	aborted: () => boolean;
} {
	let signal: AbortSignal | null = null;
	return {
		waitForEvent: (_timeoutMs, theSignal) => {
			signal = theSignal;
			return new Promise((resolve) => {
				if (theSignal.aborted) {
					resolve(false);
					return;
				}
				theSignal.addEventListener("abort", () => resolve(false));
			});
		},
		aborted: () => signal?.aborted === true,
	};
}

function makeGate(overrides: Partial<Parameters<typeof waitForExtensionReadiness>[0]> = {}) {
	const calls: { onTimeout: number } = { onTimeout: 0 };
	const opts = {
		waitForEvent: async () => true as boolean,
		termination: new Promise<never>(() => {}), // never settles by default
		isTerminated: () => false,
		waitMs: 10_000,
		onTimeout: () => {
			calls.onTimeout++;
		},
		...overrides,
	};
	return { opts, calls };
}

test('observed readiness resolves "ready" without a timeout breadcrumb', async () => {
	const { opts, calls } = makeGate({ waitForEvent: async () => true });
	assert.equal(await waitForExtensionReadiness(opts), "ready");
	assert.equal(calls.onTimeout, 0);
});

test('a bounded-wait timeout with a live run resolves "timeout" with the breadcrumb', async () => {
	const { opts, calls } = makeGate({ waitForEvent: async () => false });
	assert.equal(await waitForExtensionReadiness(opts), "timeout");
	assert.equal(calls.onTimeout, 1, "the timeout breadcrumb must fire exactly once");
});

test('run termination wins the race: "terminated", no breadcrumb, wait cancelled', async () => {
	const fake = abortOnlyWaitForEvent();
	const { opts, calls } = makeGate({
		waitForEvent: fake.waitForEvent,
		termination: Promise.resolve(),
	});
	assert.equal(await waitForExtensionReadiness(opts), "terminated");
	assert.equal(calls.onTimeout, 0, "a terminated run must not emit a timeout breadcrumb");
	assert.equal(fake.aborted(), true, "the pending wait must be cancelled, not left dangling");
});

test('a settled wait is re-checked against termination before dispatching', async () => {
	// The wait resolves false at the same moment the run terminates — the
	// race winner may be either — the gate must not send into a dead run.
	let terminated = false;
	const { opts, calls } = makeGate({
		waitForEvent: async () => false,
		termination: new Promise<never>(() => {}),
		isTerminated: () => terminated,
	});
	terminated = true;
	assert.equal(await waitForExtensionReadiness(opts), "terminated");
	assert.equal(calls.onTimeout, 0);
});