// GSD — reopen-milestone tool handler

/**
 * Core operation behind gsd_milestone_reopen.
 *
 * Reopens a terminal Milestone hierarchy atomically while preserving immutable
 * history, then removes readable closeout projections under the operation
 * fence. Milestones without a canonical lifecycle row are refused: adopt the
 * project with /gsd db adopt, then reopen.
 */

import {
  getMilestone,
  getMilestoneSlices,
  getSliceRunUatAssessment,
  getSliceTasks,
} from "../gsd-db.js";
import {
  isCurrentMilestoneReopenOperation,
  reopenMilestone,
  type MilestoneReopenReceipt,
} from "../milestone-lifecycle-domain-operation.js";
import { isMilestoneLifecycleAdopted } from "../db/milestone-closeout-readiness.js";
import type { ExecutionInvocation } from "../execution-invocation.js";
import { invalidateStateCache } from "../state.js";
import { releaseExhaustedUnits } from "../db/unit-dispatch-budgets.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifestAndFlush } from "../workflow-manifest.js";
import { logWarning } from "../workflow-logger.js";
import { debugLog } from "../debug-logger.js";
import { join } from "node:path";
import {
  buildFlatTaskFileName,
  buildSliceFileName,
  buildTaskFileName,
  legacyMilestonesDir,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveSliceFile,
  resolveSlicePath,
  resolveTaskFile,
  resolveTasksDir,
  clearPathCache,
  targetMilestoneFile,
  targetSliceFile,
  targetTaskFile,
} from "../paths.js";
import { removeProjectionIfCurrent } from "../projection-cleanup.js";
import { repairMilestoneShadowsForReopen } from "../lifecycle-shadow-repair-domain-operation.js";
import { readDomainOperationFence } from "../db/writers/lifecycle-commands.js";

export interface ReopenMilestoneParams {
  milestoneId: string;
  reason?: string;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
  /** Unlock the milestone without resetting completed slices/tasks or deleting their SUMMARYs. */
  keepCompleted?: boolean;
}

export interface ReopenMilestoneResult {
  milestoneId: string;
  slicesReset: number;
  tasksReset: number;
  operationId?: string;
  resultingRevision?: number;
  duplicate?: boolean;
  current?: boolean;
  superseded?: boolean;
  stale?: boolean;
}

type CleanupDelivery = { artifactPath: string; operationId: string };
let cleanupInterleaveForTest: ((delivery: CleanupDelivery) => void) | null = null;

export function _setReopenMilestoneCleanupInterleaveForTest(
  hook: ((delivery: CleanupDelivery) => void) | null,
): void {
  cleanupInterleaveForTest = hook;
}

export async function handleReopenMilestone(
  params: ReopenMilestoneParams,
  basePath: string,
  invocation?: ExecutionInvocation,
): Promise<ReopenMilestoneResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }
  if (!isMilestoneLifecycleAdopted(params.milestoneId)) {
    return {
      error: `Milestone ${params.milestoneId} has no canonical lifecycle row; the legacy reopen path was removed. ` +
        "Adopt the project with /gsd db adopt, then retry.",
    };
  }

  let canonicalReceipt: MilestoneReopenReceipt;
  let slicesResetCount = 0;
  let tasksResetCount = 0;
  // The canonical reopen deletes each run-uat verdict; its ASSESSMENT file goes with it.
  const slicesWithUatVerdict = new Set(
    getMilestoneSlices(params.milestoneId)
      .filter((slice) => getSliceRunUatAssessment(params.milestoneId, slice.id) !== null)
      .map((slice) => slice.id),
  );
  if (!invocation) {
    return { error: "adopted Milestone reopen requires canonical invocation identity" };
  }
  // Converge drifted descendants (legacy terminal while their canonical row
  // stayed `ready`) before the reopen's terminal-parity checks (#2440). The
  // evidence gate is unchanged: unverifiable drift fails the reopen here,
  // listed, instead of aborting inside the Domain Operation. A replayed
  // invocation skips the repair — its stored receipt must be returned as-is,
  // not preceded by fresh mutations against newer state.
  if (!readDomainOperationFence(invocation.idempotencyKey).replay) {
    try {
      const shadowRepair = repairMilestoneShadowsForReopen({
        invocation,
        milestoneId: params.milestoneId,
      });
      if (shadowRepair.unresolved.length > 0) {
        return {
          error: `Milestone ${params.milestoneId} has unresolved canonical lifecycle shadows: ${shadowRepair.unresolved.join(", ")}`,
        };
      }
      if (shadowRepair.repaired.length > 0) {
        logWarning(
          "db",
          `Repaired ${shadowRepair.repaired.length} evidence-backed lifecycle shadow(s) before reopening Milestone ${params.milestoneId}`,
        );
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  try {
    canonicalReceipt = reopenMilestone({
      invocation,
      milestoneId: params.milestoneId,
      reason: params.reason?.trim() || "Full Milestone redo requested",
      keepCompleted: params.keepCompleted === true,
      audit: {
        ...(params.actorName ? { actorName: params.actorName } : {}),
        ...(params.triggerReason ? { triggerReason: params.triggerReason } : {}),
      },
    });
    slicesResetCount = canonicalReceipt.slicesReset;
    tasksResetCount = canonicalReceipt.tasksReset;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  // A reopened unit gets its verification retries again (ADR-048).
  releaseExhaustedUnits(params.milestoneId);

  // ── Invalidate caches ────────────────────────────────────────────────────
  invalidateStateCache();

  // A historical replay must not remove files rendered by a newer operation.
  // T04 makes each individual cleanup delivery operation-fenced.
  const shouldProjectReopen = canonicalReceipt.isCurrent !== false;
  let projectionStale = false;
  let superseded = !shouldProjectReopen;
  const operationId = canonicalReceipt.operationId;
  const isCurrent = () => isCurrentMilestoneReopenOperation(operationId, params.milestoneId);

  // ── Clean up stale filesystem artifacts (M12 fix) ────────────────────────
  // Keep readable projections consistent with the reopened database hierarchy.
  // Legacy imports may still observe these files only through explicit recovery.
  if (shouldProjectReopen) {
    try {
      const slices = getMilestoneSlices(params.milestoneId);
      const milestoneTitle = getMilestone(params.milestoneId)?.title;
      const milestoneDir = resolveMilestonePath(basePath, params.milestoneId);
      const legacyBase = legacyMilestonesDir(basePath);
      const isLegacy = !!milestoneDir && (
        milestoneDir.startsWith(legacyBase + "/") || milestoneDir.startsWith(legacyBase + "\\")
      );
      const remove = (artifactPath: string): boolean => {
        cleanupInterleaveForTest?.({ artifactPath, operationId });
        return removeProjectionIfCurrent({ artifactPath, operationId, isCurrent });
      };

      // The canonical reopen deletes the validation verdict; its VALIDATION file goes with it.
      const milestoneSummaries = new Set(["SUMMARY", "VALIDATION"].flatMap((suffix) => [
        resolveMilestoneFile(basePath, params.milestoneId, suffix),
        targetMilestoneFile(basePath, params.milestoneId, suffix, milestoneTitle),
        ...(milestoneDir ? [join(milestoneDir, `${params.milestoneId}-${suffix}.md`)] : []),
      ]).filter((path): path is string => Boolean(path)));
      for (const artifactPath of milestoneSummaries) {
        if (!remove(artifactPath)) {
          superseded = true;
          projectionStale = true;
          break;
        }
      }

      if (params.keepCompleted !== true) {
      cleanup: for (const slice of slices) {
        if (superseded) break;
        const sliceDir = resolveSlicePath(basePath, params.milestoneId, slice.id);
        for (const suffix of ["SUMMARY", "UAT", ...(slicesWithUatVerdict.has(slice.id) ? ["ASSESSMENT"] : [])]) {
          const sliceArtifacts = new Set([
            resolveSliceFile(basePath, params.milestoneId, slice.id, suffix),
            targetSliceFile(basePath, params.milestoneId, slice.id, suffix, milestoneTitle),
            ...(sliceDir ? [
              join(sliceDir, buildSliceFileName(slice.id, suffix)),
              join(sliceDir, `${slice.id}-${suffix}.md`),
            ] : []),
          ].filter((path): path is string => Boolean(path)));
          for (const artifactPath of sliceArtifacts) {
            if (!remove(artifactPath)) {
              superseded = true;
              projectionStale = true;
              break cleanup;
            }
          }
        }

        const tasksDir = resolveTasksDir(basePath, params.milestoneId, slice.id);
        const tasks = getSliceTasks(params.milestoneId, slice.id);
        for (const task of tasks) {
          let taskSummaries: string[] = [];
          if (isLegacy) {
            if (tasksDir) {
              taskSummaries = [join(tasksDir, buildTaskFileName(task.id, "SUMMARY"))];
            }
          } else if (milestoneDir) {
            taskSummaries = [
              join(milestoneDir, buildFlatTaskFileName(slice.id, task.id, "SUMMARY")),
              join(milestoneDir, buildTaskFileName(task.id, "SUMMARY")),
            ];
          }
          const taskArtifacts = new Set([
            resolveTaskFile(basePath, params.milestoneId, slice.id, task.id, "SUMMARY"),
            targetTaskFile(basePath, params.milestoneId, slice.id, task.id, "SUMMARY", milestoneTitle),
            ...taskSummaries,
          ].filter((path): path is string => Boolean(path)));
          for (const artifactPath of taskArtifacts) {
            if (!remove(artifactPath)) {
              superseded = true;
              projectionStale = true;
              break cleanup;
            }
          }
        }
      }
      }
    } catch (err) {
      projectionStale = true;
      debugLog("reopen-milestone-cleanup-failed", { milestoneId: params.milestoneId, error: String(err) });
    }
  }
  clearPathCache();

  // ── Post-mutation hook ───────────────────────────────────────────────────
  try {
    if (!shouldProjectReopen) {
      return {
        milestoneId: params.milestoneId,
        slicesReset: slicesResetCount,
        tasksReset: tasksResetCount,
        operationId: canonicalReceipt.operationId,
        resultingRevision: canonicalReceipt.resultingRevision,
        duplicate: canonicalReceipt.status === "replayed",
        current: false,
        superseded: true,
      };
    }
    if (!superseded) {
      const flushed = await flushWorkflowProjections(
        basePath,
        { milestoneId: params.milestoneId },
        { operationId, isCurrent },
      );
      projectionStale ||= flushed.stale;
      superseded ||= flushed.superseded;
      if (!superseded && isCurrent()) await writeManifestAndFlush(basePath);
    }
  } catch (hookErr) {
    projectionStale = true;
    logWarning("tool", `reopen-milestone post-mutation hook warning: ${(hookErr as Error).message}`);
  }

  const current = isCurrent();
  superseded ||= !current;
  projectionStale ||= superseded;

  return {
    milestoneId: params.milestoneId,
    slicesReset: slicesResetCount,
    tasksReset: tasksResetCount,
    operationId: canonicalReceipt.operationId,
    resultingRevision: canonicalReceipt.resultingRevision,
    duplicate: canonicalReceipt.status === "replayed",
    current,
    ...(projectionStale ? { stale: true } : {}),
    ...(superseded ? { superseded: true } : {}),
  };
}
