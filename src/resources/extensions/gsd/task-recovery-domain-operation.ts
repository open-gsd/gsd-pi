// Project/App: gsd-pi
// File Purpose: Replay-safe semantic Domain Operations for Task recovery history.

import {
  canonicalDomainJson,
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationContext,
  type DomainOperationMutation,
  type DomainOperationRequest,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import {
  CURRENT_EVIDENCE_BACKED_FAILURE_VERDICT_SQL,
  CURRENT_TASK_RECOVERY_CAUSAL_AUTHORITY_SQL,
} from "./db/sql-constants.js";
import {
  appendRecoveryWorkCheckpoint,
  createOrReadRecoveryBudget,
  grantRecoveryWaiver,
  openRecoveryBlocker,
  recordFailureObservation,
  recordRecoveryAction,
  recordRequirementDisposition,
  resolveRecoveryBlocker,
  terminateRecoveryWaiver,
  type AppendRecoveryWorkCheckpointInput,
  type GrantRecoveryWaiverInput,
  type RecordRequirementDispositionInput,
} from "./db/writers/task-recovery.js";
import {
  readDomainOperationFence,
  isTaskRecoveryResumeAuthorized,
} from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { readLatestTaskAttempt } from "./task-execution-domain-operation.js";

export {
  cancelTask,
  reopenTask,
  type TaskLifecycleIdentity,
  type TaskLifecycleReceipt,
} from "./task-lifecycle-domain-operation.js";
import {
  normalizeFailureFingerprint,
  selectRecoveryDecision,
  type HumanBlockerKind,
  type RecoveryDecision,
  type RecoveryPolicyInput,
  type TaskFailureKind,
} from "./recovery-policy.js";

type AgentClassification = Extract<RecoveryPolicyInput, { owner: "agent" }>["classification"];
type ReceiptStatus = DomainOperationResult["status"];

interface TaskScope {
  lifecycleId: string;
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

interface FailedAttemptScope extends TaskScope {
  attemptId: string;
  resultId: string;
  kernelCheckpointId: string;
  boundaryStage: "execute" | "verify";
}

export type RouteFailureInput = {
  invocation: ExecutionInvocation;
  attemptId: string;
  resultId: string;
  summary: string;
  evidence: DomainJsonValue;
  rationale: string;
  targetLifecycleId?: string;
  supersedesResolvedBlockerId?: string;
} & (
  | { owner: "agent"; classification: AgentClassification }
  | {
      owner: "user" | "external";
      classification: { failureKind: TaskFailureKind };
      blocker: {
        blockerKind: HumanBlockerKind;
        description: string;
        requestedAction: string;
      };
    }
);

export interface TaskRecoveryReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  failureObservationId: string;
  recoveryActionId: string;
  action: RecoveryDecision["action"];
  recoveryBudgetId?: string;
  blockerId?: string;
  workCheckpointId?: string;
  resumeAuthorized?: boolean;
}

export interface TaskRecoveryResumeReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  recoveryActionId: string;
  workCheckpointId: string;
}

type PendingTaskRecoveryAction = Extract<
  RecoveryDecision["action"],
  "retry" | "repair" | "remediate" | "replan"
>;

interface PendingTaskRecoveryContextBase {
  recoveryActionId: string;
  attemptId: string;
  resultId: string;
  failureKind: string;
  summary: string;
  evidence: DomainJsonValue;
  rationale: string;
  replanCompleted: boolean;
  checkpoint: {
    checkpointId: string;
    confirmedContext: string;
    unresolvedSummary: string;
    evidenceSummary: string;
    suggestedNextAction: string;
  };
}

export type PendingTaskRecoveryContext = PendingTaskRecoveryContextBase & (
  | {
      action: PendingTaskRecoveryAction;
      resumeAuthorized?: false;
    }
  | { action: "continue"; resumeAuthorized: true }
);

export interface BlockerResolutionReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  blockerId: string;
  blockerStatus: "resolved" | "dismissed";
  workCheckpointId: string;
}

export interface WaiverReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  waiverId: string;
  waiverStatus: "active" | "revoked" | "expired";
  dispositionId?: string;
}

export interface RequirementDispositionReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  dispositionId: string;
  disposition: "unsatisfied" | "satisfied" | "waived";
}

export interface WorkCheckpointReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  workCheckpointId: string;
  sequence: number;
}

export interface TaskRecoveryBlockerSnapshot {
  blockerId: string;
  blockerKind: HumanBlockerKind;
  blockerStatus: "open" | "resolved" | "dismissed";
  resolutionOwner: "user" | "external";
  resolution: string;
  recoveryAction: RecoveryDecision["action"];
  resolvedOperationId?: string;
  resolvedProjectRevision?: number;
}

export interface TaskRecoveryRouteSnapshot {
  recoveryActionId: string;
  action: RecoveryDecision["action"];
  recoveryOwner: "agent" | "user" | "external";
  failureKind: string;
  blocker: TaskRecoveryBlockerSnapshot | null;
  resumeAuthorized: boolean;
  resumeEligibility?: TaskRecoveryResumeEligibility;
}

export type TaskRecoveryResumeGuard =
  | "recovery-action-exists"
  | "abort-action"
  | "agent-owned"
  | "action-blocker"
  | "lifecycle-in-progress"
  | "attempt-settled"
  | "causal-authority"
  | "latest-attempt"
  | "open-blockers"
  | "route-head"
  | "already-resumed";

export interface TaskRecoveryResumeEligibility {
  recoveryActionId: string;
  eligible: boolean;
  attemptId?: string;
  resultId?: string;
  failedGuard?: TaskRecoveryResumeGuard;
  detail?: string;
}

function taskRecoveryBlockerSnapshot(
  stored: Record<string, unknown>,
): TaskRecoveryBlockerSnapshot {
  return {
    blockerId: String(stored["blocker_id"]),
    blockerKind: String(stored["blocker_kind"]) as HumanBlockerKind,
    blockerStatus: String(stored["blocker_status"]) as TaskRecoveryBlockerSnapshot["blockerStatus"],
    resolutionOwner: String(stored["resolution_owner"]) as TaskRecoveryBlockerSnapshot["resolutionOwner"],
    resolution: String(stored["resolution"]),
    recoveryAction: String(stored["action"]) as RecoveryDecision["action"],
    ...(stored["resolved_operation_id"]
      ? { resolvedOperationId: String(stored["resolved_operation_id"]) }
      : {}),
    ...(stored["resolved_project_revision"]
      ? { resolvedProjectRevision: Number(stored["resolved_project_revision"]) }
      : {}),
  };
}

function operationRequest(
  operationType: string,
  invocation: ExecutionInvocation,
  payload: DomainJsonValue,
): DomainOperationRequest {
  const fence = readDomainOperationFence(invocation.idempotencyKey);
  return {
    operationType,
    idempotencyKey: invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: invocation.actorType,
    ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation.sourceTransport,
    ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
    payload,
  };
}

function mutation(
  eventType: string,
  entityId: string,
  payload: DomainJsonValue,
): DomainOperationMutation {
  return {
    events: [{
      eventType,
      entityType: "task",
      entityId,
      payload,
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: `${eventType}/${entityId}`.toLowerCase(),
      projectionKind: "task-recovery",
      rendererVersion: "1",
    }],
  };
}

function taskEntity(scope: Pick<FailedAttemptScope, "milestoneId" | "sliceId" | "taskId">): string {
  return `${scope.milestoneId}/${scope.sliceId}/${scope.taskId}`;
}

function checkpointScope(scope: Pick<FailedAttemptScope, "milestoneId" | "sliceId" | "taskId">): string {
  return `task:${taskEntity(scope)}`.toLowerCase();
}

function requireNonBlank(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must not be blank`);
  }
  return value.trim();
}

function requireRepairEvidence(evidence: DomainJsonValue): DomainJsonValue {
  if (
    evidence === null ||
    Array.isArray(evidence) ||
    typeof evidence !== "object" ||
    Object.keys(evidence).length === 0
  ) {
    throw new Error("evidence must be a non-empty object");
  }
  return evidence;
}

function suggestedAgentRecoveryAction(
  action: Extract<RecoveryDecision, { owner: "agent" }>["action"],
): string {
  switch (action) {
    case "retry":
      return "Retry the Task using the preserved failure evidence.";
    case "repair":
      return "Repair the deterministic execution fault before continuing the Task.";
    case "remediate":
      return "Remediate the failed verification evidence, then rerun verification.";
    case "replan":
      return "Replan the Task before implementation, then execute the replacement plan.";
    case "abort":
      return "Stop automatic Task execution and preserve this failure for diagnosis.";
  }
}

export function readPendingTaskRecoveryContext(
  task: Pick<TaskScope, "milestoneId" | "sliceId" | "taskId">,
): PendingTaskRecoveryContext | null {
  const stored = getDb().prepare(`
    SELECT lifecycle.lifecycle_id, action.action, action.recovery_action_id,
           attempt.attempt_id, observation.result_id,
           observation.failure_kind, observation.summary, observation.evidence_json,
           action.rationale,
           CASE WHEN EXISTS (
             SELECT 1 FROM workflow_domain_events replan
             WHERE replan.project_id = action.project_id
               AND replan.event_type = 'workflow.task.replanned'
               AND replan.entity_type = 'task'
               AND replan.entity_id = lifecycle.milestone_id || '/' || lifecycle.slice_id || '/' || lifecycle.task_id
               AND replan.project_revision > action.project_revision
           ) THEN 1 ELSE 0 END AS replan_completed,
           checkpoint.checkpoint_id, checkpoint.confirmed_context,
           checkpoint.unresolved_summary, checkpoint.evidence_summary,
           checkpoint.suggested_next_action
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_execution_attempts attempt
      ON attempt.lifecycle_id = lifecycle.lifecycle_id
     AND attempt.project_id = lifecycle.project_id
    JOIN workflow_kernel_checkpoints kernel
      ON kernel.lifecycle_id = lifecycle.lifecycle_id
     AND kernel.attempt_id = attempt.attempt_id
     AND kernel.project_id = lifecycle.project_id
     AND kernel.next_stage = 'route'
     AND NOT EXISTS (
       SELECT 1 FROM workflow_kernel_checkpoints successor
       WHERE successor.previous_kernel_checkpoint_id = kernel.kernel_checkpoint_id
     )
    JOIN workflow_failure_observations observation
      ON observation.attempt_id = attempt.attempt_id
     AND observation.lifecycle_id = lifecycle.lifecycle_id
     AND observation.project_id = lifecycle.project_id
    JOIN workflow_attempt_results result
      ON result.result_id = observation.result_id
     AND result.attempt_id = observation.attempt_id
     AND result.lifecycle_id = observation.lifecycle_id
     AND result.project_id = observation.project_id
    JOIN workflow_recovery_actions action
      ON action.failure_observation_id = observation.failure_observation_id
     AND action.lifecycle_id = lifecycle.lifecycle_id
     AND action.project_id = lifecycle.project_id
    JOIN workflow_work_checkpoints checkpoint
      ON checkpoint.operation_id = action.operation_id
     AND checkpoint.lifecycle_id = lifecycle.lifecycle_id
     AND checkpoint.project_id = lifecycle.project_id
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND action.action IN ('retry', 'repair', 'remediate', 'replan', 'abort')
      AND ${CURRENT_TASK_RECOVERY_CAUSAL_AUTHORITY_SQL}
      AND attempt.attempt_number = (
        SELECT MAX(latest.attempt_number)
        FROM workflow_execution_attempts latest
        WHERE latest.lifecycle_id = lifecycle.lifecycle_id
          AND latest.project_id = lifecycle.project_id
      )
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as Record<string, unknown> | undefined;
  if (!stored) return null;
  const attemptId = String(stored["attempt_id"]);
  const storedAction = String(stored["action"]);
  let checkpoint = stored;
  const resumeAuthorized = isTaskRecoveryResumeAuthorized(attemptId);
  if (storedAction === "abort" && !resumeAuthorized) return null;
  if (resumeAuthorized) {
    const lifecycleId = String(stored["lifecycle_id"]);
    const resumed = getDb().prepare(`
      SELECT checkpoint.checkpoint_id, checkpoint.confirmed_context,
             checkpoint.unresolved_summary, checkpoint.evidence_summary,
             checkpoint.suggested_next_action
      FROM workflow_domain_events event
      JOIN workflow_recovery_actions resumed_action
        ON resumed_action.project_id = event.project_id
       AND resumed_action.recovery_action_id = json_extract(event.payload_json, '$.recoveryActionId')
      JOIN workflow_work_checkpoints checkpoint
        ON checkpoint.project_id = event.project_id
       AND checkpoint.operation_id = event.operation_id
       AND checkpoint.checkpoint_id = json_extract(event.payload_json, '$.workCheckpointId')
       AND checkpoint.lifecycle_id = resumed_action.lifecycle_id
      WHERE event.event_type = 'task.recovery.resumed'
        AND event.entity_type = 'task'
        AND event.entity_id = :entity_id
        AND resumed_action.recovery_action_id = :recovery_action_id
        AND resumed_action.lifecycle_id = :lifecycle_id
        AND json_extract(event.payload_json, '$.lifecycleId') = :lifecycle_id
        AND json_extract(event.payload_json, '$.attemptId') = :attempt_id
        AND json_extract(event.payload_json, '$.resultId') = :result_id
      ORDER BY event.project_revision DESC
      LIMIT 1
    `).get({
      ":entity_id": taskEntity({
        milestoneId: task.milestoneId,
        sliceId: task.sliceId,
        taskId: task.taskId,
      }),
      ":lifecycle_id": lifecycleId,
      ":recovery_action_id": String(stored["recovery_action_id"]),
      ":attempt_id": attemptId,
      ":result_id": String(stored["result_id"]),
    }) as Record<string, unknown> | undefined;
    if (!resumed) throw new Error("Authorized Task recovery resume is missing its Work Checkpoint");
    checkpoint = resumed;
  }
  return {
    ...(resumeAuthorized
      ? { action: "continue" as const, resumeAuthorized: true as const }
      : { action: storedAction as PendingTaskRecoveryAction }),
    recoveryActionId: String(stored["recovery_action_id"]),
    attemptId,
    resultId: String(stored["result_id"]),
    failureKind: String(stored["failure_kind"]),
    summary: String(stored["summary"]),
    evidence: JSON.parse(String(stored["evidence_json"])) as DomainJsonValue,
    rationale: String(stored["rationale"]),
    replanCompleted: Number(stored["replan_completed"]) === 1,
    checkpoint: {
      checkpointId: String(checkpoint["checkpoint_id"]),
      confirmedContext: String(checkpoint["confirmed_context"]),
      unresolvedSummary: String(checkpoint["unresolved_summary"]),
      evidenceSummary: String(checkpoint["evidence_summary"]),
      suggestedNextAction: String(checkpoint["suggested_next_action"]),
    },
  };
}

function loadRoutedFailureScope(
  attemptId: string,
  resultId: string,
  requireCurrentHead = true,
): FailedAttemptScope {
  const scope = getDb().prepare(`
    SELECT lifecycle.lifecycle_id, lifecycle.milestone_id, lifecycle.slice_id,
           lifecycle.task_id, attempt.attempt_id, result.result_id,
           checkpoint.kernel_checkpoint_id,
           CASE WHEN result.outcome = 'succeeded' THEN 'verify' ELSE 'execute' END AS boundary_stage
    FROM workflow_execution_attempts attempt
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.project_id = attempt.project_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.lifecycle_id = lifecycle.lifecycle_id
     AND checkpoint.attempt_id = attempt.attempt_id
     AND checkpoint.project_id = lifecycle.project_id
    WHERE attempt.attempt_id = :attempt_id
      AND result.result_id = :result_id
      AND attempt.attempt_state = 'settled'
      AND (
        result.outcome IN ('failed', 'interrupted') OR
        (result.outcome = 'succeeded' AND ${CURRENT_EVIDENCE_BACKED_FAILURE_VERDICT_SQL})
      )
      AND checkpoint.next_stage = 'route'
      ${requireCurrentHead ? `AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
      )` : ""}
  `).get({ ":attempt_id": attemptId, ":result_id": resultId }) as Record<string, unknown> | undefined;
  if (!scope) throw new Error("Task recovery requires a current execute or verification failure route head");
  return {
    lifecycleId: String(scope["lifecycle_id"]),
    milestoneId: String(scope["milestone_id"]),
    sliceId: String(scope["slice_id"]),
    taskId: String(scope["task_id"]),
    attemptId: String(scope["attempt_id"]),
    resultId: String(scope["result_id"]),
    kernelCheckpointId: String(scope["kernel_checkpoint_id"]),
    boundaryStage: String(scope["boundary_stage"]) as "execute" | "verify",
  };
}

function requireRoutableResult(
  resultId: string,
  newOwner: RouteFailureInput["owner"],
  supersedesResolvedBlockerId?: string,
): void {
  const routed = getDb().prepare(`
    SELECT action.recovery_action_id, action.action, action.blocker_id,
           observation.recovery_owner, blocker.blocker_status
    FROM workflow_failure_observations observation
    LEFT JOIN workflow_recovery_actions action
      ON action.failure_observation_id = observation.failure_observation_id
    LEFT JOIN workflow_blockers blocker ON blocker.blocker_id = action.blocker_id
    WHERE observation.result_id = :result_id
    ORDER BY observation.project_revision DESC
    LIMIT 1
  `).get({ ":result_id": resultId }) as Record<string, unknown> | undefined;
  if (!routed) return;
  const supersedesResolvedBlocker = supersedesResolvedBlockerId &&
    newOwner === "agent" &&
    routed["blocker_id"] === supersedesResolvedBlockerId &&
    ["user", "external"].includes(String(routed["recovery_owner"])) &&
    ["clarify", "pause"].includes(String(routed["action"])) &&
    ["resolved", "dismissed"].includes(String(routed["blocker_status"]));
  if (!supersedesResolvedBlocker) {
    throw new Error("Task Result already has a recovery observation");
  }
}

function recoveryUseCounts(
  lifecycleId: string,
  failureKind: string,
  fingerprint: string,
  policyClass?: string,
): { budgetUses: number; replanUses: number } {
  const budgetUses = policyClass
    ? Number((getDb().prepare(`
        SELECT COUNT(*) AS count
        FROM workflow_recovery_actions action
        JOIN workflow_recovery_budgets budget
          ON budget.recovery_budget_id = action.recovery_budget_id
        WHERE budget.lifecycle_id = :lifecycle_id
          AND budget.failure_kind = :failure_kind
          AND budget.failure_fingerprint = :fingerprint
          AND budget.policy_class = :policy_class
      `).get({
        ":lifecycle_id": lifecycleId,
        ":failure_kind": failureKind,
        ":fingerprint": fingerprint,
        ":policy_class": policyClass,
      }) as Record<string, unknown> | undefined)?.["count"] ?? 0)
    : 0;
  const replanUses = Number((getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_recovery_actions action
    JOIN workflow_failure_observations observation
      ON observation.failure_observation_id = action.failure_observation_id
    WHERE observation.lifecycle_id = :lifecycle_id
      AND observation.failure_kind = :failure_kind
      AND observation.failure_fingerprint = :fingerprint
      AND action.action = 'replan'
  `).get({
    ":lifecycle_id": lifecycleId,
    ":failure_kind": failureKind,
    ":fingerprint": fingerprint,
  }) as Record<string, unknown> | undefined)?.["count"] ?? 0);
  return { budgetUses, replanUses };
}

function selectAgentDecision(
  input: Extract<RouteFailureInput, { owner: "agent" }>,
  scope: FailedAttemptScope,
  failureKind: string,
  fingerprint: string,
): RecoveryDecision {
  const preview = selectRecoveryDecision({
    owner: "agent",
    classification: input.classification,
    budgetUses: 0,
    replanUses: 0,
  });
  const counts = recoveryUseCounts(
    scope.lifecycleId,
    failureKind,
    fingerprint,
    preview.owner === "agent" ? preview.budget?.policyClass : undefined,
  );
  return selectRecoveryDecision({
    owner: "agent",
    classification: input.classification,
    ...counts,
  });
}

function loadTaskRecoveryReceipt(
  operation: DomainOperationResult,
): TaskRecoveryReceipt {
  const stored = getDb().prepare(`
    SELECT observation.lifecycle_id, observation.attempt_id, observation.result_id,
           observation.failure_observation_id, action.recovery_action_id,
           action.action, action.recovery_budget_id, action.blocker_id,
           checkpoint.checkpoint_id
    FROM workflow_recovery_actions action
    JOIN workflow_failure_observations observation
      ON observation.failure_observation_id = action.failure_observation_id
    LEFT JOIN workflow_work_checkpoints checkpoint
      ON checkpoint.operation_id = action.operation_id
     AND checkpoint.lifecycle_id = observation.lifecycle_id
    WHERE action.operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Task recovery receipt is missing its Observation or Action");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    lifecycleId: String(stored["lifecycle_id"]),
    attemptId: String(stored["attempt_id"]),
    resultId: String(stored["result_id"]),
    failureObservationId: String(stored["failure_observation_id"]),
    recoveryActionId: String(stored["recovery_action_id"]),
    action: String(stored["action"]) as RecoveryDecision["action"],
    ...(stored["recovery_budget_id"]
      ? { recoveryBudgetId: String(stored["recovery_budget_id"]) }
      : {}),
    ...(stored["blocker_id"] ? { blockerId: String(stored["blocker_id"]) } : {}),
    ...(stored["checkpoint_id"]
      ? { workCheckpointId: String(stored["checkpoint_id"]) }
      : {}),
    resumeAuthorized: isTaskRecoveryResumeAuthorized(String(stored["attempt_id"])),
  };
}

/**
 * Diagnose the durable guards for an abort or remediation resume without binding the caller
 * to the session that recorded the action. Guard order is intentional: callers
 * get the first actionable failure instead of one opaque SQL miss.
 */
export function readTaskRecoveryResumeEligibility(
  recoveryActionId: string,
): TaskRecoveryResumeEligibility {
  const normalizedId = requireNonBlank(recoveryActionId, "recoveryActionId");
  const stored = getDb().prepare(`
    SELECT action.action, action.blocker_id,
           observation.recovery_owner, observation.boundary_stage,
           observation.attempt_id, observation.result_id,
           attempt.attempt_state, attempt.attempt_number,
           result.outcome, lifecycle.lifecycle_status,
           CASE WHEN ${CURRENT_TASK_RECOVERY_CAUSAL_AUTHORITY_SQL} THEN 1 ELSE 0 END AS causal_authority,
           CASE WHEN attempt.attempt_number = (
             SELECT MAX(latest.attempt_number)
             FROM workflow_execution_attempts latest
             WHERE latest.project_id = attempt.project_id
               AND latest.lifecycle_id = attempt.lifecycle_id
           ) THEN 1 ELSE 0 END AS latest_attempt,
           CASE WHEN EXISTS (
             SELECT 1 FROM workflow_execution_attempts latest
             WHERE latest.project_id = attempt.project_id
               AND latest.lifecycle_id = attempt.lifecycle_id
               AND latest.attempt_state = 'settled'
               AND latest.settle_outcome = 'succeeded'
               AND latest.attempt_number > attempt.attempt_number
               AND NOT EXISTS (
                 SELECT 1 FROM workflow_execution_attempts newer
                 WHERE newer.project_id = latest.project_id
                   AND newer.lifecycle_id = latest.lifecycle_id
                   AND newer.attempt_number > latest.attempt_number
               )
           ) THEN 1 ELSE 0 END AS latest_attempt_succeeded,
           CASE WHEN EXISTS (
             SELECT 1 FROM workflow_blockers blocker
             WHERE blocker.project_id = action.project_id
               AND blocker.lifecycle_id = action.lifecycle_id
               AND blocker.blocker_status = 'open'
           ) THEN 1 ELSE 0 END AS has_open_blockers,
           CASE WHEN EXISTS (
             SELECT 1 FROM workflow_kernel_checkpoints kernel
             WHERE kernel.project_id = attempt.project_id
               AND kernel.lifecycle_id = attempt.lifecycle_id
               AND kernel.attempt_id = attempt.attempt_id
               AND kernel.next_stage = 'route'
               AND NOT EXISTS (
                 SELECT 1 FROM workflow_kernel_checkpoints successor
                 WHERE successor.previous_kernel_checkpoint_id = kernel.kernel_checkpoint_id
               )
           ) THEN 1 ELSE 0 END AS has_route_head,
           CASE WHEN EXISTS (
             SELECT 1 FROM workflow_domain_events resumed
             WHERE resumed.project_id = action.project_id
               AND resumed.event_type = 'task.recovery.resumed'
               AND json_extract(resumed.payload_json, '$.recoveryActionId') = action.recovery_action_id
           ) THEN 1 ELSE 0 END AS already_resumed
    FROM workflow_recovery_actions action
    JOIN workflow_failure_observations observation
      ON observation.project_id = action.project_id
     AND observation.lifecycle_id = action.lifecycle_id
     AND observation.failure_observation_id = action.failure_observation_id
    JOIN workflow_execution_attempts attempt
      ON attempt.project_id = observation.project_id
     AND attempt.lifecycle_id = observation.lifecycle_id
     AND attempt.attempt_id = observation.attempt_id
    JOIN workflow_attempt_results result
      ON result.project_id = observation.project_id
     AND result.lifecycle_id = observation.lifecycle_id
     AND result.attempt_id = observation.attempt_id
     AND result.result_id = observation.result_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = attempt.project_id
     AND lifecycle.lifecycle_id = attempt.lifecycle_id
    WHERE action.recovery_action_id = :recovery_action_id
  `).get({ ":recovery_action_id": normalizedId }) as Record<string, unknown> | undefined;
  if (!stored) {
    return {
      recoveryActionId: normalizedId,
      eligible: false,
      failedGuard: "recovery-action-exists",
      detail: "no Recovery Action exists with this recoveryActionId",
    };
  }

  const base = {
    recoveryActionId: normalizedId,
    attemptId: String(stored["attempt_id"]),
    resultId: String(stored["result_id"]),
  };
  const reject = (failedGuard: TaskRecoveryResumeGuard, detail: string): TaskRecoveryResumeEligibility => ({
    ...base,
    eligible: false,
    failedGuard,
    detail,
  });
  const resumableAction = stored["action"] === "abort" || stored["action"] === "remediate";
  if (!resumableAction) {
    return reject(
      "abort-action",
      `Recovery Action is ${String(stored["action"])}, not abort or remediate`,
    );
  }
  if (stored["recovery_owner"] !== "agent") return reject("agent-owned", `recovery owner is ${String(stored["recovery_owner"])}, not agent`);
  if (stored["blocker_id"] !== null) return reject("action-blocker", "Recovery Action is linked to a Blocker");
  if (Number(stored["already_resumed"]) === 1) return reject("already-resumed", "Recovery Action was already resumed");
  if (stored["lifecycle_status"] !== "in_progress" && stored["lifecycle_status"] !== "ready") {
    return reject("lifecycle-in-progress", `Task lifecycle is ${String(stored["lifecycle_status"])}`);
  }
  if (stored["attempt_state"] !== "settled") return reject("attempt-settled", `Attempt state is ${String(stored["attempt_state"])}`);
  if (Number(stored["causal_authority"]) !== 1) return reject("causal-authority", "Result no longer owns the current execute/verify failure route");
  // #1754 residual databases can contain a settled successful successor that
  // predates the still-current abort route. Let that durable route be resumed
  // once; ordinary stale or already-consumed actions still fail this guard.
  const supersededResidual = stored["action"] === "abort"
    && Number(stored["latest_attempt_succeeded"]) === 1
    && Number(stored["already_resumed"]) !== 1;
  if (Number(stored["latest_attempt"]) !== 1 && !supersededResidual) return reject("latest-attempt", "a newer Task Attempt exists");
  if (Number(stored["has_open_blockers"]) === 1) return reject("open-blockers", "Task lifecycle has an open Blocker");
  if (Number(stored["has_route_head"]) !== 1 && !supersededResidual) return reject("route-head", "Attempt no longer owns the current route Kernel checkpoint");
  return { ...base, eligible: true };
}

function requireResumableRecoveryScope(recoveryActionId: string): FailedAttemptScope {
  const eligibility = readTaskRecoveryResumeEligibility(recoveryActionId);
  if (!eligibility.eligible || !eligibility.attemptId || !eligibility.resultId) {
    throw new Error(
      `Task recovery resume rejected by ${eligibility.failedGuard ?? "unknown"} guard: ${eligibility.detail ?? "not eligible"}`,
    );
  }
  return loadRoutedFailureScope(
    eligibility.attemptId,
    eligibility.resultId,
    false,
  );
}

function loadTaskRecoveryResumeReceipt(
  operation: DomainOperationResult,
): TaskRecoveryResumeReceipt {
  const stored = getDb().prepare(`
    SELECT event.payload_json, checkpoint.checkpoint_id
    FROM workflow_domain_events event
    JOIN workflow_work_checkpoints checkpoint
      ON checkpoint.project_id = event.project_id
     AND checkpoint.operation_id = event.operation_id
    WHERE event.operation_id = :operation_id
      AND event.event_type = 'task.recovery.resumed'
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Task recovery resume receipt is missing its event or Work Checkpoint");
  const payload = JSON.parse(String(stored["payload_json"])) as Record<string, unknown>;
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    lifecycleId: String(payload["lifecycleId"]),
    attemptId: String(payload["attemptId"]),
    resultId: String(payload["resultId"]),
    recoveryActionId: String(payload["recoveryActionId"]),
    workCheckpointId: String(stored["checkpoint_id"]),
  };
}

export function resumeTaskRecovery(input: {
  invocation: ExecutionInvocation;
  recoveryActionId: string;
  repairSummary: string;
  evidence: DomainJsonValue;
}): TaskRecoveryResumeReceipt {
  const recoveryActionId = requireNonBlank(input.recoveryActionId, "recoveryActionId");
  const repairSummary = requireNonBlank(input.repairSummary, "repairSummary");
  const evidence = requireRepairEvidence(input.evidence);
  const operation = executeDomainOperation(operationRequest(
    "task.recovery.resume",
    input.invocation,
    { recoveryActionId, repairSummary, evidence },
  ), (context) => {
    const scope = requireResumableRecoveryScope(recoveryActionId);
    const checkpoint = appendRecoveryWorkCheckpoint(context, {
      lifecycleId: scope.lifecycleId,
      scopeKey: checkpointScope(scope),
      checkpointKind: "correction",
      confirmedContext: repairSummary,
      unresolvedSummary: "",
      evidenceSummary: canonicalDomainJson(evidence),
      suggestedNextAction: "Claim one new Task Attempt using the recorded repair evidence.",
    });
    return mutation("task.recovery.resumed", taskEntity(scope), {
      lifecycleId: scope.lifecycleId,
      attemptId: scope.attemptId,
      resultId: scope.resultId,
      recoveryActionId,
      repairSummary,
      evidence,
      workCheckpointId: checkpoint.checkpointId,
    });
  });
  return loadTaskRecoveryResumeReceipt(operation);
}

export function readTaskRecoveryRoute(attemptId: string): TaskRecoveryRouteSnapshot | null {
  const stored = getDb().prepare(`
    SELECT action.recovery_action_id, action.action,
           observation.recovery_owner, observation.failure_kind,
           blocker.blocker_id, blocker.blocker_kind, blocker.blocker_status,
           blocker.resolution_owner, blocker.resolution,
           blocker.resolved_operation_id, blocker.resolved_project_revision
    FROM workflow_failure_observations observation
    JOIN workflow_recovery_actions action
      ON action.failure_observation_id = observation.failure_observation_id
     AND action.project_id = observation.project_id
    LEFT JOIN workflow_blockers blocker
      ON blocker.blocker_id = action.blocker_id
     AND blocker.project_id = action.project_id
     AND blocker.lifecycle_id = action.lifecycle_id
    WHERE observation.attempt_id = :attempt_id
    ORDER BY action.project_revision DESC
    LIMIT 1
  `).get({ ":attempt_id": attemptId }) as Record<string, unknown> | undefined;
  if (!stored) return null;
  const blocker = stored["blocker_id"] ? taskRecoveryBlockerSnapshot(stored) : null;
  const recoveryActionId = String(stored["recovery_action_id"]);
  const resumableAction = stored["action"] === "abort" || stored["action"] === "remediate";
  const resumeEligibility = resumableAction
    ? readTaskRecoveryResumeEligibility(recoveryActionId)
    : undefined;
  return {
    recoveryActionId,
    action: String(stored["action"]) as RecoveryDecision["action"],
    recoveryOwner: String(stored["recovery_owner"]) as TaskRecoveryRouteSnapshot["recoveryOwner"],
    failureKind: String(stored["failure_kind"]),
    blocker,
    resumeAuthorized: resumableAction && isTaskRecoveryResumeAuthorized(attemptId),
    ...(resumeEligibility ? { resumeEligibility } : {}),
  };
}

/** Every Attempt that ever committed a recovery action for this Task, newest first. */
export function readTaskRecoveryAttemptIds(
  task: {
    milestoneId: string;
    sliceId: string;
    taskId: string;
  },
  options?: { projectId?: string },
): string[] {
  // #2778: identity columns alone can match a foreign project's imported row;
  // callers that hold the project scope (e.g. the shadow-snapshot reader) pass it here.
  const projectId = options?.projectId ?? null;
  const rows = getDb().prepare(`
    SELECT observation.attempt_id, MAX(action.project_revision) AS latest_project_revision
    FROM workflow_failure_observations observation
    JOIN workflow_recovery_actions action
      ON action.failure_observation_id = observation.failure_observation_id
     AND action.lifecycle_id = observation.lifecycle_id
     AND action.project_id = observation.project_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = observation.lifecycle_id
     AND lifecycle.project_id = observation.project_id
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND (:project_id IS NULL OR lifecycle.project_id = :project_id)
      AND observation.attempt_id IS NOT NULL
    GROUP BY observation.attempt_id
    ORDER BY latest_project_revision DESC
  `).all({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
    ":project_id": projectId,
  }) as Array<Record<string, unknown>>;
  return rows.map((row) => String(row["attempt_id"]));
}

export function readCurrentTaskRecoveryRoute(task: {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}): (TaskRecoveryRouteSnapshot & { attemptId: string }) | null {
  const attempt = readLatestTaskAttempt(task);
  if (!attempt) return null;
  const route = readTaskRecoveryRoute(attempt.attemptId);
  return route ? { attemptId: attempt.attemptId, ...route } : null;
}

export function readTaskRecoveryBlocker(attemptId: string): TaskRecoveryBlockerSnapshot | null {
  return readTaskRecoveryRoute(attemptId)?.blocker ?? null;
}

export function readResolvedTaskHumanReviewBlocker(
  attemptId: string,
): TaskRecoveryBlockerSnapshot | null {
  const stored = getDb().prepare(`
    SELECT blocker.blocker_id, blocker.blocker_kind, blocker.blocker_status,
           blocker.resolution_owner, blocker.resolution,
           blocker.resolved_operation_id, blocker.resolved_project_revision,
           action.action
    FROM workflow_failure_observations observation
    JOIN workflow_recovery_actions action
      ON action.failure_observation_id = observation.failure_observation_id
     AND action.project_id = observation.project_id
    JOIN workflow_blockers blocker
      ON blocker.blocker_id = action.blocker_id
     AND blocker.project_id = action.project_id
     AND blocker.lifecycle_id = action.lifecycle_id
    WHERE observation.attempt_id = :attempt_id
      AND blocker.blocker_kind = 'subjective_uat'
      AND blocker.blocker_status = 'resolved'
    ORDER BY action.project_revision DESC
    LIMIT 1
  `).get({ ":attempt_id": attemptId }) as Record<string, unknown> | undefined;
  if (!stored) return null;
  return taskRecoveryBlockerSnapshot(stored);
}

export function recordFailureAndSelectRecovery(
  input: RouteFailureInput,
): TaskRecoveryReceipt {
  const operation = executeDomainOperation(operationRequest(
    "attempt.route",
    input.invocation,
    {
      attemptId: input.attemptId,
      resultId: input.resultId,
      owner: input.owner,
      classification: input.classification,
      summary: input.summary,
      evidence: input.evidence,
      rationale: input.rationale,
      targetLifecycleId: input.targetLifecycleId ?? null,
      supersedesResolvedBlockerId: input.supersedesResolvedBlockerId ?? null,
      ...(input.owner === "agent" ? {} : { blocker: input.blocker }),
    },
  ), (context) => {
    const scope = loadRoutedFailureScope(input.attemptId, input.resultId);
    requireRoutableResult(input.resultId, input.owner, input.supersedesResolvedBlockerId);
    const failureKind = input.classification.failureKind.trim().toLowerCase();
    const fingerprint = normalizeFailureFingerprint(input.classification);
    const decision = input.owner === "agent"
      ? selectAgentDecision(input, scope, failureKind, fingerprint)
      : selectRecoveryDecision({ owner: input.owner, blockerKind: input.blocker.blockerKind });

    let blockerId: string | undefined;
    if (input.owner !== "agent") {
      blockerId = openRecoveryBlocker(context, {
        lifecycleId: scope.lifecycleId,
        attemptId: scope.attemptId,
        kernelCheckpointId: scope.kernelCheckpointId,
        blockerKind: input.blocker.blockerKind,
        resolutionOwner: input.owner,
        description: input.blocker.description,
        requestedAction: input.blocker.requestedAction,
      }).blockerId;
    }
    const observation = recordFailureObservation(context, {
      lifecycleId: scope.lifecycleId,
      attemptId: scope.attemptId,
      resultId: scope.resultId,
      boundaryStage: scope.boundaryStage,
      kernelCheckpointId: scope.kernelCheckpointId,
      ...(blockerId ? { blockerId } : {}),
      recoveryOwner: decision.owner,
      failureKind,
      failureFingerprint: fingerprint,
      summary: input.summary,
      evidence: input.evidence,
    });
    const budget = decision.owner === "agent" && decision.budget
      ? createOrReadRecoveryBudget(context, {
          lifecycleId: scope.lifecycleId,
          failureKind,
          failureFingerprint: fingerprint,
          policyClass: decision.budget.policyClass,
          maxUses: decision.budget.maxUses,
          policyVersion: decision.policyVersion,
        })
      : undefined;
    const targetLifecycleId = decision.owner === "agent" &&
        ["retry", "repair", "replan", "remediate"].includes(decision.action)
      ? input.targetLifecycleId ?? scope.lifecycleId
      : undefined;
    const action = recordRecoveryAction(context, {
      lifecycleId: scope.lifecycleId,
      failureObservationId: observation.failureObservationId,
      action: decision.action,
      ...(budget ? { recoveryBudgetId: budget.recoveryBudgetId } : {}),
      ...(targetLifecycleId ? { targetLifecycleId } : {}),
      ...(blockerId ? { blockerId } : {}),
      rationale: input.rationale,
      policyVersion: decision.policyVersion,
    });
    let workCheckpointId: string;
    if (decision.owner === "agent") {
      workCheckpointId = appendRecoveryWorkCheckpoint(context, {
        lifecycleId: scope.lifecycleId,
        scopeKey: checkpointScope(scope),
        checkpointKind: "correction",
        confirmedContext: input.summary,
        unresolvedSummary: failureKind,
        evidenceSummary: canonicalDomainJson(input.evidence),
        suggestedNextAction: suggestedAgentRecoveryAction(decision.action),
      }).checkpointId;
    } else {
      const humanInput = input as Extract<RouteFailureInput, { owner: "user" | "external" }>;
      workCheckpointId = appendRecoveryWorkCheckpoint(context, {
        lifecycleId: scope.lifecycleId,
        scopeKey: checkpointScope(scope),
        checkpointKind: "pause",
        confirmedContext: input.summary,
        unresolvedSummary: humanInput.blocker.description,
        evidenceSummary: input.rationale,
        suggestedNextAction: humanInput.blocker.requestedAction,
      }).checkpointId;
    }
    return mutation("task.recovery.routed", taskEntity(scope), {
      attemptId: scope.attemptId,
      resultId: scope.resultId,
      failureObservationId: observation.failureObservationId,
      recoveryActionId: action.recoveryActionId,
      action: decision.action,
      workCheckpointId,
    });
  });
  return loadTaskRecoveryReceipt(operation);
}

function loadTaskIdentity(lifecycleId: string): TaskScope {
  const lifecycle = getDb().prepare(`
    SELECT lifecycle_id, milestone_id, slice_id, task_id
    FROM workflow_item_lifecycles
    WHERE lifecycle_id = :lifecycle_id AND item_kind = 'task'
  `).get({ ":lifecycle_id": lifecycleId }) as Record<string, unknown> | undefined;
  if (!lifecycle) throw new Error("Task lifecycle is missing");
  return {
    lifecycleId: String(lifecycle["lifecycle_id"]),
    milestoneId: String(lifecycle["milestone_id"]),
    sliceId: String(lifecycle["slice_id"]),
    taskId: String(lifecycle["task_id"]),
  };
}

export function resolveTaskBlocker(input: {
  invocation: ExecutionInvocation;
  blockerId: string;
  disposition: "resolved" | "dismissed";
  resolution: string;
  checkpoint: Omit<AppendRecoveryWorkCheckpointInput, "lifecycleId" | "scopeKey">;
}): BlockerResolutionReceipt {
  const operation = executeDomainOperation(operationRequest(
    "task.blocker.resolve",
    input.invocation,
    {
      blockerId: input.blockerId,
      disposition: input.disposition,
      resolution: input.resolution,
      checkpoint: input.checkpoint,
    },
  ), (context) => {
    const blocker = getDb().prepare(`
      SELECT lifecycle_id, resolution_owner FROM workflow_blockers
      WHERE blocker_id = :blocker_id AND blocker_status = 'open'
    `).get({ ":blocker_id": input.blockerId }) as Record<string, unknown> | undefined;
    if (!blocker) throw new Error("Recovery Blocker must be the current open Blocker");
    if (input.invocation.actorType !== blocker["resolution_owner"]) {
      throw new Error("Recovery Blocker may only be closed by its resolution owner");
    }
    const scope = loadTaskIdentity(String(blocker["lifecycle_id"]));
    resolveRecoveryBlocker(context, {
      blockerId: input.blockerId,
      disposition: input.disposition,
      resolution: input.resolution,
    });
    appendRecoveryWorkCheckpoint(context, {
      ...input.checkpoint,
      lifecycleId: scope.lifecycleId,
      scopeKey: checkpointScope(scope),
    });
    return mutation("task.blocker.resolved", taskEntity(scope), {
      blockerId: input.blockerId,
      disposition: input.disposition,
    });
  });
  const stored = getDb().prepare(`
    SELECT blocker.blocker_id, blocker.blocker_status, checkpoint.checkpoint_id
    FROM workflow_blockers blocker
    JOIN workflow_work_checkpoints checkpoint
      ON checkpoint.operation_id = blocker.resolved_operation_id
     AND checkpoint.lifecycle_id = blocker.lifecycle_id
    WHERE blocker.resolved_operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Blocker resolution receipt is incomplete");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    blockerId: String(stored["blocker_id"]),
    blockerStatus: String(stored["blocker_status"]) as "resolved" | "dismissed",
    workCheckpointId: String(stored["checkpoint_id"]),
  };
}

export function grantTaskWaiver(
  input: { invocation: ExecutionInvocation } & GrantRecoveryWaiverInput,
): WaiverReceipt {
  const { invocation, ...waiver } = input;
  if (waiver.grantedByActorType === "user" &&
      (invocation.actorType !== "user" || invocation.actorId !== waiver.grantedByActorId)) {
    throw new Error("A user-granted Waiver requires the matching user invocation identity");
  }
  if (waiver.grantedByActorType === "policy" &&
      invocation.actorType !== "agent" && invocation.actorType !== "policy") {
    throw new Error("A policy-granted Waiver requires an agent or policy invocation");
  }
  const operation = executeDomainOperation(operationRequest(
    "task.waiver.grant",
    invocation,
    waiver as unknown as DomainJsonValue,
  ), (context) => {
    const stored = grantRecoveryWaiver(context, waiver);
    const scope = loadTaskIdentity(waiver.lifecycleId);
    return mutation("task.waiver.granted", taskEntity(scope), { waiverId: stored.waiverId });
  });
  const stored = getDb().prepare(`
    SELECT waiver_id, waiver_status FROM workflow_waivers
    WHERE operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Waiver grant receipt is missing");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    waiverId: String(stored["waiver_id"]),
    waiverStatus: "active",
  };
}

export function recordTaskRequirementDisposition(
  input: { invocation: ExecutionInvocation } & RecordRequirementDispositionInput,
): RequirementDispositionReceipt {
  const { invocation, ...disposition } = input;
  const operation = executeDomainOperation(operationRequest(
    "task.disposition.record",
    invocation,
    disposition as unknown as DomainJsonValue,
  ), (context) => {
    const stored = recordRequirementDisposition(context, disposition);
    return mutation("task.requirement.disposition.recorded", disposition.requirementId, {
      dispositionId: stored.dispositionId,
      disposition: stored.disposition,
    });
  });
  const stored = getDb().prepare(`
    SELECT disposition_id, disposition
    FROM workflow_requirement_dispositions
    WHERE operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Requirement Disposition receipt is missing");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    dispositionId: String(stored["disposition_id"]),
    disposition: String(stored["disposition"]) as RequirementDispositionReceipt["disposition"],
  };
}

export function terminateTaskWaiver(input: {
  invocation: ExecutionInvocation;
  waiverId: string;
  requirementId: string;
  disposition: "revoked" | "expired";
  successorDisposition: "unsatisfied" | "satisfied";
  supersedesDispositionId: string;
  rationale: string;
}): WaiverReceipt {
  const operation = executeDomainOperation(operationRequest(
    "task.waiver.terminate",
    input.invocation,
    {
      waiverId: input.waiverId,
      requirementId: input.requirementId,
      disposition: input.disposition,
      successorDisposition: input.successorDisposition,
      supersedesDispositionId: input.supersedesDispositionId,
      rationale: input.rationale,
    },
  ), (context) => {
    const currentWaivedHead = getDb().prepare(`
      SELECT disposition.disposition_id
      FROM workflow_waivers waiver
      JOIN workflow_requirement_dispositions disposition
        ON disposition.waiver_id = waiver.waiver_id
       AND disposition.requirement_id = waiver.requirement_id
      WHERE waiver.waiver_id = :waiver_id
        AND waiver.requirement_id = :requirement_id
        AND waiver.waiver_status = 'active'
        AND disposition.disposition_id = :disposition_id
        AND disposition.disposition = 'waived'
        AND NOT EXISTS (
          SELECT 1 FROM workflow_requirement_dispositions successor
          WHERE successor.supersedes_disposition_id = disposition.disposition_id
        )
    `).get({
      ":waiver_id": input.waiverId,
      ":requirement_id": input.requirementId,
      ":disposition_id": input.supersedesDispositionId,
    });
    if (!currentWaivedHead) {
      throw new Error("Waiver termination requires its matching current waived disposition head");
    }
    const successor = recordRequirementDisposition(context, {
      requirementId: input.requirementId,
      disposition: input.successorDisposition,
      supersedesDispositionId: input.supersedesDispositionId,
      rationale: input.rationale,
    });
    terminateRecoveryWaiver(context, {
      waiverId: input.waiverId,
      disposition: input.disposition,
    });
    return mutation("task.waiver.terminated", input.requirementId, {
      waiverId: input.waiverId,
      dispositionId: successor.dispositionId,
      status: input.disposition,
    });
  });
  const stored = getDb().prepare(`
    SELECT waiver.waiver_id, waiver.waiver_status, disposition.disposition_id
    FROM workflow_waivers waiver
    JOIN workflow_requirement_dispositions disposition
      ON disposition.operation_id = waiver.ended_operation_id
     AND disposition.requirement_id = waiver.requirement_id
    WHERE waiver.ended_operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Waiver termination receipt is incomplete");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    waiverId: String(stored["waiver_id"]),
    waiverStatus: String(stored["waiver_status"]) as "revoked" | "expired",
    dispositionId: String(stored["disposition_id"]),
  };
}

export function appendTaskWorkCheckpoint(input: {
  invocation: ExecutionInvocation;
  lifecycleId: string;
} & Omit<AppendRecoveryWorkCheckpointInput, "lifecycleId" | "scopeKey">): WorkCheckpointReceipt {
  const { invocation, lifecycleId, ...checkpoint } = input;
  const operation = executeDomainOperation(operationRequest(
    "task.checkpoint.append",
    invocation,
    { lifecycleId, ...checkpoint } as unknown as DomainJsonValue,
  ), (context) => {
    const scope = loadTaskIdentity(lifecycleId);
    const stored = appendRecoveryWorkCheckpoint(context, {
      ...checkpoint,
      lifecycleId,
      scopeKey: checkpointScope(scope),
    });
    return mutation("task.checkpoint.appended", taskEntity(scope), {
      checkpointId: stored.checkpointId,
      sequence: stored.sequence,
    });
  });
  const stored = getDb().prepare(`
    SELECT checkpoint_id, sequence FROM workflow_work_checkpoints
    WHERE operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Work Checkpoint receipt is missing");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    workCheckpointId: String(stored["checkpoint_id"]),
    sequence: Number(stored["sequence"]),
  };
}
