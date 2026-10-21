// Project/App: gsd-pi
// File Purpose: Persist a reopened task's failure diagnosis and inject it into the re-dispatched execute-task prompt.
// GSD Extension — follow-up to #1225 (#1272)
//
// When complete-slice's gate reopens a task via gsd_task_reopen, the operator
// supplies a `reason` explaining exactly what the full-suite gate caught and
// how to fix it. That reason previously only landed in the workflow event log
// (audit trail) and never reached the re-dispatched executor, so the executor
// re-ran the original (green) verify and re-completed the task without touching
// the regression. This module is the "inject unresolved context into the next
// dispatch" mechanism for reopen reasons — a lightweight, file-based sibling of
// escalation.js#claimOverrideForInjection, keyed by (milestone, slice, task).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { legacyMilestonesDir, resolveSlicePath, resolveTasksDir } from "./paths.js";
import { atomicWriteSync, removeProjectionFileSync } from "./atomic-write.js";
import { logWarning } from "./workflow-logger.js";

interface ReopenReasonArtifact {
  version: 1;
  milestoneId: string;
  sliceId: string;
  taskId: string;
  reason: string;
  createdAt: string;
}

/**
 * Canonical reopen-reason artifact path, parallel to T##-SUMMARY.md and
 * T##-ESCALATION.json:
 *   .gsd/milestones/{M}/slices/{S}/tasks/{T}-REOPEN.json
 * Flat-phase: the artifact sits directly in the phase dir. Legacy layouts
 * without a tasks/ subdir return null (caller degrades gracefully).
 */
export function reopenReasonArtifactPath(
  basePath: string, milestoneId: string, sliceId: string, taskId: string,
): string | null {
  const tDir = resolveTasksDir(basePath, milestoneId, sliceId);
  if (tDir) return join(tDir, `${taskId}-REOPEN.json`);
  if (existsSync(legacyMilestonesDir(basePath))) return null;
  const phaseDir = resolveSlicePath(basePath, milestoneId, sliceId);
  if (!phaseDir) return null;
  return join(phaseDir, `${taskId}-REOPEN.json`);
}

/**
 * Persist the reopen reason so the next execute-task dispatch can surface it.
 * A no-op when the reason is empty or the artifact path cannot be resolved —
 * reopen itself must still succeed even if we cannot attach context.
 */
export function writeReopenReason(
  basePath: string, milestoneId: string, sliceId: string, taskId: string, reason: string,
): void {
  const trimmed = reason.trim();
  if (!trimmed) return;
  const path = reopenReasonArtifactPath(basePath, milestoneId, sliceId, taskId);
  if (!path) {
    logWarning("tool", `reopen-reason: cannot resolve artifact path for ${milestoneId}/${sliceId}/${taskId}; reopen reason not attached to next dispatch`);
    return;
  }
  const artifact: ReopenReasonArtifact = {
    version: 1,
    milestoneId, sliceId, taskId,
    reason: trimmed,
    createdAt: new Date().toISOString(),
  };
  mkdirSync(join(path, ".."), { recursive: true });
  atomicWriteSync(path, JSON.stringify(artifact, null, 2));
}

/**
 * If a reopen reason is pending for this task, claim it (one-shot: the artifact
 * is deleted on read) and return the markdown block to prepend to the executor's
 * prompt. Returns null when nothing is pending or the artifact is malformed.
 */
export function claimReopenReasonForInjection(
  basePath: string, milestoneId: string, sliceId: string, taskId: string,
): { injectionBlock: string } | null {
  const path = reopenReasonArtifactPath(basePath, milestoneId, sliceId, taskId);
  if (!path || !existsSync(path)) return null;
  let art: ReopenReasonArtifact | null = null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ReopenReasonArtifact>;
    if (parsed && parsed.version === 1 && typeof parsed.reason === "string" && parsed.reason.trim()) {
      art = parsed as ReopenReasonArtifact;
    }
  } catch {
    art = null;
  }
  // Claim (delete) regardless of validity so a malformed artifact doesn't
  // wedge every future dispatch of this task.
  try { removeProjectionFileSync(path); } catch { /* already gone */ }
  if (!art) return null;
  return { injectionBlock: formatReopenReasonBlock(art) };
}

function formatReopenReasonBlock(art: ReopenReasonArtifact): string {
  return [
    `## Reopened — Reason (from ${art.taskId})`,
    "",
    "This task was previously marked complete but a downstream gate (e.g. complete-slice's full-suite run) reopened it. The verify command in your task plan passed in isolation — it did **not** catch the regression below. Do **not** call `gsd_task_complete` until you have reproduced and fixed exactly what this diagnosis describes, then re-run the specific failing command it names (not just the original scoped verify).",
    "",
    "**Diagnosis / fix instructions from the gate:**",
    "",
    art.reason.trim(),
  ].join("\n");
}
