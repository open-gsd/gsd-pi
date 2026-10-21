import { clearParseCache } from "../files.js";
import {
  getSlice,
  getTask,
  insertReplanHistory,
  upsertTaskPlanning,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { isClosedStatus } from "../status-guards.js";
import { isNonEmptyString, validateStringArray } from "../validation.js";
import { assertVerifyIsShellCheckable } from "../verification-gate.js";
import { normalizeVerifyCommandForVenv } from "../python-resolver.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import {
  createRepositoryRegistryFromPreferences,
  defaultRepositoryTargets,
  deriveRepositoryTargetsFromPlannedPaths,
  type RepositoryRegistry,
} from "../repository-registry.js";
import {
  resolveEffectiveTargetRepositories,
  validateReferencedRepositories,
  validateRepositoryTargetIds,
} from "./plan-task.js";
import { renderPlanFromDb, renderTaskPlanFromDb } from "../markdown-renderer.js";
import { resolveMilestonePath, resolveSlicePath } from "../paths.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifestAndFlush } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import {
  adoptLifecycleIfMissing,
  normalizeLegacyLifecycleStatus,
} from "../db/writers/lifecycle-commands.js";
import {
  executePlanningDomainOperation,
  PlanningGuardError,
  planningOperationPayload,
} from "../planning-domain-operation.js";
import type { PlanningInvocation } from "../planning-invocation.js";
import { validateTaskToolRequirements } from "../task-tool-requirements.js";

export interface ReplanTaskParams {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  title: string;
  description: string;
  estimate: string;
  files: string[];
  verify: string;
  inputs: string[];
  expectedOutput: string[];
  requiredWorkflowTools?: string[];
  /** Repository id(s) this task touches (parent workspace); recomputed from planned paths when omitted. */
  targetRepositories?: string[];
  reworkBriefRef?: string;
  fullPlanMd?: string;
  actorName?: string;
  triggerReason?: string;
}

export interface ReplanTaskResult {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  taskPlanPath: string;
}

function validateParams(params: ReplanTaskParams): ReplanTaskParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.sliceId)) throw new Error("sliceId is required");
  if (!isNonEmptyString(params?.taskId)) throw new Error("taskId is required");
  if (!isNonEmptyString(params?.title)) throw new Error("title is required");
  if (!isNonEmptyString(params?.description)) throw new Error("description is required");
  if (!isNonEmptyString(params?.estimate)) throw new Error("estimate is required");
  if (!isNonEmptyString(params?.verify)) throw new Error("verify is required");
  assertVerifyIsShellCheckable(params.verify);
  const requiredWorkflowTools = params.requiredWorkflowTools === undefined
    ? []
    : Array.from(new Set(validateStringArray(params.requiredWorkflowTools, "requiredWorkflowTools")));
  const toolRequirementError = validateTaskToolRequirements(params.taskId, requiredWorkflowTools);
  if (toolRequirementError) throw new Error(toolRequirementError);
  return {
    ...params,
    files: validateStringArray(params.files, "files"),
    inputs: validateStringArray(params.inputs, "inputs"),
    expectedOutput: validateStringArray(params.expectedOutput, "expectedOutput"),
    requiredWorkflowTools,
    ...(params.targetRepositories !== undefined
      ? { targetRepositories: validateRepositoryTargetIds("targetRepositories", params.targetRepositories) }
      : {}),
  };
}

function replanSummary(params: ReplanTaskParams): string {
  const ref = params.reworkBriefRef?.trim();
  return ref
    ? `Task ${params.taskId} replanned from rework brief ${ref}`
    : `Task ${params.taskId} replanned`;
}

export async function handleReplanTask(
  rawParams: ReplanTaskParams,
  basePath: string,
  invocation: PlanningInvocation,
): Promise<ReplanTaskResult | { error: string }> {
  let params: ReplanTaskParams;
  try {
    params = validateParams(rawParams);
    params = { ...params, verify: normalizeVerifyCommandForVenv(params.verify, basePath) };
  } catch (err) {
    return { error: `validation failed: ${(err as Error).message}` };
  }

  let repositoryRegistry: RepositoryRegistry;
  try {
    const loaded = loadEffectiveGSDPreferences(basePath);
    repositoryRegistry = createRepositoryRegistryFromPreferences(basePath, loaded?.preferences);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `validation failed: ${message}` };
  }

  const defaultTargets = defaultRepositoryTargets(repositoryRegistry);
  // Replan recomputes repository targets from the replanned paths so a row
  // fossilized with the old parent-mode fan-out default heals on replan (#1630).
  const derivedTargets = deriveRepositoryTargetsFromPlannedPaths(
    repositoryRegistry,
    [...params.files, ...params.expectedOutput],
  );

  let operationStatus: "committed" | "replayed";
  try {
    const receipt = executePlanningDomainOperation({
      operationType: "workflow.task.replan",
      invocation,
      actorId: params.actorName,
      payload: planningOperationPayload(params),
      event: {
        eventType: "workflow.task.replanned",
        entityType: "task",
        entityId: `${params.milestoneId}/${params.sliceId}/${params.taskId}`,
        payload: {
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          taskId: params.taskId,
        },
        destinations: ["projection"],
      },
      projection: {
        projectionKey: `planning/${params.milestoneId}/${params.sliceId}/${params.taskId}`.toLowerCase(),
        projectionKind: "markdown",
        rendererVersion: "v1",
      },
      lifecycleItems: () => [
        { itemKind: "slice", milestoneId: params.milestoneId, sliceId: params.sliceId },
        { itemKind: "task", milestoneId: params.milestoneId, sliceId: params.sliceId, taskId: params.taskId },
      ],
      mutate(context) {
        const parentSlice = getSlice(params.milestoneId, params.sliceId);
        if (!parentSlice) {
          throw new PlanningGuardError(`missing parent slice: ${params.milestoneId}/${params.sliceId}`);
        }
        if (isClosedStatus(parentSlice.status)) {
          throw new PlanningGuardError(`cannot replan a task in a closed slice: ${params.sliceId} (status: ${parentSlice.status})`);
        }
        const parentLifecycle = adoptLifecycleIfMissing(context, {
          itemKind: "slice",
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          lifecycleStatus: normalizeLegacyLifecycleStatus(parentSlice.status) ?? "ready",
        });
        if (parentLifecycle.lifecycleStatus === "completed" || parentLifecycle.lifecycleStatus === "cancelled") {
          throw new PlanningGuardError(
            `cannot replan a task in ${parentLifecycle.lifecycleStatus} slice ${params.sliceId} — use gsd_slice_reopen first`,
          );
        }

        const task = getTask(params.milestoneId, params.sliceId, params.taskId);
        if (!task) {
          throw new PlanningGuardError(`task not found: ${params.milestoneId}/${params.sliceId}/${params.taskId}`);
        }
        if (isClosedStatus(task.status)) {
          throw new PlanningGuardError(`cannot replan completed task ${params.taskId} — use gsd_task_reopen first`);
        }
        const lifecycle = adoptLifecycleIfMissing(context, {
          itemKind: "task",
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          taskId: params.taskId,
          lifecycleStatus: normalizeLegacyLifecycleStatus(task.status) ?? "ready",
        });
        if (lifecycle.lifecycleStatus === "completed" || lifecycle.lifecycleStatus === "cancelled") {
          throw new PlanningGuardError(
            `cannot replan ${lifecycle.lifecycleStatus} task ${params.taskId} — use gsd_task_reopen first`,
          );
        }

        const effectiveTargetRepositories = resolveEffectiveTargetRepositories(
          params.targetRepositories,
          parentSlice.target_repositories,
          defaultTargets,
          derivedTargets,
        );
        const repoValidationError = validateReferencedRepositories(effectiveTargetRepositories, repositoryRegistry);
        if (repoValidationError) {
          throw new PlanningGuardError(`validation failed: ${repoValidationError}`);
        }

        upsertTaskPlanning(params.milestoneId, params.sliceId, params.taskId, {
          title: params.title,
          description: params.description,
          estimate: params.estimate,
          files: params.files,
          verify: params.verify,
          inputs: params.inputs,
          expectedOutput: params.expectedOutput,
          requiredWorkflowTools: params.requiredWorkflowTools ?? [],
          fullPlanMd: params.fullPlanMd,
          targetRepositories: effectiveTargetRepositories,
        });
        insertReplanHistory({
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          taskId: params.taskId,
          summary: replanSummary(params),
          previousArtifactPath: params.reworkBriefRef ?? null,
        });
      },
    });
    operationStatus = receipt.status;
  } catch (err) {
    if (err instanceof PlanningGuardError) return { error: err.message };
    return { error: `db write failed: ${(err as Error).message}` };
  }

  try {
    const milestonePath = resolveMilestonePath(basePath, params.milestoneId);
    const slicePath = resolveSlicePath(basePath, params.milestoneId, params.sliceId);
    const isLegacySliceLayout = Boolean(milestonePath && slicePath && slicePath !== milestonePath);
    const renderResult = isLegacySliceLayout
      ? await renderTaskPlanFromDb(basePath, params.milestoneId, params.sliceId, params.taskId)
      : await renderPlanFromDb(basePath, params.milestoneId, params.sliceId);
    const taskPlanPath = "taskPlanPath" in renderResult ? renderResult.taskPlanPath : renderResult.planPath;

    invalidateStateCache();
    clearParseCache();

    try {
      await flushWorkflowProjections(basePath, { milestoneId: params.milestoneId });
      await writeManifestAndFlush(basePath);
      if (operationStatus === "committed") {
        appendEvent(basePath, {
          cmd: "replan-task",
          params: { milestoneId: params.milestoneId, sliceId: params.sliceId, taskId: params.taskId },
          ts: new Date().toISOString(),
          actor: "agent",
          actor_name: params.actorName,
          trigger_reason: params.triggerReason,
        });
      }
    } catch (hookErr) {
      logWarning("tool", `replan-task post-mutation hook warning: ${(hookErr as Error).message}`);
    }

    return {
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      taskId: params.taskId,
      taskPlanPath,
    };
  } catch (err) {
    return { error: `render failed: ${(err as Error).message}` };
  }
}
