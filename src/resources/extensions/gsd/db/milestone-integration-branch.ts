// Project/App: gsd-pi
// File Purpose: Database record of the branch each milestone merges back to.

import { getDbOrNull } from "./engine.js";

/**
 * The recorded integration branch, `null` when the milestone has no row, or
 * `undefined` when no database is open.
 */
export function getRecordedIntegrationBranch(milestoneId: string): string | null | undefined {
  const db = getDbOrNull();
  if (!db) return undefined;
  const row = db.prepare(`
    SELECT integration_branch FROM milestone_integration_branches WHERE milestone_id = :milestone_id
  `).get({ ":milestone_id": milestoneId });
  return typeof row?.["integration_branch"] === "string" ? row["integration_branch"] : null;
}

/** Record the integration branch. No-op when no database is open. */
export function recordIntegrationBranch(milestoneId: string, branch: string): void {
  getDbOrNull()?.prepare(`
    INSERT INTO milestone_integration_branches (milestone_id, integration_branch, updated_at)
    VALUES (:milestone_id, :integration_branch, :updated_at)
    ON CONFLICT (milestone_id) DO UPDATE SET
      integration_branch = excluded.integration_branch,
      updated_at = excluded.updated_at
  `).run({
    ":milestone_id": milestoneId,
    ":integration_branch": branch,
    ":updated_at": new Date().toISOString(),
  });
}
