// Project/App: gsd-pi
// File Purpose: Replay-safe Task reopen and cancellation Domain Operations.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationContext,
  type DomainOperationMutation,
  type DomainOperationRequest,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { TASK_LIFECYCLE_PROJECTION_KIND } from "./projection-identity.js";
import { normalizeLegacyLifecycleStatus } from "./db/lifecycle-shadow-comparison.js";
import {
  adoptOrTransitionLifecycle,
  appendKernelCheckpoint,
  grantCancellationWaiver,
  readDomainOperationFence,
  readLifecycleShadowComparison,
  revokeActiveWaivers,
  settleAttemptWithResult,
  type CanonicalLifecycleStatus,
  type LifecycleShadowRecord,
} from "./db/writers/lifecycle-commands.js";
import {
  appendRecoveryWorkCheckpoint,
  cancelLegacyTaskState,
  currentDispositionHead,
  recordRequirementDisposition,
  reopenLegacyTaskState,
} from "./db/writers/task-recovery.js";
import { terminalizeTaskExecutionDispatch } from "./db/writers/task-execution.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { ensurePendingSliceQ8, removeInvalidatedRows } from "./db/writers/slice-companion-state.js";
import { deleteVerificationEvidence } from "./gsd-db.js";
import { recordTaskRequirementDisposition } from "./task-recovery-domain-operation.js";
import {
  TASK_SOURCE_COMMIT_EFFECT,
  readLifecycleCloseoutPlan,
} from "./db/writers/closeout.js";

export interface TaskLifecycleIdentity {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

export interface TaskLifecycleReceipt {
  status: DomainOperationResult["status"];
  operationId: string;
  resultingRevision: number;
  lifecycleId: string;
  workCheckpointId: string;
  canonicalStatus: "ready" | "cancelled";
  legacyStatus: "pending" | "skipped";
  interruptedAttemptId?: string;
  resultId?: string;
  kernelCheckpointId?: string;
}

interface TaskState extends TaskLifecycleIdentity {
  milestoneStatus: string;
  sliceStatus: string;
  legacyStatus: string;
  lifecycleId: string | null;
  lifecycleStatus: CanonicalLifecycleStatus | null;
}

interface RunningAttempt {
  attemptId: string;
  kernelCheckpointId: string;
  dispatchId: number;
  workerId: string;
  milestoneLeaseToken: number;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be blank`);
  return normalized;
}

function operationRequest(
  operationType: "task.reopen" | "task.cancel",
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

function taskEntity(task: TaskLifecycleIdentity): string {
  return `${task.milestoneId}/${task.sliceId}/${task.taskId}`;
}

function taskPayload(task: TaskLifecycleIdentity): DomainJsonValue {
  return {
    milestoneId: task.milestoneId,
    sliceId: task.sliceId,
    taskId: task.taskId,
  };
}

function shadowPayload(shadow: LifecycleShadowRecord): DomainJsonValue {
  return {
    itemKind: shadow.itemKind,
    milestoneId: shadow.milestoneId,
    sliceId: shadow.sliceId ?? null,
    taskId: shadow.taskId ?? null,
    kind: shadow.kind,
    legacyStatus: shadow.legacyStatus,
    canonicalStatus: shadow.canonicalStatus,
    normalizedLegacyStatus: shadow.normalizedLegacyStatus,
    normalizedCanonicalStatus: shadow.normalizedCanonicalStatus,
  };
}

function checkpointScope(task: TaskLifecycleIdentity): string {
  return `task:${taskEntity(task)}`.toLowerCase();
}

// The canonical cancellation scope: slice closeout, milestone closeout and
// milestone reopen all resolve "<M>/<S>/<T> cancellation".
function taskCancellationWaiverScope(task: TaskLifecycleIdentity): string {
  return `${taskEntity(task)} cancellation`;
}

/**
 * Record why a cancelled Task no longer needs to run (no runtime "skipped"
 * outcome). cancelTask follows up with the 'waived' requirement disposition
 * that closeout requires; the schema forbids it in the Waiver's own operation.
 */
function grantTaskCancellationWaiver(
  context: Readonly<DomainOperationContext>,
  invocation: ExecutionInvocation,
  lifecycleId: string,
  task: TaskLifecycleIdentity,
  rationale: string,
): string {
  const actorType = invocation.actorType === "user" ? "user" : "policy";
  const actorId = invocation.actorId?.trim() || null;
  if (actorType === "user" && !actorId) {
    throw new Error("A user-authorized Task cancellation requires actor identity");
  }
  const requirementId = `task-cancellation:${taskEntity(task)}`;
  return grantCancellationWaiver(context, {
    lifecycleId,
    scope: taskCancellationWaiverScope(task),
    rationale,
    grantedByActorType: actorType,
    grantedByActorId: actorId,
    requirement: {
      id: requirementId,
      description: `Cancellation of task ${taskEntity(task)} authorized by task.cancel`,
      source: "task-cancel",
    },
  });
}

function revokeTaskCancellationWaivers(
  context: Readonly<DomainOperationContext>,
  lifecycleId: string,
  task: TaskLifecycleIdentity,
  reason: string,
): void {
  // The schema requires a revoked Waiver's current 'waived' disposition to be
  // superseded in the same operation.
  const dispositions = getDb().prepare(`
    SELECT disposition.requirement_id, disposition.disposition_id
    FROM workflow_waivers waiver
    JOIN workflow_requirement_dispositions disposition
      ON disposition.waiver_id = waiver.waiver_id
     AND disposition.requirement_id = waiver.requirement_id
     AND disposition.disposition = 'waived'
    WHERE waiver.lifecycle_id = :lifecycle_id AND waiver.scope = :scope
      AND waiver.waiver_status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_requirement_dispositions successor
        WHERE successor.supersedes_disposition_id = disposition.disposition_id
      )
  `).all({
    ":lifecycle_id": lifecycleId,
    ":scope": taskCancellationWaiverScope(task),
  }) as Array<Record<string, unknown>>;
  for (const disposition of dispositions) {
    recordRequirementDisposition(context, {
      requirementId: String(disposition["requirement_id"]),
      disposition: "unsatisfied",
      supersedesDispositionId: String(disposition["disposition_id"]),
      rationale: `Task ${taskEntity(task)} reopened: ${reason}`,
    });
  }
  revokeActiveWaivers(context, lifecycleId, taskCancellationWaiverScope(task));
}

function mutation(
  eventType: string,
  task: TaskLifecycleIdentity,
  payload: DomainJsonValue,
): DomainOperationMutation {
  const entityId = taskEntity(task);
  return {
    events: [{
      eventType,
      entityType: "task",
      entityId,
      payload,
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: `lifecycle/${entityId}`.toLowerCase(),
      projectionKind: TASK_LIFECYCLE_PROJECTION_KIND,
      rendererVersion: "1",
    }],
  };
}

function loadTaskState(task: TaskLifecycleIdentity): TaskState {
  const milestoneId = requireText(task.milestoneId, "milestoneId");
  const sliceId = requireText(task.sliceId, "sliceId");
  const taskId = requireText(task.taskId, "taskId");
  if (!getDb().prepare(`SELECT 1 FROM milestones WHERE id = :milestone_id`).get({ ":milestone_id": milestoneId })) {
    throw new Error(`milestone not found: ${milestoneId}`);
  }
  if (!getDb().prepare(`
    SELECT 1 FROM slices WHERE milestone_id = :milestone_id AND id = :slice_id
  `).get({ ":milestone_id": milestoneId, ":slice_id": sliceId })) {
    throw new Error(`slice not found: ${milestoneId}/${sliceId}`);
  }
  const state = getDb().prepare(`
    SELECT milestone.status AS milestone_status,
           slice.status AS slice_status,
           task.status AS task_status,
           lifecycle.lifecycle_id,
           lifecycle.lifecycle_status
    FROM tasks task
    JOIN slices slice
      ON slice.milestone_id = task.milestone_id
     AND slice.id = task.slice_id
    JOIN milestones milestone ON milestone.id = task.milestone_id
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task'
     AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id
     AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id
      AND task.slice_id = :slice_id
      AND task.id = :task_id
  `).get({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
  }) as Record<string, unknown> | undefined;
  if (!state) throw new Error(`task not found: ${taskEntity(task)}`);
  return {
    ...task,
    milestoneStatus: String(state["milestone_status"]),
    sliceStatus: String(state["slice_status"]),
    legacyStatus: String(state["task_status"]),
    lifecycleId: state["lifecycle_id"] ? String(state["lifecycle_id"]) : null,
    lifecycleStatus: state["lifecycle_status"]
      ? String(state["lifecycle_status"]) as CanonicalLifecycleStatus
      : null,
  };
}

function requireOpenParents(state: TaskState, action: "reopen" | "cancel"): void {
  const milestoneStatus = normalizeLegacyLifecycleStatus(state.milestoneStatus);
  if (!milestoneStatus) {
    throw new Error(`cannot ${action} task: milestone ${state.milestoneId} has unknown status ${state.milestoneStatus}`);
  }
  if (milestoneStatus === "completed" || milestoneStatus === "cancelled") {
    throw new Error(`cannot ${action} task in a closed milestone: ${state.milestoneId} (status: ${state.milestoneStatus})`);
  }
  const sliceStatus = normalizeLegacyLifecycleStatus(state.sliceStatus);
  if (!sliceStatus) {
    throw new Error(`cannot ${action} task: slice ${state.sliceId} has unknown status ${state.sliceStatus}`);
  }
  if (sliceStatus === "completed" || sliceStatus === "cancelled") {
    throw new Error(`cannot ${action} task in a closed slice: ${state.sliceId} (status: ${state.sliceStatus})`);
  }
  const terminalParent = getDb().prepare(`
    SELECT item_kind, lifecycle_status
    FROM workflow_item_lifecycles
    WHERE ((
      item_kind = 'milestone'
      AND milestone_id = :milestone_id
      AND slice_id IS NULL
    ) OR (
      item_kind = 'slice'
      AND milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND task_id IS NULL
    ))
      AND lifecycle_status IN ('completed', 'cancelled')
  `).get({ ":milestone_id": state.milestoneId, ":slice_id": state.sliceId });
  if (terminalParent) throw new Error("cannot mutate Task under a terminal canonical parent lifecycle");
}

function currentRunningAttempt(
  lifecycleId: string,
  options: { requireActiveLease?: boolean } = {},
): RunningAttempt | null {
  const requireActiveLease = options.requireActiveLease ?? true;
  const rows = getDb().prepare(`
    SELECT attempt.attempt_id, checkpoint.kernel_checkpoint_id,
           attempt.coordination_dispatch_id, attempt.worker_id,
           attempt.milestone_lease_token
    FROM workflow_execution_attempts attempt
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.lifecycle_id = attempt.lifecycle_id
     AND checkpoint.attempt_id = attempt.attempt_id
     AND checkpoint.project_id = attempt.project_id
    WHERE attempt.lifecycle_id = :lifecycle_id
      AND attempt.attempt_state = 'running'
      AND checkpoint.next_stage = 'execute'
      AND (
        :require_active_lease = 0
        OR EXISTS (
          SELECT 1
          FROM workflow_item_lifecycles lifecycle
          JOIN milestone_leases lease
            ON lease.milestone_id = lifecycle.milestone_id
           AND lease.worker_id = attempt.worker_id
           AND lease.fencing_token = attempt.milestone_lease_token
           AND lease.status = 'held'
           AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE lifecycle.lifecycle_id = attempt.lifecycle_id
            AND lifecycle.project_id = attempt.project_id
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
      )
  `).all({
    ":lifecycle_id": lifecycleId,
    ":require_active_lease": requireActiveLease ? 1 : 0,
  }) as Array<Record<string, unknown>>;
  if (rows.length > 1) throw new Error("Task lifecycle has multiple running Attempts");
  const attempt = rows[0];
  if (!attempt) return null;
  return {
    attemptId: String(attempt["attempt_id"]),
    kernelCheckpointId: String(attempt["kernel_checkpoint_id"]),
    dispatchId: Number(attempt["coordination_dispatch_id"]),
    workerId: String(attempt["worker_id"]),
    milestoneLeaseToken: Number(attempt["milestone_lease_token"]),
  };
}

function loadReceipt(
  operation: DomainOperationResult,
  canonicalStatus: TaskLifecycleReceipt["canonicalStatus"],
  legacyStatus: TaskLifecycleReceipt["legacyStatus"],
): TaskLifecycleReceipt {
  const storedRows = getDb().prepare(`
    SELECT checkpoint.checkpoint_id AS work_checkpoint_id,
           checkpoint.lifecycle_id,
           result.attempt_id, result.result_id,
           kernel.kernel_checkpoint_id
    FROM workflow_work_checkpoints checkpoint
    LEFT JOIN workflow_attempt_results result
      ON result.operation_id = checkpoint.operation_id
     AND result.lifecycle_id = checkpoint.lifecycle_id
    LEFT JOIN workflow_kernel_checkpoints kernel
      ON kernel.operation_id = checkpoint.operation_id
     AND kernel.lifecycle_id = checkpoint.lifecycle_id
     AND kernel.next_stage = 'route'
    WHERE checkpoint.operation_id = :operation_id
  `).all({ ":operation_id": operation.operationId }) as Array<Record<string, unknown>>;
  if (storedRows.length !== 1) {
    throw new Error("Task lifecycle receipt requires exactly one Work Checkpoint");
  }
  const stored = storedRows[0]!;
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    lifecycleId: String(stored["lifecycle_id"]),
    workCheckpointId: String(stored["work_checkpoint_id"]),
    canonicalStatus,
    legacyStatus,
    ...(stored["attempt_id"] ? { interruptedAttemptId: String(stored["attempt_id"]) } : {}),
    ...(stored["result_id"] ? { resultId: String(stored["result_id"]) } : {}),
    ...(stored["kernel_checkpoint_id"]
      ? { kernelCheckpointId: String(stored["kernel_checkpoint_id"]) }
      : {}),
  };
}

/**
 * A reopened lifecycle has no operative Attempt route head (#1948). A terminal
 * lifecycle can still carry a settled Attempt parked at `route` with an
 * agent-owned abort that was never resumed; reopen discards that lineage by
 * closing the Kernel head (`route -> closeout -> settled`) so the next claim is
 * a fresh Attempt and no guard advertises a resume the lifecycle can no longer
 * satisfy.
 *
 * ADR-050: the `closeout` and `settled` stages of a succeeded Attempt mean a
 * Closeout Plan settled — voiding such a head is refused while its
 * source-commit effect has no Settlement Receipt, because silently discarding
 * a publishable success would hide work. A dead lineage (an interrupted or
 * failed Attempt — the cancelled-then-reopened Task) has no closeout to lie
 * about and consumes its head as before.
 */
function voidStaleRouteHead(
  context: Readonly<DomainOperationContext>,
  lifecycleId: string,
): void {
  const head = getDb().prepare(`
    SELECT head.kernel_checkpoint_id, head.attempt_id, head.next_stage
    FROM workflow_kernel_checkpoints head
    WHERE head.project_id = :project_id AND head.lifecycle_id = :lifecycle_id
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = head.kernel_checkpoint_id
      )
  `).get({ ":project_id": context.projectId, ":lifecycle_id": lifecycleId }) as
    { kernel_checkpoint_id: string; attempt_id: string; next_stage: string } | undefined;
  if (head?.next_stage !== "route") return;
  const attemptOutcome = getDb().prepare(`
    SELECT result.outcome
    FROM workflow_execution_attempts attempt
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.project_id = attempt.project_id
     AND result.lifecycle_id = attempt.lifecycle_id
    WHERE attempt.attempt_id = :attempt_id
  `).get({ ":attempt_id": head.attempt_id }) as Record<string, unknown> | undefined;
  if (String(attemptOutcome?.["outcome"] ?? "") === "succeeded") {
    const plan = readLifecycleCloseoutPlan(context.projectId, lifecycleId);
    const commitEffect = plan?.effects
      .find((effect) => effect.effectKind === TASK_SOURCE_COMMIT_EFFECT);
    if (!commitEffect?.receipt) {
      throw new Error(
        "Task reopen cannot void a route head whose Attempt succeeded without the Settlement " +
        "Receipt of its Closeout Plan source commit; run `/gsd auto` to commit and publish the " +
        "Task instead of discarding the verified work.",
      );
    }
  }
  const closeout = appendKernelCheckpoint(context, {
    lifecycleId,
    attemptId: head.attempt_id,
    nextStage: "closeout",
    previousKernelCheckpointId: head.kernel_checkpoint_id,
  });
  appendKernelCheckpoint(context, {
    lifecycleId,
    attemptId: head.attempt_id,
    nextStage: "settled",
    previousKernelCheckpointId: closeout.kernelCheckpointId,
  });
}

export function reopenTask(input: {
  invocation: ExecutionInvocation;
  task: TaskLifecycleIdentity;
  reason: string;
  /**
   * The reason is a diagnosis for the executor: the next execute-task dispatch
   * shows it until a new Attempt is claimed (see reopen-reason.ts).
   */
  injectReason?: boolean;
}): TaskLifecycleReceipt {
  const reason = requireText(input.reason, "reason");
  const inject: { injectReason?: true } = input.injectReason === true ? { injectReason: true } : {};
  const operation = executeDomainOperation(operationRequest(
    "task.reopen",
    input.invocation,
    { task: taskPayload(input.task), reason, ...inject },
  ), (context) => {
    const state = loadTaskState(input.task);
    requireOpenParents(state, "reopen");
    const legacyStatus = normalizeLegacyLifecycleStatus(state.legacyStatus);
    if (legacyStatus !== "completed" && legacyStatus !== "cancelled") {
      throw new Error(`task ${state.taskId} is not complete (status: ${state.legacyStatus}) — nothing to reopen`);
    }
    if (state.lifecycleStatus && state.lifecycleStatus !== legacyStatus) {
      throw new Error("Task reopen requires matching terminal legacy and canonical heads");
    }
    if (state.lifecycleId && currentRunningAttempt(state.lifecycleId)) {
      throw new Error("Task reopen cannot target a running Attempt");
    }
    if (state.lifecycleId) voidStaleRouteHead(context, state.lifecycleId);
    const lifecycle = adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: state.milestoneId,
      sliceId: state.sliceId,
      taskId: state.taskId,
      lifecycleStatus: "ready",
      adoptedFromStatus: legacyStatus,
    });
    reopenLegacyTaskState(context, input.task);
    revokeTaskCancellationWaivers(context, lifecycle.lifecycleId, input.task, reason);
    deleteVerificationEvidence(state.milestoneId, state.sliceId, state.taskId);
    // The SUMMARY row claims a completion that this reopen voids. Left in
    // place it reads as artifact/DB drift and pauses the next dispatch. The
    // row moves to the event payload, so its content is not lost.
    const invalidatedEvidence = removeInvalidatedRows([[
      "artifacts",
      "artifact_type = 'SUMMARY' AND milestone_id = :milestone_id AND slice_id = :slice_id AND task_id = :task_id",
    ]], { ":milestone_id": state.milestoneId, ":slice_id": state.sliceId, ":task_id": state.taskId });
    ensurePendingSliceQ8(context, input.task);
    const checkpoint = appendRecoveryWorkCheckpoint(context, {
      lifecycleId: lifecycle.lifecycleId,
      scopeKey: checkpointScope(input.task),
      checkpointKind: "correction",
      confirmedContext: reason,
      unresolvedSummary: reason,
      evidenceSummary: "Task explicitly reopened from terminal history",
      suggestedNextAction: "claim a new Task Attempt when ready",
    });
    const shadow = readLifecycleShadowComparison(context, {
      itemKind: "task",
      ...input.task,
    });
    return mutation("task.reopened", input.task, {
      lifecycleId: lifecycle.lifecycleId,
      workCheckpointId: checkpoint.checkpointId,
      reason,
      ...inject,
      invalidatedEvidence,
      shadow: shadowPayload(shadow),
    });
  });
  return loadReceipt(operation, "ready", "pending");
}

export function cancelTask(input: {
  invocation: ExecutionInvocation;
  task: TaskLifecycleIdentity;
  reason: string;
}): TaskLifecycleReceipt {
  const reason = requireText(input.reason, "reason");
  const operation = executeDomainOperation(operationRequest(
    "task.cancel",
    input.invocation,
    { task: taskPayload(input.task), reason },
  ), (context) => {
    const state = loadTaskState(input.task);
    requireOpenParents(state, "cancel");
    const legacyStatus = normalizeLegacyLifecycleStatus(state.legacyStatus);
    if (legacyStatus === "completed" || legacyStatus === "cancelled") {
      throw new Error(`Task ${state.taskId} is already terminal`);
    }
    if (!legacyStatus) throw new Error(`Task ${state.taskId} has an unknown legacy status`);
    if (!state.lifecycleStatus && legacyStatus !== "pending") {
      throw new Error("Legacy-only active Task cancellation cannot fabricate Attempt history");
    }
    const lifecycle = state.lifecycleId
      ? { lifecycleId: state.lifecycleId, lifecycleStatus: state.lifecycleStatus! }
      : adoptOrTransitionLifecycle(context, {
          itemKind: "task",
          milestoneId: state.milestoneId,
          sliceId: state.sliceId,
          taskId: state.taskId,
          lifecycleStatus: "cancelled",
          adoptedFromStatus: "pending",
        });
    // Cancellation owns cleanup of abandoned work as well as actively leased
    // work, so an expired or released lease must not hide the Attempt that
    // still needs to be settled.
    const running = currentRunningAttempt(lifecycle.lifecycleId, { requireActiveLease: false });
    let resultId: string | undefined;
    let kernelCheckpointId: string | undefined;
    if (lifecycle.lifecycleStatus === "in_progress") {
      if (!running) throw new Error("In-progress Task cancellation requires its running Attempt");
      const endedAt = new Date().toISOString();
      resultId = settleAttemptWithResult(context, {
        attemptId: running.attemptId,
        outcome: "interrupted",
        failureClass: "task-cancelled",
        summary: reason,
        output: { reason },
        endedAt,
        cancellation: true,
      }).resultId;
      terminalizeTaskExecutionDispatch(context, {
        dispatchId: running.dispatchId,
        workerId: running.workerId,
        milestoneLeaseToken: running.milestoneLeaseToken,
        outcome: "interrupted",
        endedAt,
        cancellation: true,
      });
      kernelCheckpointId = appendKernelCheckpoint(context, {
        lifecycleId: lifecycle.lifecycleId,
        attemptId: running.attemptId,
        nextStage: "route",
        previousKernelCheckpointId: running.kernelCheckpointId,
      }).kernelCheckpointId;
    } else if (running) {
      throw new Error("Only an in-progress Task may own a running Attempt");
    }
    if (state.lifecycleId) {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: state.milestoneId,
        sliceId: state.sliceId,
        taskId: state.taskId,
        lifecycleStatus: "cancelled",
      });
    }
    cancelLegacyTaskState(context, input.task);
    const waiverId = grantTaskCancellationWaiver(
      context,
      input.invocation,
      lifecycle.lifecycleId,
      input.task,
      reason,
    );
    const checkpoint = appendRecoveryWorkCheckpoint(context, {
      lifecycleId: lifecycle.lifecycleId,
      scopeKey: checkpointScope(input.task),
      checkpointKind: "handoff",
      confirmedContext: reason,
      unresolvedSummary: "",
      evidenceSummary: resultId
        ? `Running Attempt interrupted with Result ${resultId}`
        : "Task cancelled before execution",
      suggestedNextAction: "reopen the Task only when the work is required again",
    });
    const shadow = readLifecycleShadowComparison(context, {
      itemKind: "task",
      ...input.task,
    });
    return mutation("task.cancelled", input.task, {
      lifecycleId: lifecycle.lifecycleId,
      workCheckpointId: checkpoint.checkpointId,
      waiverId,
      reason,
      interruptedAttemptId: running?.attemptId ?? null,
      resultId: resultId ?? null,
      kernelCheckpointId: kernelCheckpointId ?? null,
      shadow: shadowPayload(shadow),
    });
  });
  recordTaskCancellationDisposition(input.invocation, operation.operationId, reason);
  return loadReceipt(operation, "cancelled", "skipped");
}

/**
 * Closeout accepts a cancellation Waiver only with a current 'waived'
 * disposition. Runs once per Waiver, so a replayed cancel adds nothing.
 */
function recordTaskCancellationDisposition(
  invocation: ExecutionInvocation,
  cancelOperationId: string,
  rationale: string,
): void {
  const waiver = getDb().prepare(`
    SELECT waiver.waiver_id, waiver.requirement_id
    FROM workflow_waivers waiver
    WHERE waiver.operation_id = :operation_id
      AND NOT EXISTS (
        SELECT 1 FROM workflow_requirement_dispositions disposition
        WHERE disposition.waiver_id = waiver.waiver_id
      )
  `).get({ ":operation_id": cancelOperationId }) as Record<string, unknown> | undefined;
  if (!waiver) return;
  const requirementId = String(waiver["requirement_id"]);
  const head = currentDispositionHead(requirementId);
  recordTaskRequirementDisposition({
    invocation: { ...invocation, idempotencyKey: `${invocation.idempotencyKey}/disposition` },
    requirementId,
    disposition: "waived",
    waiverId: String(waiver["waiver_id"]),
    ...(head ? { supersedesDispositionId: head } : {}),
    rationale,
  });
}
