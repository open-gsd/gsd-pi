// Project/App: gsd-pi
// File Purpose: Context-bound canonical lifecycle, Attempt, Result, and checkpoint writers.

import { randomUUID } from "node:crypto";

import {
  canonicalDomainJson,
  type DomainJsonValue,
  type DomainOperationContext,
} from "../domain-operation.js";
import { getDb, isInTransaction } from "../engine.js";
import { CURRENT_TASK_RECOVERY_CAUSAL_AUTHORITY_SQL } from "../sql-constants.js";
import {
  isAllowedKernelStageTransition,
  type KernelStage,
} from "../kernel-stage-policy.js";
export { isAllowedKernelStageTransition };
import {
  type CanonicalLifecycleStatus,
  compareLifecycleShadow,
  type LifecycleShadowComparison,
  normalizeCanonicalLifecycleStatus,
} from "../lifecycle-shadow-comparison.js";
export {
  type CanonicalLifecycleStatus,
  compareLifecycleShadow,
  type LifecycleShadowComparison,
  type LifecycleShadowComparisonKind,
  normalizeCanonicalLifecycleStatus,
  normalizeLegacyLifecycleStatus,
} from "../lifecycle-shadow-comparison.js";

const ITEM_KINDS = new Set(["milestone", "slice", "task"]);
const ATTEMPT_OUTCOMES = new Set(["succeeded", "failed", "interrupted"]);

export interface DomainOperationFence {
  projectId: string;
  revision: number;
  authorityEpoch: number;
  replay: boolean;
}

export interface LifecycleIdentity {
  itemKind: "milestone" | "slice" | "task";
  milestoneId: string;
  sliceId?: string;
  taskId?: string;
}

export interface LifecycleCommandInput extends LifecycleIdentity {
  lifecycleStatus: CanonicalLifecycleStatus;
  adoptedFromStatus?: CanonicalLifecycleStatus;
  occurredAt?: string;
}

export interface LifecycleShadowRecord extends LifecycleIdentity, LifecycleShadowComparison {}

export interface LifecycleCommandResult {
  lifecycleId: string;
  lifecycleStatus: CanonicalLifecycleStatus;
  stateVersion: number;
  adopted: boolean;
}

export interface LifecycleShadowRepairStepInput extends LifecycleIdentity {
  expectedBeforeStatus: CanonicalLifecycleStatus | null;
  targetStatus: "in_progress" | "completed";
  priorRepairOperationId?: string;
}

export interface ClaimRunningAttemptInput {
  lifecycleId: string;
  retryOfAttemptId?: string;
  coordinationDispatchId?: number;
  workerId: string;
  milestoneLeaseToken: number;
  claimedAt?: string;
  startedAt?: string;
}

export interface ClaimRunningAttemptResult {
  attemptId: string;
  attemptNumber: number;
  retryOfAttemptId: string | null;
  attemptState: "running";
  kernelCheckpointId: string;
}

export interface SettleAttemptInput {
  attemptId: string;
  outcome: "succeeded" | "failed" | "interrupted";
  failureClass: string;
  summary: string;
  output: DomainJsonValue;
  endedAt?: string;
  createdAt?: string;
  recovery?: {
    workerId: string;
    milestoneLeaseToken: number;
  };
  cancellation?: boolean;
}

export interface SettleAttemptResult {
  attemptId: string;
  resultId: string;
  attemptState: "settled";
  outcome: "succeeded" | "failed" | "interrupted";
}

export interface AppendKernelCheckpointInput {
  lifecycleId: string;
  attemptId: string;
  nextStage: KernelStage;
  previousKernelCheckpointId?: string | null;
  createdAt?: string;
}

export interface AppendKernelCheckpointResult {
  kernelCheckpointId: string;
  sequence: number;
  attemptId: string;
  nextStage: AppendKernelCheckpointInput["nextStage"];
  previousKernelCheckpointId: string | null;
}

interface LifecycleRow {
  lifecycle_id: string;
  lifecycle_status: CanonicalLifecycleStatus;
  state_version: number;
  updated_at: string;
  last_operation_id: string;
}

interface AttemptRow {
  attempt_id: string;
  attempt_number: number;
  attempt_state: string;
  next_stage: string | null;
}

interface KernelHeadRow {
  kernel_checkpoint_id: string;
  attempt_id: string;
  sequence: number;
  next_stage: AppendKernelCheckpointInput["nextStage"];
}

function requireNonBlank(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must not be blank`);
  }
}

function requireTimestamp(value: string, field: string): string {
  requireNonBlank(value, field);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be a valid timestamp`);
  return new Date(timestamp).toISOString();
}

function changes(result: unknown): number {
  const value = (result as { changes?: unknown })?.changes;
  return typeof value === "number" ? value : 0;
}

export function requireActiveDomainOperationContext(context: Readonly<DomainOperationContext>): string {
  if (!isInTransaction()) {
    throw new Error("lifecycle writer requires an active Domain Operation context");
  }
  const active = getDb().prepare(`
    SELECT operation.operation_type
    FROM workflow_operations operation
    JOIN project_authority authority ON authority.project_id = operation.project_id
    WHERE operation.operation_id = :operation_id
      AND operation.project_id = :project_id
      AND operation.resulting_revision = :resulting_revision
      AND operation.resulting_authority_epoch = :resulting_authority_epoch
      AND authority.revision = operation.expected_revision
      AND authority.authority_epoch = operation.expected_authority_epoch
  `).get({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
    ":resulting_revision": context.resultingRevision,
    ":resulting_authority_epoch": context.resultingAuthorityEpoch,
  });
  if (!active) throw new Error("lifecycle writer context is not the active Domain Operation provenance");
  return String((active as Record<string, unknown>)["operation_type"]);
}

function validateLifecycleIdentity(input: LifecycleCommandInput): void {
  if (!ITEM_KINDS.has(input.itemKind)) throw new Error("invalid lifecycle item kind");
  requireNonBlank(input.milestoneId, "milestoneId");
  if (normalizeCanonicalLifecycleStatus(input.lifecycleStatus) === null) {
    throw new Error(`invalid lifecycle status ${input.lifecycleStatus}`);
  }
  if (input.adoptedFromStatus !== undefined && normalizeCanonicalLifecycleStatus(input.adoptedFromStatus) === null) {
    throw new Error(`invalid adopted lifecycle status ${input.adoptedFromStatus}`);
  }
  const hasSlice = typeof input.sliceId === "string" && input.sliceId.trim().length > 0;
  const hasTask = typeof input.taskId === "string" && input.taskId.trim().length > 0;
  if (input.itemKind === "milestone" && (input.sliceId !== undefined || input.taskId !== undefined)) {
    throw new Error("milestone lifecycle identity shape cannot include sliceId or taskId");
  }
  if (input.itemKind === "slice" && (!hasSlice || input.taskId !== undefined)) {
    throw new Error("slice lifecycle identity shape requires sliceId and no taskId");
  }
  if (input.itemKind === "task" && (!hasSlice || !hasTask)) {
    throw new Error("task lifecycle identity shape requires sliceId and taskId");
  }
}

function isValidLifecycleTransition(
  itemKind: LifecycleIdentity["itemKind"],
  from: CanonicalLifecycleStatus,
  to: CanonicalLifecycleStatus,
): boolean {
  if (from === to) return true;
  if (from === "pending") return to === "ready" || to === "cancelled";
  if (from === "ready") {
    return to === "in_progress" || to === "paused" || to === "cancelled" ||
      ((itemKind === "slice" || itemKind === "milestone") && to === "completed");
  }
  if (from === "in_progress") {
    return to === "paused" || to === "completed" || to === "cancelled" ||
      // #2202: operator closeout — accept a discovered blocker instead of
      // fabricating a completion or cancelling the Task.
      (itemKind === "task" && to === "blocker-accepted");
  }
  if (from === "paused") return to === "ready" || to === "in_progress" || to === "cancelled";
  return (from === "completed" || from === "cancelled" || from === "blocker-accepted") && to === "ready";
}

function requireHierarchyRow(input: LifecycleCommandInput): void {
  const db = getDb();
  let hierarchy: Record<string, unknown> | undefined;
  if (input.itemKind === "milestone") {
    hierarchy = db.prepare("SELECT 1 AS present FROM milestones WHERE id = :milestone_id").get({
      ":milestone_id": input.milestoneId,
    });
  } else if (input.itemKind === "slice") {
    hierarchy = db.prepare(`
      SELECT 1 AS present FROM slices
      WHERE milestone_id = :milestone_id AND id = :slice_id
    `).get({ ":milestone_id": input.milestoneId, ":slice_id": input.sliceId });
  } else {
    hierarchy = db.prepare(`
      SELECT 1 AS present FROM tasks
      WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :task_id
    `).get({
      ":milestone_id": input.milestoneId,
      ":slice_id": input.sliceId,
      ":task_id": input.taskId,
    });
  }
  if (!hierarchy) throw new Error(`${input.itemKind} hierarchy row is missing`);
}

function findLifecycle(context: Readonly<DomainOperationContext>, input: LifecycleCommandInput): LifecycleRow | undefined {
  return getDb().prepare(`
    SELECT lifecycle_id, lifecycle_status, state_version, updated_at, last_operation_id
    FROM workflow_item_lifecycles
    WHERE project_id = :project_id
      AND item_kind = :item_kind
      AND milestone_id = :milestone_id
      AND slice_id IS :slice_id
      AND task_id IS :task_id
  `).get({
    ":project_id": context.projectId,
    ":item_kind": input.itemKind,
    ":milestone_id": input.milestoneId,
    ":slice_id": input.sliceId ?? null,
    ":task_id": input.taskId ?? null,
  }) as unknown as LifecycleRow | undefined;
}

function existingLifecycleResult(existing: LifecycleRow): LifecycleCommandResult {
  return {
    lifecycleId: existing.lifecycle_id,
    lifecycleStatus: existing.lifecycle_status,
    stateVersion: existing.state_version,
    adopted: false,
  };
}

export function readDomainOperationFence(idempotencyKey?: string): DomainOperationFence {
  if (idempotencyKey !== undefined) requireNonBlank(idempotencyKey, "idempotency key");
  const db = getDb();
  const authority = db.prepare(`
    SELECT project_id, revision, authority_epoch
    FROM project_authority WHERE singleton = 1
  `).get() as Record<string, unknown> | undefined;
  if (!authority) throw new Error("project authority is missing");

  if (idempotencyKey !== undefined) {
    const operation = db.prepare(`
      SELECT expected_revision, expected_authority_epoch
      FROM workflow_operations
      WHERE project_id = :project_id AND idempotency_key = :idempotency_key
    `).get({
      ":project_id": authority["project_id"],
      ":idempotency_key": idempotencyKey,
    }) as Record<string, unknown> | undefined;
    if (operation) {
      return {
        projectId: String(authority["project_id"]),
        revision: Number(operation["expected_revision"]),
        authorityEpoch: Number(operation["expected_authority_epoch"]),
        replay: true,
      };
    }
  }

  return {
    projectId: String(authority["project_id"]),
    revision: Number(authority["revision"]),
    authorityEpoch: Number(authority["authority_epoch"]),
    replay: false,
  };
}

export function isTaskRecoveryResumeAuthorized(
  attemptId: string,
): boolean {
  requireNonBlank(attemptId, "attemptId");
  const stored = getDb().prepare(`
    SELECT 1 AS authorized
    FROM workflow_domain_events resumed
    JOIN workflow_recovery_actions action
      ON action.project_id = resumed.project_id
     AND action.recovery_action_id = json_extract(resumed.payload_json, '$.recoveryActionId')
    JOIN workflow_failure_observations observation
      ON observation.project_id = action.project_id
     AND observation.lifecycle_id = action.lifecycle_id
     AND observation.failure_observation_id = action.failure_observation_id
    JOIN workflow_attempt_results result
      ON result.project_id = observation.project_id
     AND result.lifecycle_id = observation.lifecycle_id
     AND result.attempt_id = observation.attempt_id
     AND result.result_id = observation.result_id
    JOIN workflow_execution_attempts attempt
      ON attempt.project_id = observation.project_id
     AND attempt.lifecycle_id = observation.lifecycle_id
     AND attempt.attempt_id = observation.attempt_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = attempt.project_id
     AND lifecycle.lifecycle_id = attempt.lifecycle_id
    JOIN workflow_kernel_checkpoints kernel
      ON kernel.project_id = attempt.project_id
     AND kernel.lifecycle_id = attempt.lifecycle_id
     AND kernel.attempt_id = attempt.attempt_id
     AND kernel.next_stage = 'route'
    JOIN workflow_work_checkpoints checkpoint
      ON checkpoint.project_id = resumed.project_id
     AND checkpoint.operation_id = resumed.operation_id
     AND checkpoint.checkpoint_id = json_extract(resumed.payload_json, '$.workCheckpointId')
     AND checkpoint.lifecycle_id = action.lifecycle_id
    WHERE resumed.event_type = 'task.recovery.resumed'
      AND resumed.entity_type = 'task'
      AND resumed.entity_id = lifecycle.milestone_id || '/' || lifecycle.slice_id || '/' || lifecycle.task_id
      AND json_extract(resumed.payload_json, '$.lifecycleId') = action.lifecycle_id
      AND json_extract(resumed.payload_json, '$.attemptId') = observation.attempt_id
      AND json_extract(resumed.payload_json, '$.resultId') = observation.result_id
      AND action.action IN ('abort', 'remediate')
      AND observation.recovery_owner = 'agent'
      AND ${CURRENT_TASK_RECOVERY_CAUSAL_AUTHORITY_SQL}
      AND attempt.attempt_id = :attempt_id
      AND attempt.attempt_state = 'settled'
      AND resumed.project_revision > action.project_revision
      AND NOT EXISTS (
        SELECT 1 FROM workflow_execution_attempts consumed
        WHERE consumed.project_id = resumed.project_id
          AND consumed.lifecycle_id = action.lifecycle_id
          AND consumed.retry_of_attempt_id = observation.attempt_id
          AND consumed.claim_project_revision > resumed.project_revision
      )
  `).get({ ":attempt_id": attemptId }) as Record<string, unknown> | undefined;
  return stored?.["authorized"] === 1;
}

function readCurrentTaskRecoveryAction(
  projectId: string,
  lifecycleId: string,
  attemptId: string,
  claimRevision: number,
  claimAuthorityEpoch: number,
): Record<string, unknown> | undefined {
  return getDb().prepare(`
    SELECT action.action, action.recovery_action_id, action.project_revision
    FROM workflow_recovery_actions action
    JOIN workflow_failure_observations observation
      ON observation.failure_observation_id = action.failure_observation_id
     AND observation.project_id = action.project_id
     AND observation.lifecycle_id = action.lifecycle_id
    JOIN workflow_attempt_results result
      ON result.result_id = observation.result_id
     AND result.project_id = observation.project_id
     AND result.lifecycle_id = observation.lifecycle_id
     AND result.attempt_id = observation.attempt_id
    WHERE action.project_id = :project_id
      AND action.lifecycle_id = :lifecycle_id
      AND action.target_lifecycle_id = :lifecycle_id
      AND observation.attempt_id = :attempt_id
      AND observation.recovery_owner = 'agent'
      AND action.action IN ('retry', 'repair', 'remediate', 'replan')
      AND action.project_revision < :project_revision
      AND action.authority_epoch <= :authority_epoch
      AND ${CURRENT_TASK_RECOVERY_CAUSAL_AUTHORITY_SQL}
  `).get({
    ":project_id": projectId,
    ":lifecycle_id": lifecycleId,
    ":attempt_id": attemptId,
    ":project_revision": claimRevision,
    ":authority_epoch": claimAuthorityEpoch,
  }) as Record<string, unknown> | undefined;
}

export function adoptOrTransitionLifecycle(
  context: Readonly<DomainOperationContext>,
  input: LifecycleCommandInput,
): LifecycleCommandResult {
  requireActiveDomainOperationContext(context);
  validateLifecycleIdentity(input);
  requireHierarchyRow(input);
  const now = requireTimestamp(input.occurredAt ?? new Date().toISOString(), "occurredAt");
  const existing = findLifecycle(context, input);

  if (!existing) {
    const adoptedFromStatus = input.adoptedFromStatus ?? input.lifecycleStatus;
    if (!isValidLifecycleTransition(input.itemKind, adoptedFromStatus, input.lifecycleStatus)) {
      throw new Error("invalid workflow lifecycle transition");
    }
    const stateVersion = adoptedFromStatus === input.lifecycleStatus ? 0 : 1;
    const lifecycleId = randomUUID();
    getDb().prepare(`
      INSERT INTO workflow_item_lifecycles (
        lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
        lifecycle_status, state_version, created_at, updated_at,
        last_operation_id, last_project_revision, last_authority_epoch
      ) VALUES (
        :lifecycle_id, :project_id, :item_kind, :milestone_id, :slice_id, :task_id,
        :lifecycle_status, :state_version, :created_at, :updated_at,
        :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":lifecycle_id": lifecycleId,
      ":project_id": context.projectId,
      ":item_kind": input.itemKind,
      ":milestone_id": input.milestoneId,
      ":slice_id": input.sliceId ?? null,
      ":task_id": input.taskId ?? null,
      ":lifecycle_status": input.lifecycleStatus,
      ":state_version": stateVersion,
      ":created_at": now,
      ":updated_at": now,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    return { lifecycleId, lifecycleStatus: input.lifecycleStatus, stateVersion, adopted: true };
  }

  if (existing.lifecycle_status === input.lifecycleStatus) {
    return existingLifecycleResult(existing);
  }

  const previousTimestamp = Date.parse(existing.updated_at);
  const requestedTimestamp = Date.parse(now);
  if (input.occurredAt !== undefined && requestedTimestamp <= previousTimestamp) {
    throw new Error("occurredAt must be after the current lifecycle timestamp");
  }
  const updatedAt = requestedTimestamp <= previousTimestamp
    ? new Date(previousTimestamp + 1).toISOString()
    : now;

  const result = getDb().prepare(`
    UPDATE workflow_item_lifecycles
    SET lifecycle_status = :lifecycle_status,
        state_version = state_version + 1,
        updated_at = :updated_at,
        last_operation_id = :operation_id,
        last_project_revision = :project_revision,
        last_authority_epoch = :authority_epoch
    WHERE lifecycle_id = :lifecycle_id AND project_id = :project_id
  `).run({
    ":lifecycle_status": input.lifecycleStatus,
    ":updated_at": updatedAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
    ":lifecycle_id": existing.lifecycle_id,
    ":project_id": context.projectId,
  });
  if (changes(result) !== 1) throw new Error("lifecycle transition did not update exactly one row");
  return {
    lifecycleId: existing.lifecycle_id,
    lifecycleStatus: input.lifecycleStatus,
    stateVersion: existing.state_version + 1,
    adopted: false,
  };
}

export function adoptLifecycleIfMissing(
  context: Readonly<DomainOperationContext>,
  input: LifecycleCommandInput,
): LifecycleCommandResult {
  requireActiveDomainOperationContext(context);
  validateLifecycleIdentity(input);
  requireHierarchyRow(input);
  if (input.occurredAt !== undefined) requireTimestamp(input.occurredAt, "occurredAt");

  const existing = findLifecycle(context, input);
  return existing
    ? existingLifecycleResult(existing)
    : adoptOrTransitionLifecycle(context, input);
}

function requirePriorTaskRepairStep(
  context: Readonly<DomainOperationContext>,
  input: LifecycleShadowRepairStepInput,
): void {
  if (!input.priorRepairOperationId) {
    throw new Error("in-progress Task shadow repair requires its prior ready-to-in-progress repair receipt");
  }
  const prior = getDb().prepare(`
    SELECT 1 AS present
    FROM workflow_operations operation
    JOIN workflow_domain_events event ON event.operation_id = operation.operation_id
    WHERE operation.operation_id = :operation_id
      AND operation.project_id = :project_id
      AND operation.operation_type = 'lifecycle.shadow.repair'
      AND operation.resulting_revision < :resulting_revision
      AND event.event_type = 'lifecycle.shadow.advanced'
      AND event.entity_type = 'task'
      AND event.entity_id = :entity_id
      AND json_extract(event.payload_json, '$.afterStatus') = 'in_progress'
  `).get({
    ":operation_id": input.priorRepairOperationId,
    ":project_id": context.projectId,
    ":resulting_revision": context.resultingRevision,
    ":entity_id": `${input.milestoneId}/${input.sliceId}/${input.taskId}`,
  });
  if (!prior) {
    throw new Error("in-progress Task shadow repair requires a matching prior repair receipt");
  }
}

/**
 * Apply one evidence-fenced forward repair edge. A ready Task reaches
 * completion only when its caller composes two separately committed edges.
 */
export function repairLifecycleShadowStep(
  context: Readonly<DomainOperationContext>,
  input: LifecycleShadowRepairStepInput,
): LifecycleCommandResult {
  if (requireActiveDomainOperationContext(context) !== "lifecycle.shadow.repair") {
    throw new Error("lifecycle shadow repair requires a lifecycle.shadow.repair Domain Operation");
  }
  const current = findLifecycle(context, {
    itemKind: input.itemKind,
    milestoneId: input.milestoneId,
    ...(input.sliceId ? { sliceId: input.sliceId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    lifecycleStatus: input.targetStatus,
  });
  if ((current?.lifecycle_status ?? null) !== input.expectedBeforeStatus) {
    throw new Error("lifecycle shadow repair current status does not match expected before status");
  }
  const isMissingTerminalAdoption = input.expectedBeforeStatus === null && input.targetStatus === "completed";
  const isReadyTaskAdvance =
    input.expectedBeforeStatus === "ready" &&
    input.itemKind === "task" &&
    input.targetStatus === "in_progress";
  const isReadySliceCompletion =
    input.expectedBeforeStatus === "ready" &&
    input.itemKind === "slice" &&
    input.targetStatus === "completed";
  const isAdvancedTaskCompletion =
    input.expectedBeforeStatus === "in_progress" &&
    input.itemKind === "task" &&
    input.targetStatus === "completed";
  if (!isMissingTerminalAdoption && !isReadyTaskAdvance && !isReadySliceCompletion && !isAdvancedTaskCompletion) {
    throw new Error("unsupported lifecycle shadow repair edge");
  }
  if (isAdvancedTaskCompletion) {
    if (current?.last_operation_id !== input.priorRepairOperationId) {
      throw new Error("in-progress Task shadow repair requires its current head repair receipt");
    }
    requirePriorTaskRepairStep(context, input);
  }

  return adoptOrTransitionLifecycle(context, {
    itemKind: input.itemKind,
    milestoneId: input.milestoneId,
    ...(input.sliceId ? { sliceId: input.sliceId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    lifecycleStatus: input.targetStatus,
    ...(input.expectedBeforeStatus === null ? { adoptedFromStatus: "completed" as const } : {}),
  });
}

export function completeLegacyTaskForVerifiedAttempt(
  context: Readonly<DomainOperationContext>,
  identity: { milestoneId: string; sliceId: string; taskId: string },
  completedAt = new Date().toISOString(),
): void {
  requireActiveDomainOperationContext(context);
  requireNonBlank(identity.milestoneId, "milestoneId");
  requireNonBlank(identity.sliceId, "sliceId");
  requireNonBlank(identity.taskId, "taskId");
  const timestamp = requireTimestamp(completedAt, "completedAt");
  const result = getDb().prepare(`
    UPDATE tasks
    SET status = 'complete', completed_at = COALESCE(completed_at, :completed_at)
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :task_id
  `).run({
    ":completed_at": timestamp,
    ":milestone_id": identity.milestoneId,
    ":slice_id": identity.sliceId,
    ":task_id": identity.taskId,
  });
  if (changes(result) !== 1) {
    throw new Error("Verified Task publication did not complete exactly one legacy Task");
  }
}

/**
 * Close the legacy Task row as `blocker-accepted` (#2202). The replan gate
 * reads legacy `tasks.status`, so the canonical-only write cannot unlock
 * replan on its own — both vocabularies move in the same Domain Operation.
 * No SUMMARY or completion timestamp is fabricated: the Task is closed, not
 * completed.
 */
export function closeLegacyTaskAsBlockerAccepted(
  context: Readonly<DomainOperationContext>,
  identity: { milestoneId: string; sliceId: string; taskId: string },
): void {
  requireActiveDomainOperationContext(context);
  requireNonBlank(identity.milestoneId, "milestoneId");
  requireNonBlank(identity.sliceId, "sliceId");
  requireNonBlank(identity.taskId, "taskId");
  const result = getDb().prepare(`
    UPDATE tasks
    SET status = 'blocker-accepted'
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :task_id
  `).run({
    ":milestone_id": identity.milestoneId,
    ":slice_id": identity.sliceId,
    ":task_id": identity.taskId,
  });
  if (changes(result) !== 1) {
    throw new Error("Blocker-accepted closeout did not close exactly one legacy Task");
  }
}

export function readLifecycleShadowComparison(
  context: Readonly<DomainOperationContext>,
  identity: LifecycleIdentity,
): LifecycleShadowRecord {
  requireActiveDomainOperationContext(context);
  const input: LifecycleCommandInput = { ...identity, lifecycleStatus: "pending" };
  validateLifecycleIdentity(input);
  requireHierarchyRow(input);
  const db = getDb();
  let hierarchy: Record<string, unknown> | undefined;
  if (identity.itemKind === "milestone") {
    hierarchy = db.prepare("SELECT status FROM milestones WHERE id = :milestone_id").get({
      ":milestone_id": identity.milestoneId,
    });
  } else if (identity.itemKind === "slice") {
    hierarchy = db.prepare(`
      SELECT status FROM slices WHERE milestone_id = :milestone_id AND id = :slice_id
    `).get({ ":milestone_id": identity.milestoneId, ":slice_id": identity.sliceId });
  } else {
    hierarchy = db.prepare(`
      SELECT status FROM tasks
      WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :task_id
    `).get({
      ":milestone_id": identity.milestoneId,
      ":slice_id": identity.sliceId,
      ":task_id": identity.taskId,
    });
  }
  const lifecycle = findLifecycle(context, input);
  return {
    ...identity,
    ...compareLifecycleShadow(
      hierarchy ? String(hierarchy["status"]) : null,
      lifecycle?.lifecycle_status ?? null,
    ),
  };
}

function loadKernelHead(projectId: string, lifecycleId: string): KernelHeadRow | undefined {
  return getDb().prepare(`
    SELECT head.kernel_checkpoint_id, head.attempt_id, head.sequence, head.next_stage
    FROM workflow_kernel_checkpoints head
    WHERE head.project_id = :project_id AND head.lifecycle_id = :lifecycle_id
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = head.kernel_checkpoint_id
      )
  `).get({ ":project_id": projectId, ":lifecycle_id": lifecycleId }) as unknown as KernelHeadRow | undefined;
}

export function appendKernelCheckpoint(
  context: Readonly<DomainOperationContext>,
  input: AppendKernelCheckpointInput,
): AppendKernelCheckpointResult {
  requireActiveDomainOperationContext(context);
  requireNonBlank(input.lifecycleId, "lifecycleId");
  requireNonBlank(input.attemptId, "attemptId");
  const now = requireTimestamp(input.createdAt ?? new Date().toISOString(), "createdAt");
  const head = loadKernelHead(context.projectId, input.lifecycleId);
  const expectedPrevious = head?.kernel_checkpoint_id ?? null;
  const suppliedPrevious = input.previousKernelCheckpointId ?? null;
  if (suppliedPrevious !== expectedPrevious) {
    throw new Error("Kernel checkpoint must extend the current head");
  }
  if (head?.attempt_id === input.attemptId) {
    if (!isAllowedKernelStageTransition(head.next_stage, input.nextStage)) {
      throw new Error(`invalid Kernel stage transition ${head.next_stage} -> ${input.nextStage}`);
    }
    if (head.next_stage === "execute") {
      const expectedOutcomes = input.nextStage === "verify"
        ? ["succeeded"]
        : ["failed", "interrupted"];
      const result = getDb().prepare(`
        SELECT 1 AS present FROM workflow_attempt_results
        WHERE project_id = ? AND lifecycle_id = ?
          AND attempt_id = ? AND operation_id = ?
          AND project_revision = ? AND authority_epoch = ?
          AND outcome IN (${expectedOutcomes.map(() => "?").join(", ")})
      `).get(
        context.projectId,
        input.lifecycleId,
        input.attemptId,
        context.operationId,
        context.resultingRevision,
        context.resultingAuthorityEpoch,
        ...expectedOutcomes,
      );
      if (!result) {
        throw new Error(`${input.nextStage} checkpoint requires a matching Attempt Result in the same Domain Operation`);
      }
    }
  }
  const checkpointId = randomUUID();
  const sequence = (head?.sequence ?? 0) + 1;
  getDb().prepare(`
    INSERT INTO workflow_kernel_checkpoints (
      kernel_checkpoint_id, project_id, lifecycle_id, attempt_id,
      next_stage, sequence, previous_kernel_checkpoint_id, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :checkpoint_id, :project_id, :lifecycle_id, :attempt_id,
      :next_stage, :sequence, :previous_checkpoint_id, :created_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":checkpoint_id": checkpointId,
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":attempt_id": input.attemptId,
    ":next_stage": input.nextStage,
    ":sequence": sequence,
    ":previous_checkpoint_id": suppliedPrevious,
    ":created_at": now,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return {
    kernelCheckpointId: checkpointId,
    sequence,
    attemptId: input.attemptId,
    nextStage: input.nextStage,
    previousKernelCheckpointId: suppliedPrevious,
  };
}

export function claimRunningAttempt(
  context: Readonly<DomainOperationContext>,
  input: ClaimRunningAttemptInput,
): ClaimRunningAttemptResult {
  if (requireActiveDomainOperationContext(context) !== "attempt.claim") {
    throw new Error("Attempt claim requires an attempt.claim Domain Operation");
  }
  requireNonBlank(input.lifecycleId, "lifecycleId");
  requireNonBlank(input.workerId, "workerId");
  if (!Number.isSafeInteger(input.milestoneLeaseToken) || input.milestoneLeaseToken <= 0) {
    throw new Error("milestoneLeaseToken must be a positive safe integer");
  }
  if (
    input.coordinationDispatchId !== undefined &&
    (!Number.isSafeInteger(input.coordinationDispatchId) || input.coordinationDispatchId <= 0)
  ) {
    throw new Error("coordinationDispatchId must be a positive safe integer");
  }
  const now = new Date().toISOString();
  const claimedAt = requireTimestamp(input.claimedAt ?? now, "claimedAt");
  const startedAt = requireTimestamp(input.startedAt ?? now, "startedAt");
  if (Date.parse(startedAt) < Date.parse(claimedAt)) {
    throw new Error("startedAt must not precede claimedAt");
  }
  const lifecycle = getDb().prepare(`
    SELECT lifecycle_id, lifecycle_status
    FROM workflow_item_lifecycles
    WHERE lifecycle_id = :lifecycle_id AND project_id = :project_id
  `).get({
    ":lifecycle_id": input.lifecycleId,
    ":project_id": context.projectId,
  }) as Record<string, unknown> | undefined;
  if (!lifecycle) throw new Error("Attempt lifecycle is missing");
  if (lifecycle["lifecycle_status"] !== "in_progress") {
    throw new Error(`Attempt claim requires lifecycle in_progress, found ${String(lifecycle["lifecycle_status"])}`);
  }

  const prior = getDb().prepare(`
    SELECT attempt.attempt_id, attempt.attempt_number, attempt.attempt_state,
           (
             SELECT checkpoint.next_stage
             FROM workflow_kernel_checkpoints checkpoint
             WHERE checkpoint.lifecycle_id = attempt.lifecycle_id
               AND checkpoint.attempt_id = attempt.attempt_id
               AND checkpoint.project_id = attempt.project_id
               AND NOT EXISTS (
                 SELECT 1 FROM workflow_kernel_checkpoints successor
                 WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
               )
           ) AS next_stage
    FROM workflow_execution_attempts attempt
    WHERE attempt.lifecycle_id = :lifecycle_id
    ORDER BY attempt.attempt_number DESC LIMIT 1
  `).get({ ":lifecycle_id": input.lifecycleId }) as unknown as AttemptRow | undefined;
  if (!prior && input.retryOfAttemptId !== undefined) {
    throw new Error("retry Attempt has no predecessor");
  }
  if (prior && prior.attempt_state !== "settled") {
    throw new Error("lifecycle already has an active running Attempt");
  }
  if (prior && input.retryOfAttemptId !== prior.attempt_id) {
    throw new Error("retry must reference the immediate predecessor Attempt");
  }
  if (prior?.next_stage === "route") {
    const recoveryAction = readCurrentTaskRecoveryAction(
      context.projectId,
      input.lifecycleId,
      prior.attempt_id,
      context.resultingRevision,
      context.resultingAuthorityEpoch,
    );
    const resumeAuthorized = isTaskRecoveryResumeAuthorized(prior.attempt_id);
    if (!recoveryAction && !resumeAuthorized) {
      throw new Error(
        "retry claim requires current causal recovery authority for the route head",
      );
    }
    if (recoveryAction?.["action"] === "replan") {
      const replanned = getDb().prepare(`
        SELECT 1 AS replanned
        FROM workflow_domain_events event
        JOIN workflow_item_lifecycles target
          ON target.lifecycle_id = :lifecycle_id
         AND target.project_id = :project_id
        WHERE event.project_id = :project_id
          AND event.event_type = 'workflow.task.replanned'
          AND event.entity_type = 'task'
          AND event.entity_id = target.milestone_id || '/' || target.slice_id || '/' || target.task_id
          AND event.project_revision > :recovery_revision
      `).get({
        ":project_id": context.projectId,
        ":lifecycle_id": input.lifecycleId,
        ":recovery_revision": Number(recoveryAction["project_revision"]),
      });
      if (!replanned) {
        throw new Error("replan recovery requires a later durable Task replan before retry claim");
      }
    }
  }
  if (prior && !prior.next_stage) throw new Error("retry predecessor is missing its current Kernel head");

  const attemptId = randomUUID();
  const attemptNumber = (prior?.attempt_number ?? 0) + 1;
  const retryOfAttemptId = prior?.attempt_id ?? null;
  getDb().prepare(`
    INSERT INTO workflow_execution_attempts (
      attempt_id, project_id, lifecycle_id, attempt_number, retry_of_attempt_id,
      attempt_state, coordination_dispatch_id, worker_id, milestone_lease_token,
      claimed_at, started_at, ended_at,
      claim_operation_id, claim_project_revision, claim_authority_epoch,
      settle_operation_id, settle_project_revision, settle_authority_epoch
    ) VALUES (
      :attempt_id, :project_id, :lifecycle_id, :attempt_number, :retry_of_attempt_id,
      'running', :dispatch_id, :worker_id, :lease_token,
      :claimed_at, :started_at, NULL,
      :operation_id, :project_revision, :authority_epoch,
      NULL, NULL, NULL
    )
  `).run({
    ":attempt_id": attemptId,
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":attempt_number": attemptNumber,
    ":retry_of_attempt_id": retryOfAttemptId,
    ":dispatch_id": input.coordinationDispatchId ?? null,
    ":worker_id": input.workerId,
    ":lease_token": input.milestoneLeaseToken,
    ":claimed_at": claimedAt,
    ":started_at": startedAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });

  const head = loadKernelHead(context.projectId, input.lifecycleId);
  const checkpoint = appendKernelCheckpoint(context, {
    lifecycleId: input.lifecycleId,
    attemptId,
    nextStage: "execute",
    previousKernelCheckpointId: head?.kernel_checkpoint_id ?? null,
    createdAt: claimedAt,
  });
  return {
    attemptId,
    attemptNumber,
    retryOfAttemptId,
    attemptState: "running",
    kernelCheckpointId: checkpoint.kernelCheckpointId,
  };
}

export function settleAttemptWithResult(
  context: Readonly<DomainOperationContext>,
  input: SettleAttemptInput,
): SettleAttemptResult {
  const operationType = requireActiveDomainOperationContext(context);
  requireNonBlank(input.attemptId, "attemptId");
  if (!ATTEMPT_OUTCOMES.has(input.outcome)) throw new Error(`invalid Attempt outcome ${input.outcome}`);
  if (input.recovery) {
    requireNonBlank(input.recovery.workerId, "recovery.workerId");
    if (!Number.isSafeInteger(input.recovery.milestoneLeaseToken) || input.recovery.milestoneLeaseToken <= 0) {
      throw new Error("recovery.milestoneLeaseToken must be a positive safe integer");
    }
    if (input.outcome !== "interrupted") {
      throw new Error("Attempt recovery requires interrupted outcome");
    }
  }
  if (input.cancellation && (input.outcome !== "interrupted" || input.recovery)) {
    throw new Error("Cancellation requires an interrupted non-recovery settlement");
  }
  const allowedOperationTypes = input.cancellation
    ? ["task.cancel", "slice.cancel"]
    : [input.recovery ? "attempt.interrupt" : "attempt.settle"];
  if (!allowedOperationTypes.includes(operationType)) {
    throw new Error(`Attempt settlement requires a ${allowedOperationTypes.join(" or ")} Domain Operation`);
  }
  requireNonBlank(input.failureClass, "failureClass");
  if (typeof input.summary !== "string") throw new Error("summary must be a string");
  const endedAt = requireTimestamp(input.endedAt ?? new Date().toISOString(), "endedAt");
  const createdAt = requireTimestamp(input.createdAt ?? endedAt, "createdAt");
  const outputJson = canonicalDomainJson(input.output);
  const attempt = getDb().prepare(`
    SELECT attempt_id, lifecycle_id, attempt_state, started_at
    FROM workflow_execution_attempts
    WHERE attempt_id = :attempt_id AND project_id = :project_id
  `).get({
    ":attempt_id": input.attemptId,
    ":project_id": context.projectId,
  }) as Record<string, unknown> | undefined;
  if (!attempt) throw new Error("Attempt is missing");
  if (attempt["attempt_state"] === "settled") throw new Error("Attempt is already settled and terminal");
  if (attempt["attempt_state"] !== "running") throw new Error("only a running Attempt can settle");
  if (Date.parse(endedAt) < Date.parse(String(attempt["started_at"]))) {
    throw new Error("endedAt must not precede startedAt");
  }

  const updated = getDb().prepare(`
    UPDATE workflow_execution_attempts
    SET attempt_state = 'settled', ended_at = :ended_at,
        settle_outcome = :settle_outcome,
        recovery_worker_id = :recovery_worker_id,
        recovery_milestone_lease_token = :recovery_lease_token,
        settle_operation_id = :operation_id,
        settle_project_revision = :project_revision,
        settle_authority_epoch = :authority_epoch
    WHERE attempt_id = :attempt_id AND project_id = :project_id AND attempt_state = 'running'
  `).run({
    ":ended_at": endedAt,
    ":settle_outcome": input.outcome,
    ":recovery_worker_id": input.recovery?.workerId ?? null,
    ":recovery_lease_token": input.recovery?.milestoneLeaseToken ?? null,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
    ":attempt_id": input.attemptId,
    ":project_id": context.projectId,
  });
  if (changes(updated) !== 1) throw new Error("Attempt settlement did not update exactly one row");

  const resultId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_attempt_results (
      result_id, project_id, lifecycle_id, attempt_id, outcome,
      failure_class, summary, output_json, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :result_id, :project_id, :lifecycle_id, :attempt_id, :outcome,
      :failure_class, :summary, :output_json, :created_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":result_id": resultId,
    ":project_id": context.projectId,
    ":lifecycle_id": attempt["lifecycle_id"],
    ":attempt_id": input.attemptId,
    ":outcome": input.outcome,
    ":failure_class": input.failureClass,
    ":summary": input.summary,
    ":output_json": outputJson,
    ":created_at": createdAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return {
    attemptId: input.attemptId,
    resultId,
    attemptState: "settled",
    outcome: input.outcome,
  };
}
