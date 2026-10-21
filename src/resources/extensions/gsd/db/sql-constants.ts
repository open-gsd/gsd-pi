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
