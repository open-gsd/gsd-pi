// Project/App: gsd-pi
// File Purpose: Test helper that stores a milestone CONTEXT artifact row, as gsd_summary_save does.

import { insertArtifact } from "../../gsd-db.ts";

export function saveContextArtifact(milestoneId: string): void {
  insertArtifact({
    path: `milestones/${milestoneId}/${milestoneId}-CONTEXT.md`,
    artifact_type: "CONTEXT",
    milestone_id: milestoneId,
    slice_id: null,
    task_id: null,
    full_content: `# ${milestoneId} Context\n`,
  });
}
