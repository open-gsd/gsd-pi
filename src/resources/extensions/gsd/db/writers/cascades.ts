// Project/App: gsd-pi
// File Purpose: Domain Write Operations (Hierarchy Status Cascades) for the
// single-writer layer. Each operation owns its own transaction() and mutates
// the related rows of one logical hierarchy change in a single commit, so the
// atomicity rule lives in one place instead of being hand-rolled (or missed)
// in callers. Operations own DB-row atomicity only — markdown re-projection,
// validation, and messaging stay in callers / db-writer.ts.
import { getDbOrNull, transaction } from "../engine.js";
import { GSDError, GSD_STALE_STATE } from "../../errors.js";
import { isClosedStatus } from "../../status-guards.js";
import { getMilestone, getMilestoneSlices } from "../queries.js";

function requireDb(): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
}

// ─── Reopen cascades ───────────────────────────────────────────────────────
// A reopen blocked by a structural precondition returns a discriminated reason
// (carrying the offending entity's status where the caller's message needs it).
// Structural guards run inside the transaction for TOCTOU safety; the caller
// owns user-facing message formatting and projection.

export type ReopenMilestoneOutcome =
  | { ok: true; slicesReset: number; tasksReset: number }
  | { ok: false; reason: "milestone-not-found" }
  | { ok: false; reason: "canonical-authority-present" }
  | { ok: false; reason: "milestone-not-closed"; status: string };

/**
 * Reopen a closed milestone: milestone → "active", completion timestamp
 * cleared. The default cascade also sets every slice → "in_progress" and every
 * task → "pending". Pass keepCompleted to unlock the milestone without
 * resetting already-finished descendants. Folds the hand-rolled
 * transaction-plus-cascade previously in tools/reopen-milestone.ts.
 */
export function reopenMilestoneCascade(
  milestoneId: string,
  keepCompleted = false,
): ReopenMilestoneOutcome {
  requireDb();
  let outcome: ReopenMilestoneOutcome = { ok: true, slicesReset: 0, tasksReset: 0 };
  transaction(() => {
    const milestone = getMilestone(milestoneId);
    if (!milestone) { outcome = { ok: false, reason: "milestone-not-found" }; return; }
    const canonicalAuthority = getDbOrNull()!.prepare(`
      SELECT 1 FROM workflow_item_lifecycles
      WHERE milestone_id = :milestone_id
      LIMIT 1
    `).get({ ":milestone_id": milestoneId });
    if (canonicalAuthority) {
      outcome = { ok: false, reason: "canonical-authority-present" };
      return;
    }
    if (!isClosedStatus(milestone.status)) { outcome = { ok: false, reason: "milestone-not-closed", status: milestone.status }; return; }

    getDbOrNull()!.prepare(
      `UPDATE milestones SET status = 'active', completed_at = NULL WHERE id = :mid`,
    ).run({ ":mid": milestoneId });
    if (keepCompleted) {
      outcome = { ok: true, slicesReset: 0, tasksReset: 0 };
      return;
    }

    const slices = getMilestoneSlices(milestoneId);
    getDbOrNull()!.prepare(
      `UPDATE slices SET status = 'in_progress', completed_at = NULL WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    const tasksResult = getDbOrNull()!.prepare(
      `UPDATE tasks SET status = 'pending', completed_at = NULL WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    const tasksReset = (tasksResult as { changes?: number }).changes ?? 0;
    outcome = { ok: true, slicesReset: slices.length, tasksReset };
  });
  return outcome;
}
