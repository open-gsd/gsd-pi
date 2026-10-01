// Project/App: gsd-pi
// File Purpose: Replay-safe, evidence-gated forward lifecycle-shadow repair.

import { createHash } from "node:crypto";
import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationEventInput,
  type DomainOperationProjectionInput,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import {
  getLifecycleShadowRepairCandidate,
  isFailedVerificationResult,
  type LifecycleShadowRepairCandidate,
  type LifecycleShadowRepairEvidence,
  type LifecycleShadowRepairIdentity,
} from "./db/queries.js";
import {
  readDomainOperationFence,
  repairLifecycleShadowStep,
  type CanonicalLifecycleStatus,
} from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

type RepairStep = "adopt" | "advance" | "complete" | "unresolved";
type RepairDisposition = "advanced" | "repaired" | "unresolved";

interface StoredRepairPayload {
  item: LifecycleShadowRepairIdentity;
  beforeStatus: CanonicalLifecycleStatus | null;
  afterStatus: CanonicalLifecycleStatus | null;
  targetStatus: "completed" | null;
  disposition: RepairDisposition;
  evidence: LifecycleShadowRepairEvidence | null;
  comparison: LifecycleShadowRepairCandidate["comparison"];
  reason: string | null;
}

interface RepairStepReceipt {
  operation: DomainOperationResult;
  payload: StoredRepairPayload;
}

let beforeCommitHook: (() => void) | null = null;

export function _setLifecycleShadowRepairBeforeCommitForTest(hook: (() => void) | null): void {
  beforeCommitHook = hook;
}

export interface LifecycleShadowRepairReceipt {
  status: DomainOperationResult["status"];
  operationId: string;
  resultingRevision: number;
  disposition: RepairDisposition;
  beforeStatus: CanonicalLifecycleStatus | null;
  afterStatus: CanonicalLifecycleStatus | null;
  targetStatus: "completed" | null;
  evidence: LifecycleShadowRepairEvidence | null;
  comparison: LifecycleShadowRepairCandidate["comparison"];
  reason: string | null;
}

export interface MilestoneLifecycleShadowRepairResult {
  repaired: string[];
  unresolved: string[];
}

function requireText(value: string | undefined, field: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${field} must not be blank`);
  return normalized;
}

function normalizeIdentity(identity: LifecycleShadowRepairIdentity): LifecycleShadowRepairIdentity {
  const milestoneId = requireText(identity.milestoneId, "milestoneId");
  if (identity.itemKind === "milestone") {
    if (identity.sliceId !== undefined || identity.taskId !== undefined) {
      throw new Error("milestone repair identity cannot include sliceId or taskId");
    }
    return { itemKind: "milestone", milestoneId };
  }
  const sliceId = requireText(identity.sliceId, "sliceId");
  if (identity.itemKind === "slice") {
    if (identity.taskId !== undefined) throw new Error("slice repair identity cannot include taskId");
    return { itemKind: "slice", milestoneId, sliceId };
  }
  if (identity.itemKind !== "task") throw new Error("invalid lifecycle repair item kind");
  return {
    itemKind: "task",
    milestoneId,
    sliceId,
    taskId: requireText(identity.taskId, "taskId"),
  };
}

function entityId(item: LifecycleShadowRepairIdentity): string {
  return [item.milestoneId, item.sliceId, item.taskId].filter(Boolean).join("/");
}

function operationKey(invocation: ExecutionInvocation, step: RepairStep): string {
  return `${invocation.idempotencyKey}:${step}`;
}

function operationExists(invocation: ExecutionInvocation, step: RepairStep): boolean {
  return readDomainOperationFence(operationKey(invocation, step)).replay;
}

function eventType(disposition: RepairDisposition): string {
  if (disposition === "advanced") return "lifecycle.shadow.advanced";
  if (disposition === "repaired") return "lifecycle.shadow.repaired";
  return "lifecycle.shadow.unresolved";
}

function projectionKey(item: LifecycleShadowRepairIdentity): string {
  return `lifecycle-shadow-repair/${entityId(item)}`.toLowerCase();
}

function requestPayload(item: LifecycleShadowRepairIdentity, step: RepairStep): DomainJsonValue {
  return { item: item as unknown as DomainJsonValue, step };
}

function requireStableCandidate(
  expected: LifecycleShadowRepairCandidate,
  actual: LifecycleShadowRepairCandidate,
): void {
  if (
    expected.legacyStatus !== actual.legacyStatus ||
    expected.canonicalStatus !== actual.canonicalStatus ||
    expected.canonicalLastOperationId !== actual.canonicalLastOperationId ||
    expected.targetStatus !== actual.targetStatus ||
    expected.evidence?.evidenceDigest !== actual.evidence?.evidenceDigest ||
    JSON.stringify(expected.comparison) !== JSON.stringify(actual.comparison)
  ) {
    throw new Error("lifecycle shadow repair requires stable durable completion evidence and before state");
  }
}

function executeRepairStep(input: {
  invocation: ExecutionInvocation;
  item: LifecycleShadowRepairIdentity;
  step: RepairStep;
  targetStatus: "in_progress" | "completed" | "ready" | null;
  disposition: RepairDisposition;
  priorRepairOperationId?: string;
}): RepairStepReceipt {
  const idempotencyKey = operationKey(input.invocation, input.step);
  const fence = readDomainOperationFence(idempotencyKey);
  const expectedCandidate = getLifecycleShadowRepairCandidate(input.item);
  if (!expectedCandidate) throw new Error(`lifecycle shadow repair item not found: ${entityId(input.item)}`);
  beforeCommitHook?.();
  const operation = executeDomainOperation({
    operationType: "lifecycle.shadow.repair",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: requestPayload(input.item, input.step),
  }, (context) => {
    const candidate = getLifecycleShadowRepairCandidate(input.item);
    if (!candidate) throw new Error(`lifecycle shadow repair item not found: ${entityId(input.item)}`);
    requireStableCandidate(expectedCandidate, candidate);
    let afterStatus = candidate.canonicalStatus;
    if (input.targetStatus !== null) {
      // Only the open-Milestone authority adoption (#2313) targets `ready`;
      // it claims no completion, so no durable completion evidence exists
      // for it and none is required.
      if (!candidate.evidence && input.targetStatus !== "ready") {
        throw new Error("lifecycle shadow repair requires durable completion evidence");
      }
      afterStatus = repairLifecycleShadowStep(context, {
        ...input.item,
        expectedBeforeStatus: candidate.canonicalStatus,
        targetStatus: input.targetStatus,
        ...(input.priorRepairOperationId
          ? { priorRepairOperationId: input.priorRepairOperationId }
          : {}),
      }).lifecycleStatus;
    }
    const payload: StoredRepairPayload = {
      item: input.item,
      beforeStatus: candidate.canonicalStatus,
      afterStatus,
      targetStatus: candidate.targetStatus,
      disposition: input.disposition,
      evidence: candidate.evidence,
      comparison: candidate.comparison,
      reason: candidate.reason,
    };
    return {
      events: [{
        eventType: eventType(input.disposition),
        entityType: input.item.itemKind,
        entityId: entityId(input.item),
        payload: payload as unknown as DomainJsonValue,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: projectionKey(input.item),
        projectionKind: "lifecycle-shadow-repair",
        rendererVersion: "1",
      }],
    };
  });
  const stored = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = :event_type
  `).all({
    ":operation_id": operation.operationId,
    ":event_type": eventType(input.disposition),
  });
  if (stored.length !== 1) throw new Error("lifecycle shadow repair receipt requires exactly one event");
  return {
    operation,
    payload: JSON.parse(String(stored[0]!["payload_json"])) as StoredRepairPayload,
  };
}

function toReceipt(step: RepairStepReceipt): LifecycleShadowRepairReceipt {
  return {
    status: step.operation.status,
    operationId: step.operation.operationId,
    resultingRevision: step.operation.resultingRevision,
    disposition: step.payload.disposition,
    beforeStatus: step.payload.beforeStatus,
    afterStatus: step.payload.afterStatus,
    targetStatus: step.payload.targetStatus,
    evidence: step.payload.evidence,
    comparison: step.payload.comparison,
    reason: step.payload.reason,
  };
}

function singleStepReceipt(input: Parameters<typeof executeRepairStep>[0]): LifecycleShadowRepairReceipt {
  return toReceipt(executeRepairStep(input));
}

function replayExistingRepair(
  invocation: ExecutionInvocation,
  item: LifecycleShadowRepairIdentity,
): LifecycleShadowRepairReceipt | null {
  if (operationExists(invocation, "adopt")) {
    return singleStepReceipt({
      invocation,
      item,
      step: "adopt",
      targetStatus: "completed",
      disposition: "repaired",
    });
  }
  if (operationExists(invocation, "unresolved")) {
    return singleStepReceipt({
      invocation,
      item,
      step: "unresolved",
      targetStatus: null,
      disposition: "unresolved",
    });
  }
  if (operationExists(invocation, "complete")) {
    return singleStepReceipt({
      invocation,
      item,
      step: "complete",
      targetStatus: "completed",
      disposition: "repaired",
    });
  }
  if (operationExists(invocation, "advance")) {
    return singleStepReceipt({
      invocation,
      item,
      step: "advance",
      targetStatus: "in_progress",
      disposition: "advanced",
    });
  }
  return null;
}

function isMatchingTaskAdvanceReceipt(
  operationId: string | null,
  item: LifecycleShadowRepairIdentity,
): operationId is string {
  if (!operationId || item.itemKind !== "task") return false;
  return Boolean(getDb().prepare(`
    SELECT 1 AS present
    FROM workflow_operations operation
    JOIN workflow_domain_events event ON event.operation_id = operation.operation_id
    WHERE operation.operation_id = :operation_id
      AND operation.operation_type = 'lifecycle.shadow.repair'
      AND event.event_type = 'lifecycle.shadow.advanced'
      AND event.entity_type = 'task'
      AND event.entity_id = :entity_id
      AND json_extract(event.payload_json, '$.afterStatus') = 'in_progress'
  `).get({
    ":operation_id": operationId,
    ":entity_id": entityId(item),
  }));
}

function milestoneRepairItems(milestoneId: string): LifecycleShadowRepairIdentity[] {
  const taskItems = getDb().prepare(`
    SELECT slice_id, id AS task_id
    FROM tasks
    WHERE milestone_id = :milestone_id
    ORDER BY slice_id, sequence, id
  `).all({ ":milestone_id": milestoneId }).map((row) => ({
    itemKind: "task" as const,
    milestoneId,
    sliceId: String(row["slice_id"]),
    taskId: String(row["task_id"]),
  }));
  const sliceItems = getDb().prepare(`
    SELECT id AS slice_id
    FROM slices
    WHERE milestone_id = :milestone_id
    ORDER BY sequence, id
  `).all({ ":milestone_id": milestoneId }).map((row) => ({
    itemKind: "slice" as const,
    milestoneId,
    sliceId: String(row["slice_id"]),
  }));
  return [...taskItems, ...sliceItems];
}

function sliceRepairItems(milestoneId: string, sliceId: string): LifecycleShadowRepairIdentity[] {
  const taskItems = getDb().prepare(`
    SELECT id AS task_id
    FROM tasks
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id
    ORDER BY sequence, id
  `).all({ ":milestone_id": milestoneId, ":slice_id": sliceId }).map((row) => ({
    itemKind: "task" as const,
    milestoneId,
    sliceId,
    taskId: String(row["task_id"]),
  }));
  return [...taskItems, { itemKind: "slice" as const, milestoneId, sliceId }];
}

function childRepairInvocation(
  invocation: ExecutionInvocation,
  item: LifecycleShadowRepairIdentity,
  phase: "adopt" | "advance" | "complete",
): ExecutionInvocation {
  return {
    ...invocation,
    idempotencyKey: `${invocation.idempotencyKey}:lifecycle-shadow-repair:${entityId(item)}:${phase}`,
  };
}

interface MilestoneRepairEntry {
  item: LifecycleShadowRepairIdentity;
  candidate: LifecycleShadowRepairCandidate;
  kind: "single-step" | "two-phase-task";
}

/**
 * Commits every single-step descendant (missing-shadow adoption, or a ready
 * Slice's direct completion) in one shared lifecycle.shadow.repair Domain
 * Operation. This is the atomic core of the milestone repair: either every
 * listed descendant is durably repaired together, or the whole batch fails
 * closed and none of them are.
 *
 * A ready Task's advance-then-complete sequence cannot join this batch: the
 * schema requires those two edges to be separately committed operations
 * (see repairLifecycleShadowStep), so two-phase Tasks are repaired outside
 * this batch, only after every descendant in the milestone has already been
 * confirmed repairable (see repairMilestoneLifecycleShadowsForward).
 */
function executeMilestoneSingleStepRepairBatch(
  invocation: ExecutionInvocation,
  milestoneId: string,
  entries: MilestoneRepairEntry[],
): string[] {
  const batchDigest = createHash("sha256")
    .update(entries.map((entry) => entityId(entry.item)).sort().join(","))
    .digest("hex")
    .slice(0, 12);
  const idempotencyKey = `${invocation.idempotencyKey}:lifecycle-shadow-repair:milestone/${milestoneId}/batch/${batchDigest}`;
  const fence = readDomainOperationFence(idempotencyKey);
  beforeCommitHook?.();
  executeDomainOperation({
    operationType: "lifecycle.shadow.repair",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: invocation.actorType,
    ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation.sourceTransport,
    ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
    payload: {
      milestoneId,
      items: entries.map((entry) => entityId(entry.item)),
    },
  }, (context) => {
    const events: DomainOperationEventInput[] = [];
    const projections: DomainOperationProjectionInput[] = [];
    for (const entry of entries) {
      const freshCandidate = getLifecycleShadowRepairCandidate(entry.item);
      if (!freshCandidate) throw new Error(`lifecycle shadow repair item not found: ${entityId(entry.item)}`);
      requireStableCandidate(entry.candidate, freshCandidate);
      const afterStatus = repairLifecycleShadowStep(context, {
        ...entry.item,
        expectedBeforeStatus: freshCandidate.canonicalStatus,
        targetStatus: "completed",
        ...(freshCandidate.canonicalStatus === "in_progress" && freshCandidate.canonicalLastOperationId
          ? { priorRepairOperationId: freshCandidate.canonicalLastOperationId }
          : {}),
      }).lifecycleStatus;
      const payload: StoredRepairPayload = {
        item: entry.item,
        beforeStatus: freshCandidate.canonicalStatus,
        afterStatus,
        targetStatus: freshCandidate.targetStatus,
        disposition: "repaired",
        evidence: freshCandidate.evidence,
        comparison: freshCandidate.comparison,
        reason: freshCandidate.reason,
      };
      events.push({
        eventType: "lifecycle.shadow.repaired",
        entityType: entry.item.itemKind,
        entityId: entityId(entry.item),
        payload: payload as unknown as DomainJsonValue,
        destinations: ["projection"],
      });
      projections.push({
        projectionKey: projectionKey(entry.item),
        projectionKind: "lifecycle-shadow-repair",
        rendererVersion: "1",
      });
    }
    return { events, projections };
  });
  return entries.map((entry) => entityId(entry.item));
}

/**
 * Restores missing canonical Milestone lifecycle authority (#2313): a legacy
 * Milestone that is still open (normalized pending/in_progress) but whose
 * canonical row is missing is adopted as `ready`. This claims no completion —
 * only the authority the completion guards require — so it is gated on the
 * legacy status itself, not on descendant completion evidence, and it runs
 * before the descendant pass so unresolved descendants surface as their own
 * precise items instead of hiding behind the parent-authority gate.
 * Existing canonical descendant rows are preserved untouched. Replay-safe:
 * the step is fenced by its own idempotency key and no-ops once the canonical
 * row exists.
 */
/**
 * Restores missing canonical open-item lifecycle authority (#2313): a legacy
 * Milestone or Slice that is still open (normalized pending/in_progress) but
 * whose canonical row is missing is adopted as `ready`. This claims no
 * completion — only the authority the completion guards require — so it is
 * gated on the legacy status itself, not on descendant completion evidence,
 * and it runs before the descendant pass so unresolved descendants surface as
 * their own precise items instead of hiding behind the parent-authority gate.
 * Existing canonical rows are preserved untouched. Replay-safe: each step is
 * fenced by its own idempotency key and no-ops once the canonical row exists.
 */
function adoptMissingCanonicalOpenLifecycle(
  invocation: ExecutionInvocation,
  item: LifecycleShadowRepairIdentity,
): boolean {
  const candidate = getLifecycleShadowRepairCandidate(item);
  if (!candidate || candidate.canonicalStatus !== null) return false;
  if (
    candidate.comparison.normalizedLegacyStatus !== "pending" &&
    candidate.comparison.normalizedLegacyStatus !== "in_progress"
  ) {
    return false;
  }
  const receipt = singleStepReceipt({
    invocation: childRepairInvocation(invocation, item, "adopt"),
    item,
    step: "adopt",
    targetStatus: "ready",
    disposition: "repaired",
  });
  return receipt.disposition === "repaired";
}

function missingCanonicalSliceItems(milestoneId: string): LifecycleShadowRepairIdentity[] {
  const rows = getDb().prepare(`
    SELECT slice.id AS slice_id
    FROM slices slice
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'slice' AND lifecycle.milestone_id = slice.milestone_id
     AND lifecycle.slice_id = slice.id AND lifecycle.task_id IS NULL
    WHERE slice.milestone_id = :milestone_id AND lifecycle.lifecycle_id IS NULL
    ORDER BY slice.sequence, slice.id
  `).all({ ":milestone_id": milestoneId });
  return rows.map((row) => ({
    itemKind: "slice" as const,
    milestoneId,
    sliceId: String(row["slice_id"]),
  }));
}

/**
 * Converges legacy-complete descendants before Milestone validation.
 *
 * This is deliberately narrow: only a candidate with durable legacy completion
 * evidence and a canonical target of `completed` may advance. Tasks are
 * processed before Slices so the hierarchy is canonical from the leaves up.
 *
 * Atomicity: this is an all-or-nothing pass over the milestone's descendants.
 * A read-only planning pass first classifies every in-scope descendant as
 * repairable or unresolved. If even one descendant is unresolved, the whole
 * pass writes nothing and reports every in-scope descendant as unresolved.
 * Only when every in-scope descendant is independently repairable does any
 * write happen; single-step repairs then commit together in one shared
 * Domain Operation (see executeMilestoneSingleStepRepairBatch). Missing
 * canonical open-item authority (the Milestone and any legacy-open Slices)
 * is restored beforehand by adoptMissingCanonicalOpenLifecycle — restoring
 * authority is not a completion claim and does not join the descendant batch.
 */
export function repairMilestoneLifecycleShadowsForward(input: {
  invocation: ExecutionInvocation;
  milestoneId: string;
}): MilestoneLifecycleShadowRepairResult {
  const milestoneId = requireText(input.milestoneId, "milestoneId");
  return planAndRepairShadows(input.invocation, milestoneId, milestoneRepairItems(milestoneId), {
    gateOnMilestoneStatus: true,
    adoptMissingShadows: false,
    adoptMissingOpenAuthority: true,
  });
}

/**
 * Reopen-scoped variant (#2440): identical planning and evidence gates, but a
 * canonically terminal Milestone does not short-circuit the pass — reopen runs
 * against a closed Milestone by definition, and its drifted descendants (legacy
 * terminal while the canonical row stayed `ready`) must converge before the
 * reopen's terminal-parity checks. The per-descendant evidence gate is
 * unchanged: unverifiable descendants are reported unresolved, never written.
 */
export function repairMilestoneShadowsForReopen(input: {
  invocation: ExecutionInvocation;
  milestoneId: string;
}): MilestoneLifecycleShadowRepairResult {
  const milestoneId = requireText(input.milestoneId, "milestoneId");
  return planAndRepairShadows(input.invocation, milestoneId, milestoneRepairItems(milestoneId), {
    gateOnMilestoneStatus: false,
    // Reopen has no later completion sweep to adopt missing shadows — an
    // evidence-backed descendant without a canonical row is adopted here,
    // or terminal parity stays unreachably "missing canonical authority".
    adoptMissingShadows: true,
    adoptMissingOpenAuthority: false,
  });
}

/**
 * Slice-scoped reopen variant (#2440): converges only the reopened Slice's own
 * tasks and the Slice itself, leaves up. Drift elsewhere in the milestone is a
 * Milestone-reopen concern, not a blocker for this Slice's redo.
 */
export function repairSliceShadowsForReopen(input: {
  invocation: ExecutionInvocation;
  milestoneId: string;
  sliceId: string;
}): MilestoneLifecycleShadowRepairResult {
  const milestoneId = requireText(input.milestoneId, "milestoneId");
  const sliceId = requireText(input.sliceId, "sliceId");
  const items = sliceRepairItems(milestoneId, sliceId);
  if (items.length <= 1) return { repaired: [], unresolved: [] };
  return planAndRepairShadows(input.invocation, milestoneId, items, {
    gateOnMilestoneStatus: false,
    adoptMissingShadows: true,
    adoptMissingOpenAuthority: false,
  });
}

function planAndRepairShadows(
  invocation: ExecutionInvocation,
  milestoneId: string,
  repairItems: LifecycleShadowRepairIdentity[],
  opts: {
    gateOnMilestoneStatus: boolean;
    adoptMissingShadows: boolean;
    /** #2313: restore missing canonical open Milestone/Slice authority first (forward repair only). */
    adoptMissingOpenAuthority: boolean;
  },
): MilestoneLifecycleShadowRepairResult {
  const milestoneCandidate = getLifecycleShadowRepairCandidate({ itemKind: "milestone", milestoneId });
  if (
    opts.gateOnMilestoneStatus &&
    milestoneCandidate &&
    (milestoneCandidate.canonicalStatus === "pending" ||
     milestoneCandidate.canonicalStatus === "completed" ||
     milestoneCandidate.canonicalStatus === "cancelled")
  ) {
    return { repaired: [], unresolved: [] };
  }

  const repaired: string[] = [];
  // #2313: the forward repair restores missing canonical open-item authority
  // before the descendant pass so unresolved descendants surface as their own
  // precise items instead of hiding behind the parent-authority gate. Reopen
  // variants (#2440) skip this pre-step: their repair is scoped to the drifted
  // descendants the reopen targets, and a legacy-open missing row left unseen
  // here is exactly what the forward repair adopts at the next completion.
  if (opts.adoptMissingOpenAuthority) {
    if (adoptMissingCanonicalOpenLifecycle(invocation, { itemKind: "milestone", milestoneId })) {
      repaired.push(milestoneId);
    }
    for (const sliceItem of missingCanonicalSliceItems(milestoneId)) {
      if (adoptMissingCanonicalOpenLifecycle(invocation, sliceItem)) {
        repaired.push(entityId(sliceItem));
      }
    }
  }

  // A canonically-completed sibling descendant proves the adoption pattern is
  // established for this milestone (e.g. a partially-applied legacy import):
  // bare legacy-complete stragglers are then swept in by milestone completion
  // rather than blocking validation (#2070). Without that corroboration, an
  // adopted milestone claiming readiness on unsubstantiated descendants is
  // refused (#2002).
  const corroborated = repairItems.some(
    (item) => getLifecycleShadowRepairCandidate(item)?.canonicalStatus === "completed",
  );

  const inScope: MilestoneRepairEntry[] = [];
  const unresolved: string[] = [];

  for (const item of repairItems) {
    const candidate = getLifecycleShadowRepairCandidate(item);
    if (!candidate || candidate.canonicalStatus === "completed") continue;
    const legacyComplete = candidate.comparison.normalizedLegacyStatus === "completed";
    if (!legacyComplete) continue;

    const identity = entityId(item);
    const failedVerification =
      item.itemKind === "task" &&
      typeof candidate.legacyVerificationResult === "string" &&
      candidate.legacyVerificationResult !== "" &&
      isFailedVerificationResult(candidate.legacyVerificationResult);
    if (failedVerification) {
      // Recorded failed verification must never be silently repaired (#2002).
      unresolved.push(identity);
      continue;
    }
    if (candidate.targetStatus !== "completed" || !candidate.evidence) {
      if (
        !opts.adoptMissingShadows &&
        corroborated &&
        candidate.canonicalStatus === null
      ) {
        // Adoption pattern established: this bare straggler — no durable
        // completion evidence of its own — is swept in by milestone
        // completion rather than blocking validation (#2070). Evidence-backed
        // descendants never defer (#2313): slice completion has no sweep, so
        // deferring them would leave "missing canonical lifecycle authority"
        // where the evidence gate could have converged them. Reopen variants
        // disable this exemption (#2440) — there is no later completion
        // sweep, so missing shadows must be resolved now or reopen stays
        // blocked.
        continue;
      }
      unresolved.push(identity);
      continue;
    }
    const canRepair =
      candidate.canonicalStatus === null ||
      candidate.canonicalStatus === "ready" ||
      (
        candidate.canonicalStatus === "in_progress" &&
        item.itemKind === "task" &&
        isMatchingTaskAdvanceReceipt(candidate.canonicalLastOperationId, item)
      );
    if (!canRepair) {
      unresolved.push(identity);
      continue;
    }

    const kind: MilestoneRepairEntry["kind"] =
      candidate.canonicalStatus === "ready" && item.itemKind === "task" ? "two-phase-task" : "single-step";
    inScope.push({ item, candidate, kind });
  }

  if (unresolved.length > 0) {
    for (const entry of inScope) unresolved.push(entityId(entry.item));
    return { repaired, unresolved };
  }
  if (inScope.length === 0) return { repaired, unresolved: [] };

  const taskEntries = inScope.filter((entry) => entry.item.itemKind === "task");
  const sliceEntries = inScope.filter((entry) => entry.item.itemKind === "slice");

  const singleStepTaskEntries = taskEntries.filter((entry) => entry.kind === "single-step");
  const twoPhaseTaskEntries = taskEntries.filter((entry) => entry.kind === "two-phase-task");
  const singleStepSliceEntries = sliceEntries.filter((entry) => entry.kind === "single-step");

  for (const entry of twoPhaseTaskEntries) {
    let receipt = repairLifecycleShadowForward({
      invocation: childRepairInvocation(invocation, entry.item, "advance"),
      item: entry.item,
    });
    if (receipt.disposition === "advanced") {
      receipt = repairLifecycleShadowForward({
        invocation: childRepairInvocation(invocation, entry.item, "complete"),
        item: entry.item,
      });
    }
    if (receipt.disposition === "repaired" && receipt.afterStatus === "completed") {
      repaired.push(entityId(entry.item));
    } else {
      throw new Error(
        `lifecycle shadow repair: descendant ${entityId(entry.item)} was verified repairable during ` +
        "planning but failed during execution",
      );
    }
  }

  const singleStepEntries = [...singleStepTaskEntries, ...singleStepSliceEntries];
  if (singleStepEntries.length > 0) {
    repaired.push(...executeMilestoneSingleStepRepairBatch(invocation, milestoneId, singleStepEntries));
  }

  return { repaired, unresolved: [] };
}

export function repairLifecycleShadowForward(input: {
  invocation: ExecutionInvocation;
  item: LifecycleShadowRepairIdentity;
}): LifecycleShadowRepairReceipt {
  const item = normalizeIdentity(input.item);
  const replay = replayExistingRepair(input.invocation, item);
  if (replay) return replay;

  const candidate = getLifecycleShadowRepairCandidate(item);
  if (!candidate) throw new Error(`lifecycle shadow repair item not found: ${entityId(item)}`);
  if (!candidate.evidence || candidate.targetStatus !== "completed") {
    return singleStepReceipt({
      invocation: input.invocation,
      item,
      step: "unresolved",
      targetStatus: null,
      disposition: "unresolved",
    });
  }
  if (candidate.canonicalStatus === null) {
    return singleStepReceipt({
      invocation: input.invocation,
      item,
      step: "adopt",
      targetStatus: "completed",
      disposition: "repaired",
    });
  }
  if (candidate.canonicalStatus === "ready" && item.itemKind === "task") {
    return singleStepReceipt({
      invocation: input.invocation,
      item,
      step: "advance",
      targetStatus: "in_progress",
      disposition: "advanced",
    });
  }
  if (
    candidate.canonicalStatus === "in_progress" &&
    isMatchingTaskAdvanceReceipt(candidate.canonicalLastOperationId, item)
  ) {
    return singleStepReceipt({
      invocation: input.invocation,
      item,
      step: "complete",
      targetStatus: "completed",
      disposition: "repaired",
      priorRepairOperationId: candidate.canonicalLastOperationId,
    });
  }
  if (candidate.canonicalStatus === "ready" && item.itemKind === "slice") {
    return singleStepReceipt({
      invocation: input.invocation,
      item,
      step: "complete",
      targetStatus: "completed",
      disposition: "repaired",
    });
  }
  return singleStepReceipt({
    invocation: input.invocation,
    item,
    step: "unresolved",
    targetStatus: null,
    disposition: "unresolved",
  });
}
