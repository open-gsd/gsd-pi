// Project/App: gsd-pi
// File Purpose: Shared SQL literal fragments for runtime database policy.
// Kept out of the barrel surface so they remain database implementation details.
import { RAW_CLOSED_STATUSES } from "../status-guards.js";

export function currentEvidenceBackedFailureVerdictSqlV39(
  resultAlias: string,
  causalAuthorityAlias?: string,
): string {
  const causalAuthoritySql = causalAuthorityAlias
    ? `AND verdict.project_revision < ${causalAuthorityAlias}.project_revision
    AND verdict.authority_epoch <= ${causalAuthorityAlias}.authority_epoch`
    : "";

  return `EXISTS (
  SELECT 1
  FROM workflow_technical_verdicts verdict
  JOIN workflow_acceptance_criteria criterion
    ON criterion.criterion_id = verdict.criterion_id
   AND criterion.project_id = verdict.project_id
   AND criterion.lifecycle_id = verdict.lifecycle_id
  JOIN workflow_verification_evidence evidence
    ON evidence.verdict_id = verdict.verdict_id
   AND evidence.project_id = verdict.project_id
   AND evidence.attempt_id = verdict.attempt_id
  WHERE verdict.project_id = ${resultAlias}.project_id
    AND verdict.lifecycle_id = ${resultAlias}.lifecycle_id
    AND verdict.attempt_id = ${resultAlias}.attempt_id
    AND verdict.verdict IN ('fail', 'inconclusive')
    ${causalAuthoritySql}
    AND NOT EXISTS (
      SELECT 1 FROM workflow_acceptance_criteria successor
      WHERE successor.supersedes_criterion_id = criterion.criterion_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM workflow_technical_verdicts successor
      WHERE successor.supersedes_verdict_id = verdict.verdict_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM workflow_technical_verdicts newer
      JOIN workflow_verification_evidence newer_evidence
        ON newer_evidence.verdict_id = newer.verdict_id
       AND newer_evidence.project_id = newer.project_id
       AND newer_evidence.attempt_id = newer.attempt_id
      WHERE newer.project_id = verdict.project_id
        AND newer.criterion_id = verdict.criterion_id
        AND newer.lifecycle_id = verdict.lifecycle_id
        AND newer.attempt_id = verdict.attempt_id
        AND newer.project_revision > verdict.project_revision
        AND NOT EXISTS (
          SELECT 1 FROM workflow_technical_verdicts successor
          WHERE successor.supersedes_verdict_id = newer.verdict_id
        )
    )
)`;
}

export const CURRENT_EVIDENCE_BACKED_FAILURE_VERDICT_SQL =
  currentEvidenceBackedFailureVerdictSqlV39("result");

export const CURRENT_TASK_RECOVERY_CAUSAL_AUTHORITY_SQL = `(
  (observation.boundary_stage = 'execute' AND result.outcome IN ('failed', 'interrupted')) OR
  (observation.boundary_stage = 'verify' AND result.outcome = 'succeeded'
    AND ${CURRENT_EVIDENCE_BACKED_FAILURE_VERDICT_SQL})
)`;

/** Status values that mean a unit is closed; used in ON CONFLICT guards to
 *  prevent an upsert from reopening a completed slice/task. Derived from the
 *  single source `RAW_CLOSED_STATUSES` (ADR-030) so the SQL fragment cannot
 *  drift from `isClosedStatus()`. Renders as `'complete', 'done', 'skipped',
 *  'closed', 'cancelled', 'blocker-accepted'`. */
export const TERMINAL_STATUS_SQL = RAW_CLOSED_STATUSES.map((s) => `'${s}'`).join(", ");

/** Event that marks an Open Question as a Task escalation. */
export const TASK_ESCALATION_OPENED_EVENT = "task.escalation.opened";

/** SQL condition, correlated with a `tasks` row: the Task has an escalation question in the given status. */
function taskEscalationExistsSql(statusCondition: string): string {
  return `EXISTS (
  SELECT 1
  FROM workflow_item_lifecycles escalation_lifecycle
  JOIN workflow_open_questions escalation_question
    ON escalation_question.lifecycle_id = escalation_lifecycle.lifecycle_id
   AND escalation_question.project_id = escalation_lifecycle.project_id
  JOIN workflow_domain_events escalation_event
    ON escalation_event.event_type = '${TASK_ESCALATION_OPENED_EVENT}'
   AND json_extract(escalation_event.payload_json, '$.questionId') = escalation_question.question_id
  WHERE escalation_lifecycle.item_kind = 'task'
    AND escalation_lifecycle.milestone_id = tasks.milestone_id
    AND escalation_lifecycle.slice_id = tasks.slice_id
    AND escalation_lifecycle.task_id = tasks.id
    AND escalation_question.question_status ${statusCondition}
)`;
}

/** True when the Task has a current (open or answered) escalation question. */
export const TASK_HAS_ESCALATION_SQL = taskEscalationExistsSql("!= 'withdrawn'");

/** True when the Task has an open escalation question. This is the pause. */
export const TASK_HAS_OPEN_ESCALATION_SQL = taskEscalationExistsSql("= 'open'");
