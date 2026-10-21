import { join } from "node:path";

import {
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";

export function seedMergeReadyMilestone(repo: string, milestoneId: string): void {
  closeDatabase();
  try {
    if (!openDatabase(join(repo, ".gsd", "gsd.db"))) {
      throw new Error(`Could not open canonical DB for ${milestoneId}`);
    }
    insertMilestone({ id: milestoneId, title: `${milestoneId} Test Milestone`, status: "complete" });
    insertSlice({ id: "S01", milestoneId, title: "Test Slice", status: "complete" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId, title: "Test Task", status: "complete" });
    insertAssessment({
      path: `milestones/${milestoneId}/${milestoneId}-VALIDATION.md`,
      milestoneId,
      status: "pass",
      scope: "milestone-validation",
      fullContent: "verdict: pass",
    });
  } finally {
    closeDatabase();
  }
}
