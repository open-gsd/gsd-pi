// Project/App: gsd-pi
// File Purpose: Test helper that gives legacy-complete fixture rows the completion evidence lifecycle backfill needs.

import { _getAdapter, insertSlice } from "../../gsd-db.ts";

const COMPLETED_AT = "2026-01-01T00:00:00.000Z";

/**
 * The first open of an old database runs lifecycle backfill. It adopts a
 * legacy completion as completed only with evidence: a Task needs
 * completed_at, a summary and a verification result; a Slice needs
 * completed_at and a summary; a Milestone needs completed_at and one Slice.
 * A fixture that means "this row is complete" calls this before it closes
 * the database; without it the open adopts the row as open work.
 */
export function addLegacyCompletionEvidence(): void {
  const db = _getAdapter()!;
  const withoutSlice = db.prepare(`
    SELECT id FROM milestones
    WHERE status = 'complete' AND NOT EXISTS (SELECT 1 FROM slices WHERE slices.milestone_id = milestones.id)
  `).all();
  for (const milestone of withoutSlice) {
    insertSlice({ id: "S01", milestoneId: String(milestone["id"]), title: "Delivered", status: "complete" });
  }
  db.exec(`
    UPDATE tasks SET completed_at = '${COMPLETED_AT}', full_summary_md = 'Done.', verification_result = 'passed'
    WHERE status = 'complete';
    UPDATE slices SET completed_at = '${COMPLETED_AT}', full_summary_md = 'Done.' WHERE status = 'complete';
    UPDATE milestones SET completed_at = '${COMPLETED_AT}' WHERE status = 'complete';
  `);
}
