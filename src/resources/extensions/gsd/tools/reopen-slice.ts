/**
 * reopen-slice handler — the core operation behind gsd_slice_reopen.
 *
 * Reopens a completed or cancelled Slice and all terminal Tasks in one
 * revision- and Authority-Epoch-fenced Domain Operation. Prior Attempts,
 * Results, evidence, and dispatch history remain immutable. Reopen revokes
 * current cancellation Waivers and rejects progressed transitive downstream
 * Slices before moving the current lifecycle heads back to ready/pending.
 *
 * Also recovers a legacy, unadopted desync (#1205): when a UAT→planning
 * fallback leaves the Slice open but all Tasks terminal, this clears that
 * state so the planner can re-plan. An adopted canonical open Slice fails
 * closed instead of using this compatibility escape.
 *
 * The parent Milestone must still be open. Projection cleanup happens after
 * commit and checks the current operation before removing completion output,
 * so a stale reopen cannot erase projections from a newer completion.
 */

// GSD — reopen-slice tool handler
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import {
  getSliceTasks,
} from "../gsd-db.js";
import {
  isCurrentSliceReopenOperation,
  reopenSlice,
  SliceLifecycleValidationError,
} from "../slice-lifecycle-domain-operation.js";
import type { ExecutionInvocation } from "../execution-invocation.js";
import { invalidateStateCache } from "../state.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { renderPlanCheckboxes } from "../markdown-renderer.js";
import { writeManifestAndFlush } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import { join } from "node:path";
import {
  _setProjectionCleanupInterleaveForTest,
  removeProjectionIfCurrent,
} from "../projection-cleanup.js";
import {
  buildFlatTaskFileName,
  buildTaskFileName,
  legacyMilestonesDir,
  resolveMilestonePath,
  resolveTasksDir,
  resolveSliceFile,
  resolveSlicePath,
  targetSliceFile,
  clearPathCache,
} from "../paths.js";

export interface ReopenSliceParams {
  milestoneId: string;
  sliceId: string;
  reason?: string;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface ReopenSliceResult {
  milestoneId: string;
  sliceId: string;
  tasksReset: number;
  duplicate?: boolean;
  superseded?: boolean;
  stale?: boolean;
}

export function _setReopenSliceCleanupInterleaveForTest(hook: (() => void) | null): void {
  _setProjectionCleanupInterleaveForTest(hook);
}

export async function handleReopenSlice(
  params: ReopenSliceParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ReopenSliceResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.sliceId || typeof params.sliceId !== "string" || params.sliceId.trim() === "") {
    return { error: "sliceId is required and must be a non-empty string" };
  }
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }

  let tasksResetCount: number;
  let operationStatus: "committed" | "replayed";
  let operationId: string;
  let projectionStale = false;
  try {
    const receipt = reopenSlice({
      invocation,
      slice: { milestoneId: params.milestoneId, sliceId: params.sliceId },
      reason: params.reason?.trim() || "User-directed full Slice redo",
      audit: { actorName: params.actorName, triggerReason: params.triggerReason },
    });
    tasksResetCount = receipt.tasksReset;
    operationStatus = receipt.status;
    operationId = receipt.operationId;
    if (receipt.status === "replayed" && !receipt.isCurrent) {
      return {
        milestoneId: params.milestoneId,
        sliceId: params.sliceId,
        tasksReset: tasksResetCount,
        duplicate: true,
        superseded: true,
      };
    }
  } catch (error) {
    if (!(error instanceof SliceLifecycleValidationError)) throw error;
    return { error: error.message };
  }

  // ── Invalidate caches ────────────────────────────────────────────────────
  invalidateStateCache();

  // ── Clean up stale filesystem artifacts (M12 fix) ────────────────────────
  // Without this, the DB-filesystem reconciler sees SUMMARY.md files and
  // auto-corrects tasks back to "complete", making reopen a no-op (#3161).
  try {
    const slice = { milestoneId: params.milestoneId, sliceId: params.sliceId };
    const isCurrent = () => isCurrentSliceReopenOperation(operationId, slice);
    const milestoneDir = resolveMilestonePath(basePath, params.milestoneId);
    const legacyBase = legacyMilestonesDir(basePath);
    const isLegacy = !!milestoneDir && (
      milestoneDir.startsWith(legacyBase + "/") || milestoneDir.startsWith(legacyBase + "\\")
    );
    const tasksDir = resolveTasksDir(basePath, params.milestoneId, params.sliceId);
    const tasks = getSliceTasks(params.milestoneId, params.sliceId);
    cleanup: for (const task of tasks) {
      const summaryPaths = isLegacy
        ? (tasksDir ? [join(tasksDir, buildTaskFileName(task.id, "SUMMARY"))] : [])
        : milestoneDir
          ? [
            join(milestoneDir, buildFlatTaskFileName(params.sliceId, task.id, "SUMMARY")),
            join(milestoneDir, buildTaskFileName(task.id, "SUMMARY")),
          ]
          : [];
      for (const summaryPath of summaryPaths) {
        if (!removeProjectionIfCurrent({ artifactPath: summaryPath, operationId, isCurrent })) {
          projectionStale = true;
          break cleanup;
        }
      }
    }
    const sliceDir = projectionStale ? null : resolveSlicePath(basePath, params.milestoneId, params.sliceId);
    if (sliceDir) {
      const sliceArtifacts = new Set([
        targetSliceFile(basePath, params.milestoneId, params.sliceId, "SUMMARY"),
        targetSliceFile(basePath, params.milestoneId, params.sliceId, "UAT"),
        join(sliceDir, `${params.sliceId}-SUMMARY.md`),
        join(sliceDir, `${params.sliceId}-UAT.md`),
      ]);
      const existingSummary = resolveSliceFile(basePath, params.milestoneId, params.sliceId, "SUMMARY");
      const existingUat = resolveSliceFile(basePath, params.milestoneId, params.sliceId, "UAT");
      if (existingSummary) sliceArtifacts.add(existingSummary);
      if (existingUat) sliceArtifacts.add(existingUat);
      for (const artifactPath of sliceArtifacts) {
        if (!removeProjectionIfCurrent({ artifactPath, operationId, isCurrent })) {
          projectionStale = true;
          break;
        }
      }
    }
  } catch (cleanupErr) {
    projectionStale = true;
    logWarning("tool", `reopen-slice artifact cleanup warning: ${(cleanupErr as Error).message}`);
  }
  clearPathCache();

  // ── Post-mutation hook ───────────────────────────────────────────────────
  try {
    const slice = { milestoneId: params.milestoneId, sliceId: params.sliceId };
    if (isCurrentSliceReopenOperation(operationId, slice)) {
      await renderPlanCheckboxes(basePath, params.milestoneId, params.sliceId);
      const flushed = await flushWorkflowProjections(basePath, { milestoneId: params.milestoneId });
      projectionStale ||= flushed.stale;
      await writeManifestAndFlush(basePath);
    } else {
      projectionStale = true;
    }
    if (operationStatus === "committed") {
      appendEvent(basePath, {
        cmd: "reopen-slice",
        params: {
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          reason: params.reason ?? null,
          tasksReset: tasksResetCount,
        },
        ts: new Date().toISOString(),
        actor: "agent",
        actor_name: params.actorName,
        trigger_reason: params.triggerReason,
      });
    }
  } catch (hookErr) {
    projectionStale = true;
    logWarning("tool", `reopen-slice post-mutation hook warning: ${(hookErr as Error).message}`);
  }

  return {
    milestoneId: params.milestoneId,
    sliceId: params.sliceId,
    tasksReset: tasksResetCount,
    ...(operationStatus === "replayed" ? { duplicate: true } : {}),
    ...(projectionStale ? { stale: true } : {}),
  };
}
