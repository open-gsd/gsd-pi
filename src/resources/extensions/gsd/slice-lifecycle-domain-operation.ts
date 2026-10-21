// Project/App: gsd-pi
// File Purpose: Replay-safe Slice lifecycle Domain Operations.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationRequest,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { SLICE_LIFECYCLE_PROJECTION_KIND } from "./projection-identity.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import {
  cancelSliceHierarchy,
  completeSliceHierarchy,
  grantSliceCancellationWaiver,
  reopenSliceHierarchy,
  SliceLifecycleValidationError,
  type SliceCancellationHierarchyResult,
  type SliceCancellationInterruption,
  type SliceCompletionHierarchyResult,
  type SliceCompletionProof,
  type SliceReopenHierarchyResult,
} from "./db/writers/slice-lifecycle.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

export { SliceLifecycleValidationError };

export interface SliceLifecycleIdentity {
  milestoneId: string;
  sliceId: string;
}

export interface SliceLifecycleAudit {
  actorName?: string;
  triggerReason?: string;
}

function auditPayload(audit?: SliceLifecycleAudit): Record<string, DomainJsonValue> {
  return {
    actorName: audit?.actorName?.trim() || null,
    triggerReason: audit?.triggerReason?.trim() || null,
  };
}

export interface SliceCancellationReceipt {
  status: DomainOperationResult["status"];
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
  sliceLifecycleId: string;
  waiverId: string;
  canonicalStatus: "cancelled";
  legacyStatus: "skipped";
  wasAlreadySkipped: boolean;
  tasksSkipped: number;
  cancelledTaskIds: string[];
  preservedTaskIds: string[];
  interruptions: SliceCancellationInterruption[];
  isCurrent: boolean;
}

interface StoredCancellationPayload {
  sliceLifecycleId: string;
  waiverId: string;
  wasAlreadySkipped: boolean;
  cancelledTaskIds: string[];
  preservedTaskIds: string[];
  interruptions: SliceCancellationInterruption[];
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new SliceLifecycleValidationError(`${field} must not be blank`);
  return normalized;
}

function request(
  operationType: "slice.cancel" | "slice.complete" | "slice.reopen",
  invocation: ExecutionInvocation,
  slice: SliceLifecycleIdentity,
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
    payload: {
      slice: { milestoneId: slice.milestoneId, sliceId: slice.sliceId },
      ...payload,
    },
  };
}

function shadowPayload(
  result: SliceCancellationHierarchyResult | SliceCompletionHierarchyResult | SliceReopenHierarchyResult,
): DomainJsonValue[] {
  return result.shadows.map((shadow) => ({
    itemKind: shadow.itemKind,
    milestoneId: shadow.milestoneId,
    sliceId: shadow.sliceId ?? null,
    taskId: shadow.taskId ?? null,
    kind: shadow.kind,
    legacyStatus: shadow.legacyStatus,
    canonicalStatus: shadow.canonicalStatus,
    normalizedLegacyStatus: shadow.normalizedLegacyStatus,
    normalizedCanonicalStatus: shadow.normalizedCanonicalStatus,
  }));
}

function storedPayload(operationId: string): StoredCancellationPayload {
  const event = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = 'slice.cancelled'
  `).all({ ":operation_id": operationId }) as Array<Record<string, unknown>>;
  if (event.length !== 1) throw new Error("Slice cancellation receipt requires one durable event");
  return JSON.parse(String(event[0]!["payload_json"])) as StoredCancellationPayload;
}

export function cancelSlice(input: {
  invocation: ExecutionInvocation;
  slice: SliceLifecycleIdentity;
  reason: string;
  audit?: SliceLifecycleAudit;
}): SliceCancellationReceipt {
  const slice = {
    milestoneId: requireText(input.slice.milestoneId, "milestoneId"),
    sliceId: requireText(input.slice.sliceId, "sliceId"),
  };
  const reason = requireText(input.reason, "reason");
  const audit = auditPayload(input.audit);
  const grantedByActorType = input.invocation.actorType === "user" ? "user" : "policy";
  const grantedByActorId = input.invocation.actorId?.trim() || undefined;
  if (grantedByActorType === "user" && !grantedByActorId) {
    throw new SliceLifecycleValidationError("A user-authorized Slice cancellation requires actor identity");
  }
  const operation = executeDomainOperation(request("slice.cancel", input.invocation, slice, { reason, audit }), (context) => {
    const result = cancelSliceHierarchy(context, { ...slice, reason });
    const waiver = grantSliceCancellationWaiver(context, {
      lifecycleId: result.sliceLifecycleId,
      ...slice,
      rationale: reason,
      grantedByActorType,
      ...(grantedByActorId ? { grantedByActorId } : {}),
    });
    return {
      events: [{
        eventType: "slice.cancelled",
        entityType: "slice",
        entityId: `${slice.milestoneId}/${slice.sliceId}`,
        payload: {
          sliceLifecycleId: result.sliceLifecycleId,
          waiverId: waiver.waiverId,
          reason,
          audit,
          wasAlreadySkipped: result.wasAlreadySkipped,
          cancelledTaskIds: result.cancelledTaskIds,
          preservedTaskIds: result.preservedTaskIds,
          interruptions: result.interruptions.map((interruption) => ({ ...interruption })),
          lifecycleShadowComparisons: shadowPayload(result),
        },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `lifecycle/${slice.milestoneId}/${slice.sliceId}`.toLowerCase(),
        projectionKind: SLICE_LIFECYCLE_PROJECTION_KIND,
        rendererVersion: "1",
      }],
    };
  });
  const stored = storedPayload(operation.operationId);
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
    sliceLifecycleId: stored.sliceLifecycleId,
    waiverId: stored.waiverId,
    canonicalStatus: "cancelled",
    legacyStatus: "skipped",
    wasAlreadySkipped: stored.wasAlreadySkipped,
    tasksSkipped: stored.cancelledTaskIds.length,
    cancelledTaskIds: stored.cancelledTaskIds,
    preservedTaskIds: stored.preservedTaskIds,
    interruptions: stored.interruptions,
    isCurrent: isCurrentSliceOperation(operation.operationId, slice, "cancelled"),
  };
}

export interface SliceReopenReceipt {
  status: DomainOperationResult["status"];
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
  sliceLifecycleId: string;
  canonicalStatus: "ready";
  legacyStatus: "in_progress";
  tasksReset: number;
  reopenedTaskIds: string[];
  isCurrent: boolean;
}

export function reopenSlice(input: {
  invocation: ExecutionInvocation;
  slice: SliceLifecycleIdentity;
  reason: string;
  audit?: SliceLifecycleAudit;
}): SliceReopenReceipt {
  const slice = {
    milestoneId: requireText(input.slice.milestoneId, "milestoneId"),
    sliceId: requireText(input.slice.sliceId, "sliceId"),
  };
  const reason = requireText(input.reason, "reason");
  const audit = auditPayload(input.audit);
  const operation = executeDomainOperation(request("slice.reopen", input.invocation, slice, { reason, audit }), (context) => {
    const result = reopenSliceHierarchy(context, { ...slice, reason });
    return {
      events: [{
        eventType: "slice.reopened",
        entityType: "slice",
        entityId: `${slice.milestoneId}/${slice.sliceId}`,
        payload: {
          sliceLifecycleId: result.sliceLifecycleId,
          reason,
          audit,
          reopenedTaskIds: result.reopenedTaskIds,
          revokedWaiverIds: result.revokedWaiverIds,
          lifecycleShadowComparisons: shadowPayload(result),
        },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `lifecycle/${slice.milestoneId}/${slice.sliceId}`.toLowerCase(),
        projectionKind: SLICE_LIFECYCLE_PROJECTION_KIND,
        rendererVersion: "1",
      }],
    };
  });
  const event = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = 'slice.reopened'
  `).all({ ":operation_id": operation.operationId }) as Array<Record<string, unknown>>;
  if (event.length !== 1) throw new Error("Slice reopen receipt requires one durable event");
  const stored = JSON.parse(String(event[0]!["payload_json"])) as {
    sliceLifecycleId: string;
    reopenedTaskIds: string[];
  };
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
    sliceLifecycleId: stored.sliceLifecycleId,
    canonicalStatus: "ready",
    legacyStatus: "in_progress",
    tasksReset: stored.reopenedTaskIds.length,
    reopenedTaskIds: stored.reopenedTaskIds,
    isCurrent: isCurrentSliceReopenOperation(operation.operationId, slice),
  };
}

export interface SliceCompletionCloseout {
  sliceTitle: string;
  oneLiner: string;
  narrative: string;
  verification: string;
  uatContent: string;
  operationalReadiness: string;
  deviations: string;
  knownLimitations: string;
  followUps: string;
  provides: string[];
  requires: Array<{ slice: string; provides: string }>;
  affects: string[];
  keyFiles: string[];
  keyDecisions: string[];
  patternsEstablished: string[];
  observabilitySurfaces: string[];
  drillDownPaths: string[];
  requirementsAdvanced: Array<{ id: string; how: string }>;
  requirementsValidated: Array<{ id: string; proof: string }>;
  requirementsSurfaced: string[];
  requirementsInvalidated: Array<{ id: string; what: string }>;
  filesModified: Array<{ path: string; description: string }>;
}

export interface SliceCompletionReceipt {
  status: DomainOperationResult["status"];
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
  sliceLifecycleId: string;
  canonicalStatus: "completed";
  legacyStatus: "complete";
  completedAt: string;
  completedTaskIds: string[];
  cancelledTaskIds: string[];
  proofs: SliceCompletionProof[];
  q8Verdict: "pass" | "omitted";
  closeout: SliceCompletionCloseout;
  isCurrent: boolean;
}

interface StoredCompletionPayload {
  sliceLifecycleId: string;
  completedAt: string;
  completedTaskIds: string[];
  cancelledTaskIds: string[];
  proofs: SliceCompletionProof[];
  q8Verdict: "pass" | "omitted";
  closeout: SliceCompletionCloseout;
}

function storedCompletionPayload(operationId: string): StoredCompletionPayload {
  const event = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = 'slice.completed'
  `).all({ ":operation_id": operationId }) as Array<Record<string, unknown>>;
  if (event.length !== 1) throw new Error("Slice completion receipt requires one durable event");
  return JSON.parse(String(event[0]!["payload_json"])) as StoredCompletionPayload;
}

function isCurrentSliceOperation(
  operationId: string,
  slice: SliceLifecycleIdentity,
  lifecycleStatus: "ready" | "completed" | "cancelled",
): boolean {
  return Boolean(getDb().prepare(`
    SELECT 1
    FROM workflow_item_lifecycles
    WHERE item_kind = 'slice'
      AND milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND task_id IS NULL
      AND lifecycle_status = :lifecycle_status
      AND last_operation_id = :operation_id
  `).get({
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
    ":operation_id": operationId,
    ":lifecycle_status": lifecycleStatus,
  }));
}

export function isCurrentSliceReopenOperation(
  operationId: string,
  slice: SliceLifecycleIdentity,
): boolean {
  if (!isCurrentSliceOperation(operationId, slice, "ready")) return false;
  return !getDb().prepare(`
    SELECT 1
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task'
     AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id
     AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id
      AND task.slice_id = :slice_id
      AND (
        lifecycle.last_operation_id IS NULL
        OR lifecycle.last_operation_id != :operation_id
        OR lifecycle.lifecycle_status != 'ready'
      )
    LIMIT 1
  `).get({
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
    ":operation_id": operationId,
  });
}

export function isCurrentSliceCompletionOperation(
  operationId: string,
  slice: SliceLifecycleIdentity,
): boolean {
  return isCurrentSliceOperation(operationId, slice, "completed");
}

export function completeSlice(input: {
  invocation: ExecutionInvocation;
  slice: SliceLifecycleIdentity;
  closeout: SliceCompletionCloseout;
  audit?: SliceLifecycleAudit;
}): SliceCompletionReceipt {
  const slice = {
    milestoneId: requireText(input.slice.milestoneId, "milestoneId"),
    sliceId: requireText(input.slice.sliceId, "sliceId"),
  };
  const audit = auditPayload(input.audit);
  const operation = executeDomainOperation(request("slice.complete", input.invocation, slice, {
    closeout: input.closeout as unknown as DomainJsonValue,
    audit,
  }), (context) => {
    const result = completeSliceHierarchy(context, {
      ...slice,
      operationalReadiness: input.closeout.operationalReadiness,
    });
    return {
      events: [{
        eventType: "slice.completed",
        entityType: "slice",
        entityId: `${slice.milestoneId}/${slice.sliceId}`,
        payload: {
          sliceLifecycleId: result.sliceLifecycleId,
          completedAt: result.completedAt,
          completedTaskIds: result.completedTaskIds,
          cancelledTaskIds: result.cancelledTaskIds,
          proofs: result.proofs.map((proof) => ({ ...proof })),
          q8Verdict: result.q8Verdict,
          closeout: input.closeout as unknown as DomainJsonValue,
          audit,
          lifecycleShadowComparisons: shadowPayload(result),
        },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `lifecycle/${slice.milestoneId}/${slice.sliceId}`.toLowerCase(),
        projectionKind: SLICE_LIFECYCLE_PROJECTION_KIND,
        rendererVersion: "1",
      }],
    };
  });
  const stored = storedCompletionPayload(operation.operationId);
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
    sliceLifecycleId: stored.sliceLifecycleId,
    canonicalStatus: "completed",
    legacyStatus: "complete",
    completedAt: stored.completedAt,
    completedTaskIds: stored.completedTaskIds,
    cancelledTaskIds: stored.cancelledTaskIds,
    proofs: stored.proofs,
    q8Verdict: stored.q8Verdict,
    closeout: stored.closeout,
    isCurrent: isCurrentSliceCompletionOperation(operation.operationId, slice),
  };
}
