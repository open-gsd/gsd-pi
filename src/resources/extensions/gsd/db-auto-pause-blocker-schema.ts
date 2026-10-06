// Project/App: gsd-pi
// File Purpose: The link column from an open pause row to its workflow_blockers
// row (ADR-046: every human pause opens a blocker). A required-schema-feature
// column, added with no schema version bump.

import type { DbAdapter } from "./db-adapter.js";

export function hasAutoPauseBlockerColumn(db: DbAdapter): boolean {
  const columns = db.prepare(`PRAGMA table_info(auto_pauses)`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === "blocker_id");
}

export function createAutoPauseBlockerColumn(db: DbAdapter): void {
  if (hasAutoPauseBlockerColumn(db)) return;
  db.exec(`ALTER TABLE auto_pauses ADD COLUMN blocker_id TEXT`);
}
