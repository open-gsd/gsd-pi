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

import { getDb } from "./db/engine.js";

/**
 * The markdown block for a reopen diagnosis that no Attempt has answered yet,
 * or null when the latest reopen carried no diagnosis or an Attempt was
 * claimed after it.
 */
export function readPendingReopenReason(
  milestoneId: string, sliceId: string, taskId: string,
): { injectionBlock: string } | null {
  const row = getDb().prepare(`
    SELECT event.payload_json
    FROM workflow_domain_events event
    WHERE event.event_type = 'task.reopened'
      AND event.entity_type = 'task'
      AND event.entity_id = :entity_id
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_item_lifecycles lifecycle
        JOIN workflow_execution_attempts attempt
          ON attempt.lifecycle_id = lifecycle.lifecycle_id
         AND attempt.project_id = lifecycle.project_id
        WHERE lifecycle.item_kind = 'task'
          AND lifecycle.project_id = event.project_id
          AND lifecycle.milestone_id = :milestone_id
          AND lifecycle.slice_id = :slice_id
          AND lifecycle.task_id = :task_id
          AND attempt.claim_project_revision > event.project_revision
      )
    ORDER BY event.project_revision DESC
    LIMIT 1
  `).get({
    ":entity_id": `${milestoneId}/${sliceId}/${taskId}`,
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
  }) as { payload_json: string } | undefined;
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
