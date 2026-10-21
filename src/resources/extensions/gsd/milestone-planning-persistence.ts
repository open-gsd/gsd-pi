// Project/App: gsd-pi
// File Purpose: Persist planned milestone roadmaps and their DB-backed projections.

import type { CanonicalLifecycleStatus } from "./db/writers/lifecycle-commands.js";
import { clearParseCache } from "./files.js";
import {
  adoptLifecycleIfMissing,
  getMilestone,
  getMilestoneSlices,
  getSlice,
  insertMilestone,
  insertSlice,
  normalizeCanonicalLifecycleStatus,
  normalizeLegacyLifecycleStatus,
  upsertMilestonePlanning,
  upsertSlicePlanning,
} from "./gsd-db.js";
import type { PlanningInvocation } from "./planning-invocation.js";
import {
  executePlanningDomainOperation,
  PlanningGuardError,
  planningOperationPayload,
} from "./planning-domain-operation.js";
import { invalidateStateCache } from "./state.js";
import { renderRoadmapFromDb } from "./markdown-renderer.js";
import { flushWorkflowProjections } from "./projection-flush.js";
import { writeManifestAndFlush } from "./workflow-manifest.js";
import { appendEvent } from "./workflow-events.js";
import { logWarning } from "./workflow-logger.js";
import { isClosedStatus } from "./status-guards.js";

export interface PersistMilestonePlanSlice {
  sliceId: string;
  title: string;
  risk: string;
  depends: string[];
  demo: string;
  goal: string;
  successCriteria: string;
  proofLevel: string;
  integrationClosure: string;
  observabilityImpact: string;
  isSketch?: boolean;
  sketchScope?: string;
}

export interface PersistMilestonePlanParams {
  milestoneId: string;
  title: string;
  vision: string;
  slices: PersistMilestonePlanSlice[];
  status?: string;
  dependsOn?: string[];
  actorName?: string;
  triggerReason?: string;
  successCriteria?: string[];
  keyRisks?: Array<{ risk: string; whyItMatters: string }>;
  proofStrategy?: Array<{ riskOrUnknown: string; retireIn: string; whatWillBeProven: string }>;
  verificationContract?: string;
  verificationIntegration?: string;
  verificationOperational?: string;
  verificationUat?: string;
  definitionOfDone?: string[];
  requirementCoverage?: string;
  boundaryMapMarkdown?: string;
}

export interface PersistMilestonePlanResult {
  milestoneId: string;
  roadmapPath: string;
}

function validatePlanPromotion(
  context: Parameters<typeof adoptLifecycleIfMissing>[0],
  params: PersistMilestonePlanParams,
): string | null {
  const requestedLifecycleStatus = params.status
    ? normalizeLegacyLifecycleStatus(params.status) ?? normalizeCanonicalLifecycleStatus(params.status)
    : null;
  if (requestedLifecycleStatus === "completed" || requestedLifecycleStatus === "cancelled") {
    return `cannot plan milestone ${params.milestoneId} with terminal status ${params.status}`;
  }

  const existingMilestone = getMilestone(params.milestoneId);
  if (existingMilestone && isClosedStatus(existingMilestone.status)) {
    return `cannot re-plan milestone ${params.milestoneId}: it is already complete`;
  }
  if (existingMilestone) {
    const legacyLifecycleStatus = normalizeLegacyLifecycleStatus(existingMilestone.status);
    const lifecycleStatus = legacyLifecycleStatus === "completed" || legacyLifecycleStatus === "cancelled"
      ? legacyLifecycleStatus
      : "ready";
    const lifecycle = adoptLifecycleIfMissing(context, {
      itemKind: "milestone",
      milestoneId: params.milestoneId,
      lifecycleStatus,
    });
    if (lifecycle.lifecycleStatus === "completed" || lifecycle.lifecycleStatus === "cancelled") {
      return `cannot re-plan ${lifecycle.lifecycleStatus} milestone ${params.milestoneId} — use gsd_milestone_reopen first`;
    }
  }

  // Guard: refuse to re-plan a milestone that would drop completed slices (#2960).
  // Allow re-planning when all completed slices are still present in the
  // incoming plan — their status is preserved below (#2558). Block only when
  // the new plan omits a completed slice, which could shadow completed work.
  const existingSlices = getMilestoneSlices(params.milestoneId);
  const incomingSliceById = new Map(params.slices.map((slice) => [slice.sliceId, slice]));
  const existingSliceLifecycleById = new Map<string, CanonicalLifecycleStatus>();
  for (const slice of existingSlices) {
    const legacyLifecycleStatus = normalizeLegacyLifecycleStatus(slice.status);
    const plannedLifecycleStatus = incomingSliceById.get(slice.id)?.isSketch === true
      ? "pending"
      : "ready";
    const lifecycle = adoptLifecycleIfMissing(context, {
      itemKind: "slice",
      milestoneId: params.milestoneId,
      sliceId: slice.id,
      lifecycleStatus: legacyLifecycleStatus === "completed" || legacyLifecycleStatus === "cancelled"
        ? legacyLifecycleStatus
        : plannedLifecycleStatus,
    });
    existingSliceLifecycleById.set(slice.id, lifecycle.lifecycleStatus);
    if (incomingSliceById.has(slice.id) && (lifecycle.lifecycleStatus === "completed" || lifecycle.lifecycleStatus === "cancelled")) {
      return `cannot re-plan ${lifecycle.lifecycleStatus} slice ${slice.id} — use gsd_slice_reopen first`;
    }
  }
  const completedSlices = existingSlices.filter((slice) => existingSliceLifecycleById.get(slice.id) === "completed");
  const droppedCompleted = completedSlices.filter((slice) => !incomingSliceById.has(slice.id));
  if (droppedCompleted.length > 0) {
    return `cannot re-plan milestone ${params.milestoneId}: ${droppedCompleted.length} completed slice(s) would be dropped (${droppedCompleted.map(s => s.id).join(", ")}). Use gsd_reassess_roadmap to modify the roadmap.`;
  }
  const droppedPending = existingSlices.find((slice) => (
    !incomingSliceById.has(slice.id) && existingSliceLifecycleById.get(slice.id) !== "cancelled"
  ));
  if (droppedPending) {
    return `cannot re-plan milestone ${params.milestoneId}: pending slice ${droppedPending.id} would be dropped. Use gsd_reassess_roadmap to remove it.`;
  }

  // Validate depends_on: all dependencies must exist and be complete
  if (params.dependsOn && params.dependsOn.length > 0) {
    for (const depId of params.dependsOn) {
      const dep = getMilestone(depId);
      if (!dep) {
        return `depends_on references unknown milestone: ${depId}`;
      }
      if (!isClosedStatus(dep.status)) {
        return `depends_on milestone ${depId} is not yet complete (status: ${dep.status})`;
      }
    }
  }

  return null;
}

function writePlanRows(params: PersistMilestonePlanParams): void {
  insertMilestone({
    id: params.milestoneId,
    title: params.title,
    status: params.status ?? "active",
    depends_on: params.dependsOn ?? [],
  });

  upsertMilestonePlanning(params.milestoneId, {
    title: params.title,
    status: params.status ?? "active",
    depends_on: params.dependsOn ?? [],
    vision: params.vision,
    successCriteria: params.successCriteria,
    keyRisks: params.keyRisks,
    proofStrategy: params.proofStrategy,
    verificationContract: params.verificationContract,
    verificationIntegration: params.verificationIntegration,
    verificationOperational: params.verificationOperational,
    verificationUat: params.verificationUat,
    definitionOfDone: params.definitionOfDone,
    requirementCoverage: params.requirementCoverage,
    boundaryMapMarkdown: params.boundaryMapMarkdown,
  });

  for (let i = 0; i < params.slices.length; i++) {
    const slice = params.slices[i]!;
    // Replanning changes the plan, not the Slice lifecycle projection.
    const existing = getSlice(params.milestoneId, slice.sliceId);
    const status = existing?.status ?? "pending";
    insertSlice({
      id: slice.sliceId,
      milestoneId: params.milestoneId,
      title: slice.title,
      status,
      risk: slice.risk,
      depends: slice.depends,
      demo: slice.demo,
      sequence: i + 1, // Preserve agent-ordered sequence (#3356)
      // ADR-011: pass undefined through so ON CONFLICT preserves existing values
      // when the caller omitted the fields on a re-plan.
      isSketch: slice.isSketch,
      sketchScope: slice.sketchScope,
    });
    upsertSlicePlanning(params.milestoneId, slice.sliceId, {
      goal: slice.goal,
      successCriteria: slice.successCriteria,
      proofLevel: slice.proofLevel,
      integrationClosure: slice.integrationClosure,
      observabilityImpact: slice.observabilityImpact,
    });
  }
}

function adoptPlanLifecycles(
  context: Parameters<typeof adoptLifecycleIfMissing>[0],
  params: PersistMilestonePlanParams,
): void {
  adoptLifecycleIfMissing(context, {
    itemKind: "milestone",
    milestoneId: params.milestoneId,
    lifecycleStatus: "ready",
  });
  for (const slice of params.slices) {
    adoptLifecycleIfMissing(context, {
      itemKind: "slice",
      milestoneId: params.milestoneId,
      sliceId: slice.sliceId,
      lifecycleStatus: slice.isSketch === true ? "pending" : "ready",
    });
  }
}

function persistPlanOperation(
  params: PersistMilestonePlanParams,
  invocation: PlanningInvocation,
): ReturnType<typeof executePlanningDomainOperation> {
  return executePlanningDomainOperation({
    operationType: "workflow.milestone.plan",
    invocation,
    actorId: params.actorName,
    payload: planningOperationPayload(params),
    event: {
      eventType: "workflow.milestone.planned",
      entityType: "milestone",
      entityId: params.milestoneId,
      payload: {
        milestoneId: params.milestoneId,
        sliceIds: params.slices.map((slice) => slice.sliceId),
      },
      destinations: ["projection"],
    },
    projection: {
      projectionKey: `planning/${params.milestoneId.toLowerCase()}`,
      projectionKind: "markdown",
      rendererVersion: "v1",
    },
    lifecycleItems: () => [
      { itemKind: "milestone", milestoneId: params.milestoneId },
      ...params.slices.map((slice) => ({
        itemKind: "slice" as const,
        milestoneId: params.milestoneId,
        sliceId: slice.sliceId,
      })),
    ],
    mutate(context) {
      const guardError = validatePlanPromotion(context, params);
      if (guardError) throw new PlanningGuardError(guardError);
      writePlanRows(params);
      adoptPlanLifecycles(context, params);
    },
  });
}

async function renderPlanArtifacts(
  basePath: string,
  params: PersistMilestonePlanParams,
): Promise<string | { error: string }> {
  try {
    const renderResult = await renderRoadmapFromDb(basePath, params.milestoneId);
    // renderRoadmapFromDb only skips for unplanned milestones (zero slices +
    // empty vision); persistMilestonePlan always populates both via writePlanRows
    // before this render, so the skipped branch is unreachable here. Fall back to
    // resolving the projected path so a future invariant still surfaces a clear
    // render failure rather than an undefined dereference.
    if ("skipped" in renderResult) {
      return { error: `render skipped: milestone ${params.milestoneId} has no planned slices` };
    }
    return renderResult.roadmapPath;
  } catch (renderErr) {
    // #1634: DB rows stay committed on purpose — the DB is the authority and
    // ROADMAP.md is only a projection. The roadmap-missing drift handler
    // detects the absent file and re-renders it on the next reconciliation
    // pass, so a failed render is transient drift, never a permanently
    // orphaned milestone.
    logWarning("tool", `plan_milestone — render failed (DB plan kept; roadmap-missing drift repair re-renders ROADMAP.md on the next reconciliation pass): ${(renderErr as Error).message}`);
    invalidateStateCache();
    return { error: `render failed: ${(renderErr as Error).message}. The milestone plan is saved in the DB; ROADMAP.md will be re-rendered by drift reconciliation on the next dispatch (or run /gsd sync).` };
  }
}

async function runPostPlanHooks(
  basePath: string,
  params: PersistMilestonePlanParams,
  operationStatus: "committed" | "replayed",
): Promise<void> {
  try {
    await flushWorkflowProjections(basePath, { milestoneId: params.milestoneId });
    await writeManifestAndFlush(basePath);
    if (operationStatus === "committed") {
      appendEvent(basePath, {
        cmd: "plan-milestone",
        params: { milestoneId: params.milestoneId },
        ts: new Date().toISOString(),
        actor: "agent",
        actor_name: params.actorName,
        trigger_reason: params.triggerReason,
      });
    }
  } catch (hookErr) {
    logWarning("tool", `plan-milestone post-mutation hook warning: ${(hookErr as Error).message}`);
  }
}

export async function persistMilestonePlan(
  params: PersistMilestonePlanParams,
  basePath: string,
  invocation: PlanningInvocation,
): Promise<PersistMilestonePlanResult | { error: string }> {
  let operationStatus: "committed" | "replayed";
  try {
    operationStatus = persistPlanOperation(params, invocation).status;
  } catch (err) {
    if (err instanceof PlanningGuardError) return { error: err.message };
    return { error: `db write failed: ${(err as Error).message}` };
  }

  const roadmapPath = await renderPlanArtifacts(basePath, params);
  if (typeof roadmapPath !== "string") return roadmapPath;

  invalidateStateCache();
  clearParseCache();

  await runPostPlanHooks(basePath, params, operationStatus);

  return {
    milestoneId: params.milestoneId,
    roadmapPath,
  };
}
