// Project/App: gsd-pi
// File Purpose: Establish the database-owned companion state required by Slice lifecycle operations.

import type { DomainJsonValue, DomainOperationContext } from "../domain-operation.js";
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

/** The rows a reopen removed, by table. They live on in the reopen event payload. */
export type InvalidatedEvidence = Record<string, DomainJsonValue[]>;

/** Remove the rows a reopen invalidates and return them, so their content is not lost. */
export function removeInvalidatedRows(
  removals: ReadonlyArray<readonly [table: string, where: string]>,
  parameters: Record<string, string>,
): InvalidatedEvidence {
  const removed: InvalidatedEvidence = {};
  for (const [table, where] of removals) {
    removed[table] = getDb().prepare(`SELECT * FROM ${table} WHERE ${where}`).all(parameters) as DomainJsonValue[];
    getDb().prepare(`DELETE FROM ${table} WHERE ${where}`).run(parameters);
  }
  return removed;
}

/**
 * A reopened Slice is done again, so every proof of the earlier work is stale:
 * the agent's claimed Task evidence, the SUMMARY artifacts of the Slice and its
 * Tasks, the run-uat verdict with its ASSESSMENT artifact, the UAT gate, the
 * run-uat retry count, and UAT exec runs not yet saved in a result. Remove
 * them so the redo is judged on new evidence only.
 * The removed rows are returned for the reopen event payload: the redo does
 * not read them, and the database does not lose them.
 */
export function invalidateSliceEvidence(
  context: Readonly<DomainOperationContext>,
  slice: SliceCompanionIdentity,
): InvalidatedEvidence {
  requireActiveDomainOperationContext(context);
  const parameters = {
    ":milestone_id": slice.milestoneId,
    ":slice_id": slice.sliceId,
  };
  const ofSlice = "milestone_id = :milestone_id AND slice_id = :slice_id";
  const removed = removeInvalidatedRows([
    ["verification_evidence", ofSlice],
    // A SUMMARY row of the Slice or of its Tasks claims the completion that the
    // reopen voids: left in place it reads as artifact/DB drift.
    ["artifacts", `(${ofSlice} AND artifact_type = 'SUMMARY') OR '.gsd/' || path IN (SELECT path FROM assessments WHERE ${ofSlice} AND scope = 'run-uat')`],
    ["assessments", `${ofSlice} AND scope = 'run-uat'`],
    ["quality_gates", `${ofSlice} AND gate_id = 'UAT'`],
    ["uat_retry_counters", ofSlice],
  ], parameters);
  getDb().prepare(
    `UPDATE exec_runs SET attempt_ref = NULL WHERE kind = 'uat_exec' AND ${ofSlice}`,
  ).run(parameters);
  return removed;
}
