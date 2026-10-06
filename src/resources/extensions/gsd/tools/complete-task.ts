// Project/App: gsd-pi
// File Purpose: Shared helpers behind gsd_task_complete.
//
// Task completion is canonical-only: gsd_task_complete routes through the
// durable Attempt completion pipeline (stageTaskCompletion), which requires a
// canonical Task lifecycle with a running, lease-held Attempt. The legacy
// write path (task-row status write plus claimed evidence) is removed; this
// module keeps the summary-path resolution and the rework-gate helpers the
// canonical path shares.

import { join } from "node:path";

import {
  buildFlatTaskFileName,
  buildTaskFileName,
  gsdProjectionRoot,
  legacyMilestonesDir,
  resolveMilestonePath,
  resolveSlicePath,
} from "../paths.js";
import { resolveCanonicalMilestoneRoot } from "../worktree-manager.js";
import type { CompleteTaskParams } from "../types.js";

function taskSummaryPath(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): string {
  // Layout-aware: avoid creating a milestones/ directory for flat-phase projects.
  // When that directory is created as a side effect, milestonesDir() detects it as
  // a legacy layout and breaks all subsequent path resolution for the session.
  const slicePath = resolveSlicePath(basePath, milestoneId, sliceId);
  const phaseDir = resolveMilestonePath(basePath, milestoneId);
  const legacyBase = legacyMilestonesDir(basePath);
  const isLegacy = phaseDir
    ? phaseDir.startsWith(legacyBase + "/") || phaseDir.startsWith(legacyBase + "\\")
    : false;
  if (isLegacy && phaseDir) {
    // Legacy layout: the slice has its own slices/SID/ subdir → tasks/ subdir.
    const legacySlicePath = slicePath && slicePath !== phaseDir
      ? slicePath
      : join(phaseDir, "slices", sliceId);
    return join(legacySlicePath, "tasks", buildTaskFileName(taskId, "SUMMARY"));
  }
  if (phaseDir) {
    // Flat-phase: task summaries go in the phase dir (no tasks/ subdir)
    return join(phaseDir, buildFlatTaskFileName(sliceId, taskId, "SUMMARY"));
  }
  // Fallback: legacy hardcoded path (milestone/slice dir not on disk yet)
  return join(
    gsdProjectionRoot(basePath),
    "milestones",
    milestoneId,
    "slices",
    sliceId,
    "tasks",
    `${taskId}-SUMMARY.md`,
  );
}

/**
 * Resolve the on-disk SUMMARY.md path for a task without writing anything.
 *
 * Used by callers that need to reference an already-completed task's summary
 * (e.g. the idempotent duplicate short-circuit in `executeTaskComplete`), which
 * must apply the same canonical-milestone-root resolution the completion
 * pipeline uses so the reported path matches the one the real completion wrote.
 */
export function resolveTaskSummaryPath(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): string {
  return taskSummaryPath(
    resolveCanonicalMilestoneRoot(basePath, milestoneId),
    milestoneId,
    sliceId,
    taskId,
  );
}

/**
 * Normalize a list parameter that may arrive as a string (newline-delimited
 * bullet list from the LLM) into a string array (#3361).
 */
export function normalizeListParam(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) {
    return value.split(/\n/).map(s => s.replace(/^[\s\-*•]+/, "").trim()).filter(Boolean);
  }
  return [];
}

export function normalizeReworkResolution(
  params: Pick<CompleteTaskParams, "milestoneId" | "sliceId" | "taskId" | "reworkResolution">,
): Array<{
  milestoneId: string;
  sliceId: string;
  taskId: string;
  findingId: string;
  status: "resolved" | "deferred-with-override";
  evidence: string;
  decisionRef?: string;
}> {
  return (params.reworkResolution ?? []).map((resolution) => ({
    milestoneId: params.milestoneId,
    sliceId: params.sliceId,
    taskId: params.taskId,
    findingId: resolution.findingId,
    status: resolution.status,
    evidence: resolution.evidence,
    decisionRef: resolution.decisionRef,
  }));
}

export function unresolvedReworkError(missingFindingIds: string[]): string {
  const plural = missingFindingIds.length === 1 ? "finding" : "findings";
  return `unresolved blocking rework ${plural}: ${missingFindingIds.join(", ")} — provide reworkResolution entries with status resolved and evidence, or status deferred-with-override with evidence and decisionRef, before completing the task`;
}

export function satisfiesBlockingReworkFinding(resolution: ReturnType<typeof normalizeReworkResolution>[number]): boolean {
  if (resolution.evidence.trim().length === 0) return false;
  if (resolution.status === "resolved") return true;
  return (resolution.decisionRef ?? "").trim().length > 0;
}
