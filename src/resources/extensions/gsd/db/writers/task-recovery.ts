// Project/App: gsd-pi
// File Purpose: Context-bound writers for durable Task failures, recovery actions, Blockers, and Work Checkpoints.

import { randomUUID } from "node:crypto";

import type {
  HumanBlockerKind,
  RecoveryDecision,
  RecoveryOwner,
  RecoveryPolicyClass,
} from "../../recovery-policy.js";
import {
  canonicalDomainJson,
  type DomainJsonValue,
  type DomainOperationContext,
} from "../domain-operation.js";
import { getDb } from "../engine.js";
import { CURRENT_EVIDENCE_BACKED_FAILURE_VERDICT_SQL } from "../sql-constants.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

export type RecoveryAction = RecoveryDecision["action"];
export type WorkCheckpointKind =
  | "discovery"
  | "research"
  | "requirements"
  | "roadmap"
  | "delivery"
  | "answer"
  | "pause"
  | "correction"
  | "recap"
  | "handoff";

interface RouteHeadInput {
  lifecycleId: string;
  attemptId: string;
  kernelCheckpointId: string;
  boundaryStage?: "execute" | "verify";
}

export interface OpenRecoveryBlockerInput extends RouteHeadInput {
  blockerKind: HumanBlockerKind;
  resolutionOwner: "user" | "external";
  description: string;
  requestedAction: string;
  openedAt?: string;
}

export interface RecordFailureObservationInput extends RouteHeadInput {
  resultId: string;
  boundaryStage?: "execute" | "verify";
  blockerId?: string;
  recoveryOwner: RecoveryOwner;
  failureKind: string;
  failureFingerprint: string;
  summary: string;
  evidence: DomainJsonValue;
  observedAt?: string;
}

export interface RecoveryBudgetInput {
  lifecycleId: string;
  failureKind: string;
  failureFingerprint: string;
  policyClass: RecoveryPolicyClass;
  maxUses: 1 | 2;
  policyVersion: string;
  createdAt?: string;
}

export interface RecordRecoveryActionInput {
  lifecycleId: string;
  failureObservationId: string;
  action: RecoveryAction;
  recoveryBudgetId?: string;
  targetLifecycleId?: string;
  blockerId?: string;
  rationale: string;
  policyVersion: string;
  selectedAt?: string;
}

export interface AppendRecoveryWorkCheckpointInput {
  lifecycleId: string;
  scopeKey: string;
  checkpointKind: WorkCheckpointKind;
  confirmedContext: string;
  unresolvedSummary: string;
  evidenceSummary: string;
  suggestedNextAction: string;
  createdAt?: string;
}

export interface GrantRecoveryWaiverInput {
  lifecycleId: string;
  requirementId: string;
  blockerId?: string;
  scope: string;
  rationale: string;
  grantedByActorType: "user" | "policy";
  grantedByActorId?: string;
  grantedAt?: string;
  expiresAt?: string;
}

export interface RecordRequirementDispositionInput {
  requirementId: string;
  disposition: "unsatisfied" | "satisfied" | "waived";
  waiverId?: string;
  supersedesDispositionId?: string;
  rationale: string;
  createdAt?: string;
}

export interface LegacyTaskStateInput {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

function requireOperation(
  context: Readonly<DomainOperationContext>,
  allowed: readonly string[],
): string {
  const operationType = requireActiveDomainOperationContext(context);
  if (!allowed.includes(operationType)) {
    throw new Error(`${allowed.join(" or ")} Domain Operation required`);
  }
  return operationType;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be blank`);
  return normalized;
}

function requireTimestamp(value: string | undefined, field: string): string {
  const supplied = value ?? new Date().toISOString();
  const timestamp = Date.parse(supplied);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be a valid timestamp`);
  return new Date(timestamp).toISOString();
}

function normalizedKey(value: string, field: string): string {
  return requireText(value, field).toLowerCase();
}

function changedRows(result: unknown): number {
  return Number((result as { changes?: number }).changes ?? 0);
}

function requireCurrentRouteHead(
  context: Readonly<DomainOperationContext>,
  input: RouteHeadInput & { resultId?: string },
): void {
  const resultJoin = input.resultId
    ? "JOIN workflow_attempt_results result ON result.attempt_id = attempt.attempt_id AND result.project_id = attempt.project_id"
    : "";
  let resultGuard = "";
  if (input.resultId) {
    resultGuard = input.boundaryStage === "verify"
      ? `AND result.result_id = :result_id
         AND result.outcome = 'succeeded'
         AND ${CURRENT_EVIDENCE_BACKED_FAILURE_VERDICT_SQL}`
      : "AND result.result_id = :result_id AND result.outcome IN ('failed', 'interrupted')";
  }
  const parameters: Record<string, unknown> = {
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":attempt_id": input.attemptId,
    ":checkpoint_id": input.kernelCheckpointId,
  };
  if (input.resultId) parameters[":result_id"] = input.resultId;
  const head = getDb().prepare(`
    SELECT 1 AS present
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_execution_attempts attempt
      ON attempt.lifecycle_id = lifecycle.lifecycle_id
     AND attempt.project_id = lifecycle.project_id
    ${resultJoin}
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.lifecycle_id = lifecycle.lifecycle_id
     AND checkpoint.attempt_id = attempt.attempt_id
     AND checkpoint.project_id = lifecycle.project_id
    WHERE lifecycle.project_id = :project_id
      AND lifecycle.lifecycle_id = :lifecycle_id
      AND attempt.attempt_id = :attempt_id
      AND attempt.attempt_state = 'settled'
      AND checkpoint.kernel_checkpoint_id = :checkpoint_id
      AND checkpoint.next_stage = 'route'
      ${resultGuard}
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
      )
  `).get(parameters);
  if (!head) throw new Error("Task recovery requires the current route head");
}

export function openRecoveryBlocker(
  context: Readonly<DomainOperationContext>,
  input: OpenRecoveryBlockerInput,
): { blockerId: string; blockerStatus: "open" } {
  requireOperation(context, ["attempt.route", "task.blocker.open"]);
  requireCurrentRouteHead(context, input);
  if (input.blockerKind === "external_dependency" && input.resolutionOwner !== "external") {
    throw new Error("external_dependency recovery requires an external owner");
  }
  if (input.blockerKind !== "external_dependency" && input.resolutionOwner !== "user") {
    throw new Error(`${input.blockerKind} recovery requires a user owner`);
  }
  const blockerId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_blockers (
      blocker_id, project_id, lifecycle_id, blocker_kind, resolution_owner,
      blocker_status, description, requested_action, resolution, opened_at,
      opened_operation_id, opened_project_revision, opened_authority_epoch
    ) VALUES (
      :blocker_id, :project_id, :lifecycle_id, :blocker_kind, :resolution_owner,
      'open', :description, :requested_action, '', :opened_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":blocker_id": blockerId,
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":blocker_kind": input.blockerKind,
    ":resolution_owner": input.resolutionOwner,
    ":description": requireText(input.description, "description"),
    ":requested_action": requireText(input.requestedAction, "requestedAction"),
    ":opened_at": requireTimestamp(input.openedAt, "openedAt"),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return { blockerId, blockerStatus: "open" };
}

export function resolveRecoveryBlocker(
  context: Readonly<DomainOperationContext>,
  input: {
    blockerId: string;
    disposition: "resolved" | "dismissed";
    resolution: string;
    resolvedAt?: string;
  },
): { blockerId: string; blockerStatus: "resolved" | "dismissed" } {
  requireOperation(context, ["task.blocker.resolve"]);
  const blockerId = requireText(input.blockerId, "blockerId");
  const updated = getDb().prepare(`
    UPDATE workflow_blockers
    SET blocker_status = :status,
        resolution = :resolution,
        resolved_at = :resolved_at,
        resolved_operation_id = :operation_id,
        resolved_project_revision = :project_revision,
        resolved_authority_epoch = :authority_epoch
    WHERE blocker_id = :blocker_id
      AND project_id = :project_id
      AND blocker_status = 'open'
  `).run({
    ":status": input.disposition,
    ":resolution": requireText(input.resolution, "resolution"),
    ":resolved_at": requireTimestamp(input.resolvedAt, "resolvedAt"),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
    ":blocker_id": blockerId,
    ":project_id": context.projectId,
  });
  if (changedRows(updated) !== 1) throw new Error("Recovery Blocker must be the current open Blocker");
  return { blockerId, blockerStatus: input.disposition };
}

export function recordFailureObservation(
  context: Readonly<DomainOperationContext>,
  input: RecordFailureObservationInput,
): { failureObservationId: string } {
  requireOperation(context, ["attempt.route"]);
  requireCurrentRouteHead(context, input);
  const failureObservationId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_failure_observations (
      failure_observation_id, project_id, lifecycle_id, attempt_id, result_id,
      blocker_id, recovery_owner, boundary_stage, failure_kind,
      failure_fingerprint, summary, evidence_json, observed_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :observation_id, :project_id, :lifecycle_id, :attempt_id, :result_id,
      :blocker_id, :recovery_owner, :boundary_stage, :failure_kind,
      :failure_fingerprint, :summary, :evidence_json, :observed_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":observation_id": failureObservationId,
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":attempt_id": input.attemptId,
    ":result_id": input.resultId,
    ":blocker_id": input.blockerId ?? null,
    ":recovery_owner": input.recoveryOwner,
    ":boundary_stage": input.boundaryStage ?? "execute",
    ":failure_kind": normalizedKey(input.failureKind, "failureKind"),
    ":failure_fingerprint": normalizedKey(input.failureFingerprint, "failureFingerprint"),
    ":summary": requireText(input.summary, "summary"),
    ":evidence_json": canonicalDomainJson(input.evidence),
    ":observed_at": requireTimestamp(input.observedAt, "observedAt"),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return { failureObservationId };
}

export function createOrReadRecoveryBudget(
  context: Readonly<DomainOperationContext>,
  input: RecoveryBudgetInput,
): { recoveryBudgetId: string; created: boolean } {
  requireOperation(context, ["attempt.route"]);
  const failureKind = normalizedKey(input.failureKind, "failureKind");
  const failureFingerprint = normalizedKey(input.failureFingerprint, "failureFingerprint");
  const policyVersion = requireText(input.policyVersion, "policyVersion");
  const expectedMax = input.policyClass === "deterministic-repair" ? 1 : 2;
  if (input.maxUses !== expectedMax) {
    throw new Error(`${input.policyClass} recovery budget requires maxUses ${expectedMax}`);
  }
  const existing = getDb().prepare(`
    SELECT recovery_budget_id, max_uses, policy_version
    FROM workflow_recovery_budgets
    WHERE project_id = :project_id
      AND lifecycle_id = :lifecycle_id
      AND failure_kind = :failure_kind
      AND failure_fingerprint = :failure_fingerprint
      AND policy_class = :policy_class
  `).get({
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":failure_kind": failureKind,
    ":failure_fingerprint": failureFingerprint,
    ":policy_class": input.policyClass,
  }) as Record<string, unknown> | undefined;
  if (existing) {
    if (Number(existing["max_uses"]) !== input.maxUses || existing["policy_version"] !== policyVersion) {
      throw new Error("Existing recovery budget policy does not match the requested policy");
    }
    return { recoveryBudgetId: String(existing["recovery_budget_id"]), created: false };
  }

  const recoveryBudgetId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_recovery_budgets (
      recovery_budget_id, project_id, lifecycle_id, failure_kind,
      failure_fingerprint, policy_class, max_uses, policy_version, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :budget_id, :project_id, :lifecycle_id, :failure_kind,
      :failure_fingerprint, :policy_class, :max_uses, :policy_version, :created_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":budget_id": recoveryBudgetId,
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":failure_kind": failureKind,
    ":failure_fingerprint": failureFingerprint,
    ":policy_class": input.policyClass,
    ":max_uses": input.maxUses,
    ":policy_version": policyVersion,
    ":created_at": requireTimestamp(input.createdAt, "createdAt"),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return { recoveryBudgetId, created: true };
}

export function recordRecoveryAction(
  context: Readonly<DomainOperationContext>,
  input: RecordRecoveryActionInput,
): { recoveryActionId: string; action: RecoveryAction } {
  requireOperation(context, ["attempt.route"]);
  const recoveryActionId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_recovery_actions (
      recovery_action_id, project_id, lifecycle_id, failure_observation_id,
      action, recovery_budget_id, target_lifecycle_id, blocker_id,
      rationale, policy_version, selected_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :action_id, :project_id, :lifecycle_id, :observation_id,
      :action, :budget_id, :target_lifecycle_id, :blocker_id,
      :rationale, :policy_version, :selected_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":action_id": recoveryActionId,
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":observation_id": input.failureObservationId,
    ":action": input.action,
    ":budget_id": input.recoveryBudgetId ?? null,
    ":target_lifecycle_id": input.targetLifecycleId ?? null,
    ":blocker_id": input.blockerId ?? null,
    ":rationale": requireText(input.rationale, "rationale"),
    ":policy_version": requireText(input.policyVersion, "policyVersion"),
    ":selected_at": requireTimestamp(input.selectedAt, "selectedAt"),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return { recoveryActionId, action: input.action };
}

export function appendRecoveryWorkCheckpoint(
  context: Readonly<DomainOperationContext>,
  input: AppendRecoveryWorkCheckpointInput,
): { checkpointId: string; sequence: number } {
  requireOperation(context, [
    "attempt.route",
    "task.blocker.resolve",
    "task.checkpoint.append",
    "task.recovery.resume",
    "task.reopen",
    "task.cancel",
  ]);
  const scopeKey = normalizedKey(input.scopeKey, "scopeKey");
  const head = getDb().prepare(`
    SELECT checkpoint_id, lifecycle_id, sequence
    FROM workflow_work_checkpoints checkpoint
    WHERE checkpoint.project_id = :project_id
      AND checkpoint.scope_key = :scope_key
      AND NOT EXISTS (
        SELECT 1 FROM workflow_work_checkpoints successor
        WHERE successor.previous_checkpoint_id = checkpoint.checkpoint_id
      )
  `).get({
    ":project_id": context.projectId,
    ":scope_key": scopeKey,
  }) as Record<string, unknown> | undefined;
  if (head && head["lifecycle_id"] !== input.lifecycleId) {
    throw new Error("Work Checkpoint scope belongs to a different lifecycle");
  }
  const checkpointId = randomUUID();
  const sequence = Number(head?.["sequence"] ?? 0) + 1;
  getDb().prepare(`
    INSERT INTO workflow_work_checkpoints (
      checkpoint_id, project_id, scope_key, lifecycle_id, checkpoint_kind,
      sequence, previous_checkpoint_id, confirmed_context, unresolved_summary,
      evidence_summary, suggested_next_action, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :checkpoint_id, :project_id, :scope_key, :lifecycle_id, :checkpoint_kind,
      :sequence, :previous_checkpoint_id, :confirmed_context, :unresolved_summary,
      :evidence_summary, :suggested_next_action, :created_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":checkpoint_id": checkpointId,
    ":project_id": context.projectId,
    ":scope_key": scopeKey,
    ":lifecycle_id": input.lifecycleId,
    ":checkpoint_kind": input.checkpointKind,
    ":sequence": sequence,
    ":previous_checkpoint_id": head?.["checkpoint_id"] ?? null,
    ":confirmed_context": input.confirmedContext,
    ":unresolved_summary": input.unresolvedSummary,
    ":evidence_summary": input.evidenceSummary,
    ":suggested_next_action": input.suggestedNextAction,
    ":created_at": requireTimestamp(input.createdAt, "createdAt"),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return { checkpointId, sequence };
}

function updateLegacyTaskState(
  context: Readonly<DomainOperationContext>,
  input: LegacyTaskStateInput,
  operationType: "task.reopen" | "task.cancel",
  status: "pending" | "skipped",
): void {
  requireOperation(context, [operationType]);
  const updated = getDb().prepare(`
    UPDATE tasks
    SET status = :status, completed_at = NULL
    WHERE milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND id = :task_id
  `).run({
    ":status": status,
    ":milestone_id": requireText(input.milestoneId, "milestoneId"),
    ":slice_id": requireText(input.sliceId, "sliceId"),
    ":task_id": requireText(input.taskId, "taskId"),
  });
  if (changedRows(updated) !== 1) throw new Error("Task compatibility state update must affect one row");
}

export function reopenLegacyTaskState(
  context: Readonly<DomainOperationContext>,
  input: LegacyTaskStateInput,
): void {
  updateLegacyTaskState(context, input, "task.reopen", "pending");
}

export function cancelLegacyTaskState(
  context: Readonly<DomainOperationContext>,
  input: LegacyTaskStateInput,
): void {
  updateLegacyTaskState(context, input, "task.cancel", "skipped");
}

export function grantRecoveryWaiver(
  context: Readonly<DomainOperationContext>,
  input: GrantRecoveryWaiverInput,
): { waiverId: string; waiverStatus: "active" } {
  requireOperation(context, ["task.waiver.grant"]);
  if (input.grantedByActorType === "user" && !input.grantedByActorId?.trim()) {
    throw new Error("A user-granted Waiver requires grantedByActorId");
  }
  const grantedAt = requireTimestamp(input.grantedAt, "grantedAt");
  const expiresAt = input.expiresAt === undefined
    ? null
    : requireTimestamp(input.expiresAt, "expiresAt");
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(grantedAt)) {
    throw new Error("expiresAt must be after grantedAt");
  }
  const waiverId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_waivers (
      waiver_id, project_id, lifecycle_id, requirement_id, blocker_id,
      waiver_status, scope, rationale, granted_by_actor_type,
      granted_by_actor_id, granted_at, expires_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :waiver_id, :project_id, :lifecycle_id, :requirement_id, :blocker_id,
      'active', :scope, :rationale, :actor_type,
      :actor_id, :granted_at, :expires_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":waiver_id": waiverId,
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":requirement_id": requireText(input.requirementId, "requirementId"),
    ":blocker_id": input.blockerId ?? null,
    ":scope": requireText(input.scope, "scope"),
    ":rationale": requireText(input.rationale, "rationale"),
    ":actor_type": input.grantedByActorType,
    ":actor_id": input.grantedByActorId?.trim() || null,
    ":granted_at": grantedAt,
    ":expires_at": expiresAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return { waiverId, waiverStatus: "active" };
}

function currentDispositionHead(requirementId: string): string | null {
  const head = getDb().prepare(`
    SELECT disposition.disposition_id
    FROM workflow_requirement_dispositions disposition
    WHERE disposition.requirement_id = :requirement_id
      AND NOT EXISTS (
        SELECT 1 FROM workflow_requirement_dispositions successor
        WHERE successor.supersedes_disposition_id = disposition.disposition_id
      )
  `).get({ ":requirement_id": requirementId }) as Record<string, unknown> | undefined;
  return head ? String(head["disposition_id"]) : null;
}

export function recordRequirementDisposition(
  context: Readonly<DomainOperationContext>,
  input: RecordRequirementDispositionInput,
): { dispositionId: string; disposition: RecordRequirementDispositionInput["disposition"] } {
  requireOperation(context, ["task.disposition.record", "task.waiver.terminate", "milestone.reopen"]);
  const requirementId = requireText(input.requirementId, "requirementId");
  const currentHead = currentDispositionHead(requirementId);
  const suppliedHead = input.supersedesDispositionId ?? null;
  if (suppliedHead !== currentHead) {
    throw new Error("Requirement disposition must supersede the current head");
  }
  if (input.disposition === "waived" && !input.waiverId) {
    throw new Error("A waived disposition requires waiverId");
  }
  if (input.disposition !== "waived" && input.waiverId) {
    throw new Error(`${input.disposition} disposition cannot reference a Waiver`);
  }
  const dispositionId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_requirement_dispositions (
      disposition_id, project_id, requirement_id, disposition, waiver_id,
      supersedes_disposition_id, rationale, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :disposition_id, :project_id, :requirement_id, :disposition, :waiver_id,
      :supersedes_id, :rationale, :created_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":disposition_id": dispositionId,
    ":project_id": context.projectId,
    ":requirement_id": requirementId,
    ":disposition": input.disposition,
    ":waiver_id": input.waiverId ?? null,
    ":supersedes_id": suppliedHead,
    ":rationale": requireText(input.rationale, "rationale"),
    ":created_at": requireTimestamp(input.createdAt, "createdAt"),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return { dispositionId, disposition: input.disposition };
}

export function terminateRecoveryWaiver(
  context: Readonly<DomainOperationContext>,
  input: {
    waiverId: string;
    disposition: "revoked" | "expired";
    endedAt?: string;
  },
): { waiverId: string; waiverStatus: "revoked" | "expired" } {
  requireOperation(context, ["task.waiver.terminate", "milestone.reopen"]);
  const waiverId = requireText(input.waiverId, "waiverId");
  const updated = getDb().prepare(`
    UPDATE workflow_waivers
    SET waiver_status = :status,
        ended_at = :ended_at,
        ended_operation_id = :operation_id,
        ended_project_revision = :project_revision,
        ended_authority_epoch = :authority_epoch
    WHERE waiver_id = :waiver_id
      AND project_id = :project_id
      AND waiver_status = 'active'
  `).run({
    ":status": input.disposition,
    ":ended_at": requireTimestamp(input.endedAt, "endedAt"),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
    ":waiver_id": waiverId,
    ":project_id": context.projectId,
  });
  if (changedRows(updated) !== 1) throw new Error("Waiver must be the current active Waiver");
  return { waiverId, waiverStatus: input.disposition };
}
