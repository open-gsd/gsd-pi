// Project/App: gsd-pi
// File Purpose: Task Closeout Plan Domain Operations (ADR-050): prepare the
// plan while the Task's Attempt is settled at the verify stage, record the
// source commit's Settlement Receipt, then publication runs.

import {
  executeDomainOperation,
  type DomainJsonValue,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import {
  readDomainOperationFence,
} from "./db/writers/lifecycle-commands.js";
import {
  TASK_CLOSEOUT_PREPARE_OPERATION,
  TASK_CLOSEOUT_SETTLE_EFFECT_OPERATION,
  TASK_SOURCE_COMMIT_EFFECT,
  closeoutHash,
  closeoutPlanHasEffects,
  insertCloseoutPlan,
  insertSettlementReceipt,
  readLifecycleCloseoutPlan,
  readLifecycleCloseoutPlanHeadId,
  type CloseoutEffectInput,
  type CloseoutPlan,
  type CloseoutSettlementReceipt,
} from "./db/writers/closeout.js";

export { TASK_SOURCE_COMMIT_EFFECT };

import type { ExecutionInvocation } from "./execution-invocation.js";
import { TASK_LIFECYCLE_PROJECTION_KIND } from "./projection-identity.js";

export interface TaskCloseoutIdentity {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

export function taskEntityId(task: TaskCloseoutIdentity): string {
  return `${task.milestoneId}/${task.sliceId}/${task.taskId}`;
}

interface TaskLifecycleRow {
  projectId: string;
  lifecycleId: string;
  lifecycleStatus: string;
}

function readTaskLifecycleRow(task: TaskCloseoutIdentity): TaskLifecycleRow | null {
  const row = getDb().prepare(`
    SELECT lifecycle.lifecycle_id, lifecycle.lifecycle_status, lifecycle.project_id
    FROM workflow_item_lifecycles lifecycle
    JOIN project_authority authority
      ON authority.project_id = lifecycle.project_id
     AND authority.singleton = 1
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    projectId: String(row["project_id"]),
    lifecycleId: String(row["lifecycle_id"]),
    lifecycleStatus: String(row["lifecycle_status"]),
  };
}

function requireTaskLifecycle(task: TaskCloseoutIdentity): TaskLifecycleRow {
  const lifecycle = readTaskLifecycleRow(task);
  if (!lifecycle) {
    throw new Error(`Task ${taskEntityId(task)} has no canonical lifecycle for a Closeout Plan`);
  }
  return lifecycle;
}

function taskProjection(task: TaskCloseoutIdentity) {
  return [{
    projectionKey: `lifecycle/${taskEntityId(task)}`.toLowerCase(),
    projectionKind: TASK_LIFECYCLE_PROJECTION_KIND,
    rendererVersion: "1",
  }];
}

/**
 * The Closeout Plan that speaks for the Task now, or null when the Task has
 * none. An open Task whose last lifecycle transition is newer than the plan
 * reads as history, the same head rule a Milestone plan follows.
 */
export function readTaskCloseoutPlan(task: TaskCloseoutIdentity): CloseoutPlan | null {
  const lifecycle = readTaskLifecycleRow(task);
  if (!lifecycle) return null;
  return readLifecycleCloseoutPlan(lifecycle.projectId, lifecycle.lifecycleId);
}

/** The settled source-commit receipt of the Task's current plan, or null. */
export function settledTaskSourceCommitReceipt(
  task: TaskCloseoutIdentity,
): CloseoutSettlementReceipt | null {
  return readTaskCloseoutPlan(task)?.effects
    .find((effect) => effect.effectKind === TASK_SOURCE_COMMIT_EFFECT)?.receipt ?? null;
}

function defaultEffects(task: TaskCloseoutIdentity): CloseoutEffectInput[] {
  return [{
    effectKind: TASK_SOURCE_COMMIT_EFFECT,
    required: true,
    spec: { task: taskEntityId(task) },
  }];
}

/**
 * Store the Task Closeout Plan while the Task is unpublished. The plan cites
 * the settled succeeded Attempt and carries the source commit as its one
 * required effect. Preparing again for the same Attempt and effects returns
 * the stored plan, so its Settlement Receipt survives a restart.
 */
export function prepareTaskCloseout(input: {
  invocation: ExecutionInvocation;
  task: TaskCloseoutIdentity;
  attemptId: string;
  /** The tested source revision of the Attempt's passing Technical Verdict. */
  testedSourceRevision: string;
  effects?: CloseoutEffectInput[];
}): CloseoutPlan {
  const { task } = input;
  const effects = input.effects ?? defaultEffects(task);
  const testedSourceSetHash = closeoutHash({
    task: taskEntityId(task),
    testedSourceRevision: input.testedSourceRevision,
  });
  const readinessBasisHash = closeoutHash({
    kind: "task-technical-verdict",
    attemptId: input.attemptId,
    testedSourceRevision: input.testedSourceRevision,
  });

  const current = readTaskCloseoutPlan(task);
  if (
    current &&
    current.lifecycleStatus !== "completed" &&
    current.attemptId === input.attemptId &&
    closeoutPlanHasEffects(current, effects)
  ) {
    return current;
  }

  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  executeDomainOperation({
    operationType: TASK_CLOSEOUT_PREPARE_OPERATION,
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: {
      task: {
        milestoneId: task.milestoneId,
        sliceId: task.sliceId,
        taskId: task.taskId,
      },
      attemptId: input.attemptId,
      testedSourceRevision: input.testedSourceRevision,
      effects: effects as unknown as DomainJsonValue,
    },
  }, (context) => {
    const lifecycle = requireTaskLifecycle(task);
    if (lifecycle.lifecycleStatus === "completed") {
      throw new Error(`Task ${taskEntityId(task)} is already published; a Closeout Plan cannot be prepared`);
    }
    // The plan cites a settled, succeeded Attempt of this lifecycle. The
    // schema trigger also enforces causal priority; this read names the
    // exact prerequisite when the caller is early.
    const attempt = getDb().prepare(`
      SELECT attempt.attempt_id
      FROM workflow_execution_attempts attempt
      JOIN workflow_attempt_results result
        ON result.attempt_id = attempt.attempt_id
       AND result.project_id = attempt.project_id
       AND result.lifecycle_id = attempt.lifecycle_id
      WHERE attempt.attempt_id = :attempt_id
        AND attempt.project_id = :project_id
        AND attempt.lifecycle_id = :lifecycle_id
        AND attempt.attempt_state = 'settled'
        AND result.outcome = 'succeeded'
    `).get({
      ":attempt_id": input.attemptId,
      ":project_id": lifecycle.projectId,
      ":lifecycle_id": lifecycle.lifecycleId,
    }) as Record<string, unknown> | undefined;
    if (!attempt) {
      throw new Error(
        `Task ${taskEntityId(task)} Closeout Plan requires its settled, succeeded Attempt ` +
        `${input.attemptId}`,
      );
    }
    const closeoutPlanId = insertCloseoutPlan(context, {
      milestoneId: task.milestoneId,
      lifecycleId: lifecycle.lifecycleId,
      attemptId: input.attemptId,
      testedSourceSetHash,
      readinessBasisHash,
      effects,
      preparedAt: new Date().toISOString(),
      // Supersede this lifecycle's current plan, whatever Attempt cited it: a
      // re-prepare on a new Attempt (the #2618 repair path) replaces the stale
      // plan in the same operation, so one Task lifecycle never carries two
      // live plans and the receipt lands on the plan that speaks now.
      supersedesCloseoutPlanId: readLifecycleCloseoutPlanHeadId(
        lifecycle.projectId,
        lifecycle.lifecycleId,
      ),
    });
    return {
      events: [{
        eventType: "task.closeout.prepared",
        entityType: "task",
        entityId: taskEntityId(task),
        payload: {
          closeoutPlanId,
          taskLifecycleId: lifecycle.lifecycleId,
          attemptId: input.attemptId,
          testedSourceSetHash,
          effectKinds: effects.map((effect) => effect.effectKind),
        },
        destinations: ["projection" as const],
      }],
      projections: taskProjection(task),
    };
  });
  return readTaskCloseoutPlan(task)!;
}

/**
 * Record that the Task's source commit settled. `performed` when this run
 * created the commit, `recognized` when git had nothing to commit and the
 * current commit already carries the work (the recognized-merge rule).
 * Returns the stored receipt when the effect already has one, so a restarted
 * host never settles twice.
 */
export function recordTaskSourceCommitReceipt(input: {
  task: TaskCloseoutIdentity;
  outcome: CloseoutSettlementReceipt["outcome"];
  /** The commit the receipt names: the new commit, or the current one. */
  externalRef: string;
  proof: Record<string, DomainJsonValue>;
}): CloseoutSettlementReceipt {
  const { task } = input;
  const plan = readTaskCloseoutPlan(task);
  const effect = plan?.effects.find((candidate) => candidate.effectKind === TASK_SOURCE_COMMIT_EFFECT);
  if (!plan || !effect) {
    throw new Error(
      `Task ${taskEntityId(task)} has no Closeout Plan effect ${TASK_SOURCE_COMMIT_EFFECT}`,
    );
  }
  if (effect.receipt) return effect.receipt;

  const idempotencyKey = `internal:task.closeout.settle:${effect.closeoutEffectId}`;
  const fence = readDomainOperationFence(idempotencyKey);
  executeDomainOperation({
    operationType: TASK_CLOSEOUT_SETTLE_EFFECT_OPERATION,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload: {
      task: {
        milestoneId: task.milestoneId,
        sliceId: task.sliceId,
        taskId: task.taskId,
      },
      closeoutEffectId: effect.closeoutEffectId,
      outcome: input.outcome,
      externalRef: input.externalRef,
      proof: input.proof,
    },
  }, (context) => {
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
        eventType: "task.closeout.effect_settled",
        entityType: "task",
        entityId: taskEntityId(task),
        payload: {
          closeoutPlanId: plan.closeoutPlanId,
          closeoutEffectId: effect.closeoutEffectId,
          effectKind: TASK_SOURCE_COMMIT_EFFECT,
          settlementReceiptId,
          outcome: input.outcome,
          externalRef: input.externalRef,
        },
        destinations: ["projection"],
      }],
      projections: taskProjection(task),
    };
  });
  return readTaskCloseoutPlan(task)!
    .effects.find((candidate) => candidate.effectKind === TASK_SOURCE_COMMIT_EFFECT)!.receipt!;
}
