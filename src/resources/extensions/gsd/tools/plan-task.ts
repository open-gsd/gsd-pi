import { clearParseCache } from "../files.js";
import { assertVerifyIsShellCheckable } from "../verification-gate.js";
import { normalizeVerifyCommandForVenv } from "../python-resolver.js";
import { isClosedStatus } from "../status-guards.js";
import { isNonEmptyString, validateStringArray } from "../validation.js";
import { getGateIdsForTurn } from "../gate-registry.js";
import {
  adoptLifecycleIfMissing,
  adoptOrTransitionLifecycle,
  getSlice,
  getTask,
  insertGateRow,
  insertTask,
  normalizeLegacyLifecycleStatus,
  setSliceSketchFlag,
  upsertTaskPlanning,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { renderTaskPlanFromDb, renderPlanFromDb } from "../markdown-renderer.js";
import { resolveMilestonePath, resolveSlicePath } from "../paths.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifestAndFlush } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { validatePathOnlyPlanningFields, validatePlanningPathScope } from "../planning-path-scope.js";
import { stripPlanningArtifactReferences } from "../pre-execution-checks.js";
import {
  createRepositoryRegistryFromPreferences,
  defaultRepositoryTargets,
  deriveRepositoryTargetsFromPlannedPaths,
  type RepositoryRegistry,
} from "../repository-registry.js";
import type { GateId } from "../types.js";
import {
  executePlanningDomainOperation,
  PlanningGuardError,
  planningOperationPayload,
} from "../planning-domain-operation.js";
import type { PlanningInvocation } from "../planning-invocation.js";
import { validateTaskToolRequirements } from "../task-tool-requirements.js";
import { executeTaskIllegalPlanToolsError } from "../execute-task-plan-tool-guard.js";

export interface PlanTaskParams {
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
  /** Workflow tools the eventual execute-task unit must be able to call. */
  requiredWorkflowTools?: string[];
  observabilityImpact?: string;
  /** Repository id(s) this task touches (parent workspace); omitted for single-repo projects. */
  targetRepositories?: string[];
  fullPlanMd?: string;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface PlanTaskResult {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  taskPlanPath: string;
}

export function validateRepositoryTargetIds(field: string, value: unknown): string[] {
  const ids = validateStringArray(value, field);
  if (ids.length === 0) throw new Error(`${field} must include at least one repository id when provided`);
  const deduped = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  if (deduped.length === 0) throw new Error(`${field} must include at least one repository id when provided`);
  return deduped;
}

export function validateReferencedRepositories(
  targetRepositories: string[] | undefined,
  registry: RepositoryRegistry,
): string | null {
  if (!targetRepositories) return null;
  const known = new Set(registry.repositories.map((repo) => repo.id));
  const missing = targetRepositories.filter((id) => !known.has(id));
  if (missing.length === 0) return null;
  return `unknown targetRepositories: ${missing.join(", ")}. Declared repositories: ${Array.from(known).join(", ")}`;
}

function resolveAllowedRootsForPathScope(
  targetRepositories: string[],
  registry: RepositoryRegistry,
): string[] {
  if (targetRepositories.length === 0) return [registry.projectRoot];
  const roots = targetRepositories
    .map((id) => registry.byId.get(id)?.root)
    .filter((root): root is string => typeof root === "string");
  return roots.length > 0 ? roots : [registry.projectRoot];
}

function validatePathScopeForTargetRepositories(
  params: PlanTaskParams,
  basePath: string,
  registry: RepositoryRegistry,
  targetRepositories: string[],
): string | null {
  return validatePlanningPathScope(
    basePath,
    [
      { field: "files", values: params.files },
      { field: "inputs", values: params.inputs },
      { field: "expectedOutput", values: params.expectedOutput },
    ],
    resolveAllowedRootsForPathScope(targetRepositories, registry),
  );
}

export function resolveEffectiveTargetRepositories(
  taskTargetRepositories: string[] | undefined,
  sliceTargetRepositories: string[] | undefined,
  defaultTargets: string[],
  derivedTargets: string[] | null,
): string[] {
  if (taskTargetRepositories) return taskTargetRepositories;
  if (sliceTargetRepositories?.length) return sliceTargetRepositories;
  // Defaulted parent-mode targets must follow where the task's files actually
  // live — otherwise verification fans out to child repos the task never
  // touched and can never pass (#1630).
  if (derivedTargets?.length) return derivedTargets;
  return defaultTargets;
}

function validateParams(params: PlanTaskParams): PlanTaskParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.sliceId)) throw new Error("sliceId is required");
  if (!isNonEmptyString(params?.taskId)) throw new Error("taskId is required");
  if (!isNonEmptyString(params?.title)) throw new Error("title is required");
  if (!isNonEmptyString(params?.description)) throw new Error("description is required");
  if (!isNonEmptyString(params?.estimate)) throw new Error("estimate is required");
  if (!isNonEmptyString(params?.verify)) throw new Error("verify is required");
  assertVerifyIsShellCheckable(params.verify);
  if (params.observabilityImpact !== undefined && !isNonEmptyString(params.observabilityImpact)) {
    throw new Error("observabilityImpact must be a non-empty string when provided");
  }

  const files = validateStringArray(params.files, "files");
  const illegalToolsError = executeTaskIllegalPlanToolsError(
    { description: params.description, files },
    `task ${params.taskId}`,
  );
  if (illegalToolsError) throw new Error(illegalToolsError);

  return {
    ...params,
    files,
    inputs: validateStringArray(params.inputs, "inputs"),
    expectedOutput: validateStringArray(params.expectedOutput, "expectedOutput"),
    requiredWorkflowTools: params.requiredWorkflowTools === undefined
      ? []
      : Array.from(new Set(validateStringArray(params.requiredWorkflowTools, "requiredWorkflowTools"))),
    ...(params.targetRepositories !== undefined
      ? { targetRepositories: validateRepositoryTargetIds("targetRepositories", params.targetRepositories) }
      : {}),
  };
}

function resolveTaskGates(basePath: string): GateId[] {
  const loaded = loadEffectiveGSDPreferences(basePath);
  if (loaded?.preferences?.gate_evaluation?.task_gates === false) return [];
  return [...getGateIdsForTurn("execute-task")];
}

export async function handlePlanTask(
  rawParams: PlanTaskParams,
  basePath: string,
  invocation: PlanningInvocation,
): Promise<PlanTaskResult | { error: string }> {
  let params: PlanTaskParams;
  try {
    params = validateParams(rawParams);
    params = { ...params, verify: normalizeVerifyCommandForVenv(params.verify, basePath) };
  } catch (err) {
    return { error: `validation failed: ${(err as Error).message}` };
  }
  // Planning artifacts in inputs/files are redundant (the executor preloads
  // them); drop them here so the stored row never carries them and the
  // dispatch-gate check has nothing to re-flag.
  stripPlanningArtifactReferences(params, basePath);

  const toolRequirementError = validateTaskToolRequirements(params.taskId, params.requiredWorkflowTools ?? []);
  if (toolRequirementError) {
    return { error: `tool-contract validation failed: ${toolRequirementError}` };
  }

  const pathOnlyError = validatePathOnlyPlanningFields([
    { field: "expectedOutput", values: params.expectedOutput },
  ]);
  if (pathOnlyError) {
    return { error: `validation failed: ${pathOnlyError}` };
  }

  let taskGates: GateId[];
  let repositoryRegistry: RepositoryRegistry;
  try {
    taskGates = resolveTaskGates(basePath);
    const loaded = loadEffectiveGSDPreferences(basePath);
    repositoryRegistry = createRepositoryRegistryFromPreferences(basePath, loaded?.preferences);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `validation failed: ${message}` };
  }

  const defaultTargets = defaultRepositoryTargets(repositoryRegistry);
  const derivedTargets = deriveRepositoryTargetsFromPlannedPaths(
    repositoryRegistry,
    [...params.files, ...params.expectedOutput],
  );

  let operationStatus: "committed" | "replayed";
  try {
    const receipt = executePlanningDomainOperation({
      operationType: "workflow.task.plan",
      invocation,
      actorId: params.actorName,
      payload: planningOperationPayload(params),
      event: {
        eventType: "workflow.task.planned",
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
          throw new PlanningGuardError(`cannot plan task in a closed slice: ${params.sliceId} (status: ${parentSlice.status})`);
        }
        const legacyParentLifecycle = normalizeLegacyLifecycleStatus(parentSlice.status);
        let parentLifecycleStatus: "ready" | "completed" | "cancelled" = "ready";
        if (legacyParentLifecycle === "completed" || legacyParentLifecycle === "cancelled") {
          parentLifecycleStatus = legacyParentLifecycle;
        }
        const parentLifecycle = adoptLifecycleIfMissing(context, {
          itemKind: "slice",
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          lifecycleStatus: parentLifecycleStatus,
        });
        if (parentLifecycle.lifecycleStatus === "completed" || parentLifecycle.lifecycleStatus === "cancelled") {
          throw new PlanningGuardError(
            `cannot plan task in ${parentLifecycle.lifecycleStatus} slice ${params.sliceId} — use gsd_slice_reopen first`,
          );
        }

        const existingTask = getTask(params.milestoneId, params.sliceId, params.taskId);
        if (existingTask && isClosedStatus(existingTask.status)) {
          throw new PlanningGuardError(`cannot re-plan task ${params.taskId}: it is already complete — use gsd_task_reopen first`);
        }
        let existingLifecycle: ReturnType<typeof adoptLifecycleIfMissing> | null = null;
        if (existingTask) {
          const legacyTaskLifecycle = normalizeLegacyLifecycleStatus(existingTask.status);
          let taskLifecycleStatus: "ready" | "completed" | "cancelled" = "ready";
          if (legacyTaskLifecycle === "completed" || legacyTaskLifecycle === "cancelled") {
            taskLifecycleStatus = legacyTaskLifecycle;
          }
          existingLifecycle = adoptLifecycleIfMissing(context, {
            itemKind: "task",
            milestoneId: params.milestoneId,
            sliceId: params.sliceId,
            taskId: params.taskId,
            lifecycleStatus: taskLifecycleStatus,
          });
        }
        if (existingLifecycle?.lifecycleStatus === "completed" || existingLifecycle?.lifecycleStatus === "cancelled") {
          throw new PlanningGuardError(
            `cannot re-plan ${existingLifecycle.lifecycleStatus} task ${params.taskId} — use gsd_task_reopen first`,
          );
        }

        let effectiveTargetRepositories = resolveEffectiveTargetRepositories(
          params.targetRepositories,
          parentSlice.target_repositories,
          defaultTargets,
          derivedTargets,
        );
        // #1656: in a parent workspace, a task with nothing explicit and nothing
        // derivable from its planned paths must not fossilize the fan-out default
        // into its row. Storing no targets lets verification resolve to the
        // orchestration root instead. Derived targets (#1630) are concrete, so
        // they are still persisted.
        let persistedTargetRepositories = repositoryRegistry.mode === "parent"
          && params.targetRepositories === undefined
          && !parentSlice.target_repositories?.length
          && !derivedTargets?.length
          ? []
          : effectiveTargetRepositories;
        const repoValidationError = validateReferencedRepositories(effectiveTargetRepositories, repositoryRegistry);
        if (repoValidationError) {
          throw new PlanningGuardError(`validation failed: ${repoValidationError}`);
        }

        let pathScopeError = validatePathScopeForTargetRepositories(
          params,
          basePath,
          repositoryRegistry,
          effectiveTargetRepositories,
        );
        const storedTaskTargets = existingTask?.target_repositories?.length
          ? existingTask.target_repositories
          : undefined;
        if (pathScopeError && params.targetRepositories === undefined && storedTaskTargets) {
          const storedRepoValidationError = validateReferencedRepositories(storedTaskTargets, repositoryRegistry);
          const storedPathScopeError = storedRepoValidationError
            ? storedRepoValidationError
            : validatePathScopeForTargetRepositories(params, basePath, repositoryRegistry, storedTaskTargets);
          if (!storedPathScopeError) {
            effectiveTargetRepositories = storedTaskTargets;
            persistedTargetRepositories = storedTaskTargets;
            pathScopeError = null;
          }
        }
        if (pathScopeError) {
          throw new PlanningGuardError(`validation failed: ${pathScopeError}`);
        }

        if (!existingTask) {
          insertTask({
            id: params.taskId,
            sliceId: params.sliceId,
            milestoneId: params.milestoneId,
            title: params.title,
            status: "pending",
          });
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
          observabilityImpact: params.observabilityImpact ?? "",
          fullPlanMd: params.fullPlanMd,
          targetRepositories: persistedTargetRepositories,
        });
        for (const gid of taskGates) {
          insertGateRow({ milestoneId: params.milestoneId, sliceId: params.sliceId, gateId: gid, scope: "task", taskId: params.taskId });
        }
        setSliceSketchFlag(params.milestoneId, params.sliceId, false);
        const taskLifecycle = existingLifecycle ?? adoptLifecycleIfMissing(context, {
            itemKind: "task",
            milestoneId: params.milestoneId,
            sliceId: params.sliceId,
            taskId: params.taskId,
            lifecycleStatus: "ready",
          });
        if (taskLifecycle.lifecycleStatus === "pending") {
          adoptOrTransitionLifecycle(context, {
            itemKind: "task",
            milestoneId: params.milestoneId,
            sliceId: params.sliceId,
            taskId: params.taskId,
            lifecycleStatus: "ready",
          });
        }
        if (parentLifecycle.lifecycleStatus === "pending") {
          adoptOrTransitionLifecycle(context, {
            itemKind: "slice",
            milestoneId: params.milestoneId,
            sliceId: params.sliceId,
            lifecycleStatus: "ready",
          });
        }
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
    let renderedPath: string;

    if (isLegacySliceLayout) {
      const renderResult = await renderTaskPlanFromDb(basePath, params.milestoneId, params.sliceId, params.taskId);
      renderedPath = renderResult.taskPlanPath;
    } else {
      const renderResult = await renderPlanFromDb(basePath, params.milestoneId, params.sliceId);
      renderedPath = renderResult.planPath;
    }

    invalidateStateCache();
    clearParseCache();

    // ── Post-mutation hook: projections, manifest, event log ─────────────
    try {
      await flushWorkflowProjections(basePath, { milestoneId: params.milestoneId });
      await writeManifestAndFlush(basePath);
      if (operationStatus === "committed") {
        appendEvent(basePath, {
          cmd: "plan-task",
          params: { milestoneId: params.milestoneId, sliceId: params.sliceId, taskId: params.taskId },
          ts: new Date().toISOString(),
          actor: "agent",
          actor_name: params.actorName,
          trigger_reason: params.triggerReason,
        });
      }
    } catch (hookErr) {
      logWarning("tool", `plan-task post-mutation hook warning: ${(hookErr as Error).message}`);
    }

    return {
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      taskId: params.taskId,
      taskPlanPath: renderedPath,
    };
  } catch (err) {
    return { error: `render failed: ${(err as Error).message}` };
  }
}
