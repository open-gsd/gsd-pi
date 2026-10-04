// Project/App: gsd-pi
// File Purpose: Table that records the integration branch of each milestone.

import type { DbAdapter } from "./db-adapter.js";

export function hasIntegrationBranchSchema(db: DbAdapter): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'milestone_integration_branches'",
  ).get() !== undefined;
}

/**
 * ADR-046: the branch a milestone merges back to is a database fact. The
 * `<MID>-META.json` file is a rendered copy; deleting it must not change the
 * merge target. This is a git coordination row (like milestone_leases), so it
 * is written outside Domain Operations. Idempotent.
 */
export function createIntegrationBranchSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS milestone_integration_branches (
      milestone_id TEXT PRIMARY KEY,
      integration_branch TEXT NOT NULL CHECK (length(trim(integration_branch)) > 0),
      updated_at TEXT NOT NULL
    )
  `);
}
