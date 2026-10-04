// Project/App: gsd-pi
// File Purpose: Test fixture that saves the narrative files of a fixture project as artifact rows.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { insertArtifact } from "../gsd-db.ts";

const NARRATIVE_FILE =
  /^milestones\/([^/]+)\/(?:slices\/([^/]+)\/(?:tasks\/([^/]+?)-|\2-)|\1-)([A-Z][A-Z-]*)\.md$/;

/**
 * Save an artifact row for each narrative file of a fixture project in the
 * `.gsd/milestones/<MID>/...` layout. Prompt builders read narrative from
 * artifact rows and never from the files, so a fixture that only writes files
 * gives them nothing. The database must be open.
 */
export function saveMilestoneFilesAsArtifacts(base: string): void {
  const root = join(base, ".gsd");
  for (const entry of readdirSync(join(root, "milestones"), { recursive: true, encoding: "utf-8" })) {
    const path = `milestones/${entry.split("\\").join("/")}`;
    const match = NARRATIVE_FILE.exec(path);
    if (!match) continue;
    insertArtifact({
      path,
      artifact_type: match[4]!,
      milestone_id: match[1]!,
      slice_id: match[2] ?? null,
      task_id: match[3] ?? null,
      full_content: readFileSync(join(root, path), "utf-8"),
    });
  }
}
