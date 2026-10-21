import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  gsdProjectionRoot,
  gsdRoot,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveSliceFile,
  resolveTaskFile,
  targetMilestoneFile,
} from "../paths.js";
import { deriveCompatProjectionKey } from "../compat/compat-marker.js";
import { clearParseCache } from "../files.js";
import { isClosedStatus } from "../status-guards.js";
import { isNonEmptyString, validateStringArray } from "../validation.js";
import { removeProjectionFileSync } from "../atomic-write.js";
import {
  adoptLifecycleIfMissing,
  adoptOrTransitionLifecycle,
  getMilestone,
  getMilestoneSlices,
  getAssessment,
  getSlice,
  getSliceTasks,
  insertSlice,
  normalizeLegacyLifecycleStatus,
  projectCanonicalStatusToLegacy,
  upsertMilestonePlanning,
  upsertSlicePlanning,
  updateSliceFields,
  insertAssessment,
  deleteAssessmentByScope,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import {
  renderRoadmapFromDb,
  renderRoadmapAssessmentFromDb,
  resolveRoadmapAssessmentProjectionPath,
} from "../markdown-renderer.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifestAndFlush } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import {
  executePlanningDomainOperation,
  PlanningGuardError,
  planningOperationPayload,
} from "../planning-domain-operation.js";
import type { PlanningInvocation } from "../planning-invocation.js";
import { removeOwnedPlanProjection } from "../projection-cleanup.js";

export interface SliceChangeInput {
  sliceId: string;
  title: string;
  risk?: string;
  depends?: string[];
  demo?: string;
}

export interface ReassessRoadmapParams {
  milestoneId: string;
  completedSliceId: string;
  verdict: string;
  assessment: string;
  sliceChanges: {
    modified: SliceChangeInput[];
    added: SliceChangeInput[];
    removed: string[];
  };
  metadataCorrections?: {
    milestone?: {
      successCriteria?: string[];
      verificationContract?: string;
      verificationIntegration?: string;
      verificationOperational?: string;
      verificationUat?: string;
      definitionOfDone?: string[];
      requirementCoverage?: string;
      boundaryMapMarkdown?: string;
    };
    completedSlices?: Array<{
      sliceId: string;
      demo?: string;
      goal?: string;
      successCriteria?: string;
      proofLevel?: string;
      integrationClosure?: string;
      observabilityImpact?: string;
    }>;
  };
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface ReassessRoadmapResult {
  milestoneId: string;
  completedSliceId: string;
  assessmentPath: string;
  roadmapPath: string;
}

function assessmentDbPathForRenderedFile(basePath: string, absPath: string): string {
  // Derive the .gsd-relative key with the shared helper, which realpath-normalizes
  // both the roots and the target (falling back to resolve() for not-yet-written
  // files). A prior implementation realpath-normalized only basePath and left
  // absPath raw, so on Windows the two sides used divergent drive/short-name/junction
  // forms and the .gsd/ prefix check spuriously failed (#windows-portability).
  const key = deriveCompatProjectionKey(absPath, [gsdProjectionRoot(basePath), gsdRoot(basePath)]);
  if (key === ".." || key.startsWith("../") || isAbsolute(key)) {
    throw new Error(`assessment projection must be inside .gsd: ${absPath}`);
  }
  return `.gsd/${key}`;
}

function removeSlicePlanProjections(basePath: string, milestoneId: string, sliceIds: string[]): void {
  for (const sliceId of sliceIds) {
    const planPaths = [resolveSliceFile(basePath, milestoneId, sliceId, "PLAN")];
    for (const task of getSliceTasks(milestoneId, sliceId)) {
      planPaths.push(resolveTaskFile(basePath, milestoneId, sliceId, task.id, "PLAN"));
    }
    for (const planPath of planPaths) {
      if (!planPath) continue;
      try {
        removeOwnedPlanProjection(basePath, planPath);
      } catch (err) {
        logWarning("tool", `removed slice plan cleanup warning: ${(err as Error).message}`);
      }
    }
  }
}

function validateParams(params: ReassessRoadmapParams): ReassessRoadmapParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.completedSliceId)) throw new Error("completedSliceId is required");
  if (!isNonEmptyString(params?.verdict)) throw new Error("verdict is required");
  if (!isNonEmptyString(params?.assessment)) throw new Error("assessment is required");

  if (!params.sliceChanges || typeof params.sliceChanges !== "object") {
    throw new Error("sliceChanges must be an object");
  }

  if (!Array.isArray(params.sliceChanges.modified)) {
    throw new Error("sliceChanges.modified must be an array");
  }

  if (!Array.isArray(params.sliceChanges.added)) {
    throw new Error("sliceChanges.added must be an array");
  }

  if (!Array.isArray(params.sliceChanges.removed)) {
    throw new Error("sliceChanges.removed must be an array");
  }

  const SLICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

  const metadataCorrections = params.metadataCorrections;
  if (metadataCorrections !== undefined) {
    if (!metadataCorrections || typeof metadataCorrections !== "object" || Array.isArray(metadataCorrections)) {
      throw new Error("metadataCorrections must be an object when provided");
    }
    const metadataKeys = Object.keys(metadataCorrections);
    const unknownMetadataKey = metadataKeys.find((key) => key !== "milestone" && key !== "completedSlices");
    if (unknownMetadataKey) throw new Error(`metadataCorrections.${unknownMetadataKey} is not an allowed correction field`);

    if (metadataCorrections.milestone !== undefined) {
      const milestone = metadataCorrections.milestone;
      if (!milestone || typeof milestone !== "object" || Array.isArray(milestone)) {
        throw new Error("metadataCorrections.milestone must be an object");
      }
      const allowedMilestoneFields = new Set([
        "successCriteria",
        "verificationContract",
        "verificationIntegration",
        "verificationOperational",
        "verificationUat",
        "definitionOfDone",
        "requirementCoverage",
        "boundaryMapMarkdown",
      ]);
      const unknownField = Object.keys(milestone).find((key) => !allowedMilestoneFields.has(key));
      if (unknownField) throw new Error(`metadataCorrections.milestone.${unknownField} is not an allowed correction field`);
      if (Object.keys(milestone).length === 0) throw new Error("metadataCorrections.milestone must include at least one correction");
      for (const field of ["successCriteria", "definitionOfDone"] as const) {
        if (milestone[field] !== undefined) validateStringArray(milestone[field], `metadataCorrections.milestone.${field}`);
      }
      for (const field of [
        "verificationContract",
        "verificationIntegration",
        "verificationOperational",
        "verificationUat",
        "requirementCoverage",
        "boundaryMapMarkdown",
      ] as const) {
        if (milestone[field] !== undefined && typeof milestone[field] !== "string") {
          throw new Error(`metadataCorrections.milestone.${field} must be a string`);
        }
      }
    }

    if (metadataCorrections.completedSlices !== undefined) {
      if (!Array.isArray(metadataCorrections.completedSlices)) {
        throw new Error("metadataCorrections.completedSlices must be an array");
      }
      const seenCorrectionIds = new Set<string>();
      const allowedSliceFields = new Set([
        "sliceId",
        "demo",
        "goal",
        "successCriteria",
        "proofLevel",
        "integrationClosure",
        "observabilityImpact",
      ]);
      for (let i = 0; i < metadataCorrections.completedSlices.length; i++) {
        const correction = metadataCorrections.completedSlices[i];
        if (!correction || typeof correction !== "object" || Array.isArray(correction)) {
          throw new Error(`metadataCorrections.completedSlices[${i}] must be an object`);
        }
        const unknownField = Object.keys(correction).find((key) => !allowedSliceFields.has(key));
        if (unknownField) throw new Error(`metadataCorrections.completedSlices[${i}].${unknownField} is not an allowed correction field`);
        if (!isNonEmptyString(correction.sliceId) || !SLICE_ID_RE.test(correction.sliceId)) {
          throw new Error(`metadataCorrections.completedSlices[${i}].sliceId must be a valid slice ID`);
        }
        if (seenCorrectionIds.has(correction.sliceId)) {
          throw new Error(`metadataCorrections.completedSlices contains duplicate sliceId ${correction.sliceId}`);
        }
        seenCorrectionIds.add(correction.sliceId);
        if (Object.keys(correction).length === 1) {
          throw new Error(`metadataCorrections.completedSlices[${i}] must include at least one correction`);
        }
        for (const field of ["demo", "goal", "successCriteria", "proofLevel", "integrationClosure", "observabilityImpact"] as const) {
          if (correction[field] !== undefined && typeof correction[field] !== "string") {
            throw new Error(`metadataCorrections.completedSlices[${i}].${field} must be a string`);
          }
        }
      }
    }
  }

  // Validate each modified slice
  for (let i = 0; i < params.sliceChanges.modified.length; i++) {
    const s = params.sliceChanges.modified[i];
    if (!s || typeof s !== "object") throw new Error(`sliceChanges.modified[${i}] must be an object`);
    if (!isNonEmptyString(s.sliceId)) throw new Error(`sliceChanges.modified[${i}].sliceId is required`);
    if (!isNonEmptyString(s.title)) throw new Error(`sliceChanges.modified[${i}].title is required`);
    if (s.depends !== undefined) {
      if (!Array.isArray(s.depends) || s.depends.some((item: unknown) => !isNonEmptyString(item) || !SLICE_ID_RE.test(item as string))) {
        throw new Error(`sliceChanges.modified[${i}].depends must be an array of valid slice IDs (e.g. "S01")`);
      }
    }
  }

  // Validate each added slice
  for (let i = 0; i < params.sliceChanges.added.length; i++) {
    const s = params.sliceChanges.added[i];
    if (!s || typeof s !== "object") throw new Error(`sliceChanges.added[${i}] must be an object`);
    if (!isNonEmptyString(s.sliceId)) throw new Error(`sliceChanges.added[${i}].sliceId is required`);
    if (!isNonEmptyString(s.title)) throw new Error(`sliceChanges.added[${i}].title is required`);
    if (s.depends !== undefined) {
      if (!Array.isArray(s.depends) || s.depends.some((item: unknown) => !isNonEmptyString(item) || !SLICE_ID_RE.test(item as string))) {
        throw new Error(`sliceChanges.added[${i}].depends must be an array of valid slice IDs (e.g. "S01")`);
      }
    }
  }

  return params;
}

export async function handleReassessRoadmap(
  rawParams: ReassessRoadmapParams,
  basePath: string,
  invocation: PlanningInvocation,
): Promise<ReassessRoadmapResult | { error: string }> {
  // ── Validate ──────────────────────────────────────────────────────
  let params: ReassessRoadmapParams;
  try {
    params = validateParams(rawParams);
  } catch (err) {
    return { error: `validation failed: ${(err as Error).message}` };
  }
  const hasStructuralChanges =
    params.sliceChanges.added.length > 0 ||
    params.sliceChanges.modified.length > 0 ||
    params.sliceChanges.removed.length > 0;
  const hasMetadataCorrections = Boolean(
    params.metadataCorrections?.milestone || params.metadataCorrections?.completedSlices?.length,
  );
  const isMetadataOnlyCorrection = hasMetadataCorrections && !hasStructuralChanges;
  const invalidatesMilestoneValidation = hasStructuralChanges || Boolean(params.metadataCorrections?.milestone);

  const assessmentPath = resolveRoadmapAssessmentProjectionPath(
    basePath,
    params.milestoneId,
  );
  let operationStatus: "committed" | "replayed";
  try {
    const receipt = executePlanningDomainOperation({
      operationType: "workflow.roadmap.reassess",
      invocation,
      actorId: params.actorName,
      payload: planningOperationPayload(params),
      event: {
        eventType: "workflow.roadmap.reassessed",
        entityType: "milestone",
        entityId: params.milestoneId,
        payload: {
          milestoneId: params.milestoneId,
          completedSliceId: params.completedSliceId,
        },
        destinations: ["projection"],
      },
      projection: {
        projectionKey: `planning/${params.milestoneId}`.toLowerCase(),
        projectionKind: "markdown",
        rendererVersion: "v1",
      },
      lifecycleItems: () => {
        const sliceIds = new Set([
          params.completedSliceId,
          ...params.sliceChanges.modified.map((slice) => slice.sliceId),
          ...params.sliceChanges.added.map((slice) => slice.sliceId),
          ...params.sliceChanges.removed,
          ...(params.metadataCorrections?.completedSlices ?? []).map((slice) => slice.sliceId),
        ]);
        return [
          { itemKind: "milestone", milestoneId: params.milestoneId },
          ...Array.from(sliceIds).flatMap((sliceId) => [
            { itemKind: "slice" as const, milestoneId: params.milestoneId, sliceId },
            ...getSliceTasks(params.milestoneId, sliceId).map((task) => ({
              itemKind: "task" as const,
              milestoneId: params.milestoneId,
              sliceId,
              taskId: task.id,
            })),
          ]),
        ];
      },
      mutate(context) {
        const milestone = getMilestone(params.milestoneId);
        if (!milestone) {
          throw new PlanningGuardError(`milestone not found: ${params.milestoneId}`);
        }
        if (isClosedStatus(milestone.status) && !isMetadataOnlyCorrection) {
          throw new PlanningGuardError(`cannot reassess a closed milestone: ${params.milestoneId} (status: ${milestone.status})`);
        }
        const milestoneLifecycle = adoptLifecycleIfMissing(context, {
          itemKind: "milestone",
          milestoneId: params.milestoneId,
          lifecycleStatus: normalizeLegacyLifecycleStatus(milestone.status) ?? "ready",
        });
        if (milestoneLifecycle.lifecycleStatus === "cancelled") {
          throw new PlanningGuardError(`cannot reassess a closed milestone: ${params.milestoneId} (canonical status: ${milestoneLifecycle.lifecycleStatus})`);
        }
        if (milestoneLifecycle.lifecycleStatus === "completed" && !isMetadataOnlyCorrection) {
          throw new PlanningGuardError(`cannot reassess a closed milestone: ${params.milestoneId} (canonical status: ${milestoneLifecycle.lifecycleStatus})`);
        }

        const completedSlice = getSlice(params.milestoneId, params.completedSliceId);
        if (!completedSlice) {
          throw new PlanningGuardError(`completedSliceId not found: ${params.milestoneId}/${params.completedSliceId}`);
        }
        if (!isClosedStatus(completedSlice.status)) {
          throw new PlanningGuardError(`completedSliceId ${params.completedSliceId} is not complete (status: ${completedSlice.status}) — reassess can only be called after a slice finishes`);
        }
        const completedSliceLifecycle = adoptLifecycleIfMissing(context, {
          itemKind: "slice",
          milestoneId: params.milestoneId,
          sliceId: params.completedSliceId,
          lifecycleStatus: normalizeLegacyLifecycleStatus(completedSlice.status) ?? "completed",
        });
        if (completedSliceLifecycle.lifecycleStatus === "cancelled") {
          throw new PlanningGuardError(`completedSliceId ${params.completedSliceId} is canonically cancelled and is not a valid completed slice`);
        }

        const existingSlices = getMilestoneSlices(params.milestoneId);
        const existingSliceById = new Map(existingSlices.map((slice) => [slice.id, slice]));
        const completedSliceIds = new Set<string>();
        for (const slice of existingSlices) {
          if (slice.status !== "skipped" && isClosedStatus(slice.status)) completedSliceIds.add(slice.id);
        }

        for (const correction of params.metadataCorrections?.completedSlices ?? []) {
          const existing = existingSliceById.get(correction.sliceId);
          if (!existing) {
            throw new PlanningGuardError(`metadata correction references missing slice ${correction.sliceId}`);
          }
          if (!completedSliceIds.has(correction.sliceId)) {
            throw new PlanningGuardError(`metadata correction target ${correction.sliceId} is not complete`);
          }
          const lifecycle = adoptLifecycleIfMissing(context, {
            itemKind: "slice",
            milestoneId: params.milestoneId,
            sliceId: correction.sliceId,
            lifecycleStatus: normalizeLegacyLifecycleStatus(existing.status) ?? "completed",
          });
          if (lifecycle.lifecycleStatus !== "completed") {
            throw new PlanningGuardError(`metadata correction target ${correction.sliceId} is canonically ${lifecycle.lifecycleStatus}, not completed`);
          }
          for (const task of getSliceTasks(params.milestoneId, correction.sliceId)) {
            const taskLifecycleStatus = normalizeLegacyLifecycleStatus(task.status);
            if (taskLifecycleStatus !== "completed" && taskLifecycleStatus !== "cancelled") continue;
            adoptLifecycleIfMissing(context, {
              itemKind: "task",
              milestoneId: params.milestoneId,
              sliceId: correction.sliceId,
              taskId: task.id,
              lifecycleStatus: taskLifecycleStatus,
            });
          }
        }

        for (const modifiedSlice of params.sliceChanges.modified) {
          const existing = existingSliceById.get(modifiedSlice.sliceId);
          if (!existing) {
            throw new PlanningGuardError(`cannot modify missing slice ${modifiedSlice.sliceId}`);
          }
          if (completedSliceIds.has(modifiedSlice.sliceId)) {
            throw new PlanningGuardError(`cannot modify completed slice ${modifiedSlice.sliceId}`);
          }
          const lifecycle = adoptLifecycleIfMissing(context, {
            itemKind: "slice",
            milestoneId: params.milestoneId,
            sliceId: modifiedSlice.sliceId,
            lifecycleStatus: normalizeLegacyLifecycleStatus(existing.status) ?? "ready",
          });
          if (lifecycle.lifecycleStatus === "completed" || lifecycle.lifecycleStatus === "cancelled") {
            throw new PlanningGuardError(
              `cannot modify ${lifecycle.lifecycleStatus} slice ${modifiedSlice.sliceId} — use gsd_slice_reopen first`,
            );
          }
        }
        for (const removedId of params.sliceChanges.removed) {
          if (completedSliceIds.has(removedId)) {
            throw new PlanningGuardError(`cannot remove completed slice ${removedId}`);
          }
          const existing = existingSliceById.get(removedId);
          if (!existing) {
            throw new PlanningGuardError(`cannot remove missing slice ${removedId}`);
          }
          const legacyLifecycleStatus = normalizeLegacyLifecycleStatus(existing.status);
          const observedLifecycleStatus = legacyLifecycleStatus ?? "ready";
          const lifecycle = adoptLifecycleIfMissing(context, {
            itemKind: "slice",
            milestoneId: params.milestoneId,
            sliceId: removedId,
            lifecycleStatus: observedLifecycleStatus === "completed" ? "completed" : "cancelled",
            adoptedFromStatus: observedLifecycleStatus,
          });
          if (lifecycle.lifecycleStatus === "completed") {
            throw new PlanningGuardError(`cannot remove completed slice ${removedId}`);
          }
          for (const task of getSliceTasks(params.milestoneId, removedId)) {
            const legacyTaskLifecycleStatus = normalizeLegacyLifecycleStatus(task.status);
            const observedTaskLifecycleStatus = legacyTaskLifecycleStatus ?? "ready";
            const taskLifecycle = adoptLifecycleIfMissing(context, {
              itemKind: "task",
              milestoneId: params.milestoneId,
              sliceId: removedId,
              taskId: task.id,
              lifecycleStatus: observedTaskLifecycleStatus === "completed" ? "completed" : "cancelled",
              adoptedFromStatus: observedTaskLifecycleStatus,
            });
            if (
              legacyTaskLifecycleStatus === "completed" ||
              taskLifecycle.lifecycleStatus === "completed"
            ) {
              throw new PlanningGuardError(
                `cannot remove slice ${removedId}: completed descendant task ${task.id}`,
              );
            }
          }
        }

        const removedIds = new Set<string>(params.sliceChanges.removed);
        const effectiveSliceIds = new Set<string>(
          existingSlices.map((slice) => slice.id).filter((id) => !removedIds.has(id)),
        );
        for (const added of params.sliceChanges.added) effectiveSliceIds.add(added.sliceId);
        const effectiveDependencies = new Map(
          existingSlices
            .filter((slice) => !removedIds.has(slice.id))
            .map((slice) => [slice.id, slice.depends] as const),
        );
        for (const modified of params.sliceChanges.modified) {
          if (modified.depends !== undefined) effectiveDependencies.set(modified.sliceId, modified.depends);
        }
        for (const added of params.sliceChanges.added) {
          effectiveDependencies.set(added.sliceId, added.depends ?? []);
        }
        for (const [sliceId, dependencies] of effectiveDependencies) {
          for (const dependency of dependencies) {
            if (!effectiveSliceIds.has(dependency)) {
              throw new PlanningGuardError(`effective slice ${sliceId} depends references unknown slice "${dependency}" — update or remove the dangling dependency`);
            }
          }
        }

        for (const added of params.sliceChanges.added) {
          const existing = existingSliceById.get(added.sliceId);
          if (!existing) continue;
          const lifecycle = adoptLifecycleIfMissing(context, {
            itemKind: "slice",
            milestoneId: params.milestoneId,
            sliceId: added.sliceId,
            lifecycleStatus: normalizeLegacyLifecycleStatus(existing.status) ?? "ready",
          });
          if (existing.status === "skipped" || lifecycle.lifecycleStatus === "cancelled") {
            throw new PlanningGuardError(`cannot reuse cancelled slice ${added.sliceId} — use gsd_slice_reopen first`);
          }
          throw new PlanningGuardError(`cannot add existing slice ${added.sliceId}`);
        }

        if (params.metadataCorrections?.milestone) {
          upsertMilestonePlanning(params.milestoneId, params.metadataCorrections.milestone);
        }
        for (const correction of params.metadataCorrections?.completedSlices ?? []) {
          updateSliceFields(params.milestoneId, correction.sliceId, { demo: correction.demo });
          upsertSlicePlanning(params.milestoneId, correction.sliceId, {
            goal: correction.goal,
            successCriteria: correction.successCriteria,
            proofLevel: correction.proofLevel,
            integrationClosure: correction.integrationClosure,
            observabilityImpact: correction.observabilityImpact,
          });
        }

        for (const modified of params.sliceChanges.modified) {
          updateSliceFields(params.milestoneId, modified.sliceId, {
            title: modified.title,
            risk: modified.risk,
            depends: modified.depends,
            demo: modified.demo,
          });
        }

        const existingCount = getMilestoneSlices(params.milestoneId).length;
        for (let i = 0; i < params.sliceChanges.added.length; i++) {
          const added = params.sliceChanges.added[i]!;
          insertSlice({
            id: added.sliceId,
            milestoneId: params.milestoneId,
            title: added.title,
            status: "pending",
            risk: added.risk,
            depends: added.depends,
            demo: added.demo ?? "",
            sequence: existingCount + i + 1,
          });
          const lifecycleStatus = (added.depends ?? []).every((dependency) => completedSliceIds.has(dependency))
            ? "ready"
            : "pending";
          adoptLifecycleIfMissing(context, {
            itemKind: "slice",
            milestoneId: params.milestoneId,
            sliceId: added.sliceId,
            lifecycleStatus,
          });
        }

        for (const removedId of params.sliceChanges.removed) {
          for (const task of getSliceTasks(params.milestoneId, removedId)) {
            const legacyLifecycleStatus = normalizeLegacyLifecycleStatus(task.status);
            const lifecycle = adoptLifecycleIfMissing(context, {
              itemKind: "task",
              milestoneId: params.milestoneId,
              sliceId: removedId,
              taskId: task.id,
              lifecycleStatus: legacyLifecycleStatus ?? "ready",
            });
            if (lifecycle.lifecycleStatus === "completed") continue;
            if (lifecycle.lifecycleStatus !== "cancelled") {
              adoptOrTransitionLifecycle(context, {
                itemKind: "task",
                milestoneId: params.milestoneId,
                sliceId: removedId,
                taskId: task.id,
                lifecycleStatus: "cancelled",
              });
            }
            projectCanonicalStatusToLegacy(context, {
              entity: "task",
              milestoneId: params.milestoneId,
              sliceId: removedId,
              taskId: task.id,
              status: "skipped",
            });
          }
          const lifecycle = adoptLifecycleIfMissing(context, {
            itemKind: "slice",
            milestoneId: params.milestoneId,
            sliceId: removedId,
            lifecycleStatus: normalizeLegacyLifecycleStatus(existingSliceById.get(removedId)?.status ?? null) ?? "ready",
          });
          if (lifecycle.lifecycleStatus !== "cancelled") {
            adoptOrTransitionLifecycle(context, {
              itemKind: "slice",
              milestoneId: params.milestoneId,
              sliceId: removedId,
              lifecycleStatus: "cancelled",
            });
          }
          projectCanonicalStatusToLegacy(context, {
            entity: "slice",
            milestoneId: params.milestoneId,
            sliceId: removedId,
            status: "skipped",
          });
        }

        if (invalidatesMilestoneValidation) {
          deleteAssessmentByScope(params.milestoneId, "milestone-validation");
        }

        insertAssessment({
          path: assessmentDbPathForRenderedFile(basePath, assessmentPath),
          milestoneId: params.milestoneId,
          sliceId: params.completedSliceId,
          status: params.verdict,
          scope: "roadmap",
          fullContent: params.assessment,
        });
      },
    });
    operationStatus = receipt.status;
  } catch (err) {
    if (err instanceof PlanningGuardError) return { error: err.message };
    return { error: `db write failed: ${(err as Error).message}` };
  }

  removeSlicePlanProjections(basePath, params.milestoneId, params.sliceChanges.removed);

  // ── Render artifacts ──────────────────────────────────────────────
  try {
    const roadmapResult = await renderRoadmapFromDb(basePath, params.milestoneId);
    if ("skipped" in roadmapResult) {
      return { error: `roadmap render skipped: milestone ${params.milestoneId} has no planned slices` };
    }
    const durableAssessment = getAssessment(
      assessmentDbPathForRenderedFile(basePath, assessmentPath),
    );
    if (!durableAssessment) throw new Error("durable roadmap assessment not found");
    const assessmentResult = await renderRoadmapAssessmentFromDb(basePath, params.milestoneId, {
      verdict: String(durableAssessment["status"]),
      assessment: String(durableAssessment["full_content"]),
      completedSliceId: params.completedSliceId,
      createdAt: String(durableAssessment["created_at"]),
    });

    // ── Remove stale VALIDATION file from disk (#2957) ────────────
    if (invalidatesMilestoneValidation) {
      const milestoneDir = resolveMilestonePath(basePath, params.milestoneId);
      const validationFiles = new Set([
        resolveMilestoneFile(basePath, params.milestoneId, "VALIDATION"),
        targetMilestoneFile(
          basePath,
          params.milestoneId,
          "VALIDATION",
          getMilestone(params.milestoneId)?.title,
        ),
        milestoneDir ? join(milestoneDir, `${params.milestoneId}-VALIDATION.md`) : null,
      ].filter((file): file is string => Boolean(file)));
      for (const validationFile of validationFiles) {
        try {
          if (existsSync(validationFile)) removeProjectionFileSync(validationFile);
        } catch (e) {
          logWarning("tool", `validation file cleanup failed: ${(e as Error).message}`);
        }
      }
    }

    // ── Invalidate caches ─────────────────────────────────────────
    invalidateStateCache();
    clearParseCache();

    // ── Post-mutation hook: projections, manifest, event log ─────
    try {
      await flushWorkflowProjections(basePath, { milestoneId: params.milestoneId });
      await writeManifestAndFlush(basePath);
      if (operationStatus === "committed") {
        appendEvent(basePath, {
          cmd: "reassess-roadmap",
          params: { milestoneId: params.milestoneId, completedSliceId: params.completedSliceId },
          ts: new Date().toISOString(),
          actor: "agent",
          actor_name: params.actorName,
          trigger_reason: params.triggerReason,
        });
      }
    } catch (hookErr) {
      logWarning("tool", `reassess-roadmap post-mutation hook warning: ${(hookErr as Error).message}`);
    }

    return {
      milestoneId: params.milestoneId,
      completedSliceId: params.completedSliceId,
      assessmentPath: assessmentResult.assessmentPath,
      roadmapPath: roadmapResult.roadmapPath,
    };
  } catch (err) {
    return { error: `render failed: ${(err as Error).message}` };
  }
}
