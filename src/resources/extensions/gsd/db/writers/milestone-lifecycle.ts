// Project/App: gsd-pi
// File Purpose: Context-bound, database-authoritative Milestone lifecycle writes.

import type { DomainOperationContext } from "../domain-operation.js";
import {
  readMilestoneCloseoutAuthorization,
  type MilestoneCloseoutBlocker,
} from "../milestone-closeout-readiness.js";
import {
  compareLifecycleShadow,
  normalizeLegacyLifecycleStatus,
  type CanonicalLifecycleStatus,
} from "../lifecycle-shadow-comparison.js";
import { getDb } from "../engine.js";
import {
  adoptLifecycleIfMissing,
  adoptOrTransitionLifecycle,
  readLifecycleShadowComparison,
  requireActiveDomainOperationContext,
  type LifecycleShadowRecord,
} from "./lifecycle-commands.js";
import {
  recordRequirementDisposition,
  terminateRecoveryWaiver,
} from "./task-recovery.js";
import { ensurePendingSliceQ8 } from "./slice-companion-state.js";

export interface MilestoneCompletionHierarchyInput {
  milestoneId: string;
  sourceRevision: string;
}

export interface MilestoneCompletionCancellationAuthorization {
  [key: string]: string | null;
  itemKind: "slice" | "task";
  sliceId: string;
  taskId: string | null;
  lifecycleId: string;
  waiverId: string;
  dispositionId: string | null;
}

export interface MilestoneCompletionHierarchyResult {
  milestoneLifecycleId: string;
  completedAt: string;
  validationEventId: string;
  validationRevision: number;
  completedSliceIds: string[];
  cancelledSliceIds: string[];
  completedTaskIds: string[];
  cancelledTaskIds: string[];
  cancellationAuthorizations: MilestoneCompletionCancellationAuthorization[];
  waiverIds: string[];
  dispositionIds: string[];
  shadow: LifecycleShadowRecord;
}

export interface MilestoneReopenHierarchyInput {
  milestoneId: string;
  reason: string;
  keepCompleted?: boolean;
}

export interface MilestoneReopenHierarchyResult {
  milestoneLifecycleId: string;
  reopenedSliceIds: string[];
  reopenedTaskIds: string[];
  revokedWaiverIds: string[];
  supersedingDispositionIds: string[];
  shadows: LifecycleShadowRecord[];
}

export class MilestoneLifecycleValidationError extends Error {}

interface HierarchyRow {
  itemKind: "milestone" | "slice" | "task";
  sliceId: string | null;
  taskId: string | null;
  legacyStatus: string;
  lifecycleId: string | null;
  lifecycleStatus: CanonicalLifecycleStatus | null;
}

interface CancellationAuthorizationRow {
  waiver_id: string;
  disposition_id: string | null;
}

interface ReopenCancellationWaiverRow {
  waiver_id: string;
  requirement_id: string | null;
  disposition_id: string | null;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new MilestoneLifecycleValidationError(`${field} must not be blank`);
  return normalized;
}

function requireOperationTimestamp(context: Readonly<DomainOperationContext>): string {
  const operation = getDb().prepare(`
    SELECT created_at
    FROM workflow_operations
    WHERE operation_id = :operation_id
      AND project_id = :project_id
  `).get({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
  }) as Record<string, unknown> | undefined;
  const completedAt = String(operation?.["created_at"] ?? "");
  if (!operation || !Number.isFinite(Date.parse(completedAt))) {
    throw new Error("Milestone lifecycle operation timestamp is missing or invalid");
  }
  return completedAt;
}

/**
 * Operation timestamp advanced past every existing lifecycle timestamp in the
 * Milestone hierarchy. A Domain Operation's created_at is only wall-clock
 * millisecond precise, so a complete/reopen that lands in the same millisecond
 * as the operation that last touched a lifecycle row would otherwise fail the
 * strict-monotonicity guard in adoptOrTransitionLifecycle. Advancing past the
 * newest existing timestamp mirrors the distinctTimestamp() idiom already used
 * for subjective-UAT writes and keeps lifecycle timestamps strictly increasing.
 */
function monotonicOperationTimestamp(
  context: Readonly<DomainOperationContext>,
  milestoneId: string,
): string {
  const operationTimestamp = requireOperationTimestamp(context);
  const row = getDb().prepare(`
    SELECT MAX(updated_at) AS latest
    FROM workflow_item_lifecycles
    WHERE project_id = :project_id AND milestone_id = :milestone_id
  `).get({
    ":project_id": context.projectId,
    ":milestone_id": milestoneId,
  }) as Record<string, unknown> | undefined;
  const latest = Date.parse(String(row?.["latest"] ?? ""));
  if (!Number.isFinite(latest)) return operationTimestamp;
  return new Date(Math.max(Date.parse(operationTimestamp), latest + 1)).toISOString();
}

function blockerSummary(blockers: MilestoneCloseoutBlocker[]): string {
  return blockers.map((blocker) => blocker.kind).join(", ");
}

function changedRows(result: unknown): number {
  return Number((result as { changes?: number }).changes ?? 0);
}

function requireMatchingShadow(row: HierarchyRow, identity: string): void {
  if (!row.lifecycleId || !row.lifecycleStatus) {
    throw new MilestoneLifecycleValidationError(`${identity} is missing canonical lifecycle authority`);
  }
  const comparison = compareLifecycleShadow(row.legacyStatus, row.lifecycleStatus);
  if (comparison.kind !== "match" && comparison.kind !== "semantic_match_exact_delta") {
    throw new MilestoneLifecycleValidationError(
      `${identity} canonical and legacy lifecycle mismatch`,
    );
  }
}

function requireTerminalState(row: HierarchyRow, identity: string): "completed" | "cancelled" {
  requireMatchingShadow(row, identity);
  const legacyStatus = normalizeLegacyLifecycleStatus(row.legacyStatus);
  if (legacyStatus === "completed" && row.lifecycleStatus === "completed") return "completed";
  if (legacyStatus === "cancelled" && row.lifecycleStatus === "cancelled") return "cancelled";
  throw new MilestoneLifecycleValidationError(
    `${identity} is not terminal with canonical and legacy parity`,
  );
}

/**
 * Task-level terminal classification for Milestone completion (#2202): a
 * `blocker-accepted` Task is terminal in both vocabularies without a fabricated
 * completion — it counts as closed work, and the Milestone closeout verdict
 * gate (criteria + validation attempt) is unaffected.
 */
function taskTerminalState(
  row: HierarchyRow,
  identity: string,
): "completed" | "cancelled" | "blocker-accepted" {
  requireMatchingShadow(row, identity);
  const legacyStatus = normalizeLegacyLifecycleStatus(row.legacyStatus);
  if (legacyStatus === "completed" && row.lifecycleStatus === "completed") return "completed";
  if (legacyStatus === "cancelled" && row.lifecycleStatus === "cancelled") return "cancelled";
  if (legacyStatus === "blocker-accepted" && row.lifecycleStatus === "blocker-accepted") {
    return "blocker-accepted";
  }
  throw new MilestoneLifecycleValidationError(
    `${identity} is not terminal with canonical and legacy parity`,
  );
}

function requireNoActiveAttempts(milestoneId: string): void {
  const active = getDb().prepare(`
    SELECT lifecycle.item_kind, lifecycle.slice_id, lifecycle.task_id,
           attempt.attempt_id, attempt.attempt_state
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_execution_attempts attempt
      ON attempt.project_id = lifecycle.project_id
     AND attempt.lifecycle_id = lifecycle.lifecycle_id
    WHERE lifecycle.milestone_id = :milestone_id
      AND attempt.attempt_state != 'settled'
    ORDER BY lifecycle.item_kind, lifecycle.slice_id, lifecycle.task_id,
             attempt.attempt_number, attempt.attempt_id
    LIMIT 1
  `).get({ ":milestone_id": milestoneId }) as Record<string, unknown> | undefined;
  if (!active) return;
  let suffix = "";
  if (active["task_id"]) {
    suffix = `/${String(active["slice_id"])}/${String(active["task_id"])}`;
  } else if (active["slice_id"]) {
    suffix = `/${String(active["slice_id"])}`;
  }
  throw new MilestoneLifecycleValidationError(
    `${String(active["item_kind"])} ${milestoneId}${suffix} has active ` +
      `${String(active["attempt_state"])} Attempt ${String(active["attempt_id"])}`,
  );
}

function requireNoProgressedDependentMilestones(
  context: Readonly<DomainOperationContext>,
  milestoneId: string,
): void {
  const dependents = getDb().prepare(`
    WITH RECURSIVE reachable(milestone_id) AS (
      SELECT candidate.id
      FROM milestones candidate
      JOIN json_each(candidate.depends_on) dependency
        ON CAST(dependency.value AS TEXT) = :milestone_id
      UNION
      SELECT candidate.id
      FROM milestones candidate
      JOIN json_each(candidate.depends_on) dependency
      JOIN reachable prior
        ON CAST(dependency.value AS TEXT) = prior.milestone_id
    )
    SELECT candidate.id, candidate.status AS legacy_status,
           lifecycle.lifecycle_status AS canonical_status
    FROM reachable
    JOIN milestones candidate ON candidate.id = reachable.milestone_id
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = :project_id
     AND lifecycle.item_kind = 'milestone'
     AND lifecycle.milestone_id = candidate.id
     AND lifecycle.slice_id IS NULL
     AND lifecycle.task_id IS NULL
    WHERE candidate.id != :milestone_id
    ORDER BY candidate.sequence, candidate.id
  `).all({
    ":project_id": context.projectId,
    ":milestone_id": milestoneId,
  }) as Array<Record<string, unknown>>;
  const progressed = dependents.find((dependent) => {
    const legacyStatus = normalizeLegacyLifecycleStatus(String(dependent["legacy_status"]));
    const canonicalStatus = dependent["canonical_status"] === null
      ? null
      : String(dependent["canonical_status"]);
    return legacyStatus === "in_progress" || legacyStatus === "paused" || legacyStatus === "completed" ||
      canonicalStatus === "in_progress" || canonicalStatus === "paused" || canonicalStatus === "completed";
  });
  if (progressed) {
    throw new MilestoneLifecycleValidationError(
      `cannot reopen Milestone ${milestoneId} while dependent Milestone ${String(progressed["id"])} has progressed`,
    );
  }
}

function revokeCancellationWaivers(
  context: Readonly<DomainOperationContext>,
  milestoneId: string,
  reason: string,
  reopenedAt: string,
): { revokedWaiverIds: string[]; supersedingDispositionIds: string[] } {
  const waivers = getDb().prepare(`
    SELECT waiver.waiver_id, waiver.requirement_id,
           disposition.disposition_id
    FROM workflow_waivers waiver
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = waiver.project_id
     AND lifecycle.lifecycle_id = waiver.lifecycle_id
    LEFT JOIN workflow_requirement_dispositions disposition
      ON disposition.project_id = waiver.project_id
     AND disposition.requirement_id = waiver.requirement_id
     AND disposition.waiver_id = waiver.waiver_id
     AND disposition.disposition = 'waived'
     AND NOT EXISTS (
       SELECT 1
       FROM workflow_requirement_dispositions successor
       WHERE successor.supersedes_disposition_id = disposition.disposition_id
     )
    WHERE waiver.project_id = :project_id
      AND lifecycle.milestone_id = :milestone_id
      AND waiver.waiver_status = 'active'
      AND (
        (
          lifecycle.item_kind = 'slice'
          AND lifecycle.slice_id IS NOT NULL
          AND lifecycle.task_id IS NULL
          AND waiver.requirement_id IS NULL
          AND waiver.blocker_id IS NULL
          AND waiver.scope = 'slice:' || lifecycle.milestone_id || '/' || lifecycle.slice_id
        ) OR (
          lifecycle.item_kind = 'task'
          AND lifecycle.slice_id IS NOT NULL
          AND lifecycle.task_id IS NOT NULL
          AND waiver.scope = lifecycle.milestone_id || '/' || lifecycle.slice_id || '/' || lifecycle.task_id || ' cancellation'
        )
      )
    ORDER BY waiver.project_revision, waiver.waiver_id
  `).all({
    ":project_id": context.projectId,
    ":milestone_id": milestoneId,
  }) as unknown as ReopenCancellationWaiverRow[];
  const revokedWaiverIds: string[] = [];
  const supersedingDispositionIds: string[] = [];
  for (const waiver of waivers) {
    if (waiver.requirement_id && waiver.disposition_id) {
      const disposition = recordRequirementDisposition(context, {
        requirementId: waiver.requirement_id,
        disposition: "unsatisfied",
        supersedesDispositionId: waiver.disposition_id,
        rationale: `Milestone ${milestoneId} reopened for full redo: ${reason}`,
        createdAt: reopenedAt,
      });
      supersedingDispositionIds.push(disposition.dispositionId);
    }
    terminateRecoveryWaiver(context, {
      waiverId: waiver.waiver_id,
      disposition: "revoked",
      endedAt: reopenedAt,
    });
    revokedWaiverIds.push(waiver.waiver_id);
  }
  return { revokedWaiverIds, supersedingDispositionIds };
}

function currentSliceCancellationAuthorization(
  context: Readonly<DomainOperationContext>,
  row: HierarchyRow,
  milestoneId: string,
  completedAt: string,
): MilestoneCompletionCancellationAuthorization {
  const sliceId = row.sliceId!;
  const authorizations = getDb().prepare(`
    SELECT waiver.waiver_id, NULL AS disposition_id
    FROM workflow_waivers waiver
    JOIN workflow_operations operation
      ON operation.operation_id = waiver.operation_id
     AND operation.project_id = waiver.project_id
     AND operation.operation_type = 'slice.cancel'
    JOIN workflow_domain_events cancelled
      ON cancelled.operation_id = waiver.operation_id
     AND cancelled.project_id = waiver.project_id
     AND cancelled.event_type = 'slice.cancelled'
     AND cancelled.entity_type = 'slice'
     AND cancelled.entity_id = :entity_id
     AND json_extract(cancelled.payload_json, '$.sliceLifecycleId') = waiver.lifecycle_id
     AND json_extract(cancelled.payload_json, '$.waiverId') = waiver.waiver_id
    WHERE waiver.project_id = :project_id
      AND waiver.lifecycle_id = :lifecycle_id
      AND waiver.waiver_status = 'active'
      AND waiver.requirement_id IS NULL
      AND waiver.blocker_id IS NULL
      AND waiver.scope = :scope
      AND (waiver.expires_at IS NULL OR waiver.expires_at > :completed_at)
    ORDER BY waiver.project_revision DESC, waiver.waiver_id
  `).all({
    ":entity_id": `${milestoneId}/${sliceId}`,
    ":project_id": context.projectId,
    ":lifecycle_id": row.lifecycleId,
    ":scope": `slice:${milestoneId}/${sliceId}`,
    ":completed_at": completedAt,
  }) as unknown as CancellationAuthorizationRow[];
  if (authorizations.length !== 1) {
    throw new MilestoneLifecycleValidationError(
      `Cancelled Slice ${sliceId} requires exactly one current cancellation Waiver`,
    );
  }
  return {
    itemKind: "slice",
    sliceId,
    taskId: null,
    lifecycleId: row.lifecycleId!,
    waiverId: authorizations[0]!.waiver_id,
    dispositionId: null,
  };
}

function currentTaskCancellationAuthorization(
  context: Readonly<DomainOperationContext>,
  row: HierarchyRow,
  milestoneId: string,
  completedAt: string,
): MilestoneCompletionCancellationAuthorization[] {
  const sliceId = row.sliceId!;
  const taskId = row.taskId!;
  const authorizations = getDb().prepare(`
    SELECT waiver.waiver_id, disposition.disposition_id
    FROM workflow_waivers waiver
    JOIN workflow_operations waiver_operation
      ON waiver_operation.operation_id = waiver.operation_id
     AND waiver_operation.project_id = waiver.project_id
     AND waiver_operation.operation_type = 'task.waiver.grant'
    JOIN workflow_requirement_dispositions disposition
      ON disposition.project_id = waiver.project_id
     AND disposition.requirement_id = waiver.requirement_id
     AND disposition.waiver_id = waiver.waiver_id
     AND disposition.disposition = 'waived'
    JOIN workflow_operations disposition_operation
      ON disposition_operation.operation_id = disposition.operation_id
     AND disposition_operation.project_id = disposition.project_id
     AND disposition_operation.operation_type = 'task.disposition.record'
    WHERE waiver.project_id = :project_id
      AND waiver.lifecycle_id = :lifecycle_id
      AND waiver.waiver_status = 'active'
      AND waiver.scope = :scope
      AND (waiver.expires_at IS NULL OR waiver.expires_at > :completed_at)
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_requirement_dispositions successor
        WHERE successor.supersedes_disposition_id = disposition.disposition_id
      )
    ORDER BY waiver.project_revision DESC, waiver.waiver_id
  `).all({
    ":project_id": context.projectId,
    ":lifecycle_id": row.lifecycleId,
    ":scope": `${milestoneId}/${sliceId}/${taskId} cancellation`,
    ":completed_at": completedAt,
  }) as unknown as CancellationAuthorizationRow[];
  if (authorizations.length === 0) {
    throw new MilestoneLifecycleValidationError(
      `Cancelled Task ${sliceId}/${taskId} requires a current Waiver disposition`,
    );
  }
  return authorizations.map((authorization) => ({
    itemKind: "task",
    sliceId,
    taskId,
    lifecycleId: row.lifecycleId!,
    waiverId: authorization.waiver_id,
    dispositionId: authorization.disposition_id!,
  }));
}

function loadMilestone(context: Readonly<DomainOperationContext>, milestoneId: string): HierarchyRow {
  const row = getDb().prepare(`
    SELECT milestone.status AS legacy_status,
           lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM milestones milestone
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = :project_id
     AND lifecycle.item_kind = 'milestone'
     AND lifecycle.milestone_id = milestone.id
     AND lifecycle.slice_id IS NULL
     AND lifecycle.task_id IS NULL
    WHERE milestone.id = :milestone_id
  `).get({
    ":project_id": context.projectId,
    ":milestone_id": milestoneId,
  }) as Record<string, unknown> | undefined;
  if (!row) throw new MilestoneLifecycleValidationError(`milestone not found: ${milestoneId}`);
  return {
    itemKind: "milestone",
    sliceId: null,
    taskId: null,
    legacyStatus: String(row["legacy_status"]),
    lifecycleId: row["lifecycle_id"] ? String(row["lifecycle_id"]) : null,
    lifecycleStatus: row["lifecycle_status"]
      ? String(row["lifecycle_status"]) as CanonicalLifecycleStatus
      : null,
  };
}

function loadSlices(context: Readonly<DomainOperationContext>, milestoneId: string): HierarchyRow[] {
  return getDb().prepare(`
    SELECT slice.id AS slice_id, slice.status AS legacy_status,
           lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM slices slice
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = :project_id
     AND lifecycle.item_kind = 'slice'
     AND lifecycle.milestone_id = slice.milestone_id
     AND lifecycle.slice_id = slice.id
     AND lifecycle.task_id IS NULL
    WHERE slice.milestone_id = :milestone_id
    ORDER BY slice.sequence, slice.id
  `).all({
    ":project_id": context.projectId,
    ":milestone_id": milestoneId,
  }).map((row) => ({
    itemKind: "slice" as const,
    sliceId: String(row["slice_id"]),
    taskId: null,
    legacyStatus: String(row["legacy_status"]),
    lifecycleId: row["lifecycle_id"] ? String(row["lifecycle_id"]) : null,
    lifecycleStatus: row["lifecycle_status"]
      ? String(row["lifecycle_status"]) as CanonicalLifecycleStatus
      : null,
  }));
}

function loadTasks(context: Readonly<DomainOperationContext>, milestoneId: string): HierarchyRow[] {
  return getDb().prepare(`
    SELECT task.slice_id, task.id AS task_id, task.status AS legacy_status,
           lifecycle.lifecycle_id, lifecycle.lifecycle_status
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = :project_id
     AND lifecycle.item_kind = 'task'
     AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id
     AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id
    ORDER BY task.slice_id, task.sequence, task.id
  `).all({
    ":project_id": context.projectId,
    ":milestone_id": milestoneId,
  }).map((row) => ({
    itemKind: "task" as const,
    sliceId: String(row["slice_id"]),
    taskId: String(row["task_id"]),
    legacyStatus: String(row["legacy_status"]),
    lifecycleId: row["lifecycle_id"] ? String(row["lifecycle_id"]) : null,
    lifecycleStatus: row["lifecycle_status"]
      ? String(row["lifecycle_status"]) as CanonicalLifecycleStatus
      : null,
  }));
}

export function completeMilestoneHierarchy(
  context: Readonly<DomainOperationContext>,
  input: MilestoneCompletionHierarchyInput,
): MilestoneCompletionHierarchyResult {
  if (requireActiveDomainOperationContext(context) !== "milestone.complete") {
    throw new Error("Milestone completion requires a milestone.complete Domain Operation");
  }
  const milestoneId = requireText(input.milestoneId, "milestoneId");
  const sourceRevision = requireText(input.sourceRevision, "sourceRevision");
  const completedAt = monotonicOperationTimestamp(context, milestoneId);
  const milestone = loadMilestone(context, milestoneId);
  requireMatchingShadow(milestone, `Milestone ${milestoneId}`);
  const milestoneStatus = normalizeLegacyLifecycleStatus(milestone.legacyStatus);
  if (milestoneStatus !== "pending" && milestoneStatus !== "in_progress") {
    throw new MilestoneLifecycleValidationError(
      `Milestone ${milestoneId} is not open for completion`,
    );
  }
  if (milestone.lifecycleStatus !== "ready" && milestone.lifecycleStatus !== "in_progress") {
    throw new MilestoneLifecycleValidationError(
      `Milestone ${milestoneId} canonical lifecycle is not ready for completion`,
    );
  }

  const authorization = readMilestoneCloseoutAuthorization({ milestoneId, sourceRevision });
  if (!authorization.authorized) {
    throw new MilestoneLifecycleValidationError(
      `Milestone ${milestoneId} canonical validation is not current (${blockerSummary(authorization.blockers)})`,
    );
  }

  // Closeout is the compatibility adoption path for work completed before
  // canonical lifecycle authority existed. Existing lifecycles are preserved,
  // and every non-completed or mismatched descendant still fails below.
  for (const row of [...loadSlices(context, milestoneId), ...loadTasks(context, milestoneId)]) {
    if (row.lifecycleId || normalizeLegacyLifecycleStatus(row.legacyStatus) !== "completed") continue;
    adoptLifecycleIfMissing(context, {
      itemKind: row.itemKind,
      milestoneId,
      ...(row.sliceId ? { sliceId: row.sliceId } : {}),
      ...(row.taskId ? { taskId: row.taskId } : {}),
      lifecycleStatus: "completed",
    });
  }
  const slices = loadSlices(context, milestoneId);
  if (slices.length === 0) {
    throw new MilestoneLifecycleValidationError(`no slices found for Milestone ${milestoneId}`);
  }
  const tasks = loadTasks(context, milestoneId);
  requireNoActiveAttempts(milestoneId);

  const completedSliceIds: string[] = [];
  const cancelledSliceIds: string[] = [];
  const completedTaskIds: string[] = [];
  const cancelledTaskIds: string[] = [];
  const cancellationAuthorizations: MilestoneCompletionCancellationAuthorization[] = [];
  const cancelledSlices = new Set<string>();

  for (const slice of slices) {
    const state = requireTerminalState(slice, `Slice ${slice.sliceId}`);
    if (state === "completed") {
      completedSliceIds.push(slice.sliceId!);
    } else {
      cancelledSliceIds.push(slice.sliceId!);
      cancelledSlices.add(slice.sliceId!);
      cancellationAuthorizations.push(
        currentSliceCancellationAuthorization(context, slice, milestoneId, completedAt),
      );
    }
  }

  for (const task of tasks) {
    const taskIdentity = `${task.sliceId}/${task.taskId}`;
    const state = taskTerminalState(task, `Task ${taskIdentity}`);
    if (state === "blocker-accepted") {
      // Closed by accepting a discovered blocker — no completion proof exists
      // and none is fabricated.
      completedTaskIds.push(taskIdentity);
    } else if (state === "completed") {
      completedTaskIds.push(taskIdentity);
    } else {
      cancelledTaskIds.push(taskIdentity);
      if (!cancelledSlices.has(task.sliceId!)) {
        cancellationAuthorizations.push(
          ...currentTaskCancellationAuthorization(context, task, milestoneId, completedAt),
        );
      }
    }
  }

  const lifecycle = adoptOrTransitionLifecycle(context, {
    itemKind: "milestone",
    milestoneId,
    lifecycleStatus: "completed",
    occurredAt: completedAt,
  });
  const updated = getDb().prepare(`
    UPDATE milestones
    SET status = 'complete', completed_at = :completed_at
    WHERE id = :milestone_id AND status = :expected_status
  `).run({
    ":completed_at": completedAt,
    ":milestone_id": milestoneId,
    ":expected_status": milestone.legacyStatus,
  });
  if (Number((updated as { changes?: number }).changes ?? 0) !== 1) {
    throw new Error("Milestone completion must update exactly one compatibility Milestone");
  }

  const shadow = readLifecycleShadowComparison(context, {
    itemKind: "milestone",
    milestoneId,
  });
  if (shadow.kind !== "match" && shadow.kind !== "semantic_match_exact_delta") {
    throw new Error("Milestone completion did not converge canonical and legacy lifecycle state");
  }
  const waiverIds = cancellationAuthorizations.map((authorization) => authorization.waiverId);
  const dispositionIds = cancellationAuthorizations.flatMap((authorization) =>
    authorization.dispositionId ? [authorization.dispositionId] : []
  );
  return {
    milestoneLifecycleId: lifecycle.lifecycleId,
    completedAt,
    validationEventId: authorization.eventId,
    validationRevision: authorization.revision,
    completedSliceIds,
    cancelledSliceIds,
    completedTaskIds,
    cancelledTaskIds,
    cancellationAuthorizations,
    waiverIds,
    dispositionIds,
    shadow,
  };
}

export function reopenMilestoneHierarchy(
  context: Readonly<DomainOperationContext>,
  input: MilestoneReopenHierarchyInput,
): MilestoneReopenHierarchyResult {
  if (requireActiveDomainOperationContext(context) !== "milestone.reopen") {
    throw new Error("Milestone reopen requires a milestone.reopen Domain Operation");
  }
  const milestoneId = requireText(input.milestoneId, "milestoneId");
  const reason = requireText(input.reason, "reason");
  const reopenedAt = monotonicOperationTimestamp(context, milestoneId);
  const milestone = loadMilestone(context, milestoneId);
  requireTerminalState(milestone, `Milestone ${milestoneId}`);
  const slices = loadSlices(context, milestoneId);
  const tasks = loadTasks(context, milestoneId);
  for (const slice of slices) {
    requireTerminalState(slice, `Slice ${slice.sliceId}`);
  }
  for (const task of tasks) {
    requireTerminalState(task, `Task ${task.sliceId}/${task.taskId}`);
  }
  requireNoActiveAttempts(milestoneId);
  requireNoProgressedDependentMilestones(context, milestoneId);

  const keepCompleted = input.keepCompleted === true;
  const waiverResult = keepCompleted
    ? { revokedWaiverIds: [] as string[], supersedingDispositionIds: [] as string[] }
    : revokeCancellationWaivers(context, milestoneId, reason, reopenedAt);
  const reopenedTaskIds: string[] = [];
  const reopenedSliceIds: string[] = [];
  if (!keepCompleted) {
  for (const task of tasks) {
    const taskId = task.taskId!;
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId,
      sliceId: task.sliceId!,
      taskId,
      lifecycleStatus: "ready",
      occurredAt: reopenedAt,
    });
    const updated = getDb().prepare(`
      UPDATE tasks
      SET status = 'pending', completed_at = NULL
      WHERE milestone_id = :milestone_id
        AND slice_id = :slice_id
        AND id = :task_id
        AND status = :expected_status
    `).run({
      ":milestone_id": milestoneId,
      ":slice_id": task.sliceId,
      ":task_id": taskId,
      ":expected_status": task.legacyStatus,
    });
    if (changedRows(updated) !== 1) {
      throw new Error(`Milestone reopen must update Task ${task.sliceId}/${taskId}`);
    }
    reopenedTaskIds.push(`${task.sliceId}/${taskId}`);
  }

  for (const slice of slices) {
    const sliceId = slice.sliceId!;
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId,
      sliceId,
      lifecycleStatus: "ready",
      occurredAt: reopenedAt,
    });
    const updated = getDb().prepare(`
      UPDATE slices
      SET status = 'in_progress', completed_at = NULL,
          full_summary_md = '', full_uat_md = ''
      WHERE milestone_id = :milestone_id
        AND id = :slice_id
        AND status = :expected_status
    `).run({
      ":milestone_id": milestoneId,
      ":slice_id": sliceId,
      ":expected_status": slice.legacyStatus,
    });
    if (changedRows(updated) !== 1) {
      throw new Error(`Milestone reopen must update Slice ${sliceId}`);
    }
    ensurePendingSliceQ8(context, { milestoneId, sliceId });
    reopenedSliceIds.push(sliceId);
  }
  }

  const milestoneLifecycle = adoptOrTransitionLifecycle(context, {
    itemKind: "milestone",
    milestoneId,
    lifecycleStatus: "ready",
    occurredAt: reopenedAt,
  });
  const updatedMilestone = getDb().prepare(`
    UPDATE milestones
    SET status = 'active', completed_at = NULL
    WHERE id = :milestone_id AND status = :expected_status
  `).run({
    ":milestone_id": milestoneId,
    ":expected_status": milestone.legacyStatus,
  });
  if (changedRows(updatedMilestone) !== 1) {
    throw new Error(`Milestone reopen must update Milestone ${milestoneId}`);
  }

  const shadows = [
    readLifecycleShadowComparison(context, { itemKind: "milestone", milestoneId }),
    ...reopenedSliceIds.map((sliceId) =>
      readLifecycleShadowComparison(context, { itemKind: "slice", milestoneId, sliceId })
    ),
    ...tasks.map((task) =>
      readLifecycleShadowComparison(context, {
        itemKind: "task",
        milestoneId,
        sliceId: task.sliceId!,
        taskId: task.taskId!,
      })
    ),
  ];
  if (shadows.some((shadow) =>
    shadow.kind !== "match" && shadow.kind !== "semantic_match_exact_delta")) {
    throw new Error("Milestone reopen did not converge canonical and legacy lifecycle state");
  }
  return {
    milestoneLifecycleId: milestoneLifecycle.lifecycleId,
    reopenedSliceIds,
    reopenedTaskIds,
    ...waiverResult,
    shadows,
  };
}
