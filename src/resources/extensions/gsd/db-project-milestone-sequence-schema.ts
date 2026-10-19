// Project/App: gsd-pi
// File Purpose: Table that holds the Milestone Sequence of the PROJECT artifact as rows.

import type { DbAdapter } from "./db-adapter.js";
import { backfillProjectMilestoneSequence } from "./db/writers/project-milestone-sequence.js";

export function hasProjectMilestoneSequenceSchema(db: DbAdapter): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'project_milestone_sequence'",
  ).get() !== undefined;
}

/**
 * ADR-046: the milestones a project committed to are rows. PROJECT.md text is
 * not parsed to decide which queued milestone is promoted. A database that
 * gets the table here fills it once from its stored PROJECT artifact row.
 * Idempotent.
 */
export function createProjectMilestoneSequenceSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_milestone_sequence (
      milestone_id TEXT PRIMARY KEY,
      position INTEGER NOT NULL
    )
  `);
  backfillProjectMilestoneSequence(db);
}
