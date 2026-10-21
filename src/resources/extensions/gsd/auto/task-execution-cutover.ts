// Project/App: gsd-pi
// File Purpose: Fail-closed canonical Task Attempt boundary around auto-mode unit execution.

import type {
  ClaimTaskAttemptInput,
  ClaimTaskAttemptReceipt,
  SettleTaskAttemptInput,
  SettleTaskAttemptReceipt,
  TaskExecutionAttemptSnapshot,
  TaskResultRecoveryClassification,
} from "../task-execution-domain-operation.js";
import {
  isTaskAttemptAwaitingVerification,
  readLatestTaskAttempt,
  readTaskLifecycleStatus,
} from "../task-execution-domain-operation.js";
import type {
  RouteFailureInput,
  TaskRecoveryReceipt,
  TaskRecoveryRouteSnapshot,
} from "../task-recovery-domain-operation.js";
import { classifyFailure } from "../recovery-classification.js";
import type { PublishVerifiedTaskCompletionInput } from "../task-completion-compatibility-adapter.js";
import { internalExecutionInvocation } from "../execution-invocation.js";
import type { TaskTechnicalVerdictSnapshot } from "../task-verification-domain-operation.js";
import { describeHostVerificationRationale } from "../verification-verdict.js";
import type { UnitPhaseResult } from "./workflow-unit-dispatch.js";

export interface TaskExecutionCutoverInput {
  unitType: string;
  unitId: string;
  dispatchId: number | null;
  workerId: string | null;
  milestoneLeaseToken: number | null;
  traceId: string;
  turnId: string;
  markCanonicalDispatchSettled(): void;
}

export interface TaskExecutionCutoverDeps {
  readLatestTaskAttempt(task: ClaimTaskAttemptInput["task"]): TaskExecutionAttemptSnapshot | null;
  readTerminalTaskRecoveryAbort(
    task: ClaimTaskAttemptInput["task"],
  ): { recoveryActionId: string } | null;
  readTaskAttempt(attemptId: string): TaskExecutionAttemptSnapshot | null;
  readTaskRecoveryRoute(attemptId: string): Pick<
    TaskRecoveryRouteSnapshot,
    "recoveryActionId" | "action" | "recoveryOwner" | "resumeAuthorized" | "resumeEligibility"
  > | null;
  readTaskTechnicalVerdict(attemptId: string): TaskTechnicalVerdictSnapshot | null;
  claimTaskAttempt(input: ClaimTaskAttemptInput): ClaimTaskAttemptReceipt;
  settleTaskAttempt(input: SettleTaskAttemptInput): SettleTaskAttemptReceipt;
  routeTaskFailure(input: RouteFailureInput): TaskRecoveryReceipt;
}

type TaskRecoveryDecision = Pick<
  TaskRecoveryReceipt,
  "status" | "recoveryActionId" | "action" | "resumeAuthorized"
>;

function readHistoricalTerminalAbortDecision(
  input: TaskExecutionCutoverInput,
  deps: TaskExecutionCutoverDeps,
): TaskRecoveryDecision | null {
  const terminal = deps.readTerminalTaskRecoveryAbort(parseTaskIdentity(input.unitId));
  if (!terminal) return null;
  return {
    status: "replayed",
    recoveryActionId: terminal.recoveryActionId,
    action: "abort",
    resumeAuthorized: false,
  };
}

function routeStoredTechnicalFailure(
  input: TaskExecutionCutoverInput,
  attempt: TaskExecutionAttemptSnapshot,
  verdict: TaskTechnicalVerdictSnapshot,
  deps: TaskExecutionCutoverDeps,
): TaskRecoveryDecision {
  if (!attempt.resultId) throw new Error("Host verification Attempt Result is missing");
  if (verdict.verdict === "pass") {
    throw new Error("Task recovery cannot route a passing Technical Verdict");
  }
  const terminal = readHistoricalTerminalAbortDecision(input, deps);
  if (terminal) return terminal;
  return deps.routeTaskFailure({
    invocation: internalExecutionInvocation(`internal:auto:attempt.route:${attempt.resultId}`),
    attemptId: attempt.attemptId,
    resultId: attempt.resultId,
    owner: "agent",
    classification: { failureKind: "verification-failed" },
    summary: `Host verification ${verdict.verdict} for ${verdict.verdictId}`,
    evidence: {
      unitType: input.unitType,
      unitId: input.unitId,
      verdictId: verdict.verdictId,
      evidenceId: verdict.evidenceId,
      verdict: verdict.verdict,
    },
    rationale: describeHostVerificationRationale({
      verdict: verdict.verdict,
      checkName: `${input.unitType} ${input.unitId}`,
      observed: verdict.verdict,
      expected: "pass",
      evidenceRef: `${verdict.evidenceId} (verdict ${verdict.verdictId})`,
      nextAction: verdict.verdict === "inconclusive"
        ? "To become conclusive, inspect that evidence and resume with matching verification."
        : undefined,
    }),
  });
}

export interface VerifiedTaskPublicationDeps {
  readLatestTaskAttempt(task: ClaimTaskAttemptInput["task"]): TaskExecutionAttemptSnapshot | null;
  /** Canonical lifecycle status; defaults to the database reader. */
  readTaskLifecycleStatus?(task: ClaimTaskAttemptInput["task"]): string | null;
  publishVerifiedTaskCompletion(input: PublishVerifiedTaskCompletionInput): Promise<unknown>;
}

export interface VerifiedTaskPublicationInput {
  unitType: string;
  unitId: string;
  workerId: string | null;
  traceId: string;
  turnId: string;
  basePath: string;
}

export interface TaskHostVerificationReadinessDeps {
  readLatestTaskAttempt(task: ClaimTaskAttemptInput["task"]): Pick<
    TaskExecutionAttemptSnapshot,
    "state" | "outcome" | "nextStage"
  > | null;
}

const DEFAULT_READINESS_DEPS: TaskHostVerificationReadinessDeps = {
  readLatestTaskAttempt,
};

const TRANSIENT_PHASE_FAILURE_REASONS = new Set([
  "api-timeout",
  "ghost-completion",
  "provider-pause",
  "rate-limit",
  "session-timeout",
  "unit-aborted-pause",
]);

function parseTaskIdentity(unitId: string): ClaimTaskAttemptInput["task"] {
  const parts = unitId.split("/");
  if (parts.length !== 3 || parts.some((part) => part.trim().length === 0)) {
    throw new Error(`execute-task unit id must be milestone/slice/task, received ${unitId}`);
  }
  return {
    milestoneId: parts[0],
    sliceId: parts[1],
    taskId: parts[2],
  };
}

export function isTaskExecutionReadyForHostVerification(
  unitType: string,
  unitId: string,
  deps: TaskHostVerificationReadinessDeps = DEFAULT_READINESS_DEPS,
): boolean {
  if (unitType !== "execute-task") return false;
  try {
    return isTaskAttemptAwaitingVerification(
      deps.readLatestTaskAttempt(parseTaskIdentity(unitId)),
    );
  } catch {
    return false;
  }
}

function requireTaskClaimIdentity(input: TaskExecutionCutoverInput): {
  dispatchId: number;
  workerId: string;
  milestoneLeaseToken: number;
} {
  if (!Number.isSafeInteger(input.dispatchId) || Number(input.dispatchId) <= 0) {
    throw new Error("execute-task requires a positive coordination dispatch identity");
  }
  if (typeof input.workerId !== "string" || input.workerId.trim().length === 0) {
    throw new Error("execute-task requires a worker identity");
  }
  if (!Number.isSafeInteger(input.milestoneLeaseToken) || Number(input.milestoneLeaseToken) <= 0) {
    throw new Error("execute-task requires a positive milestone lease identity");
  }
  return {
    dispatchId: input.dispatchId as number,
    workerId: input.workerId,
    milestoneLeaseToken: input.milestoneLeaseToken as number,
  };
}

function failureReason(result: UnitPhaseResult): string {
  if (result.action === "break" || result.action === "retry") return result.reason;
  if (result.action === "continue") return "unit requested continuation without an executor Result";
  return "unit ended without an executor Result";
}

function interruptStaleAttempt(
  input: TaskExecutionCutoverInput,
  predecessor: TaskExecutionAttemptSnapshot,
  identity: ReturnType<typeof requireTaskClaimIdentity>,
  deps: TaskExecutionCutoverDeps,
): TaskRecoveryDecision {
  if (identity.milestoneLeaseToken < predecessor.milestoneLeaseToken) {
    // A strictly older token means the running Attempt belongs to a newer
    // session; this stale session must not settle it, only refuse.
    throw new Error("execute-task cannot replace an active running Attempt without a newer milestone lease");
  }
  const sameSession = identity.milestoneLeaseToken === predecessor.milestoneLeaseToken;
  const summary = sameSession
    ? "Replaced stale Task Attempt during same-session re-dispatch"
    : "Replaced stale Task Attempt after milestone lease takeover";
  const recovery = taskRecoveryClassification(input, "stale-worker", new Error(summary));
  const settlement = deps.settleTaskAttempt({
    invocation: internalExecutionInvocation(
      sameSession
        ? `internal:auto:attempt.settle:${predecessor.attemptId}:same-session`
        : `internal:auto:attempt.interrupt:${predecessor.attemptId}:${identity.workerId}:${identity.milestoneLeaseToken}`,
      { actorId: identity.workerId },
    ),
    attemptId: predecessor.attemptId,
    outcome: "interrupted",
    failureClass: "stale-worker",
    summary,
    output: {
      unitType: input.unitType,
      unitId: input.unitId,
      staleDispatchId: predecessor.coordinationDispatchId,
      staleWorkerId: predecessor.workerId,
      staleMilestoneLeaseToken: predecessor.milestoneLeaseToken,
      replacementDispatchId: identity.dispatchId,
      replacementWorkerId: identity.workerId,
      replacementMilestoneLeaseToken: identity.milestoneLeaseToken,
      recoveryClassification: {
        failureKind: recovery.failureKind,
        action: recovery.action,
        rationale: recovery.rationale,
      },
    },
    ...(sameSession
      ? {}
      : {
          recovery: {
            workerId: identity.workerId,
            milestoneLeaseToken: identity.milestoneLeaseToken,
          },
        }),
  });
  return routeTaskFailure(
    input,
    predecessor.attemptId,
    settlement.resultId,
    summary,
    recovery,
    deps,
  );
}

function isClaimReplay(
  predecessor: TaskExecutionAttemptSnapshot,
  identity: ReturnType<typeof requireTaskClaimIdentity>,
): boolean {
  return predecessor.coordinationDispatchId === identity.dispatchId &&
    predecessor.workerId === identity.workerId &&
    predecessor.milestoneLeaseToken === identity.milestoneLeaseToken;
}

function settleRunningAttempt(
  input: TaskExecutionCutoverInput,
  attemptId: string,
  failureClass: string,
  summary: string,
  deps: TaskExecutionCutoverDeps,
  error: unknown = new Error(summary),
): TaskRecoveryDecision {
  const attempt = deps.readTaskAttempt(attemptId);
  let resultId = attempt?.resultId;
  const recovery = attempt?.resultRecovery ?? taskRecoveryClassification(
    input,
    attempt?.resultFailureClass ?? failureClass,
    error,
  );
  if (attempt?.state !== "settled") {
    resultId = deps.settleTaskAttempt({
      invocation: internalExecutionInvocation(`internal:auto:attempt.settle:${attemptId}`),
      attemptId,
      outcome: "failed",
      failureClass: recovery.failureKind,
      summary,
      output: {
        unitType: input.unitType,
        unitId: input.unitId,
        rawFailureClass: failureClass,
        recoveryClassification: {
          failureKind: recovery.failureKind,
          action: recovery.action,
          rationale: recovery.rationale,
        },
      },
    }).resultId;
  }
  input.markCanonicalDispatchSettled();
  if (!resultId) throw new Error("Task recovery requires the settled Attempt Result identity");
  return routeTaskFailure(input, attemptId, resultId, summary, recovery, deps);
}

function taskRecoveryClassification(
  input: TaskExecutionCutoverInput,
  failureClass: string,
  error: unknown,
): TaskResultRecoveryClassification {
  const reason = error instanceof Error ? error.message : String(error);
  if (
    failureClass === "executor-retry" ||
    failureClass === "transient-execution" ||
    TRANSIENT_PHASE_FAILURE_REASONS.has(reason)
  ) {
    return {
      failureKind: "transient-execution",
      action: "retry",
      rationale: "Retry the bounded transient Task execution failure.",
    };
  }
  if (failureClass === "verification-failed") {
    return {
      failureKind: "verification-failed",
      action: "escalate",
      rationale: "Repair the failed host verification evidence before retrying the Task.",
    };
  }
  const classified = classifyFailure({
    error,
    unitType: input.unitType,
    unitId: input.unitId,
    ...(failureClass === "stale-worker"
      ? { failureKind: "stale-worker" as const }
      : failureClass === "missing-executor-result"
        ? { failureKind: "lifecycle-progression" as const }
        : {}),
  });
  return {
    failureKind: classified.failureKind,
    action: classified.action,
    rationale: classified.remediation,
  };
}

function routeTaskFailure(
  input: TaskExecutionCutoverInput,
  attemptId: string,
  resultId: string,
  summary: string,
  recovery: TaskResultRecoveryClassification,
  deps: TaskExecutionCutoverDeps,
): TaskRecoveryDecision {
  const terminal = readHistoricalTerminalAbortDecision(input, deps);
  if (terminal) return terminal;
  return deps.routeTaskFailure({
    invocation: internalExecutionInvocation(`internal:auto:attempt.route:${resultId}`),
    attemptId,
    resultId,
    owner: "agent",
    classification: {
      failureKind: recovery.failureKind,
      action: recovery.action,
    },
    summary,
    evidence: {
      unitType: input.unitType,
      unitId: input.unitId,
      resultId,
    },
    rationale: recovery.rationale,
  });
}

// The terminal abort is resumable by design via the operator-facing `/gsd recover`
// bridge (or the equivalent agent tool). Carry the exact id in the break reason so
// it reaches the journal, dispatch ledger, and operator instead of being discarded.
function taskRecoveryAbortResult(recoveryActionId: string): UnitPhaseResult {
  return {
    action: "break",
    reason:
      `task-recovery-abort (recoveryActionId: ${recoveryActionId}; resume with /gsd recover ${recoveryActionId} or gsd_task_recovery_resume)`,
  };
}

function applyRecoveryDecision(
  recovery: TaskRecoveryDecision,
): UnitPhaseResult {
  switch (recovery.action) {
    case "retry":
    case "repair":
    case "remediate":
    case "replan":
      return { action: "retry", reason: `task-recovery-${recovery.action}` };
    case "abort":
      if (recovery.status === "replayed" && recovery.resumeAuthorized) {
        return { action: "retry", reason: "task-recovery-resumed" };
      }
      return taskRecoveryAbortResult(recovery.recoveryActionId);
    case "clarify":
    case "pause":
      throw new Error("Agent-owned Task recovery cannot return a human-owned action");
  }
}

function isNewlyRecordedBlocker(
  attempt: TaskExecutionAttemptSnapshot | null,
): boolean {
  return attempt?.state === "settled" &&
    attempt.outcome === "failed" &&
    attempt.nextStage === "route" &&
    attempt.resultFailureClass === "blocker-discovered";
}

function reconcileNext(
  input: TaskExecutionCutoverInput,
  attemptId: string,
  result: UnitPhaseResult,
  deps: TaskExecutionCutoverDeps,
): UnitPhaseResult {
  const attempt = deps.readTaskAttempt(attemptId);
  if (isTaskAttemptAwaitingVerification(attempt)) {
    input.markCanonicalDispatchSettled();
    return result;
  }
  if (attempt?.state === "settled") {
    input.markCanonicalDispatchSettled();
    if ((attempt.outcome === "failed" || attempt.outcome === "interrupted") && attempt.nextStage === "route") {
      if (isNewlyRecordedBlocker(attempt)) return result;
      if (!attempt.resultId) throw new Error("Task recovery requires the settled Attempt Result identity");
      const summary = attempt.resultSummary ?? "Task executor recorded a failed Result";
      return applyRecoveryDecision(routeTaskFailure(
        input,
        attemptId,
        attempt.resultId,
        summary,
        attempt.resultRecovery ?? taskRecoveryClassification(
          input,
          attempt.resultFailureClass ?? "executor-result-failed",
          new Error(summary),
        ),
        deps,
      ));
    }
    throw new Error("execute-task next requires a succeeded Result at the verify stage");
  }

  const recovery = settleRunningAttempt(
    input,
    attemptId,
    "missing-executor-result",
    "execute-task ended without a succeeded executor Result",
    deps,
  );
  return applyRecoveryDecision(recovery);
}

export async function runWithTaskExecutionAttempt(
  input: TaskExecutionCutoverInput,
  run: () => Promise<UnitPhaseResult>,
  deps: TaskExecutionCutoverDeps,
): Promise<UnitPhaseResult> {
  if (input.unitType !== "execute-task") return run();

  const task = parseTaskIdentity(input.unitId);
  const identity = requireTaskClaimIdentity(input);
  const predecessor = deps.readLatestTaskAttempt(task);
  if (isTaskAttemptAwaitingVerification(predecessor)) {
    return { action: "next", data: {} };
  }
  const terminalAbort = deps.readTerminalTaskRecoveryAbort(task);
  if (terminalAbort) return taskRecoveryAbortResult(terminalAbort.recoveryActionId);
  let claim: ClaimTaskAttemptReceipt | undefined;
  let result: UnitPhaseResult;
  try {
    let retryOfAttemptId: string | undefined;
    if (predecessor?.state === "running") {
      if (isClaimReplay(predecessor, identity)) {
        retryOfAttemptId = predecessor.retryOfAttemptId;
      } else {
        const recovery = interruptStaleAttempt(input, predecessor, identity, deps);
        const decision = applyRecoveryDecision(recovery);
        if (decision.action === "break" || recovery.status === "committed") return decision;
        retryOfAttemptId = predecessor.attemptId;
      }
    } else if (predecessor) {
      const terminalRecovery = deps.readTaskRecoveryRoute(predecessor.attemptId);
      // Only a live route head carries an operative abort; a lineage closed by
      // task reopen is history and must not advertise a dead resume (#1948).
      // A consumed resume is likewise historical even though its one-shot
      // authorization now reads false; eligibility distinguishes that state
      // from a current abort that still needs operator repair (#2112). The
      // already-resumed handling is evaluated independently of the
      // resumeAuthorized flag: a freshly authorized resume carries the same
      // marker while the kernel still parks at route, so its re-entry must
      // fall through to the successor claim instead of re-routing the
      // already-routed Result (#2188).
      if (
        predecessor.nextStage === "route" &&
        terminalRecovery?.recoveryOwner === "agent" &&
        terminalRecovery.action === "abort"
      ) {
        if (terminalRecovery.resumeEligibility?.failedGuard === "already-resumed") {
          // The resume event may still await a claim or already be consumed.
          // Refresh in case a successor committed after the predecessor read,
          // avoiding the stale finalize/retry abort lever (#2112).
          const refreshed = deps.readLatestTaskAttempt(task);
          if (refreshed && refreshed.attemptId !== predecessor.attemptId) {
            return runWithTaskExecutionAttempt(input, run, deps);
          }
        }
        if (!terminalRecovery.resumeAuthorized) {
          return taskRecoveryAbortResult(terminalRecovery.recoveryActionId);
        }
      } else if (predecessor.nextStage === "route") {
        if (predecessor.outcome === "succeeded") {
          const recovery = terminalRecovery;
          if (!recovery) {
            const verdict = deps.readTaskTechnicalVerdict(predecessor.attemptId);
            if (!verdict) {
              throw new Error("Task recovery route is missing its failed Technical Verdict");
            }
            return applyRecoveryDecision(routeStoredTechnicalFailure(input, predecessor, verdict, deps));
          }
          if (recovery.recoveryOwner !== "agent") {
            return { action: "next", data: {} };
          }
        } else {
          if (!predecessor.resultId) {
            throw new Error("Task recovery requires the predecessor Result identity");
          }
          const summary = predecessor.resultSummary ?? "Task executor recorded a failed Result";
          const recovery = routeTaskFailure(
            input,
            predecessor.attemptId,
            predecessor.resultId,
            summary,
            predecessor.resultRecovery ?? taskRecoveryClassification(
              input,
              predecessor.resultFailureClass ?? "executor-result-failed",
              new Error(summary),
            ),
            deps,
          );
          const decision = applyRecoveryDecision(recovery);
          if (decision.action === "break" || recovery.status === "committed") return decision;
        }
      }
      retryOfAttemptId = predecessor.attemptId;
    }
    claim = deps.claimTaskAttempt({
      invocation: internalExecutionInvocation(
        `internal:auto:attempt.claim:${identity.dispatchId}`,
        {
          actorId: identity.workerId,
        },
      ),
      task,
      workerId: identity.workerId,
      milestoneLeaseToken: identity.milestoneLeaseToken,
      coordinationDispatchId: identity.dispatchId,
      ...(retryOfAttemptId ? { retryOfAttemptId } : {}),
    });

    result = await run();
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    // Once an Attempt is claimed, every executor failure must settle it before
    // returning. Failures before a claim exists keep propagating untouched.
    const attemptId = claim?.attemptId
      ?? (predecessor?.state === "running" && isClaimReplay(predecessor, identity)
        ? predecessor.attemptId
        : undefined);
    if (!attemptId) throw error;
    if (isNewlyRecordedBlocker(deps.readTaskAttempt(attemptId))) {
      input.markCanonicalDispatchSettled();
      return { action: "next", data: {} };
    }
    return applyRecoveryDecision(
      settleRunningAttempt(input, attemptId, "executor-error", summary, deps, error),
    );
  }

  // Every pre-claim path returns from inside the try and the catch always
  // returns or rethrows, so reaching here means the claim exists.
  if (!claim) throw new Error("execute-task lost its claimed Attempt");

  if (result.action === "next") {
    return reconcileNext(input, claim.attemptId, result, deps);
  }

  if (isNewlyRecordedBlocker(deps.readTaskAttempt(claim.attemptId))) {
    input.markCanonicalDispatchSettled();
    return result;
  }

  const recovery = settleRunningAttempt(
    input,
    claim.attemptId,
    `executor-${result.action}`,
    failureReason(result),
    deps,
  );
  return applyRecoveryDecision(recovery);
}

export async function publishVerifiedTaskExecution(
  input: VerifiedTaskPublicationInput,
  deps: VerifiedTaskPublicationDeps,
): Promise<void> {
  if (input.unitType !== "execute-task") {
    throw new Error("Verified Task publication requires an execute-task unit");
  }
  const task = parseTaskIdentity(input.unitId);
  const attempt = deps.readLatestTaskAttempt(task);
  // A reopened Task voids its prior lineage to `settled` without publishing
  // (#1948); its `ready` lifecycle has nothing to replay. A committed
  // publication whose projection failed stays replayable (lifecycle completed).
  const publicationReplayCandidate = attempt?.state === "settled" &&
    attempt.outcome === "succeeded" && attempt.nextStage === "settled" &&
    (deps.readTaskLifecycleStatus ?? readTaskLifecycleStatus)(task) !== "ready";
  const resolvedHumanReviewCandidate = attempt?.state === "settled" &&
    attempt.outcome === "succeeded" && attempt.nextStage === "route";
  if (!isTaskAttemptAwaitingVerification(attempt) &&
      !resolvedHumanReviewCandidate &&
      !publicationReplayCandidate) {
    throw new Error("Verified Task publication requires a succeeded Attempt at the verify stage");
  }
  await deps.publishVerifiedTaskCompletion({
    invocation: internalExecutionInvocation(`internal:auto:task.publish:${attempt.attemptId}`),
    basePath: input.basePath,
    task,
    attemptId: attempt.attemptId,
  });
}
