// Project/App: gsd-pi
// File Purpose: Rows of the Milestone Sequence that the PROJECT artifact commits to.
// This module must not import the engine: the schema registry calls the
// backfill while the engine opens a database.

import type { DbAdapter } from "../../db-adapter.js";
import { parseMilestoneSequence, splitH2Sections } from "../../schemas/project-sequence.js";

/** The milestone ids of the stored Milestone Sequence, in sequence order. */
export function readProjectMilestoneSequence(db: DbAdapter): string[] {
  return db.prepare(
    "SELECT milestone_id FROM project_milestone_sequence ORDER BY position",
  ).all().map((row) => String(row["milestone_id"]));
}

/**
 * Replace the stored sequence with the Milestone Sequence of a PROJECT
 * document. Call it in the transaction that stores the PROJECT artifact row,
 * so a line that leaves the sequence leaves the table.
 */
export function replaceProjectMilestoneSequence(db: DbAdapter, projectContent: string): void {
  db.prepare("DELETE FROM project_milestone_sequence").run();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO project_milestone_sequence (milestone_id, position)
    VALUES (:milestone_id, :position)
  `);
  parseMilestoneSequence(splitH2Sections(projectContent).sections).forEach((milestone, position) => {
    insert.run({ ":milestone_id": milestone.id, ":position": position });
  });
}

/**
 * A database that stored its PROJECT artifact before the table existed gets
 * its sequence rows from that artifact row. No-op when the table holds a row.
 */
export function backfillProjectMilestoneSequence(db: DbAdapter): void {
  if (db.prepare("SELECT 1 AS present FROM project_milestone_sequence LIMIT 1").get() !== undefined) return;
  const project = db.prepare("SELECT full_content FROM artifacts WHERE path = 'PROJECT.md'").get();
  if (typeof project?.["full_content"] === "string") {
    replaceProjectMilestoneSequence(db, project["full_content"]);
  }
}
