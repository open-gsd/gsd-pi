// Project/App: gsd-pi
// File Purpose: Establish the database-owned companion state required by Slice lifecycle operations.

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

export interface SliceCompanionIdentity {
  milestoneId: string;
  sliceId: string;
}

export function ensurePendingSliceQ8(
  context: Readonly<DomainOperationContext>,
  slice: SliceCompanionIdentity,
): void {
  requireActiveDomainOperationContext(context);
  const parameters = {
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
  };
  const rows = getDb().prepare(`
    SELECT 1 FROM quality_gates
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id
      AND gate_id = 'Q8' AND (task_id = '' OR task_id IS NULL)
  `).all(parameters);
  if (rows.length > 1) {
    throw new Error(`Slice ${slice.sliceId} has multiple Q8 companion gates`);
  }

  const result = rows.length === 0
    ? getDb().prepare(`
        INSERT INTO quality_gates (
          milestone_id, slice_id, gate_id, scope, task_id, status
        ) VALUES (
          :milestone_id, :slice_id, 'Q8', 'slice', '', 'pending'
        )
      `).run(parameters)
    : getDb().prepare(`
        UPDATE quality_gates
        SET status = 'pending', verdict = '', rationale = '',
            findings = '', evaluated_at = NULL
        WHERE milestone_id = :milestone_id AND slice_id = :slice_id
          AND gate_id = 'Q8' AND (task_id = '' OR task_id IS NULL)
      `).run(parameters);
  if (Number((result as { changes?: number }).changes ?? 0) !== 1) {
    throw new Error(`Slice ${slice.sliceId} must have one pending Q8 companion gate`);
  }
}

/**
 * A reopened Slice is done again, so every proof of the earlier work is stale:
 * the agent's claimed Task evidence, the run-uat verdict with its ASSESSMENT
 * artifact, the UAT gate, the run-uat retry count, and UAT exec runs not yet
 * saved in a result. Remove them so the redo is judged on new evidence only.
 * gate_runs keeps the history of the UAT attempts.
 */
export function invalidateSliceEvidence(
  context: Readonly<DomainOperationContext>,
  slice: SliceCompanionIdentity,
): void {
  requireActiveDomainOperationContext(context);
  const parameters = {
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
  };
  for (const statement of [
    "DELETE FROM verification_evidence WHERE milestone_id = :milestone_id AND slice_id = :slice_id",
    `DELETE FROM artifacts
     WHERE '.gsd/' || path IN (
       SELECT path FROM assessments
       WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND scope = 'run-uat'
     )`,
    "DELETE FROM assessments WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND scope = 'run-uat'",
    "DELETE FROM quality_gates WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND gate_id = 'UAT'",
    "DELETE FROM uat_retry_counters WHERE milestone_id = :milestone_id AND slice_id = :slice_id",
    `UPDATE exec_runs SET attempt_ref = NULL
     WHERE kind = 'uat_exec' AND milestone_id = :milestone_id AND slice_id = :slice_id`,
  ]) {
    getDb().prepare(statement).run(parameters);
  }
}
