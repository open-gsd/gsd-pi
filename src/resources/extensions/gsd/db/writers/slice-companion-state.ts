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
