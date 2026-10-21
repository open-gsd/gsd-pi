// Project/App: gsd-pi
// File Purpose: Replay-safe Milestone completion Domain Operation.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationRequest,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { MILESTONE_LIFECYCLE_PROJECTION_KIND } from "./projection-identity.js";
import { readMilestoneCloseoutAuthorization } from "./db/milestone-closeout-readiness.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import type { LifecycleShadowRecord } from "./db/writers/lifecycle-commands.js";
import {
  completeMilestoneHierarchy,
  MilestoneLifecycleValidationError,
  reopenMilestoneHierarchy,
  type MilestoneCompletionHierarchyResult,
} from "./db/writers/milestone-lifecycle.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import {
  closeQualityGatesFromEvidence,
  inspectQualityGatesFromEvidence,
} from "./quality-gate-closure.js";

export { MilestoneLifecycleValidationError };

export interface MilestoneCompletionCloseout {
  title: string;
  oneLiner: string;
  narrative: string;
  successCriteriaResults: string;
  definitionOfDoneResults: string;
  requirementOutcomes: string;
  keyDecisions: string[];
  keyFiles: string[];
  lessonsLearned: string[];
  followUps: string;
  deviations: string;
}

export interface MilestoneCompletionAudit {
  actorName?: string;
  triggerReason?: string;
}

export interface MilestoneCompletionReceipt {
  status: DomainOperationResult["status"];
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
  milestoneLifecycleId: string;
  canonicalStatus: "completed";
  legacyStatus: "complete";
  completedAt: string;
  validationEventId: string;
  validationRevision: number;
  completedSliceIds: string[];
  cancelledSliceIds: string[];
  completedTaskIds: string[];
  cancelledTaskIds: string[];
  waiverIds: string[];
  dispositionIds: string[];
  closeout: MilestoneCompletionCloseout;
  isCurrent: boolean;
}

interface StoredCompletionPayload {
  milestoneLifecycleId: string;
  completedAt: string;
  validationEventId: string;
  validationRevision: number;
  completedSliceIds: string[];
  cancelledSliceIds: string[];
  completedTaskIds: string[];
  cancelledTaskIds: string[];
  waiverIds: string[];
  dispositionIds: string[];
  closeout: MilestoneCompletionCloseout;
}

export interface CurrentMilestoneCompletionReceipt extends StoredCompletionPayload {
  operationId: string;
}

interface CurrentMilestoneCompletionHead {
  lifecycleId: string;
  operationId: string;
}

type StoredCompletionAudit = { actorName: string | null; triggerReason: string | null };

export interface MilestoneReopenReceipt {
  status: DomainOperationResult["status"];
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
  milestoneLifecycleId: string;
  canonicalStatus: "ready";
  legacyStatus: "active";
  slicesReset: number;
  tasksReset: number;
  reopenedSliceIds: string[];
  reopenedTaskIds: string[];
  revokedWaiverIds: string[];
  supersedingDispositionIds: string[];
  reason: string;
  audit: StoredCompletionAudit;
  isCurrent: boolean;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new MilestoneLifecycleValidationError(`${field} must not be blank`);
  return normalized;
}

function normalizedList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedCloseout(closeout: MilestoneCompletionCloseout): MilestoneCompletionCloseout {
  return {
    title: requiredText(closeout.title, "title"),
    oneLiner: requiredText(closeout.oneLiner, "oneLiner"),
    narrative: requiredText(closeout.narrative, "narrative"),
    successCriteriaResults: closeout.successCriteriaResults.trim(),
    definitionOfDoneResults: closeout.definitionOfDoneResults.trim(),
    requirementOutcomes: closeout.requirementOutcomes.trim(),
    keyDecisions: normalizedList(closeout.keyDecisions),
    keyFiles: normalizedList(closeout.keyFiles),
    lessonsLearned: normalizedList(closeout.lessonsLearned),
    followUps: closeout.followUps.trim(),
    deviations: closeout.deviations.trim(),
  };
}

function normalizedAudit(audit?: MilestoneCompletionAudit): StoredCompletionAudit {
  return {
    actorName: audit?.actorName?.trim() || null,
    triggerReason: audit?.triggerReason?.trim() || null,
  };
}

function operationRequest(
  operationType: "milestone.complete" | "milestone.reopen",
  invocation: ExecutionInvocation,
  payload: Record<string, DomainJsonValue>,
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

function stringField(
  payload: Record<string, unknown>,
  field: string,
  receipt = "completion",
): string {
  const value = payload[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`Milestone ${receipt} receipt ${field} is corrupt`);
  }
  return value;
}

function numberField(payload: Record<string, unknown>, field: string): number {
  const value = payload[field];
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Milestone completion receipt ${field} is corrupt`);
  }
  return Number(value);
}

function stringArrayField(
  payload: Record<string, unknown>,
  field: string,
  receipt = "completion",
): string[] {
  const value = payload[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry) ||
      new Set(value).size !== value.length) {
    throw new Error(`Milestone ${receipt} receipt ${field} is corrupt`);
  }
  return value as string[];
}

function storedCompletionPayload(
  operationId: string,
  milestoneId: string,
): StoredCompletionPayload {
  const events = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id
      AND event_type = 'milestone.completed'
      AND entity_type = 'milestone'
      AND entity_id = :milestone_id
  `).all({ ":operation_id": operationId, ":milestone_id": milestoneId }) as Array<Record<string, unknown>>;
  if (events.length !== 1) throw new Error("Milestone completion receipt requires one durable event");
  const parsed = JSON.parse(String(events[0]!["payload_json"])) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Milestone completion receipt payload is corrupt");
  }
  const payload = parsed as Record<string, unknown>;
  const closeout = payload["closeout"];
  if (!closeout || typeof closeout !== "object" || Array.isArray(closeout)) {
    throw new Error("Milestone completion receipt closeout is corrupt");
  }
  const storedCloseout = closeout as Record<string, unknown>;
  for (const field of ["title", "oneLiner", "narrative", "successCriteriaResults",
    "definitionOfDoneResults", "requirementOutcomes", "followUps", "deviations"]) {
    if (typeof storedCloseout[field] !== "string") {
      throw new Error(`Milestone completion receipt closeout.${field} is corrupt`);
    }
  }
  const normalizedStoredCloseout = {
    ...storedCloseout,
    keyDecisions: stringArrayField(storedCloseout, "keyDecisions"),
    keyFiles: stringArrayField(storedCloseout, "keyFiles"),
    lessonsLearned: stringArrayField(storedCloseout, "lessonsLearned"),
  } as unknown as MilestoneCompletionCloseout;
  return {
    milestoneLifecycleId: stringField(payload, "milestoneLifecycleId"),
    completedAt: stringField(payload, "completedAt"),
    validationEventId: stringField(payload, "validationEventId"),
    validationRevision: numberField(payload, "validationRevision"),
    completedSliceIds: stringArrayField(payload, "completedSliceIds"),
    cancelledSliceIds: stringArrayField(payload, "cancelledSliceIds"),
    completedTaskIds: stringArrayField(payload, "completedTaskIds"),
    cancelledTaskIds: stringArrayField(payload, "cancelledTaskIds"),
    waiverIds: stringArrayField(payload, "waiverIds"),
    dispositionIds: stringArrayField(payload, "dispositionIds"),
    closeout: normalizedStoredCloseout,
  };
}

function currentMilestoneCompletionHead(
  milestoneId: string,
): CurrentMilestoneCompletionHead | null {
  const lifecycle = getDb().prepare(`
    SELECT lifecycle.lifecycle_id, lifecycle.last_operation_id
    FROM workflow_item_lifecycles lifecycle
    JOIN project_authority authority
      ON authority.project_id = lifecycle.project_id
     AND authority.singleton = 1
    JOIN workflow_operations operation
      ON operation.operation_id = lifecycle.last_operation_id
     AND operation.project_id = lifecycle.project_id
     AND operation.resulting_revision = lifecycle.last_project_revision
     AND operation.resulting_authority_epoch = lifecycle.last_authority_epoch
     AND operation.operation_type = 'milestone.complete'
    WHERE lifecycle.item_kind = 'milestone'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id IS NULL
      AND lifecycle.task_id IS NULL
      AND lifecycle.lifecycle_status = 'completed'
  `).get({ ":milestone_id": milestoneId });
  if (!lifecycle) return null;
  return {
    lifecycleId: String(lifecycle["lifecycle_id"]),
    operationId: String(lifecycle["last_operation_id"]),
  };
}

export function readCurrentMilestoneCompletionReceipt(
  milestoneId: string,
): CurrentMilestoneCompletionReceipt | null {
  const head = currentMilestoneCompletionHead(milestoneId);
  if (!head) return null;

  const stored = storedCompletionPayload(head.operationId, milestoneId);
  if (stored.milestoneLifecycleId !== head.lifecycleId) {
    throw new Error("Milestone completion receipt lifecycle ownership is corrupt");
  }
  return { operationId: head.operationId, ...stored };
}

export function isCurrentMilestoneCompletionOperation(
  operationId: string,
  milestoneId: string,
): boolean {
  return currentMilestoneCompletionHead(milestoneId)?.operationId === operationId;
}

export function readMilestoneCompletionReplaySourceRevision(
  idempotencyKey: string,
): string | null {
  const row = getDb().prepare(`
    SELECT json_extract(validation.payload_json, '$.testedSourceRevision') AS source_revision
    FROM workflow_operations operation
    JOIN workflow_domain_events completed
      ON completed.operation_id = operation.operation_id
     AND completed.project_id = operation.project_id
     AND completed.event_type = 'milestone.completed'
    JOIN workflow_domain_events validation
      ON validation.event_id = json_extract(completed.payload_json, '$.validationEventId')
     AND validation.project_id = completed.project_id
     AND validation.event_type = 'milestone.validation.recorded'
    WHERE operation.operation_type = 'milestone.complete'
      AND operation.idempotency_key = :idempotency_key
  `).get({ ":idempotency_key": idempotencyKey }) as Record<string, unknown> | undefined;
  return typeof row?.["source_revision"] === "string"
    ? row["source_revision"] as string
    : null;
}

export function isCurrentMilestoneReopenOperation(
  operationId: string,
  milestoneId: string,
): boolean {
  const milestoneCurrent = getDb().prepare(`
    SELECT 1 FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = :milestone_id
      AND slice_id IS NULL AND task_id IS NULL
      AND lifecycle_status = 'ready' AND last_operation_id = :operation_id
  `).get({ ":milestone_id": milestoneId, ":operation_id": operationId });
  if (!milestoneCurrent) return false;

  const staleDescendant = getDb().prepare(`
    SELECT 1
    FROM (
      SELECT slice.id AS slice_id, NULL AS task_id, lifecycle.lifecycle_status,
             lifecycle.last_operation_id
      FROM slices slice
      LEFT JOIN workflow_item_lifecycles lifecycle
        ON lifecycle.item_kind = 'slice'
       AND lifecycle.milestone_id = slice.milestone_id
       AND lifecycle.slice_id = slice.id
       AND lifecycle.task_id IS NULL
      WHERE slice.milestone_id = :milestone_id
      UNION ALL
      SELECT task.slice_id, task.id AS task_id, lifecycle.lifecycle_status,
             lifecycle.last_operation_id
      FROM tasks task
      LEFT JOIN workflow_item_lifecycles lifecycle
        ON lifecycle.item_kind = 'task'
       AND lifecycle.milestone_id = task.milestone_id
       AND lifecycle.slice_id = task.slice_id
       AND lifecycle.task_id = task.id
      WHERE task.milestone_id = :milestone_id
    ) descendant
    WHERE descendant.lifecycle_status IS NULL
       OR descendant.lifecycle_status != 'ready'
       OR descendant.last_operation_id IS NULL
       OR descendant.last_operation_id != :operation_id
    LIMIT 1
  `).get({ ":milestone_id": milestoneId, ":operation_id": operationId });
  return !staleDescendant;
}

function storedReopenPayload(operationId: string): {
  milestoneLifecycleId: string;
  reopenedSliceIds: string[];
  reopenedTaskIds: string[];
  revokedWaiverIds: string[];
  supersedingDispositionIds: string[];
  reason: string;
  audit: StoredCompletionAudit;
} {
  const events = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = 'milestone.reopened'
  `).all({ ":operation_id": operationId }) as Array<Record<string, unknown>>;
  if (events.length !== 1) throw new Error("Milestone reopen receipt requires one durable event");
  const parsed = JSON.parse(String(events[0]!["payload_json"])) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Milestone reopen receipt payload is corrupt");
  }
  const payload = parsed as Record<string, unknown>;
  const audit = payload["audit"];
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) {
    throw new Error("Milestone reopen receipt audit is corrupt");
  }
  const storedAudit = audit as Record<string, unknown>;
  if ((storedAudit["actorName"] !== null && typeof storedAudit["actorName"] !== "string") ||
      (storedAudit["triggerReason"] !== null && typeof storedAudit["triggerReason"] !== "string")) {
    throw new Error("Milestone reopen receipt audit is corrupt");
  }
  return {
    milestoneLifecycleId: stringField(payload, "milestoneLifecycleId", "reopen"),
    reopenedSliceIds: stringArrayField(payload, "reopenedSliceIds", "reopen"),
    reopenedTaskIds: stringArrayField(payload, "reopenedTaskIds", "reopen"),
    revokedWaiverIds: stringArrayField(payload, "revokedWaiverIds", "reopen"),
    supersedingDispositionIds: stringArrayField(payload, "supersedingDispositionIds", "reopen"),
    reason: stringField(payload, "reason", "reopen"),
    audit: {
      actorName: storedAudit["actorName"] as string | null,
      triggerReason: storedAudit["triggerReason"] as string | null,
    },
  };
}

export function reopenMilestone(input: {
  invocation: ExecutionInvocation;
  milestoneId: string;
  reason: string;
  audit?: MilestoneCompletionAudit;
  keepCompleted?: boolean;
}): MilestoneReopenReceipt {
  const milestoneId = requiredText(input.milestoneId, "milestoneId");
  const reason = requiredText(input.reason, "reason");
  const audit = normalizedAudit(input.audit);
  const keepCompleted = input.keepCompleted === true;
  const operation = executeDomainOperation(
    operationRequest("milestone.reopen", input.invocation, {
      milestoneId,
      reason,
      audit,
      ...(keepCompleted ? { keepCompleted: true } : {}),
    }),
    (context) => {
      const result = reopenMilestoneHierarchy(context, { milestoneId, reason, keepCompleted });
      return {
        events: [{
          eventType: "milestone.reopened",
          entityType: "milestone",
          entityId: milestoneId,
          payload: {
            milestoneLifecycleId: result.milestoneLifecycleId,
            reason,
            audit,
            reopenedSliceIds: result.reopenedSliceIds,
            reopenedTaskIds: result.reopenedTaskIds,
            revokedWaiverIds: result.revokedWaiverIds,
            supersedingDispositionIds: result.supersedingDispositionIds,
            lifecycleShadowComparisons: result.shadows.map((shadow) => shadowPayload(shadow)),
          },
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: `lifecycle/${milestoneId}`.toLowerCase(),
          projectionKind: MILESTONE_LIFECYCLE_PROJECTION_KIND,
          rendererVersion: "1",
        }],
      };
    },
  );
  const stored = storedReopenPayload(operation.operationId);
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
    milestoneLifecycleId: stored.milestoneLifecycleId,
    canonicalStatus: "ready",
    legacyStatus: "active",
    slicesReset: stored.reopenedSliceIds.length,
    tasksReset: stored.reopenedTaskIds.length,
    reopenedSliceIds: stored.reopenedSliceIds,
    reopenedTaskIds: stored.reopenedTaskIds,
    revokedWaiverIds: stored.revokedWaiverIds,
    supersedingDispositionIds: stored.supersedingDispositionIds,
    reason: stored.reason,
    audit: stored.audit,
    isCurrent: isCurrentMilestoneReopenOperation(operation.operationId, milestoneId),
  };
}

export function completeMilestone(input: {
  invocation: ExecutionInvocation;
  milestoneId: string;
  sourceRevision: string;
  closeout: MilestoneCompletionCloseout;
  audit?: MilestoneCompletionAudit;
}): MilestoneCompletionReceipt {
  const milestoneId = requiredText(input.milestoneId, "milestoneId");
  const sourceRevision = requiredText(input.sourceRevision, "sourceRevision");
  const closeout = normalizedCloseout(input.closeout);
  const audit = normalizedAudit(input.audit);
  const operation = executeDomainOperation(
    operationRequest("milestone.complete", input.invocation, {
      milestoneId,
      sourceRevision,
      closeout: closeout as unknown as DomainJsonValue,
      audit,
    }),
    (context) => {
      const authorization = readMilestoneCloseoutAuthorization({ milestoneId, sourceRevision });
      if (!authorization.authorized) {
        throw new MilestoneLifecycleValidationError(
          `Milestone ${milestoneId} canonical validation is not current`,
        );
      }
      const gateClosureOptions = { milestoneValidationAuthorization: authorization };
      const gateClosure = inspectQualityGatesFromEvidence(milestoneId, gateClosureOptions);
      const unresolvedGate = gateClosure.unresolved[0];
      if (unresolvedGate) {
        throw new MilestoneLifecycleValidationError(
          `Milestone ${milestoneId} quality gate ${unresolvedGate.gate_id} is still pending for ${unresolvedGate.slice_id}`,
        );
      }
      const result = completeMilestoneHierarchy(context, { milestoneId, sourceRevision });
      closeQualityGatesFromEvidence(milestoneId, gateClosureOptions);
      const { shadow, cancellationAuthorizations, ...storedResult } = result;
      return {
        events: [{
          eventType: "milestone.completed",
          entityType: "milestone",
          entityId: milestoneId,
          payload: {
            ...storedResult,
            closeout: closeout as unknown as DomainJsonValue,
            audit,
            cancellationAuthorizations: cancellationAuthorizations.map((authorization) => ({
              itemKind: authorization.itemKind,
              sliceId: authorization.sliceId,
              taskId: authorization.taskId ?? null,
              lifecycleId: authorization.lifecycleId,
              waiverId: authorization.waiverId,
              dispositionId: authorization.dispositionId ?? null,
            })),
            lifecycleShadowComparison: shadowPayload(shadow),
          },
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: `lifecycle/${milestoneId}`.toLowerCase(),
          projectionKind: MILESTONE_LIFECYCLE_PROJECTION_KIND,
          rendererVersion: "1",
        }],
      };
    },
  );
  const stored = storedCompletionPayload(operation.operationId, milestoneId);
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
    milestoneLifecycleId: stored.milestoneLifecycleId,
    canonicalStatus: "completed",
    legacyStatus: "complete",
    completedAt: stored.completedAt,
    validationEventId: stored.validationEventId,
    validationRevision: stored.validationRevision,
    completedSliceIds: stored.completedSliceIds,
    cancelledSliceIds: stored.cancelledSliceIds,
    completedTaskIds: stored.completedTaskIds,
    cancelledTaskIds: stored.cancelledTaskIds,
    waiverIds: stored.waiverIds,
    dispositionIds: stored.dispositionIds,
    closeout: stored.closeout,
    isCurrent: isCurrentMilestoneCompletionOperation(operation.operationId, milestoneId),
  };
}
