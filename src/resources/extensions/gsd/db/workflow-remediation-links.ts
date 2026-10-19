// Project/App: gsd-pi
// File Purpose: Read access to workflow_remediation_links (ADR-046): the
// linked Remediation Task a failed item waits for.

import { isDbAvailable, _getAdapter } from "../gsd-db.js";

export interface LinkedRemediationTask {
  linkId: string;
  sourceLifecycleId: string;
  targetLifecycleId: string;
  requiredOutcome: string;
  remediationFingerprint: string;
  milestoneId: string;
  sliceId: string;
  sliceTitle: string;
  taskId: string;
  taskTitle: string;
}

/**
 * The open remediation links whose target is a Task of the milestone, oldest
 * first. A link is open while its target Task has work: the target lifecycle
 * is neither completed nor cancelled and the task row is not closed. A
 * `rework` link targets its own source item, so it is not a Remediation Task
 * and is never returned.
 */
export function selectOpenRemediationTasks(milestoneId: string): LinkedRemediationTask[] {
  if (!isDbAvailable()) return [];
  const rows = _getAdapter()!.prepare(
    `SELECT link.remediation_link_id AS link_id,
            link.source_lifecycle_id AS source_lifecycle_id,
            link.target_lifecycle_id AS target_lifecycle_id,
            link.required_outcome AS required_outcome,
            link.remediation_fingerprint AS remediation_fingerprint,
            target.milestone_id AS milestone_id,
            target.slice_id AS slice_id,
            slice.title AS slice_title,
            target.task_id AS task_id,
            task.title AS task_title
     FROM workflow_remediation_links link
     JOIN workflow_item_lifecycles target
       ON target.lifecycle_id = link.target_lifecycle_id
      AND target.project_id = link.project_id
     JOIN slices slice
       ON slice.milestone_id = target.milestone_id
      AND slice.id = target.slice_id
     JOIN tasks task
       ON task.milestone_id = target.milestone_id
      AND task.slice_id = target.slice_id
      AND task.id = target.task_id
     WHERE link.route_kind = 'remediation'
       AND target.item_kind = 'task'
       AND target.milestone_id = :milestone_id
       AND target.lifecycle_status NOT IN ('completed', 'cancelled')
       AND task.status NOT IN ('complete', 'done')
     ORDER BY link.created_at, link.remediation_link_id`,
  ).all({ ":milestone_id": milestoneId }) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    linkId: String(row.link_id),
    sourceLifecycleId: String(row.source_lifecycle_id),
    targetLifecycleId: String(row.target_lifecycle_id),
    requiredOutcome: String(row.required_outcome),
    remediationFingerprint: String(row.remediation_fingerprint),
    milestoneId: String(row.milestone_id),
    sliceId: String(row.slice_id),
    sliceTitle: String(row.slice_title),
    taskId: String(row.task_id),
    taskTitle: String(row.task_title),
  }));
}
