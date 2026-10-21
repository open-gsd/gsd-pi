import { clearParseCache } from "../files.js";
import {
  adoptLifecycleIfMissing,
  adoptOrTransitionLifecycle,
  getSlice,
  getSliceTasks,
  getTask,
  getLatestWorkflowDomainEvent,
  insertTask,
  upsertTaskPlanning,
  insertReplanHistory,
  normalizeLegacyLifecycleStatus,
  projectCanonicalStatusToLegacy,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { isClosedStatus } from "../status-guards.js";
import { isNonEmptyString, validateStringArray } from "../validation.js";
import { renderPlanFromDb, renderReplanFromDb } from "../markdown-renderer.js";
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
      actorId: params.actorName,
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
        const sliceLifecycle = adoptLifecycleIfMissing(context, {
          itemKind: "slice",
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          lifecycleStatus: normalizeLegacyLifecycleStatus(parentSlice.status) ?? "ready",
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
          lifecycleStatus: normalizeLegacyLifecycleStatus(blockerTask.status) ?? "ready",
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
              lifecycleStatus: normalizeLegacyLifecycleStatus(existingTask.status) ?? "ready",
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
          const legacyLifecycleStatus = normalizeLegacyLifecycleStatus(task.status);
          const observedLifecycleStatus = legacyLifecycleStatus ?? "ready";
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
            lifecycleStatus: normalizeLegacyLifecycleStatus(removedTask.status) ?? "ready",
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
        }
        ensurePendingSliceQ8(context, params);
      },
    });
    operationStatus = receipt.status;
  } catch (err) {
    if (err instanceof PlanningGuardError) return { error: err.message };
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
    const durableReplan = getLatestWorkflowDomainEvent(
      "workflow.slice.replanned",
      "slice",
      `${params.milestoneId}/${params.sliceId}`,
    );
    if (!durableReplan) throw new Error("durable replan event not found");
    const blockerTaskId = durableReplan.payload["blockerTaskId"];
    const blockerDescription = durableReplan.payload["blockerDescription"];
    const whatChanged = durableReplan.payload["whatChanged"];
    if (
      typeof blockerTaskId !== "string" ||
      typeof blockerDescription !== "string" ||
      typeof whatChanged !== "string"
    ) {
      throw new Error("durable replan event is missing projection data");
    }
    const replanResult = await renderReplanFromDb(basePath, params.milestoneId, params.sliceId, {
      blockerTaskId,
      blockerDescription,
      whatChanged,
      createdAt: durableReplan.createdAt,
    });

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
