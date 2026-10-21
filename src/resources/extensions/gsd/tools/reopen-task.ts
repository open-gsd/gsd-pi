/**
 * reopen-task handler — the core operation behind gsd_task_reopen.
 *
 * Resets a completed task back to "pending" so it can be re-done
 * without manual SQL surgery. The parent slice and milestone must
 * still be open (not complete) — you cannot reopen tasks inside a
 * closed slice.
 */

// GSD — reopen-task tool handler
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { invalidateStateCache } from "../state.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifestAndFlush } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import { writeReopenReason } from "../reopen-reason.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { removeProjectionFileSync } from "../atomic-write.js";
import { reopenTask } from "../task-lifecycle-domain-operation.js";
import type { ExecutionInvocation } from "../execution-invocation.js";
import {
  buildFlatTaskFileName,
  buildTaskFileName,
  legacyMilestonesDir,
  resolveMilestonePath,
  resolveTasksDir,
  resolveSlicePath,
  clearPathCache,
} from "../paths.js";

export interface ReopenTaskParams {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  reason?: string;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface ReopenTaskResult {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

export async function handleReopenTask(
  params: ReopenTaskParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ReopenTaskResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.taskId || typeof params.taskId !== "string" || params.taskId.trim() === "") {
    return { error: "taskId is required and must be a non-empty string" };
  }
  if (!params.sliceId || typeof params.sliceId !== "string" || params.sliceId.trim() === "") {
    return { error: "sliceId is required and must be a non-empty string" };
  }
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }

  let receipt;
  try {
    receipt = reopenTask({
      invocation,
      task: {
        milestoneId: params.milestoneId,
        sliceId: params.sliceId,
        taskId: params.taskId,
      },
      reason: params.reason?.trim() || "Task reopened for execution follow-up",
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  // ── Invalidate caches ────────────────────────────────────────────────────
  invalidateStateCache();

  // A replay can arrive after newer work has already claimed or completed the
  // Task. Never let an old request rewrite those newer readable projections.
  if (receipt.status === "replayed") {
    return {
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      taskId: params.taskId,
    };
  }

  // ── Clean up stale filesystem artifacts (M12 fix) ────────────────────────
  // Without this, the DB-filesystem reconciler sees the SUMMARY.md and
  // auto-corrects the task back to "complete", making reopen a no-op (#3161).
  // Legacy layout keeps the summary under a tasks/ subdir; flat-phase writes
  // TID-SUMMARY.md directly in the phase dir. A tasks/ subdir may still exist
  // in flat-phase for auxiliary artifacts — its mere existence must NOT redirect
  // summary cleanup into tasks/ (#1208).
  try {
    const slicePath = resolveSlicePath(basePath, params.milestoneId, params.sliceId);
    const milestonePath = resolveMilestonePath(basePath, params.milestoneId);
    if (milestonePath) {
      const legacyBase = legacyMilestonesDir(basePath);
      const isLegacy = milestonePath.startsWith(legacyBase + "/") || milestonePath.startsWith(legacyBase + "\\");
      const summaryPaths = isLegacy
        ? [join(resolveTasksDir(basePath, params.milestoneId, params.sliceId) ?? slicePath ?? join(milestonePath, "slices", params.sliceId, "tasks"), buildTaskFileName(params.taskId, "SUMMARY"))]
        : [
          join(milestonePath, buildFlatTaskFileName(params.sliceId, params.taskId, "SUMMARY")),
          join(milestonePath, buildTaskFileName(params.taskId, "SUMMARY")),
        ];
      for (const summaryPath of summaryPaths) {
        if (existsSync(summaryPath)) removeProjectionFileSync(summaryPath);
      }
    }
  } catch (cleanupErr) {
    logWarning("tool", `reopen-task artifact cleanup warning: ${(cleanupErr as Error).message}`);
  }
  clearPathCache();

  // ── Persist the reopen reason for the next execute-task dispatch (#1272) ──
  // Without this, the re-dispatched executor receives the original task plan
  // and verify command with zero signal that it was reopened — it re-runs the
  // (still-green) scoped verify and re-completes the task, never touching the
  // regression the gate actually caught. buildExecuteTaskPrompt claims this
  // artifact and prepends the diagnosis to the next dispatch.
  if (params.reason && params.reason.trim() !== "") {
    try {
      writeReopenReason(basePath, params.milestoneId, params.sliceId, params.taskId, params.reason);
    } catch (reasonErr) {
      logWarning("tool", `reopen-task reason persistence warning: ${(reasonErr as Error).message}`);
    }
  }

  // ── Post-mutation hook ───────────────────────────────────────────────────
  try {
    await flushWorkflowProjections(basePath, { milestoneId: params.milestoneId });
    await writeManifestAndFlush(basePath);
    appendEvent(basePath, {
      cmd: "reopen-task",
      params: {
        milestoneId: params.milestoneId,
        sliceId: params.sliceId,
        taskId: params.taskId,
        reason: params.reason ?? null,
      },
      ts: new Date().toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason,
    });
  } catch (hookErr) {
    logWarning("tool", `reopen-task post-mutation hook warning: ${(hookErr as Error).message}`);
  }

  return {
    milestoneId: params.milestoneId,
    sliceId: params.sliceId,
    taskId: params.taskId,
  };
}
