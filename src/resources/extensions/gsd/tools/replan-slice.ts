import { clearParseCache } from "../files.js";
import {
  adoptLifecycleIfMissing,
  adoptOrTransitionLifecycle,
  getMilestone,
  getSlice,
  getSliceTasks,
  getTask,
  getLatestWorkflowDomainEvent,
  insertTask,
  upsertTaskPlanning,
  insertReplanHistory,
  projectCanonicalStatusToLegacy,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { UnknownLegacyStatusError, adoptionLifecycleStatus, isClosedStatus } from "../status-guards.js";
import { isNonEmptyString, validateStringArray } from "../validation.js";
import { renderPlanFromDb, renderSliceReplan } from "../markdown-renderer.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifestAndFlush } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import { resolveTaskFile } from "../paths.js";
import type { PlanningInvocation } from "../planning-invocation.js";
import { removeOwnedPlanProjection } from "../projection-cleanup.js";
import {
  executePlanningDomainOperation,
  PlanningGuardError,
  planningOperationPayload,
} from "../planning-domain-operation.js";
import { executeDomainOperation, type DomainOperationResult } from "../db/domain-operation.js";
import { readDomainOperationFence } from "../db/writers/lifecycle-commands.js";
import {
  grantPlanReconciliationWaiver,
  readActivePlanReconciliationWaiver,
  recordPlanReconciliationDisposition,
  type PlanReconciliationAuthorization,
} from "../db/writers/slice-lifecycle.js";
import { readLatestTaskAttempt } from "../task-execution-domain-operation.js";
import { ensurePendingSliceQ8 } from "../db/writers/slice-companion-state.js";
import { validateTaskToolRequirements } from "../task-tool-requirements.js";

export interface ReplanSliceTaskInput {
  taskId: string;
  title: string;
  description: string;
  estimate: string;
  files: string[];
  verify: string;
  inputs: string[];
  expectedOutput: string[];
  requiredWorkflowTools?: string[];
  fullPlanMd?: string;
}

export interface ReplanSliceParams {
  milestoneId: string;
  sliceId: string;
  blockerTaskId: string;
  blockerDescription: string;
  whatChanged: string;
  updatedTasks: ReplanSliceTaskInput[];
  removedTaskIds: string[];
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface ReplanSliceResult {
  milestoneId: string;
  sliceId: string;
  replanPath: string;
  planPath: string;
}

/**
 * Provenance of a `blocker-accepted` closeout for the blocker task (#2202).
 * When the requested blockerTaskId was closed by accepting a discovered
 * blocker, the durable replan event carries the accepted blocker's provenance
 * so the revised plan is attributed to the accepted blocker explicitly instead
 * of an arbitrary closed task in the slice.
 */
function readBlockerAcceptedProvenance(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): Record<string, string> | null {
  const blockerTask = getTask(milestoneId, sliceId, taskId);
  if (!blockerTask || blockerTask.status !== "blocker-accepted") return null;
  const event = getLatestWorkflowDomainEvent(
    "task.blocker.accepted",
    "task",
    `${milestoneId}/${sliceId}/${taskId}`,
  );
  if (!event) return null;
  const payload = event.payload;
  const accepted: Record<string, string> = {
    disposition: "blocker-accepted",
    acceptedAt: typeof payload["acceptedAt"] === "string" ? payload["acceptedAt"] : event.createdAt,
  };
  for (const key of [
    "attemptId",
    "resultId",
    "blockerSummary",
    "supersededRecoveryActionId",
    "blockerId",
    "rationale",
  ] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) accepted[key] = value as string;
  }
  return accepted;
}

function validateParams(params: ReplanSliceParams): ReplanSliceParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.sliceId)) throw new Error("sliceId is required");
  if (!isNonEmptyString(params?.blockerTaskId)) throw new Error("blockerTaskId is required");
  if (!isNonEmptyString(params?.blockerDescription)) throw new Error("blockerDescription is required");
  if (!isNonEmptyString(params?.whatChanged)) throw new Error("whatChanged is required");

  if (!Array.isArray(params.updatedTasks)) {
    throw new Error("updatedTasks must be an array");
  }

  if (!Array.isArray(params.removedTaskIds)) {
    throw new Error("removedTaskIds must be an array");
  }

  const updatedTasks = params.updatedTasks.map((task, i) => {
    const t = task;
    if (!t || typeof t !== "object") throw new Error(`updatedTasks[${i}] must be an object`);
    if (!isNonEmptyString(t.taskId)) throw new Error(`updatedTasks[${i}].taskId is required`);
    if (!isNonEmptyString(t.title)) throw new Error(`updatedTasks[${i}].title is required`);
    const requiredWorkflowTools = t.requiredWorkflowTools === undefined
      ? []
      : Array.from(new Set(validateStringArray(t.requiredWorkflowTools, `updatedTasks[${i}].requiredWorkflowTools`)));
    const toolRequirementError = validateTaskToolRequirements(t.taskId, requiredWorkflowTools);
    if (toolRequirementError) throw new Error(toolRequirementError);
    return { ...t, requiredWorkflowTools };
  });

  const updatedIds = updatedTasks.map((task) => task.taskId);
  if (new Set(updatedIds).size !== updatedIds.length) {
    throw new Error("updatedTasks contains duplicate task IDs");
  }
  if (new Set(params.removedTaskIds).size !== params.removedTaskIds.length) {
    throw new Error("removedTaskIds contains duplicate task IDs");
  }
  const removedIds = new Set(params.removedTaskIds);
  const overlappingId = updatedIds.find((taskId) => removedIds.has(taskId));
  if (overlappingId) {
    throw new Error(`task ${overlappingId} cannot be both updated and removed`);
  }

  return { ...params, updatedTasks };
}

/**
 * Record the waived Requirement Dispositions for the cancellation Waivers the
 * replan operation minted for removed tasks (#2346/#2451). The schema's
 * waiver-authority trigger requires a Waiver to precede its waived
 * Disposition by at least one project revision, so this runs as its own
 * fenced Domain Operation keyed to the replan operation's receipt — a replayed
 * replan operation reuses the same key and therefore stays idempotent.
 */
function authorizeReconciliationOmissions(input: {
  invocation: PlanningInvocation;
  replanReceipt: DomainOperationResult;
  milestoneId: string;
  sliceId: string;
  authorizations: PlanReconciliationAuthorization[];
}): void {
  const idempotencyKey = `replan-authorization:${input.replanReceipt.operationId}`;
  const fence = readDomainOperationFence(idempotencyKey);
  const authorizationsPayload = input.authorizations.map((authorization) => ({
    taskId: authorization.taskId,
    requirementId: authorization.requirementId,
    waiverId: authorization.waiverId,
  }));
  executeDomainOperation({
    operationType: "workflow.slice.plan.authorization",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: planningOperationPayload({
      milestoneId: input.milestoneId,
      sliceId: input.sliceId,
      authorizations: authorizationsPayload,
    }),
  }, (context) => {
    for (const authorization of input.authorizations) {
      recordPlanReconciliationDisposition(context, authorization);
    }
    return {
      events: [{
        eventType: "workflow.slice.plan.authorized",
        entityType: "slice",
        entityId: `${input.milestoneId}/${input.sliceId}`,
        payload: { authorizations: authorizationsPayload },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `planning/${input.milestoneId}/${input.sliceId}`.toLowerCase(),
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

export async function handleReplanSlice(
  rawParams: ReplanSliceParams,
  basePath: string,
  invocation: PlanningInvocation,
): Promise<ReplanSliceResult | { error: string }> {
  // ── Validate ──────────────────────────────────────────────────────
  let params: ReplanSliceParams;
  try {
    params = validateParams(rawParams);
  } catch (err) {
    return { error: `validation failed: ${(err as Error).message}` };
  }

  let operationStatus: "committed" | "replayed";
  const blockerAcceptedProvenance = readBlockerAcceptedProvenance(
    params.milestoneId,
    params.sliceId,
    params.blockerTaskId,
  );
  try {
    const receipt = executePlanningDomainOperation({
      operationType: "workflow.slice.replan",
      invocation,
      payload: planningOperationPayload(params),
      event: {
        eventType: "workflow.slice.replanned",
        entityType: "slice",
        entityId: `${params.milestoneId}/${params.sliceId}`,
        payload: {
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          blockerTaskId: params.blockerTaskId,
          blockerDescription: params.blockerDescription,
          whatChanged: params.whatChanged,
          removedTaskIds: params.removedTaskIds,
          updatedTaskIds: params.updatedTasks.map((task) => task.taskId),
          ...(blockerAcceptedProvenance ? { blockerAccepted: blockerAcceptedProvenance } : {}),
        },
        destinations: ["projection"],
      },
      projection: {
        projectionKey: `planning/${params.milestoneId}/${params.sliceId}`.toLowerCase(),
        projectionKind: "markdown",
        rendererVersion: "v1",
      },
      lifecycleItems: () => [
        // #2313: include the parent Milestone for plan-slice parity so the
        // emitted shadow comparisons cover the full authority chain.
        { itemKind: "milestone", milestoneId: params.milestoneId },
        { itemKind: "slice", milestoneId: params.milestoneId, sliceId: params.sliceId },
        ...getSliceTasks(params.milestoneId, params.sliceId).map((task) => ({
          itemKind: "task" as const,
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          taskId: task.id,
        })),
      ],
      mutate(context) {
        // Verify parent slice exists and has not been canonically cancelled.
        const parentSlice = getSlice(params.milestoneId, params.sliceId);
        if (!parentSlice) {
          throw new PlanningGuardError(`missing parent slice: ${params.milestoneId}/${params.sliceId}`);
        }
        // #2313: adopt the parent Milestone lifecycle too, aligned with
        // plan-slice — replanning must not leave the authority chain
        // partially canonicalized.
        const parentMilestone = getMilestone(params.milestoneId);
        if (!parentMilestone) {
          throw new PlanningGuardError(`missing parent milestone: ${params.milestoneId}`);
        }
        if (isClosedStatus(parentMilestone.status)) {
          throw new PlanningGuardError(
            `cannot replan a slice in a closed milestone: ${params.milestoneId} (status: ${parentMilestone.status})`,
          );
        }
        const milestoneLifecycle = adoptLifecycleIfMissing(context, {
          itemKind: "milestone",
          milestoneId: params.milestoneId,
          lifecycleStatus: adoptionLifecycleStatus(`milestone ${params.milestoneId}`, parentMilestone.status, "ready"),
        });
        if (
          milestoneLifecycle.lifecycleStatus === "completed" ||
          milestoneLifecycle.lifecycleStatus === "cancelled"
        ) {
          throw new PlanningGuardError(
            `cannot replan a slice in a ${milestoneLifecycle.lifecycleStatus} milestone ${params.milestoneId} — use gsd_milestone_reopen first`,
          );
        }
        const sliceLifecycle = adoptLifecycleIfMissing(context, {
          itemKind: "slice",
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          lifecycleStatus: adoptionLifecycleStatus(`slice ${params.milestoneId}/${params.sliceId}`, parentSlice.status),
        });
        if (sliceLifecycle.lifecycleStatus === "cancelled" || parentSlice.status === "skipped") {
          throw new PlanningGuardError(`cannot replan cancelled slice ${params.sliceId} — use gsd_slice_reopen first`);
        }
        if (sliceLifecycle.lifecycleStatus === "completed") {
          throw new PlanningGuardError(`cannot replan completed slice ${params.sliceId} — use gsd_slice_reopen first`);
        }
        if (isClosedStatus(parentSlice.status)) {
          throw new PlanningGuardError(`cannot replan a closed slice: ${params.sliceId} (status: ${parentSlice.status})`);
        }

        // Verify blocker task exists and is complete
        const blockerTask = getTask(params.milestoneId, params.sliceId, params.blockerTaskId);
        if (!blockerTask) {
          throw new PlanningGuardError(`blockerTaskId not found: ${params.milestoneId}/${params.sliceId}/${params.blockerTaskId}`);
        }
        const blockerLifecycle = adoptLifecycleIfMissing(context, {
          itemKind: "task",
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          taskId: params.blockerTaskId,
          lifecycleStatus: adoptionLifecycleStatus(`task ${params.milestoneId}/${params.sliceId}/${params.blockerTaskId}`, blockerTask.status),
        });
        if (blockerLifecycle.lifecycleStatus === "cancelled") {
          throw new PlanningGuardError(
            `blockerTaskId ${params.blockerTaskId} is canonically cancelled — explicitly reopen it before using it as a completed blocker`,
          );
        }
        // #2202: a `blocker-accepted` Task counts as the closed blocker for the
        // replan gate; `skipped`/`cancelled` remain rejected.
        if (!isClosedStatus(blockerTask.status) || blockerTask.status === "skipped") {
          throw new PlanningGuardError(`blockerTaskId ${params.blockerTaskId} is not complete (status: ${blockerTask.status}) — the blocker task must be finished before a replan is triggered`);
        }

        // Structural enforcement — reject modifications/removal of completed tasks
        const existingTasks = getSliceTasks(params.milestoneId, params.sliceId);
        const existingTaskById = new Map(existingTasks.map((task) => [task.id, task]));
        const completedTaskIds = new Set(
          existingTasks
            .filter((task) => isClosedStatus(task.status) && task.status !== "skipped" && task.status !== "deferred" && task.status !== "cancelled")
            .map((task) => task.id),
        );

        for (const updatedTask of params.updatedTasks) {
          if (completedTaskIds.has(updatedTask.taskId)) {
            throw new PlanningGuardError(`cannot modify completed task ${updatedTask.taskId}`);
          }
          const existingTask = existingTaskById.get(updatedTask.taskId);
          if (existingTask?.status === "skipped" || existingTask?.status === "deferred" || existingTask?.status === "cancelled") {
            throw new PlanningGuardError(
              `cannot reuse cancelled task ${updatedTask.taskId} — explicitly reopen it before replanning`,
            );
          }
          if (existingTask) {
            const lifecycle = adoptLifecycleIfMissing(context, {
              itemKind: "task",
              milestoneId: params.milestoneId,
              sliceId: params.sliceId,
              taskId: updatedTask.taskId,
              lifecycleStatus: adoptionLifecycleStatus(`task ${params.milestoneId}/${params.sliceId}/${updatedTask.taskId}`, existingTask.status),
            });
            if (lifecycle.lifecycleStatus === "completed" || lifecycle.lifecycleStatus === "cancelled") {
              throw new PlanningGuardError(
                `cannot reuse ${lifecycle.lifecycleStatus} task ${updatedTask.taskId} — explicitly reopen it before replanning`,
              );
            }
          }
        }

        const removedTasks = params.removedTaskIds.map((taskId) => {
          const task = existingTaskById.get(taskId);
          if (!task) {
            throw new PlanningGuardError(`removed task not found: ${params.milestoneId}/${params.sliceId}/${taskId}`);
          }
          if (completedTaskIds.has(taskId)) {
            throw new PlanningGuardError(`cannot remove completed task ${taskId}`);
          }
          const latestAttempt = readLatestTaskAttempt({
            milestoneId: params.milestoneId,
            sliceId: params.sliceId,
            taskId,
          });
          if (latestAttempt?.state === "running") {
            throw new PlanningGuardError(`cannot remove task ${taskId} while it has a running Attempt`);
          }
          const observedLifecycleStatus = adoptionLifecycleStatus(`task ${params.milestoneId}/${params.sliceId}/${taskId}`, task.status);
          const lifecycle = adoptLifecycleIfMissing(context, {
            itemKind: "task",
            milestoneId: params.milestoneId,
            sliceId: params.sliceId,
            taskId,
            lifecycleStatus: observedLifecycleStatus === "completed" ? "completed" : "cancelled",
            adoptedFromStatus: observedLifecycleStatus,
          });
          if (lifecycle.lifecycleStatus === "completed") {
            throw new PlanningGuardError(`cannot remove completed task ${taskId}`);
          }
          return task;
        });

        insertReplanHistory({
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          taskId: params.blockerTaskId,
          summary: params.whatChanged,
        });

        for (const updatedTask of params.updatedTasks) {
          if (existingTaskById.has(updatedTask.taskId)) {
            upsertTaskPlanning(params.milestoneId, params.sliceId, updatedTask.taskId, {
              title: updatedTask.title,
              description: updatedTask.description || "",
              estimate: updatedTask.estimate || "",
              files: updatedTask.files || [],
              verify: updatedTask.verify || "",
              inputs: updatedTask.inputs || [],
              expectedOutput: updatedTask.expectedOutput || [],
              requiredWorkflowTools: updatedTask.requiredWorkflowTools ?? [],
              fullPlanMd: updatedTask.fullPlanMd,
            });
          } else {
            insertTask({
              id: updatedTask.taskId,
              sliceId: params.sliceId,
              milestoneId: params.milestoneId,
              title: updatedTask.title,
              status: "pending",
            });
            upsertTaskPlanning(params.milestoneId, params.sliceId, updatedTask.taskId, {
              title: updatedTask.title,
              description: updatedTask.description || "",
              estimate: updatedTask.estimate || "",
              files: updatedTask.files || [],
              verify: updatedTask.verify || "",
              inputs: updatedTask.inputs || [],
              expectedOutput: updatedTask.expectedOutput || [],
              requiredWorkflowTools: updatedTask.requiredWorkflowTools ?? [],
              fullPlanMd: updatedTask.fullPlanMd,
            });
            adoptLifecycleIfMissing(context, {
              itemKind: "task",
              milestoneId: params.milestoneId,
              sliceId: params.sliceId,
              taskId: updatedTask.taskId,
              lifecycleStatus: "ready",
            });
          }
        }

        // Retain removed task identities for history and FK-backed lifecycle state.
        for (const removedTask of removedTasks) {
          const lifecycle = adoptLifecycleIfMissing(context, {
            itemKind: "task",
            milestoneId: params.milestoneId,
            sliceId: params.sliceId,
            taskId: removedTask.id,
            lifecycleStatus: adoptionLifecycleStatus(`task ${params.milestoneId}/${params.sliceId}/${removedTask.id}`, removedTask.status),
          });
          if (lifecycle.lifecycleStatus !== "cancelled") {
            adoptOrTransitionLifecycle(context, {
              itemKind: "task",
              milestoneId: params.milestoneId,
              sliceId: params.sliceId,
              taskId: removedTask.id,
              lifecycleStatus: "cancelled",
            });
          }
          projectCanonicalStatusToLegacy(context, {
            entity: "task",
            milestoneId: params.milestoneId,
            sliceId: params.sliceId,
            taskId: removedTask.id,
            status: "skipped",
          });
          // #2346/#2451: a replan removal must carry the cancellation
          // authorization the completion-side invariants demand, so slice and
          // milestone closeout are not permanently blocked without a manual
          // waiver.
          grantPlanReconciliationWaiver(context, {
            milestoneId: params.milestoneId,
            sliceId: params.sliceId,
            taskId: removedTask.id,
          });
        }
        ensurePendingSliceQ8(context, params);
      },
    });
    operationStatus = receipt.status;
    // Re-derive the authorizations from durable state — not from the mutation
    // run, which a replayed replan operation skips — so an exact retry after a
    // lost or failed authorization operation still records the waived
    // Dispositions (#2346). The follow-up operation is fenced by the replan
    // receipt's operation id, so re-running it stays idempotent.
    const reconciliationAuthorizations = params.removedTaskIds
      .map((taskId) => readActivePlanReconciliationWaiver({
        milestoneId: params.milestoneId,
        sliceId: params.sliceId,
        taskId,
      }))
      .filter((authorization): authorization is PlanReconciliationAuthorization => authorization !== null);
    if (reconciliationAuthorizations.length > 0) {
      authorizeReconciliationOmissions({
        invocation,
        replanReceipt: receipt,
        milestoneId: params.milestoneId,
        sliceId: params.sliceId,
        authorizations: reconciliationAuthorizations,
      });
    }
  } catch (err) {
    if (err instanceof PlanningGuardError || err instanceof UnknownLegacyStatusError) return { error: err.message };
    return { error: `db write failed: ${(err as Error).message}` };
  }

  // ── Render artifacts ──────────────────────────────────────────────
  try {
    for (const task of getSliceTasks(params.milestoneId, params.sliceId)) {
      if (task.status !== "skipped") continue;
      const taskPlanPath = resolveTaskFile(basePath, params.milestoneId, params.sliceId, task.id, "PLAN");
      if (!taskPlanPath) continue;
      removeOwnedPlanProjection(basePath, taskPlanPath);
    }
    const renderResult = await renderPlanFromDb(basePath, params.milestoneId, params.sliceId);
    const replanResult = await renderSliceReplan(basePath, params.milestoneId, params.sliceId);
    if (!replanResult) throw new Error("durable replan event not found");

    // ── Invalidate caches ─────────────────────────────────────────
    invalidateStateCache();
    clearParseCache();

    // ── Post-mutation hook: projections, manifest, event log ─────
    try {
      await flushWorkflowProjections(basePath, { milestoneId: params.milestoneId });
      await writeManifestAndFlush(basePath);
      if (operationStatus === "committed") {
        appendEvent(basePath, {
          cmd: "replan-slice",
          params: { milestoneId: params.milestoneId, sliceId: params.sliceId, blockerTaskId: params.blockerTaskId },
          ts: new Date().toISOString(),
          actor: "agent",
          actor_name: params.actorName,
          trigger_reason: params.triggerReason,
        });
      }
    } catch (hookErr) {
      logWarning("tool", `replan-slice post-mutation hook warning: ${(hookErr as Error).message}`);
    }

    return {
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      replanPath: replanResult.replanPath,
      planPath: renderResult.planPath,
    };
  } catch (err) {
    return { error: `render failed: ${(err as Error).message}` };
  }
}
