import assert from "node:assert/strict";
import test from "node:test";
import {
	_resolveVerificationTimeoutMsForTest,
	_routeHostTechnicalFailureForTest,
	runPostUnitVerification,
} from "../auto-verification.ts";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "../constants.ts";
import { describeHostVerificationRationale } from "../verification-verdict.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

function createVerificationContext(currentUnit: { type: string; id: string } | null) {
	return {
		s: {
			currentUnit,
		},
		ctx: {
			ui: {
				notify() {
					throw new Error("notify should not be called for pass-through units");
				},
			},
		},
		pi: {},
	};
}

test("post-unit verification continues when no host-owned verification is needed", async () => {
	let paused = false;
	const pauseAuto = async () => {
		paused = true;
	};

	assert.equal(await runPostUnitVerification(createVerificationContext(null) as never, pauseAuto), "continue");
	assert.equal(
		await runPostUnitVerification(
			createVerificationContext({ type: "plan-slice", id: "M001-S001" }) as never,
			pauseAuto,
		),
		"continue",
	);
	assert.equal(paused, false);
});

test("missing host command pauses without recording an auto-fix retry (#1943)", async () => {
	let paused = false;
	let recordedVerdict = false;
	let routedFailure = false;
	const retryKey = "execute-task:M001/S01/T01";
	const session = {
		basePath: process.cwd(),
		canonicalProjectRoot: process.cwd(),
		currentUnit: { type: "execute-task", id: "M001/S01/T01" },
		lastTaskRecoveryAbortId: null,
		pendingVerificationRetry: { unitId: "stale", failureContext: "stale", attempt: 1 },
		verificationRetryCount: new Map([[retryKey, 1]]),
		verificationRetryFailureHashes: new Map([[retryKey, "stale"]]),
	};
	const result = await runPostUnitVerification({
		s: session,
		ctx: { ui: { notify() {} } },
		pi: {},
		taskAuthority: {
			readLatestTaskAttempt: () => ({
				attemptId: "attempt-1",
				resultId: "result-1",
				state: "settled",
				outcome: "succeeded",
				nextStage: "verify",
			}),
			readTaskTechnicalVerdict: () => null,
			recordTaskTechnicalVerdict: () => {
				recordedVerdict = true;
				throw new Error("must not record a requirement verdict");
			},
			invalidateTaskTechnicalPass: () => { throw new Error("must not invalidate"); },
			routeTaskFailure: () => {
				routedFailure = true;
				throw new Error("must not enter auto-fix recovery");
			},
		},
		runVerificationGate: () => ({
			passed: false,
			checks: [{
				command: "grep -q expected app.css",
				exitCode: 1,
				stdout: "",
				stderr: "'grep' is not recognized as an internal or external command",
				durationMs: 10,
				failureClass: "command-not-found",
			}],
			discoverySource: "task-plan",
			timestamp: Date.now(),
		}),
	} as never, async () => {
		paused = true;
	});

	assert.equal(result, "pause");
	assert.equal(paused, true);
	assert.equal(recordedVerdict, false);
	assert.equal(routedFailure, false);
	assert.equal(session.verificationRetryCount.has(retryKey), false);
	assert.equal(session.verificationRetryFailureHashes.has(retryKey), false);
	assert.equal(session.pendingVerificationRetry, null);
});

test("built-in verification retries a replayed authorized abort", () => {
	const outcome = _routeHostTechnicalFailureForTest({
		routeTaskFailure: () => ({
			action: "abort",
			status: "replayed",
			resumeAuthorized: true,
		}),
	} as never, {
		attemptId: "attempt-1",
		resultId: "result-1",
	} as never, {
		verdictId: "verdict-1",
		evidenceId: "evidence-1",
		verdict: "fail",
	});

	assert.equal(outcome, "retry");
});

test("terminal abort surfaces its recoveryActionId to the caller (#1593)", () => {
	const surfaced: string[] = [];
	const outcome = _routeHostTechnicalFailureForTest({
		routeTaskFailure: () => ({
			action: "abort",
			status: "applied",
			resumeAuthorized: false,
			recoveryActionId: "8f1d0c2e-6a44-4b19-9e77-2c3d5f0a1b62",
		}),
	} as never, {
		attemptId: "attempt-1",
		resultId: "result-1",
	} as never, {
		verdictId: "verdict-1",
		evidenceId: "evidence-1",
		verdict: "fail",
	}, "verification-failed", (id) => surfaced.push(id));

	assert.equal(outcome, "abort");
	assert.deepEqual(surfaced, ["8f1d0c2e-6a44-4b19-9e77-2c3d5f0a1b62"]);
});

test("a replayed authorized abort does not surface a recoveryActionId (#1593)", () => {
	const surfaced: string[] = [];
	const outcome = _routeHostTechnicalFailureForTest({
		routeTaskFailure: () => ({
			action: "abort",
			status: "replayed",
			resumeAuthorized: true,
			recoveryActionId: "8f1d0c2e-6a44-4b19-9e77-2c3d5f0a1b62",
		}),
	} as never, {
		attemptId: "attempt-1",
		resultId: "result-1",
	} as never, {
		verdictId: "verdict-1",
		evidenceId: "evidence-1",
		verdict: "fail",
	}, "verification-failed", (id) => surfaced.push(id));

	assert.equal(outcome, "retry");
	assert.deepEqual(surfaced, []);
});

test("routed fail rationale names the check, observed vs expected, and evidence (#1747)", () => {
	let routedRationale = "";
	_routeHostTechnicalFailureForTest({
		routeTaskFailure: (input: { rationale: string }) => {
			routedRationale = input.rationale;
			return { action: "retry", status: "applied", resumeAuthorized: false };
		},
	} as never, {
		attemptId: "attempt-1",
		resultId: "result-1",
	} as never, {
		verdictId: "verdict-1",
		evidenceId: "evidence-1",
		verdict: "fail",
		rationale: describeHostVerificationRationale({
			verdict: "fail",
			checkName: "just check-ci",
			observed: "timeout after 120000ms (exit 124)",
			expected: "exit 0 / pass",
			evidenceRef: "db://host-verification/attempt-1 (verdict verdict-1)",
			nextAction: "Raise verification_timeout_ms if this command is expected to run longer.",
		}),
	});
	assert.match(routedRationale, /just check-ci/);
	assert.match(routedRationale, /timeout after 120000ms/);
	assert.match(routedRationale, /exit 0 \/ pass/);
	assert.match(routedRationale, /evidence-1|verdict-1/);
	assert.doesNotMatch(routedRationale, /Route built-in host verification through the durable recovery policy/);
	assert.doesNotMatch(routedRationale, /Built-in host verification did not pass/);
});

test("inconclusive rationale states what would make it conclusive (#1747)", () => {
	const rationale = describeHostVerificationRationale({
		verdict: "inconclusive",
		checkName: "gsd-source-integrity",
		observed: "current source sha256:bbb",
		expected: "stored passing source sha256:aaa",
		evidenceRef: "db://host-verification/attempt-1/source-drift",
		nextAction: "To become conclusive, re-run host verification against the current source, or restore the stored revision.",
	});
	assert.match(rationale, /inconclusive/);
	assert.match(rationale, /gsd-source-integrity/);
	assert.match(rationale, /To become conclusive/);
});

test("verification_timeout_ms unset stays 120s; set value is enforced (#1759)", () => {
	assert.equal(_resolveVerificationTimeoutMsForTest(undefined), DEFAULT_COMMAND_TIMEOUT_MS);
	assert.equal(_resolveVerificationTimeoutMsForTest({}), DEFAULT_COMMAND_TIMEOUT_MS);
	assert.equal(_resolveVerificationTimeoutMsForTest({ verification_timeout_ms: 2500 }), 2500);
});

test("blocker-discovered completion pauses with the blocker surfaced instead of throwing (#2148)", async () => {
	let paused = false;
	let pauseMessage: string | undefined;
	const session = {
		basePath: process.cwd(),
		canonicalProjectRoot: process.cwd(),
		currentUnit: { type: "execute-task", id: "M001/S01/T01" },
		lastTaskRecoveryAbortId: null,
		pendingVerificationRetry: null,
		verificationRetryCount: new Map<string, number>(),
		verificationRetryFailureHashes: new Map<string, string>(),
	};
	const result = await runPostUnitVerification({
		s: session,
		ctx: { ui: { notify() {} } },
		pi: {},
		taskAuthority: {
			readLatestTaskAttempt: () => ({
				attemptId: "attempt-1",
				resultId: "result-1",
				resultFailureClass: "blocker-discovered",
				resultSummary: "Plan requires gsd_requirement_* tools outside this unit's surface",
				state: "settled",
				outcome: "failed",
				nextStage: "route",
			}),
			readTaskTechnicalVerdict: () => {
				throw new Error("must not read host verdicts for a blocker attempt");
			},
			recordTaskTechnicalVerdict: () => {
				throw new Error("must not record verdicts for a blocker attempt");
			},
			invalidateTaskTechnicalPass: () => {
				throw new Error("must not invalidate for a blocker attempt");
			},
			routeTaskFailure: () => {
				throw new Error("must not reroute a blocker attempt through task recovery");
			},
		},
	} as never, async (_ctx, _pi, errorContext) => {
		paused = true;
		pauseMessage = errorContext?.message;
	});

	assert.equal(result, "pause");
	assert.equal(paused, true);
	assert.match(
		pauseMessage ?? "",
		/discovered blocker/,
		`pause must name the discovered blocker, got: ${pauseMessage}`,
	);
	assert.match(
		pauseMessage ?? "",
		/Plan requires gsd_requirement_\* tools outside this unit's surface/,
		`pause must surface the blocker description, got: ${pauseMessage}`,
	);
	assert.match(
		pauseMessage ?? "",
		/\/gsd auto/,
		`pause must carry the resume instruction, got: ${pauseMessage}`,
	);
	assert.equal(session.lastTaskRecoveryAbortId, null, "a blocker pause is not a recovery abort");
});

test("non-blocker failed attempt still throws at the verify gate (#2148)", async () => {
	const result = runPostUnitVerification({
		s: {
			basePath: process.cwd(),
			canonicalProjectRoot: process.cwd(),
			currentUnit: { type: "execute-task", id: "M001/S01/T01" },
			lastTaskRecoveryAbortId: null,
			pendingVerificationRetry: null,
			verificationRetryCount: new Map<string, number>(),
			verificationRetryFailureHashes: new Map<string, string>(),
		},
		ctx: { ui: { notify() {} } },
		pi: {},
		taskAuthority: {
			readLatestTaskAttempt: () => ({
				attemptId: "attempt-1",
				resultId: "result-1",
				resultFailureClass: "executor-result-failed",
				state: "settled",
				outcome: "failed",
				nextStage: "route",
			}),
		},
	} as never, async () => {});

	await assert.rejects(
		result,
		/Host verification requires the latest succeeded canonical Attempt at the verify stage/,
	);
});

test("identical gate failures count 1/2, then 2/2, then exhaust into a durable abort (#1971)", async (t) => {
	const basePath = makeTempRepo("gsd-auto-fix-retry-bound-");
	t.after(() => cleanup(basePath));
	const notifications: string[] = [];
	let routeCalls = 0;
	let attemptNumber = 0;
	let paused = false;
	const session = {
		basePath,
		canonicalProjectRoot: basePath,
		currentUnit: { type: "execute-task", id: "M001/S01/T01" },
		lastTaskRecoveryAbortId: null as string | null,
		pendingVerificationRetry: null as { unitId: string } | null,
		verificationRetryCount: new Map<string, number>(),
		verificationRetryFailureHashes: new Map<string, string>(),
	};
	const taskAuthority = {
		readLatestTaskAttempt: () => ({
			// Every gsd_task_complete creates a NEW Attempt; the retry bound must
			// be per unit + failure, not per attemptId.
			attemptId: `attempt-${attemptNumber}`,
			resultId: `result-${attemptNumber}`,
			state: "settled",
			outcome: "succeeded",
			nextStage: "verify",
		}),
		readTaskTechnicalVerdict: () => null,
		recordTaskTechnicalVerdict: () => ({
			verdictId: `verdict-${attemptNumber}`,
			evidenceId: `evidence-${attemptNumber}`,
		}),
		invalidateTaskTechnicalPass: () => { throw new Error("must not invalidate"); },
		routeTaskFailure: () => {
			routeCalls++;
			// Mirrors the durable remediation budget (recovery-policy.ts:
			// verification-failed → remediate, maxUses 2, per task + fingerprint).
			if (routeCalls <= 2) {
				return { action: "remediate", status: "applied", recoveryActionId: `ra-${routeCalls}` };
			}
			return { action: "abort", status: "applied", resumeAuthorized: false, recoveryActionId: "ra-3" };
		},
	};
	const runGate = async () => runPostUnitVerification({
		s: session,
		ctx: { ui: { notify: (message: string) => notifications.push(message) } },
		pi: {},
		taskAuthority,
		runVerificationGate: () => ({
			passed: false,
			checks: [{
				command: "npm test",
				exitCode: 1,
				stdout: "",
				stderr: "Cannot find module './later-task-module'",
				durationMs: 10,
			}],
			discoverySource: "task-plan",
			timestamp: Date.now(),
		}),
	} as never, async () => {
		paused = true;
	});

	attemptNumber = 1;
	assert.equal(await runGate(), "retry");
	assert.ok(
		notifications.some((message) => message.includes("auto-fix attempt 1/")),
		`first failure must announce attempt 1, got: ${JSON.stringify(notifications)}`,
	);
	// The auto-loop consumes the pending retry when it re-dispatches the unit.
	session.pendingVerificationRetry = null;

	attemptNumber = 2;
	assert.equal(await runGate(), "retry");
	assert.ok(
		notifications.some((message) => message.includes("auto-fix attempt 2/")),
		`second identical failure must announce attempt 2, not reset to 1 (got: ${JSON.stringify(notifications)})`,
	);
	session.pendingVerificationRetry = null;

	attemptNumber = 3;
	assert.equal(await runGate(), "abort", "the exhausted durable budget must surface as abort");
	assert.equal(session.lastTaskRecoveryAbortId, "ra-3");
	assert.equal(session.verificationRetryCount.size, 0, "abort clears the per-unit retry counter");
	assert.equal(paused, false, "the gate defers the pause to the finalize abort path");
});
