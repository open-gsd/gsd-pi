// Project/App: gsd-pi
// File Purpose: Context-bound Slice cancellation across canonical and compatibility state.

import { randomUUID } from "node:crypto";

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import {
  adoptOrTransitionLifecycle,
  appendKernelCheckpoint,
  readLifecycleShadowComparison,
  requireActiveDomainOperationContext,
  settleAttemptWithResult,
  type CanonicalLifecycleStatus,
  type LifecycleShadowRecord,
} from "./lifecycle-commands.js";
import { compareLifecycleShadow, normalizeLegacyLifecycleStatus } from "../lifecycle-shadow-comparison.js";
import { terminalizeTaskExecutionDispatch } from "./task-execution.js";
import { ensurePendingSliceQ8 } from "./slice-companion-state.js";

interface SliceIdentity {
  milestoneId: string;
  sliceId: string;
}

interface HierarchyRow {
  taskId: string | null;
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

interface PlannedTask extends HierarchyRow {
  taskId: string;
  normalizedLegacyStatus: CanonicalLifecycleStatus;
  running: RunningAttempt | null;
  preserve: boolean;
}

export interface SliceCancellationInterruption {
  taskId: string;
  attemptId: string;
  resultId: string;
  kernelCheckpointId: string;
  dispatchId: number;
}

export interface SliceCancellationHierarchyResult {
  sliceLifecycleId: string;
  wasAlreadySkipped: boolean;
  cancelledTaskIds: string[];
  preservedTaskIds: string[];
  interruptions: SliceCancellationInterruption[];
  shadows: LifecycleShadowRecord[];
}

export interface SliceCancellationWaiver {
  waiverId: string;
  waiverStatus: "active";
}

export interface SliceReopenHierarchyResult {
  sliceLifecycleId: string;
  reopenedTaskIds: string[];
  revokedWaiverIds: string[];
  shadows: LifecycleShadowRecord[];
}

export interface SliceCompletionProof {
  taskId: string;
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  verdictId: string;
  evidenceId: string;
  kernelCheckpointId: string;
  testedSourceRevision: string;
}

export interface SliceCompletionHierarchyResult {
  sliceLifecycleId: string;
  completedAt: string;
  completedTaskIds: string[];
  cancelledTaskIds: string[];
  proofs: SliceCompletionProof[];
  q8Verdict: "pass" | "omitted";
  shadows: LifecycleShadowRecord[];
}

export class SliceLifecycleValidationError extends Error {}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new SliceLifecycleValidationError(`${field} must not be blank`);
  return normalized;
}

export function grantSliceCancellationWaiver(
  context: Readonly<DomainOperationContext>,
  input: {
    lifecycleId: string;
    milestoneId: string;
    sliceId: string;
    rationale: string;
    grantedByActorType: "user" | "policy";
    grantedByActorId?: string;
  },
): SliceCancellationWaiver {
  if (requireActiveDomainOperationContext(context) !== "slice.cancel") {
    throw new Error("slice.cancel Domain Operation required");
  }
  const actorId = input.grantedByActorId?.trim() || null;
  if (input.grantedByActorType === "user" && !actorId) {
    throw new SliceLifecycleValidationError("A user-authorized Slice cancellation requires actor identity");
  }
  const scope = `slice:${requireText(input.milestoneId, "milestoneId")}/${requireText(input.sliceId, "sliceId")}`;
  const existing = getDb().prepare(`
    SELECT waiver_id
    FROM workflow_waivers
    WHERE lifecycle_id = :lifecycle_id
      AND waiver_status = 'active'
      AND scope = :scope
  `).all({
    ":lifecycle_id": requireText(input.lifecycleId, "lifecycleId"),
    ":scope": scope,
  }) as Array<Record<string, unknown>>;
  if (existing.length > 1) {
    throw new SliceLifecycleValidationError("Slice cancellation found multiple active Waivers");
  }
  if (existing.length === 1) {
    return { waiverId: String(existing[0]!["waiver_id"]), waiverStatus: "active" };
  }
  const waiverId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_waivers (
      waiver_id, project_id, lifecycle_id, requirement_id, blocker_id,
      waiver_status, scope, rationale, granted_by_actor_type,
      granted_by_actor_id, granted_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :waiver_id, :project_id, :lifecycle_id, NULL, NULL,
      'active', :scope, :rationale, :actor_type,
      :actor_id, :granted_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":waiver_id": waiverId,
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId.trim(),
    ":scope": scope,
    ":rationale": requireText(input.rationale, "rationale"),
    ":actor_type": input.grantedByActorType,
    ":actor_id": actorId,
    ":granted_at": new Date().toISOString(),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return { waiverId, waiverStatus: "active" };
}

export interface PlanReconciliationAuthorization {
  taskId: string;
  requirementId: string;
  waiverId: string;
}

const PLAN_RECONCILIATION_OPERATION = "workflow.slice.plan";
const PLAN_RECONCILIATION_AUTHORIZATION_OPERATION = "workflow.slice.plan.authorization";

/**
 * Mint the cancellation authorization the slice-completion invariant demands
 * for a task that a plan-slice re-dispatch omits (#2217). Runs inside the
 * `workflow.slice.plan` Domain Operation and stamps the Waiver with that
 * operation's provenance; the matching waived Requirement Disposition is
 * recorded by `recordPlanReconciliationDisposition` in the fenced
 * authorization operation that follows, because the schema requires a Waiver
 * to predate its waived Disposition by at least one project revision.
 */
export function grantPlanReconciliationWaiver(
  context: Readonly<DomainOperationContext>,
  input: SliceIdentity & { taskId: string },
): PlanReconciliationAuthorization {
  if (requireActiveDomainOperationContext(context) !== PLAN_RECONCILIATION_OPERATION) {
    throw new Error("Plan reconciliation Waiver requires a workflow.slice.plan Domain Operation");
  }
  const slice = {
    milestoneId: requireText(input.milestoneId, "milestoneId"),
    sliceId: requireText(input.sliceId, "sliceId"),
  };
  const taskId = requireText(input.taskId, "taskId");
  const lifecycle = getDb().prepare(`
    SELECT lifecycle_id
    FROM workflow_item_lifecycles
    WHERE project_id = :project_id
      AND item_kind = 'task'
      AND milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND task_id = :task_id
  `).get({
    ":project_id": context.projectId,
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
    ":task_id": taskId,
  }) as Record<string, unknown> | undefined;
  if (!lifecycle) {
    throw new Error(
      `Plan reconciliation requires the cancelled Task lifecycle for ${slice.milestoneId}/${slice.sliceId}/${taskId}`,
    );
  }
  const lifecycleId = String(lifecycle["lifecycle_id"]);
  const requirementId = `plan-omission:${slice.milestoneId}/${slice.sliceId}/${taskId}`;
  const requirement = getDb().prepare(`
    SELECT id FROM requirements WHERE id = :id
  `).get({ ":id": requirementId }) as Record<string, unknown> | undefined;
  if (!requirement) {
    getDb().prepare(`
      INSERT INTO requirements (id, class, status, description, source)
      VALUES (:id, 'cancellation', 'waived', :description, 'plan-slice')
    `).run({
      ":id": requirementId,
      ":description": `Omission of task ${taskId} from slice ${slice.milestoneId}/${slice.sliceId} authorized by plan-slice reconciliation`,
    });
  }
  const scope = `task:${slice.milestoneId}/${slice.sliceId}/${taskId}`;
  const existing = getDb().prepare(`
    SELECT waiver_id
    FROM workflow_waivers
    WHERE lifecycle_id = :lifecycle_id
      AND requirement_id = :requirement_id
      AND waiver_status = 'active'
      AND scope = :scope
  `).all({
    ":lifecycle_id": lifecycleId,
    ":requirement_id": requirementId,
    ":scope": scope,
  }) as Array<Record<string, unknown>>;
  if (existing.length > 1) {
    throw new Error("Plan reconciliation found multiple active cancellation Waivers for one task");
  }
  if (existing.length === 1) {
    return { taskId, requirementId, waiverId: String(existing[0]!["waiver_id"]) };
  }
  const waiverId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_waivers (
      waiver_id, project_id, lifecycle_id, requirement_id, blocker_id,
      waiver_status, scope, rationale, granted_by_actor_type,
      granted_by_actor_id, granted_at, expires_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :waiver_id, :project_id, :lifecycle_id, :requirement_id, NULL,
      'active', :scope, :rationale, 'policy',
      NULL, :granted_at, NULL,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":waiver_id": waiverId,
    ":project_id": context.projectId,
    ":lifecycle_id": lifecycleId,
    ":requirement_id": requirementId,
    ":scope": scope,
    ":rationale": `Plan-slice reconciliation omitted task ${taskId} from slice ${slice.milestoneId}/${slice.sliceId}; the omission is authorized for slice completion`,
    ":granted_at": new Date().toISOString(),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return { taskId, requirementId, waiverId };
}

/**
 * Record the waived Requirement Disposition that binds a reconciliation
 * Waiver into a current authorized cancellation for slice completion. The
 * schema's waiver-authority trigger requires the Waiver's project revision to
 * strictly precede the Disposition's, so this runs in its own fenced
 * `workflow.slice.plan.authorization` Domain Operation after the plan
 * operation commits.
 */
export function recordPlanReconciliationDisposition(
  context: Readonly<DomainOperationContext>,
  input: PlanReconciliationAuthorization,
): void {
  if (requireActiveDomainOperationContext(context) !== PLAN_RECONCILIATION_AUTHORIZATION_OPERATION) {
    throw new Error("Plan reconciliation Disposition requires a workflow.slice.plan.authorization Domain Operation");
  }
  const requirementId = requireText(input.requirementId, "requirementId");
  const waiverId = requireText(input.waiverId, "waiverId");
  const head = getDb().prepare(`
    SELECT disposition_id
    FROM workflow_requirement_dispositions
    WHERE requirement_id = :requirement_id
      AND NOT EXISTS (
        SELECT 1 FROM workflow_requirement_dispositions successor
        WHERE successor.supersedes_disposition_id = workflow_requirement_dispositions.disposition_id
      )
  `).get({ ":requirement_id": requirementId }) as Record<string, unknown> | undefined;
  getDb().prepare(`
    INSERT INTO workflow_requirement_dispositions (
      disposition_id, project_id, requirement_id, disposition, waiver_id,
      supersedes_disposition_id, rationale, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :disposition_id, :project_id, :requirement_id, 'waived', :waiver_id,
      :supersedes_id, :rationale, :created_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":disposition_id": randomUUID(),
    ":project_id": context.projectId,
    ":requirement_id": requirementId,
    ":waiver_id": waiverId,
    ":supersedes_id": head ? String(head["disposition_id"]) : null,
    ":rationale": "Waived by plan-slice reconciliation for the omitted task",
    ":created_at": new Date().toISOString(),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
}

function revokeSliceCancellationWaivers(
  context: Readonly<DomainOperationContext>,
  lifecycleId: string,
  scope: string,
): string[] {
  const rows = getDb().prepare(`
    SELECT waiver_id
    FROM workflow_waivers
    WHERE lifecycle_id = :lifecycle_id
      AND waiver_status = 'active'
      AND scope = :scope
    ORDER BY granted_at, waiver_id
  `).all({ ":lifecycle_id": lifecycleId, ":scope": scope }) as Array<Record<string, unknown>>;
  const endedAt = new Date().toISOString();
  for (const row of rows) {
    const updated = getDb().prepare(`
      UPDATE workflow_waivers
      SET waiver_status = 'revoked', ended_at = :ended_at,
          ended_operation_id = :operation_id,
          ended_project_revision = :project_revision,
          ended_authority_epoch = :authority_epoch
      WHERE waiver_id = :waiver_id AND waiver_status = 'active'
    `).run({
      ":waiver_id": String(row["waiver_id"]),
      ":ended_at": endedAt,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    if (Number((updated as { changes?: number }).changes ?? 0) !== 1) {
      throw new Error("Slice reopen must revoke each active cancellation Waiver exactly once");
    }
  }
  return rows.map((row) => String(row["waiver_id"]));
}

function runningAttempt(lifecycleId: string): RunningAttempt | null {
  const attempts = getDb().prepare(`
    SELECT attempt.attempt_id, attempt.coordination_dispatch_id,
           attempt.worker_id, attempt.milestone_lease_token
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    JOIN milestone_leases lease
      ON lease.milestone_id = lifecycle.milestone_id
     AND lease.worker_id = attempt.worker_id
     AND lease.fencing_token = attempt.milestone_lease_token
     AND lease.status = 'held'
     AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE attempt.lifecycle_id = :lifecycle_id
      AND attempt.attempt_state = 'running'
  `).all({ ":lifecycle_id": lifecycleId }) as Array<Record<string, unknown>>;
  if (attempts.length > 1) throw new SliceLifecycleValidationError("Task lifecycle has multiple running Attempts");
  const attempt = attempts[0];
  if (!attempt) return null;
  const checkpoint = getDb().prepare(`
    SELECT checkpoint.kernel_checkpoint_id
    FROM workflow_kernel_checkpoints checkpoint
    WHERE checkpoint.lifecycle_id = :lifecycle_id
      AND checkpoint.attempt_id = :attempt_id
      AND checkpoint.next_stage = 'execute'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
      )
  `).get({
    ":lifecycle_id": lifecycleId,
    ":attempt_id": attempt["attempt_id"],
  }) as Record<string, unknown> | undefined;
  if (!checkpoint) throw new SliceLifecycleValidationError("Running Task Attempt requires the current execute Kernel head");
  const dispatchId = Number(attempt["coordination_dispatch_id"]);
  const leaseToken = Number(attempt["milestone_lease_token"]);
  const workerId = String(attempt["worker_id"] ?? "");
  if (!Number.isSafeInteger(dispatchId) || dispatchId <= 0 ||
      !Number.isSafeInteger(leaseToken) || leaseToken <= 0 || !workerId) {
    throw new SliceLifecycleValidationError("Running Task Attempt has incomplete dispatch ownership");
  }
  return {
    attemptId: String(attempt["attempt_id"]),
    kernelCheckpointId: String(checkpoint["kernel_checkpoint_id"]),
    dispatchId,
    workerId,
    milestoneLeaseToken: leaseToken,
  };
}

function requireMatchingShadow(row: HierarchyRow, entity: string): void {
  if (!row.lifecycleStatus) return;
  const comparison = compareLifecycleShadow(row.legacyStatus, row.lifecycleStatus);
  if (comparison.kind !== "match" && comparison.kind !== "semantic_match_exact_delta") {
    throw new SliceLifecycleValidationError(`${entity} canonical and legacy lifecycle mismatch`);
  }
}

function requireNoProgressedDownstreamSlices(slice: SliceIdentity): void {
  const downstream = getDb().prepare(`
    WITH RECURSIVE reachable(slice_id) AS (
      SELECT candidate.id
      FROM slices candidate
      JOIN json_each(candidate.depends) dependency
        ON CAST(dependency.value AS TEXT) = :slice_id
      WHERE candidate.milestone_id = :milestone_id
      UNION
      SELECT candidate.id
      FROM slices candidate
      JOIN json_each(candidate.depends) dependency
      JOIN reachable prior
        ON CAST(dependency.value AS TEXT) = prior.slice_id
      WHERE candidate.milestone_id = :milestone_id
    )
    SELECT candidate.id, candidate.status AS legacy_status,
           lifecycle.lifecycle_status AS canonical_status
    FROM reachable
    JOIN slices candidate
      ON candidate.milestone_id = :milestone_id
     AND candidate.id = reachable.slice_id
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'slice'
     AND lifecycle.milestone_id = candidate.milestone_id
     AND lifecycle.slice_id = candidate.id
     AND lifecycle.task_id IS NULL
    WHERE candidate.id != :slice_id
    ORDER BY candidate.sequence, candidate.id
  `).all({
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
  }) as Array<Record<string, unknown>>;

  const progressed = downstream.find((candidate) => {
    const legacy = normalizeLegacyLifecycleStatus(String(candidate["legacy_status"]));
    const canonical = candidate["canonical_status"] === null
      ? null
      : String(candidate["canonical_status"]);
    return legacy === "in_progress" || legacy === "paused" || legacy === "completed" ||
      canonical === "in_progress" || canonical === "paused" || canonical === "completed";
  });
  if (progressed) {
    throw new SliceLifecycleValidationError(
      `cannot reopen Slice ${slice.sliceId} while downstream Slice ${String(progressed["id"])} has progressed; reopen downstream work first`,
    );
  }
}

function currentCompletionProof(lifecycleId: string, taskId: string): SliceCompletionProof | null {
  const proof = getDb().prepare(`
    SELECT attempt.attempt_id, result.result_id, verdict.verdict_id,
           evidence.evidence_id, checkpoint.kernel_checkpoint_id,
           verdict.tested_source_revision
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_operations publication
      ON publication.operation_id = lifecycle.last_operation_id
     AND publication.operation_type = 'task.completion.publish'
    JOIN workflow_domain_events published
      ON published.operation_id = publication.operation_id
     AND published.event_type = 'task.completion.published'
     AND published.entity_id = lifecycle.milestone_id || '/' || lifecycle.slice_id || '/' || lifecycle.task_id
    JOIN workflow_execution_attempts attempt
      ON attempt.attempt_id = json_extract(published.payload_json, '$.attemptId')
     AND attempt.lifecycle_id = lifecycle.lifecycle_id
     AND attempt.attempt_state = 'settled'
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.lifecycle_id = lifecycle.lifecycle_id
     AND result.outcome = 'succeeded'
    JOIN workflow_acceptance_criteria criterion
      ON criterion.lifecycle_id = lifecycle.lifecycle_id
     AND criterion.criterion_key = 'host-technical-verification'
     AND NOT EXISTS (
       SELECT 1 FROM workflow_acceptance_criteria successor
       WHERE successor.supersedes_criterion_id = criterion.criterion_id
     )
    JOIN workflow_technical_verdicts verdict
      ON verdict.criterion_id = criterion.criterion_id
     AND verdict.lifecycle_id = lifecycle.lifecycle_id
     AND verdict.attempt_id = attempt.attempt_id
     AND verdict.verdict = 'pass'
     AND NOT EXISTS (
       SELECT 1 FROM workflow_technical_verdicts successor
       WHERE successor.supersedes_verdict_id = verdict.verdict_id
     )
    JOIN workflow_verification_evidence evidence
      ON evidence.verdict_id = verdict.verdict_id
     AND evidence.attempt_id = attempt.attempt_id
     AND evidence.observation = 'passed'
     AND evidence.source_revision = verdict.tested_source_revision
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.lifecycle_id = lifecycle.lifecycle_id
     AND checkpoint.attempt_id = attempt.attempt_id
     AND checkpoint.next_stage = 'settled'
     AND NOT EXISTS (
       SELECT 1 FROM workflow_kernel_checkpoints successor
       WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
     )
    WHERE lifecycle.lifecycle_id = :lifecycle_id
      AND lifecycle.item_kind = 'task'
      AND lifecycle.lifecycle_status = 'completed'
  `).get({ ":lifecycle_id": lifecycleId }) as Record<string, unknown> | undefined;
  if (!proof) return null;
  return {
    taskId,
    lifecycleId,
    attemptId: String(proof["attempt_id"]),
    resultId: String(proof["result_id"]),
    verdictId: String(proof["verdict_id"]),
    evidenceId: String(proof["evidence_id"]),
    kernelCheckpointId: String(proof["kernel_checkpoint_id"]),
    testedSourceRevision: String(proof["tested_source_revision"]),
  };
}

function hasCurrentCancellationAuthorization(lifecycleId: string, completedAt: string): boolean {
  return Boolean(getDb().prepare(`
    SELECT 1
    FROM workflow_waivers waiver
    JOIN workflow_requirement_dispositions disposition
      ON disposition.waiver_id = waiver.waiver_id
     AND disposition.requirement_id = waiver.requirement_id
     AND disposition.disposition = 'waived'
    WHERE waiver.lifecycle_id = :lifecycle_id
      AND waiver.waiver_status = 'active'
      AND (waiver.expires_at IS NULL OR waiver.expires_at > :completed_at)
      AND NOT EXISTS (
        SELECT 1 FROM workflow_requirement_dispositions successor
        WHERE successor.supersedes_disposition_id = disposition.disposition_id
      )
    LIMIT 1
  `).get({
    ":lifecycle_id": lifecycleId,
    ":completed_at": completedAt,
  }));
}

export function completeSliceHierarchy(
  context: Readonly<DomainOperationContext>,
  input: SliceIdentity & { operationalReadiness: string },
): SliceCompletionHierarchyResult {
  if (requireActiveDomainOperationContext(context) !== "slice.complete") {
    throw new Error("Slice completion requires a slice.complete Domain Operation");
  }
  const slice = {
    milestoneId: requireText(input.milestoneId, "milestoneId"),
    sliceId: requireText(input.sliceId, "sliceId"),
  };
  const operation = getDb().prepare(`
    SELECT created_at FROM workflow_operations WHERE operation_id = :operation_id
  `).get({ ":operation_id": context.operationId }) as Record<string, unknown> | undefined;
  if (!operation) throw new Error("Slice completion operation timestamp is missing");
  const completedAt = String(operation["created_at"]);

  const milestone = getDb().prepare(`
    SELECT milestone.status AS legacy_status, lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM milestones milestone
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'milestone' AND lifecycle.milestone_id = milestone.id
     AND lifecycle.slice_id IS NULL
    WHERE milestone.id = :milestone_id
  `).get({ ":milestone_id": slice.milestoneId }) as Record<string, unknown> | undefined;
  if (!milestone) throw new SliceLifecycleValidationError(`milestone not found: ${slice.milestoneId}`);
  const milestoneStatus = normalizeLegacyLifecycleStatus(String(milestone["legacy_status"]));
  if (!milestoneStatus || milestoneStatus === "completed" || milestoneStatus === "cancelled") {
    throw new SliceLifecycleValidationError(`cannot complete slice in a closed milestone: ${slice.milestoneId}`);
  }
  if (!milestone["lifecycle_id"] || !milestone["lifecycle_status"]) {
    throw new SliceLifecycleValidationError("Slice completion requires canonical Milestone lifecycle authority");
  }
  requireMatchingShadow({
    taskId: null,
    legacyStatus: String(milestone["legacy_status"]),
    lifecycleId: String(milestone["lifecycle_id"]),
    lifecycleStatus: String(milestone["lifecycle_status"]) as CanonicalLifecycleStatus,
  }, `Milestone ${slice.milestoneId}`);

  const target = getDb().prepare(`
    SELECT slice.status AS legacy_status, lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM slices slice
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'slice' AND lifecycle.milestone_id = slice.milestone_id
     AND lifecycle.slice_id = slice.id AND lifecycle.task_id IS NULL
    WHERE slice.milestone_id = :milestone_id AND slice.id = :slice_id
  `).get({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId }) as Record<string, unknown> | undefined;
  if (!target) throw new SliceLifecycleValidationError(`slice not found: ${slice.milestoneId}/${slice.sliceId}`);
  if (!target["lifecycle_id"] || !target["lifecycle_status"]) {
    throw new SliceLifecycleValidationError("Slice completion requires canonical Slice lifecycle authority");
  }
  const sliceState: HierarchyRow = {
    taskId: null,
    legacyStatus: String(target["legacy_status"]),
    lifecycleId: String(target["lifecycle_id"]),
    lifecycleStatus: String(target["lifecycle_status"]) as CanonicalLifecycleStatus,
  };
  requireMatchingShadow(sliceState, `Slice ${slice.sliceId}`);
  if (sliceState.lifecycleStatus === "completed" || sliceState.lifecycleStatus === "cancelled") {
    throw new SliceLifecycleValidationError(`Slice ${slice.sliceId} is already terminal`);
  }

  const tasks = getDb().prepare(`
    SELECT task.id AS task_id, task.status AS legacy_status,
           lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task' AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id AND task.slice_id = :slice_id
    ORDER BY task.sequence, task.id
  `).all({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId }) as Array<Record<string, unknown>>;
  if (tasks.length === 0) throw new SliceLifecycleValidationError(`no tasks found for slice ${slice.sliceId}`);

  const completedTaskIds: string[] = [];
  const cancelledTaskIds: string[] = [];
  const proofs: SliceCompletionProof[] = [];
  for (const task of tasks) {
    const taskId = String(task["task_id"]);
    const lifecycleId = task["lifecycle_id"] ? String(task["lifecycle_id"]) : "";
    if (!lifecycleId || !task["lifecycle_status"]) {
      throw new SliceLifecycleValidationError(`Task ${taskId} is missing canonical lifecycle authority`);
    }
    if (runningAttempt(lifecycleId)) {
      throw new SliceLifecycleValidationError(`Task ${taskId} has a running Attempt descendant`);
    }
    const state: HierarchyRow = {
      taskId,
      legacyStatus: String(task["legacy_status"]),
      lifecycleId,
      lifecycleStatus: String(task["lifecycle_status"]) as CanonicalLifecycleStatus,
    };
    requireMatchingShadow(state, `Task ${taskId}`);
    const legacyStatus = normalizeLegacyLifecycleStatus(state.legacyStatus);
    if (legacyStatus === "completed" && state.lifecycleStatus === "completed") {
      const proof = currentCompletionProof(lifecycleId, taskId);
      if (!proof) {
        throw new SliceLifecycleValidationError(`Task ${taskId} lacks current passing Technical Verdict and verification evidence`);
      }
      completedTaskIds.push(taskId);
      proofs.push(proof);
    } else if (legacyStatus === "cancelled" && state.lifecycleStatus === "cancelled") {
      if (!hasCurrentCancellationAuthorization(lifecycleId, completedAt)) {
        throw new SliceLifecycleValidationError(
          `Task ${taskId} cancellation lacks a current authorized Waiver disposition`,
        );
      }
      cancelledTaskIds.push(taskId);
    } else {
      throw new SliceLifecycleValidationError(`Task ${taskId} is not terminal with canonical and legacy parity`);
    }
  }

  const sliceLifecycle = adoptOrTransitionLifecycle(context, {
    itemKind: "slice", ...slice, lifecycleStatus: "completed",
  });
  const updated = getDb().prepare(`
    UPDATE slices SET status = 'complete', completed_at = :completed_at
    WHERE milestone_id = :milestone_id AND id = :slice_id
  `).run({
    ":completed_at": completedAt,
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
  });
  if (Number((updated as { changes?: number }).changes ?? 0) !== 1) {
    throw new Error("Slice completion must update exactly one compatibility Slice");
  }

  const readiness = input.operationalReadiness.trim();
  const q8Verdict = readiness ? "pass" : "omitted";
  const rationale = readiness
    ? "Operational Readiness section populated in slice summary"
    : "Operational Readiness section left empty — recorded as omitted";
  // Self-heal a missing slice-scope Q8 row before enforcing the precondition
  // (#1679): slices that reached completion via replan/reopen paths never had
  // the companion gate seeded, and throwing here permanently blocked closeout.
  ensurePendingSliceQ8(context, slice);
  const q8Rows = getDb().prepare(`
    SELECT status FROM quality_gates
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id
      AND gate_id = 'Q8' AND (task_id = '' OR task_id IS NULL)
  `).all({
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
  }) as Array<Record<string, unknown>>;
  if (q8Rows.length !== 1 || String(q8Rows[0]!["status"]) !== "pending") {
    throw new SliceLifecycleValidationError("Slice completion requires exactly one pending Q8 quality gate");
  }
  const gate = getDb().prepare(`
    UPDATE quality_gates
    SET status = 'complete', verdict = :verdict, rationale = :rationale,
        findings = :findings, evaluated_at = :evaluated_at
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id
      AND gate_id = 'Q8' AND (task_id = '' OR task_id IS NULL) AND status = 'pending'
  `).run({
    ":verdict": q8Verdict,
    ":rationale": rationale,
    ":findings": readiness,
    ":evaluated_at": completedAt,
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
  });
  if (Number((gate as { changes?: number }).changes ?? 0) !== 1) {
    throw new Error("Slice completion must close exactly one pending Q8 quality gate");
  }
  getDb().prepare(`
    INSERT INTO gate_runs (
      trace_id, turn_id, gate_id, gate_type, milestone_id, slice_id,
      outcome, failure_class, rationale, findings, attempt, max_attempts,
      retryable, evaluated_at
    ) VALUES (
      :trace_id, 'gate:Q8:slice', 'Q8', 'quality-gate', :milestone_id, :slice_id,
      :outcome, :failure_class, :rationale, :findings, 1, 1, 0, :evaluated_at
    )
  `).run({
    ":trace_id": `quality-gate:${slice.milestoneId}:${slice.sliceId}`,
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
    ":outcome": q8Verdict === "pass" ? "pass" : "manual-attention",
    ":failure_class": q8Verdict === "pass" ? "none" : "manual-attention",
    ":rationale": rationale,
    ":findings": readiness,
    ":evaluated_at": completedAt,
  });

  const shadows = [
    readLifecycleShadowComparison(context, { itemKind: "slice", ...slice }),
    ...tasks.map((task) => readLifecycleShadowComparison(context, {
      itemKind: "task",
      ...slice,
      taskId: String(task["task_id"]),
    })),
  ];
  if (shadows.some((shadow) => shadow.kind !== "match" && shadow.kind !== "semantic_match_exact_delta")) {
    throw new Error("Slice completion did not converge canonical and legacy lifecycle state");
  }
  return {
    sliceLifecycleId: sliceLifecycle.lifecycleId,
    completedAt,
    completedTaskIds,
    cancelledTaskIds,
    proofs,
    q8Verdict,
    shadows,
  };
}

function loadPlan(slice: SliceIdentity): {
  slice: HierarchyRow;
  normalizedSliceStatus: CanonicalLifecycleStatus;
  tasks: PlannedTask[];
} {
  const milestone = getDb().prepare(`
    SELECT milestone.status AS legacy_status,
           lifecycle.lifecycle_status AS lifecycle_status
    FROM milestones milestone
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'milestone'
     AND lifecycle.milestone_id = milestone.id
     AND lifecycle.slice_id IS NULL
    WHERE milestone.id = :milestone_id
  `).get({ ":milestone_id": slice.milestoneId }) as Record<string, unknown> | undefined;
  if (!milestone) throw new SliceLifecycleValidationError(`milestone not found: ${slice.milestoneId}`);
  const milestoneStatus = normalizeLegacyLifecycleStatus(String(milestone["legacy_status"]));
  if (!milestoneStatus) throw new SliceLifecycleValidationError(`Milestone ${slice.milestoneId} has an unknown legacy status`);
  if (milestoneStatus === "completed" || milestoneStatus === "cancelled") {
    throw new SliceLifecycleValidationError(`Cannot cancel a Slice in terminal Milestone ${slice.milestoneId}`);
  }
  if (milestone["lifecycle_status"]) {
    const parentShadow = compareLifecycleShadow(
      String(milestone["legacy_status"]),
      String(milestone["lifecycle_status"]),
    );
    if (parentShadow.kind !== "match" && parentShadow.kind !== "semantic_match_exact_delta") {
      throw new SliceLifecycleValidationError(`Milestone ${slice.milestoneId} canonical and legacy lifecycle mismatch`);
    }
    const canonicalParent = String(milestone["lifecycle_status"]);
    if (canonicalParent === "completed" || canonicalParent === "cancelled") {
      throw new SliceLifecycleValidationError(`Cannot cancel a Slice under terminal canonical Milestone ${slice.milestoneId}`);
    }
  }

  const sliceRow = getDb().prepare(`
    SELECT slice.status AS legacy_status, lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM slices slice
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'slice'
     AND lifecycle.milestone_id = slice.milestone_id
     AND lifecycle.slice_id = slice.id
     AND lifecycle.task_id IS NULL
    WHERE slice.milestone_id = :milestone_id AND slice.id = :slice_id
  `).get({
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
  }) as Record<string, unknown> | undefined;
  if (!sliceRow) throw new SliceLifecycleValidationError(`Slice ${slice.sliceId} not found in milestone ${slice.milestoneId}`);
  const target: HierarchyRow = {
    taskId: null,
    legacyStatus: String(sliceRow["legacy_status"]),
    lifecycleId: sliceRow["lifecycle_id"] ? String(sliceRow["lifecycle_id"]) : null,
    lifecycleStatus: sliceRow["lifecycle_status"]
      ? String(sliceRow["lifecycle_status"]) as CanonicalLifecycleStatus
      : null,
  };
  const normalizedSliceStatus = normalizeLegacyLifecycleStatus(target.legacyStatus);
  if (!normalizedSliceStatus) throw new SliceLifecycleValidationError(`Slice ${slice.sliceId} has an unknown legacy status`);
  if (normalizedSliceStatus === "completed") {
    throw new SliceLifecycleValidationError(`Slice ${slice.sliceId} is already complete — cannot skip.`);
  }
  requireMatchingShadow(target, `Slice ${slice.sliceId}`);

  const taskRows = getDb().prepare(`
    SELECT task.id AS task_id, task.status AS legacy_status,
           lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task'
     AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id
     AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id AND task.slice_id = :slice_id
    ORDER BY task.sequence, task.id
  `).all({
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
  }) as Array<Record<string, unknown>>;
  const tasks = taskRows.map((row): PlannedTask => {
    const taskId = String(row["task_id"]);
    const task = {
      taskId,
      legacyStatus: String(row["legacy_status"]),
      lifecycleId: row["lifecycle_id"] ? String(row["lifecycle_id"]) : null,
      lifecycleStatus: row["lifecycle_status"]
        ? String(row["lifecycle_status"]) as CanonicalLifecycleStatus
        : null,
    };
    const normalizedLegacyStatus = normalizeLegacyLifecycleStatus(task.legacyStatus);
    if (!normalizedLegacyStatus) throw new SliceLifecycleValidationError(`Task ${taskId} has an unknown legacy status`);
    const healsCancelledCompatibility = normalizedSliceStatus === "cancelled" &&
      task.lifecycleStatus === "cancelled" &&
      normalizedLegacyStatus !== "completed";
    if (!healsCancelledCompatibility) requireMatchingShadow(task, `Task ${task.taskId}`);
    const running = task.lifecycleId ? runningAttempt(task.lifecycleId) : null;
    if (task.lifecycleStatus === "in_progress" && !running) {
      throw new SliceLifecycleValidationError(`In-progress Task ${task.taskId} cancellation requires its running Attempt`);
    }
    if (task.lifecycleStatus !== "in_progress" && running) {
      throw new SliceLifecycleValidationError(`Only an in-progress Task may own a running Attempt (${task.taskId})`);
    }
    return {
      ...task,
      normalizedLegacyStatus,
      running,
      preserve: normalizedLegacyStatus === "completed" || normalizedLegacyStatus === "cancelled",
    };
  });
  return { slice: target, normalizedSliceStatus, tasks };
}

function updateLegacyTask(slice: SliceIdentity, taskId: string): void {
  const updated = getDb().prepare(`
    UPDATE tasks SET status = 'skipped', completed_at = NULL
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :task_id
  `).run({
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
    ":task_id": taskId,
  });
  if (Number((updated as { changes?: number }).changes ?? 0) !== 1) {
    throw new Error("Slice cancellation must update exactly one compatibility Task");
  }
}

export function cancelSliceHierarchy(
  context: Readonly<DomainOperationContext>,
  input: SliceIdentity & { reason: string },
): SliceCancellationHierarchyResult {
  if (requireActiveDomainOperationContext(context) !== "slice.cancel") {
    throw new Error("Slice cancellation requires a slice.cancel Domain Operation");
  }
  const slice = {
    milestoneId: requireText(input.milestoneId, "milestoneId"),
    sliceId: requireText(input.sliceId, "sliceId"),
  };
  const reason = requireText(input.reason, "reason");
  const plan = loadPlan(slice);
  const cancelledTaskIds: string[] = [];
  const preservedTaskIds: string[] = [];
  const interruptions: SliceCancellationInterruption[] = [];

  for (const task of plan.tasks) {
    if (task.preserve) {
      if (!task.lifecycleId) {
        adoptOrTransitionLifecycle(context, {
          itemKind: "task",
          ...slice,
          taskId: task.taskId,
          lifecycleStatus: task.normalizedLegacyStatus,
        });
      }
      preservedTaskIds.push(task.taskId);
      continue;
    }
    if (task.running) {
      const endedAt = new Date().toISOString();
      const result = settleAttemptWithResult(context, {
        attemptId: task.running.attemptId,
        outcome: "interrupted",
        failureClass: "slice-cancelled",
        summary: reason,
        output: { reason, slice },
        endedAt,
        cancellation: true,
      });
      terminalizeTaskExecutionDispatch(context, {
        dispatchId: task.running.dispatchId,
        workerId: task.running.workerId,
        milestoneLeaseToken: task.running.milestoneLeaseToken,
        outcome: "interrupted",
        endedAt,
        cancellation: true,
      });
      const kernel = appendKernelCheckpoint(context, {
        lifecycleId: task.lifecycleId!,
        attemptId: task.running.attemptId,
        nextStage: "route",
        previousKernelCheckpointId: task.running.kernelCheckpointId,
      });
      interruptions.push({
        taskId: task.taskId,
        attemptId: task.running.attemptId,
        resultId: result.resultId,
        kernelCheckpointId: kernel.kernelCheckpointId,
        dispatchId: task.running.dispatchId,
      });
    }
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      ...slice,
      taskId: task.taskId,
      lifecycleStatus: "cancelled",
      ...(!task.lifecycleId ? { adoptedFromStatus: task.normalizedLegacyStatus } : {}),
    });
    updateLegacyTask(slice, task.taskId);
    cancelledTaskIds.push(task.taskId);
  }

  const sliceLifecycle = adoptOrTransitionLifecycle(context, {
    itemKind: "slice",
    ...slice,
    lifecycleStatus: "cancelled",
    ...(!plan.slice.lifecycleId ? { adoptedFromStatus: plan.normalizedSliceStatus } : {}),
  });
  const updated = getDb().prepare(`
    UPDATE slices SET status = 'skipped', completed_at = NULL
    WHERE milestone_id = :milestone_id AND id = :slice_id
  `).run({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId });
  if (Number((updated as { changes?: number }).changes ?? 0) !== 1) {
    throw new Error("Slice cancellation must update exactly one compatibility Slice");
  }

  const shadows = [
    readLifecycleShadowComparison(context, { itemKind: "slice", ...slice }),
    ...plan.tasks.map((task) => readLifecycleShadowComparison(context, {
      itemKind: "task",
      ...slice,
      taskId: task.taskId,
    })),
  ];
  if (shadows.some((shadow) =>
    shadow.kind !== "match" && shadow.kind !== "semantic_match_exact_delta")) {
    throw new Error("Slice cancellation did not converge canonical and legacy lifecycle state");
  }
  return {
    sliceLifecycleId: sliceLifecycle.lifecycleId,
    wasAlreadySkipped: plan.normalizedSliceStatus === "cancelled",
    cancelledTaskIds,
    preservedTaskIds,
    interruptions,
    shadows,
  };
}

export function reopenSliceHierarchy(
  context: Readonly<DomainOperationContext>,
  input: SliceIdentity & { reason: string },
): SliceReopenHierarchyResult {
  if (requireActiveDomainOperationContext(context) !== "slice.reopen") {
    throw new Error("Slice reopen requires a slice.reopen Domain Operation");
  }
  const slice = {
    milestoneId: requireText(input.milestoneId, "milestoneId"),
    sliceId: requireText(input.sliceId, "sliceId"),
  };
  requireText(input.reason, "reason");
  requireNoProgressedDownstreamSlices(slice);
  const milestone = getDb().prepare(`
    SELECT milestone.status AS legacy_status, lifecycle.lifecycle_status
    FROM milestones milestone
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'milestone' AND lifecycle.milestone_id = milestone.id
     AND lifecycle.slice_id IS NULL
    WHERE milestone.id = :milestone_id
  `).get({ ":milestone_id": slice.milestoneId }) as Record<string, unknown> | undefined;
  if (!milestone) throw new SliceLifecycleValidationError(`milestone not found: ${slice.milestoneId}`);
  const milestoneStatus = normalizeLegacyLifecycleStatus(String(milestone["legacy_status"]));
  if (!milestoneStatus || milestoneStatus === "completed" || milestoneStatus === "cancelled") {
    throw new SliceLifecycleValidationError(`cannot reopen slice in a closed milestone: ${slice.milestoneId}`);
  }
  if (milestone["lifecycle_status"]) {
    if (["completed", "cancelled"].includes(String(milestone["lifecycle_status"]))) {
      throw new SliceLifecycleValidationError("cannot reopen slice under a terminal canonical milestone");
    }
    const shadow = compareLifecycleShadow(String(milestone["legacy_status"]), String(milestone["lifecycle_status"]));
    if (shadow.kind !== "match" && shadow.kind !== "semantic_match_exact_delta") {
      throw new SliceLifecycleValidationError("Milestone canonical and legacy lifecycle mismatch");
    }
  }
  const sliceRow = getDb().prepare(`
    SELECT slice.status AS legacy_status, lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM slices slice
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'slice' AND lifecycle.milestone_id = slice.milestone_id
     AND lifecycle.slice_id = slice.id AND lifecycle.task_id IS NULL
    WHERE slice.milestone_id = :milestone_id AND slice.id = :slice_id
  `).get({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId }) as Record<string, unknown> | undefined;
  if (!sliceRow) throw new SliceLifecycleValidationError(`slice not found: ${slice.milestoneId}/${slice.sliceId}`);
  const legacySliceStatus = normalizeLegacyLifecycleStatus(String(sliceRow["legacy_status"]));
  if (!legacySliceStatus) throw new SliceLifecycleValidationError(`Slice ${slice.sliceId} has an unknown legacy status`);
  const sliceState: HierarchyRow = {
    taskId: null,
    legacyStatus: String(sliceRow["legacy_status"]),
    lifecycleId: sliceRow["lifecycle_id"] ? String(sliceRow["lifecycle_id"]) : null,
    lifecycleStatus: sliceRow["lifecycle_status"] ? String(sliceRow["lifecycle_status"]) as CanonicalLifecycleStatus : null,
  };
  requireMatchingShadow(sliceState, `Slice ${slice.sliceId}`);
  const tasks = getDb().prepare(`
    SELECT task.id AS task_id, task.status AS legacy_status,
           lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task' AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id AND task.slice_id = :slice_id
    ORDER BY task.sequence, task.id
  `).all({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId }) as Array<Record<string, unknown>>;
  for (const task of tasks) {
    const lifecycleId = task["lifecycle_id"] ? String(task["lifecycle_id"]) : null;
    if (lifecycleId && runningAttempt(lifecycleId)) {
      throw new SliceLifecycleValidationError(`Task ${String(task["task_id"])} has a running Attempt descendant`);
    }
    const state: HierarchyRow = {
      taskId: String(task["task_id"]),
      legacyStatus: String(task["legacy_status"]),
      lifecycleId,
      lifecycleStatus: task["lifecycle_status"] ? String(task["lifecycle_status"]) as CanonicalLifecycleStatus : null,
    };
    requireMatchingShadow(state, `Task ${state.taskId}`);
    const legacyStatus = normalizeLegacyLifecycleStatus(state.legacyStatus);
    if (legacyStatus !== "completed" && legacyStatus !== "cancelled") {
      throw new SliceLifecycleValidationError(
        `slice ${slice.sliceId} is not complete because Task ${state.taskId} is not terminal`,
      );
    }
  }
  const terminalSlice = legacySliceStatus === "completed" || legacySliceStatus === "cancelled";
  if (!terminalSlice && (sliceState.lifecycleId || tasks.length === 0)) {
    throw new SliceLifecycleValidationError(`slice ${slice.sliceId} is not complete — nothing to reopen`);
  }
  const reopenedTaskIds: string[] = [];
  for (const task of tasks) {
    const taskId = String(task["task_id"]);
    const legacyStatus = normalizeLegacyLifecycleStatus(String(task["legacy_status"]))!;
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", ...slice, taskId, lifecycleStatus: "ready",
      ...(!task["lifecycle_id"] ? { adoptedFromStatus: legacyStatus } : {}),
    });
    const updated = getDb().prepare(`
      UPDATE tasks SET status = 'pending', completed_at = NULL
      WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :task_id
    `).run({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId, ":task_id": taskId });
    if (Number((updated as { changes?: number }).changes ?? 0) !== 1) throw new Error("Slice reopen must update one Task");
    reopenedTaskIds.push(taskId);
  }
  const sliceLifecycle = adoptOrTransitionLifecycle(context, {
    itemKind: "slice", ...slice, lifecycleStatus: "ready",
    ...(!sliceState.lifecycleId ? { adoptedFromStatus: legacySliceStatus } : {}),
  });
  const revokedWaiverIds = revokeSliceCancellationWaivers(
    context,
    sliceLifecycle.lifecycleId,
    `slice:${slice.milestoneId}/${slice.sliceId}`,
  );
  const updated = getDb().prepare(`
    UPDATE slices
    SET status = 'in_progress', completed_at = NULL,
        full_summary_md = '', full_uat_md = ''
    WHERE milestone_id = :milestone_id AND id = :slice_id
  `).run({ ":milestone_id": slice.milestoneId, ":slice_id": slice.sliceId });
  if (Number((updated as { changes?: number }).changes ?? 0) !== 1) throw new Error("Slice reopen must update one Slice");
  ensurePendingSliceQ8(context, slice);
  const shadows = [
    readLifecycleShadowComparison(context, { itemKind: "slice", ...slice }),
    ...reopenedTaskIds.map((taskId) => readLifecycleShadowComparison(context, { itemKind: "task", ...slice, taskId })),
  ];
  if (shadows.some((shadow) => shadow.kind !== "match" && shadow.kind !== "semantic_match_exact_delta")) {
    throw new Error("Slice reopen did not converge canonical and legacy lifecycle state");
  }
  return { sliceLifecycleId: sliceLifecycle.lifecycleId, reopenedTaskIds, revokedWaiverIds, shadows };
}

/**
 * Persist the rendered SUMMARY/UAT Markdown projections onto the compatibility
 * Slice row, fenced to the still-current completion operation. Returns false
 * (writing nothing) when the Slice lifecycle head has moved off this operation,
 * so callers can treat the projection as superseded rather than rebuild stale
 * completion output.
 */
export function setSliceCompletionSummaryProjectionIfCurrent(input: {
  milestoneId: string;
  sliceId: string;
  operationId: string;
  summaryMd: string;
  uatMd: string;
}): boolean {
  const updated = getDb().prepare(`
    UPDATE slices
    SET full_summary_md = :summary_md, full_uat_md = :uat_md
    WHERE milestone_id = :milestone_id
      AND id = :slice_id
      AND EXISTS (
        SELECT 1 FROM workflow_item_lifecycles lifecycle
        WHERE lifecycle.item_kind = 'slice'
          AND lifecycle.milestone_id = :milestone_id
          AND lifecycle.slice_id = :slice_id
          AND lifecycle.task_id IS NULL
          AND lifecycle.lifecycle_status = 'completed'
          AND lifecycle.last_operation_id = :operation_id
      )
  `).run({
    ":milestone_id": input.milestoneId,
    ":slice_id": input.sliceId,
    ":operation_id": input.operationId,
    ":summary_md": input.summaryMd,
    ":uat_md": input.uatMd,
  });
  return Number((updated as { changes?: number }).changes ?? 0) === 1;
}
