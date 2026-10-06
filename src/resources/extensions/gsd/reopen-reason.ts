// Project/App: gsd-pi
// File Purpose: Read a reopened task's failure diagnosis from the DB and format it for the re-dispatched execute-task prompt.
// GSD Extension — follow-up to #1225 (#1272)
//
// When complete-slice's gate reopens a task via gsd_task_reopen, the operator
// supplies a `reason` explaining exactly what the full-suite gate caught and
// how to fix it. Without it the executor re-runs the original (green) verify
// and re-completes the task without touching the regression. The reason is
// the `task.reopened` Domain Operation event; it stays pending until a new
// Attempt is claimed for the Task, so the first re-dispatch shows it.

import { getLatestPendingReopenEventRow } from "./db/lifecycle-queries.js";

/**
 * The markdown block for a reopen diagnosis that no Attempt has answered yet,
 * or null when the latest reopen carried no diagnosis or an Attempt was
 * claimed after it.
 */
export function readPendingReopenReason(
  milestoneId: string, sliceId: string, taskId: string,
): { injectionBlock: string } | null {
  const row = getLatestPendingReopenEventRow(milestoneId, sliceId, taskId);
  if (!row) return null;
  const payload = JSON.parse(row.payload_json) as { reason?: unknown; injectReason?: unknown };
  if (payload.injectReason !== true || typeof payload.reason !== "string") return null;
  return { injectionBlock: formatReopenReasonBlock(taskId, payload.reason) };
}

function formatReopenReasonBlock(taskId: string, reason: string): string {
  return [
    `## Reopened — Reason (from ${taskId})`,
    "",
    "This task was previously marked complete but a downstream gate (e.g. complete-slice's full-suite run) reopened it. The verify command in your task plan passed in isolation — it did **not** catch the regression below. Do **not** call `gsd_task_complete` until you have reproduced and fixed exactly what this diagnosis describes, then re-run the specific failing command it names (not just the original scoped verify).",
    "",
    "**Diagnosis / fix instructions from the gate:**",
    "",
    reason.trim(),
  ].join("\n");
}
