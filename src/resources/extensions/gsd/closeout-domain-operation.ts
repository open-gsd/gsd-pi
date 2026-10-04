// Project/App: gsd-pi
// File Purpose: Milestone closeout Domain Operations: prepare a Closeout Plan, record Settlement Receipts, then complete.

import {
  executeDomainOperation,
  type DomainJsonValue,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { readMilestoneCloseoutAuthorization } from "./db/milestone-closeout-readiness.js";
import {
  CLOSEOUT_PREPARE_OPERATION,
  CLOSEOUT_SETTLE_EFFECT_OPERATION,
  closeoutHash,
  closeoutPlanHasEffects,
  insertCloseoutPlan,
  insertSettlementReceipt,
  pendingRequiredCloseoutEffects,
  readCloseoutAttemptId,
  readMilestoneCloseoutPlan,
  type CloseoutEffectInput,
  type CloseoutPlan,
  type CloseoutSettlementReceipt,
} from "./db/writers/closeout.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import {
  internalExecutionInvocation,
  type ExecutionInvocation,
} from "./execution-invocation.js";
import {
  completeMilestone,
  MilestoneLifecycleValidationError,
  type MilestoneCompletionAudit,
  type MilestoneCompletionCloseout,
  type MilestoneCompletionReceipt,
} from "./milestone-lifecycle-domain-operation.js";
import { MILESTONE_LIFECYCLE_PROJECTION_KIND } from "./projection-identity.js";
import { inspectQualityGatesFromEvidence } from "./quality-gate-closure.js";

export {
  pendingRequiredCloseoutEffects,
  readMilestoneCloseoutPlan,
  type CloseoutEffectInput,
  type CloseoutPlan,
  type CloseoutSettlementReceipt,
};

function operationRequest(
  operationType: string,
  invocation: ExecutionInvocation,
  payload: Record<string, DomainJsonValue>,
) {
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

function lifecycleProjection(milestoneId: string) {
  return [{
    projectionKey: `lifecycle/${milestoneId}`.toLowerCase(),
    projectionKind: MILESTONE_LIFECYCLE_PROJECTION_KIND,
    rendererVersion: "1",
  }];
}

function requireOpenMilestoneLifecycle(projectId: string, milestoneId: string): string {
  const lifecycle = getDb().prepare(`
    SELECT lifecycle_id, lifecycle_status
    FROM workflow_item_lifecycles
    WHERE project_id = :project_id AND item_kind = 'milestone'
      AND milestone_id = :milestone_id AND slice_id IS NULL AND task_id IS NULL
  `).get({ ":project_id": projectId, ":milestone_id": milestoneId });
  if (lifecycle?.["lifecycle_status"] !== "ready" && lifecycle?.["lifecycle_status"] !== "in_progress") {
    throw new MilestoneLifecycleValidationError(`Milestone ${milestoneId} is not open for closeout`);
  }
  return String(lifecycle["lifecycle_id"]);
}

function requireTerminalDescendants(projectId: string, milestoneId: string): void {
  const open = getDb().prepare(`
    SELECT item_kind, slice_id, task_id
    FROM workflow_item_lifecycles
    WHERE project_id = :project_id AND milestone_id = :milestone_id
      AND item_kind IN ('slice', 'task')
      AND lifecycle_status NOT IN ('completed', 'cancelled', 'blocker-accepted')
    ORDER BY slice_id, task_id LIMIT 1
  `).get({ ":project_id": projectId, ":milestone_id": milestoneId });
  if (open) {
    const identity = [open["slice_id"], open["task_id"]].filter(Boolean).join("/");
    throw new MilestoneLifecycleValidationError(
      `Milestone ${milestoneId} closeout blocked: ${String(open["item_kind"])} ${identity} is not terminal`,
    );
  }
}

/**
 * Store the Closeout Plan while the Milestone is still open. The plan proves
 * the completion requirements at one source revision and lists the host
 * effects that must settle before `milestone.complete` may run.
 *
 * Preparing again with the same proof and effects returns the stored plan, so
 * its Settlement Receipts survive a retry.
 */
export function prepareCloseout(input: {
  invocation: ExecutionInvocation;
  milestoneId: string;
  sourceRevision: string;
  closeout: MilestoneCompletionCloseout;
  audit?: MilestoneCompletionAudit;
  effects: CloseoutEffectInput[];
}): CloseoutPlan {
  const { milestoneId, sourceRevision } = input;
  const audit = {
    actorName: input.audit?.actorName?.trim() || null,
    triggerReason: input.audit?.triggerReason?.trim() || null,
  };
  const authorization = readMilestoneCloseoutAuthorization({ milestoneId, sourceRevision });
  if (!authorization.authorized) {
    throw new MilestoneLifecycleValidationError(
      `Milestone ${milestoneId} canonical validation is not current`,
    );
  }
  const readinessBasisHash = closeoutHash({
    kind: authorization.kind,
    eventId: authorization.eventId,
    revision: authorization.revision,
    sourceRevision,
  });
  const attemptId = readCloseoutAttemptId(milestoneId);
  if (!attemptId) {
    throw new MilestoneLifecycleValidationError(
      `Milestone ${milestoneId} has no settled, succeeded Attempt for a Closeout Plan`,
    );
  }
  const current = readMilestoneCloseoutPlan(milestoneId);
  if (
    current &&
    current.lifecycleStatus !== "completed" &&
    current.attemptId === attemptId &&
    current.readinessBasisHash === readinessBasisHash &&
    closeoutPlanHasEffects(current, input.effects)
  ) {
    return current;
  }

  executeDomainOperation(
    operationRequest(CLOSEOUT_PREPARE_OPERATION, input.invocation, {
      milestoneId,
      sourceRevision,
      closeout: input.closeout as unknown as DomainJsonValue,
      audit,
      effects: input.effects as unknown as DomainJsonValue,
    }),
    (context) => {
      const lifecycleId = requireOpenMilestoneLifecycle(context.projectId, milestoneId);
      const unresolvedGate = inspectQualityGatesFromEvidence(milestoneId, {
        milestoneValidationAuthorization: authorization,
      }).unresolved[0];
      if (unresolvedGate) {
        throw new MilestoneLifecycleValidationError(
          `Milestone ${milestoneId} quality gate ${unresolvedGate.gate_id} is still pending for ${unresolvedGate.slice_id}`,
        );
      }
      requireTerminalDescendants(context.projectId, milestoneId);
      const closeoutPlanId = insertCloseoutPlan(context, {
        milestoneId,
        lifecycleId,
        attemptId,
        testedSourceSetHash: closeoutHash(sourceRevision),
        readinessBasisHash,
        effects: input.effects,
        preparedAt: new Date().toISOString(),
      });
      return {
        events: [{
          eventType: "milestone.closeout.prepared",
          entityType: "milestone",
          entityId: milestoneId,
          payload: {
            closeoutPlanId,
            milestoneLifecycleId: lifecycleId,
            sourceRevision,
            closeout: input.closeout as unknown as DomainJsonValue,
            audit,
            effectKinds: input.effects.map((effect) => effect.effectKind),
          },
          destinations: ["projection"],
        }],
        projections: lifecycleProjection(milestoneId),
      };
    },
  );
  return readMilestoneCloseoutPlan(milestoneId)!;
}

/**
 * Record that one host effect of the current Closeout Plan is done. Returns
 * the stored receipt when the effect already has one, so a restarted host
 * never performs the effect twice.
 */
export function recordSettlementReceipt(input: {
  milestoneId: string;
  effectKind: string;
  outcome: CloseoutSettlementReceipt["outcome"];
  externalRef: string;
  proof: Record<string, DomainJsonValue>;
}): CloseoutSettlementReceipt {
  const { milestoneId, effectKind } = input;
  const plan = readMilestoneCloseoutPlan(milestoneId);
  const effect = plan?.effects.find((candidate) => candidate.effectKind === effectKind);
  if (!plan || !effect) {
    throw new Error(`Milestone ${milestoneId} has no Closeout Plan effect ${effectKind}`);
  }
  if (effect.receipt) return effect.receipt;

  const invocation = internalExecutionInvocation(
    `internal:closeout.settle_effect:${effect.closeoutEffectId}`,
  );
  executeDomainOperation(
    operationRequest(CLOSEOUT_SETTLE_EFFECT_OPERATION, invocation, {
      milestoneId,
      closeoutEffectId: effect.closeoutEffectId,
      outcome: input.outcome,
      externalRef: input.externalRef,
      proof: input.proof,
    }),
    (context) => {
      const settlementReceiptId = insertSettlementReceipt(context, {
        closeoutEffectId: effect.closeoutEffectId,
        lifecycleId: plan.lifecycleId,
        outcome: input.outcome,
        externalRef: input.externalRef,
        proof: input.proof,
        settledAt: new Date().toISOString(),
      });
      return {
        events: [{
          eventType: "milestone.closeout.effect_settled",
          entityType: "milestone",
          entityId: milestoneId,
          payload: {
            closeoutPlanId: plan.closeoutPlanId,
            closeoutEffectId: effect.closeoutEffectId,
            effectKind,
            settlementReceiptId,
            outcome: input.outcome,
            externalRef: input.externalRef,
          },
          destinations: ["projection"],
        }],
        projections: lifecycleProjection(milestoneId),
      };
    },
  );
  return readMilestoneCloseoutPlan(milestoneId)!
    .effects.find((candidate) => candidate.closeoutEffectId === effect.closeoutEffectId)!.receipt!;
}

interface PreparedCloseoutPayload {
  sourceRevision: string;
  closeout: MilestoneCompletionCloseout;
  audit: MilestoneCompletionAudit;
}

function preparedCloseoutPayload(plan: CloseoutPlan): PreparedCloseoutPayload {
  const row = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = 'milestone.closeout.prepared'
  `).get({ ":operation_id": plan.operationId });
  const payload = JSON.parse(String(row?.["payload_json"] ?? "null")) as Record<string, unknown> | null;
  const audit = payload?.["audit"] as Record<string, string | null> | undefined;
  if (typeof payload?.["sourceRevision"] !== "string" || !payload["closeout"]) {
    throw new Error(`Closeout Plan ${plan.closeoutPlanId} has no stored closeout request`);
  }
  return {
    sourceRevision: payload["sourceRevision"],
    closeout: payload["closeout"] as MilestoneCompletionCloseout,
    audit: {
      ...(audit?.["actorName"] ? { actorName: audit["actorName"] } : {}),
      ...(audit?.["triggerReason"] ? { triggerReason: audit["triggerReason"] } : {}),
    },
  };
}

/**
 * Complete the Milestone once every required effect of its Closeout Plan has a
 * Settlement Receipt. Returns null when there is no open plan to settle; a
 * required effect without a receipt makes `milestone.complete` throw.
 */
export function settleCloseout(milestoneId: string): MilestoneCompletionReceipt | null {
  const plan = readMilestoneCloseoutPlan(milestoneId);
  if (!plan || plan.lifecycleStatus === "completed") return null;
  const prepared = preparedCloseoutPayload(plan);
  return completeMilestone({
    invocation: internalExecutionInvocation(`internal:closeout.settle:${plan.closeoutPlanId}`),
    milestoneId,
    sourceRevision: prepared.sourceRevision,
    closeout: prepared.closeout,
    audit: prepared.audit,
  });
}
