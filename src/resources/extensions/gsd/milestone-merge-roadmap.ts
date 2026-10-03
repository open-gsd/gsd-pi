// Project/App: gsd-pi
// File Purpose: Resolve milestone ROADMAP content for closeout merge from database rows.

import { getMilestoneSlices, isDbAvailable } from "./gsd-db.js";
import { renderRoadmapContentFromDb } from "./markdown-renderer.js";
import { resolveMilestoneFile } from "./paths.js";

/**
 * Resolve ROADMAP markdown for milestone merge.
 *
 * The database is the authority: when it holds slice rows for the milestone,
 * the content is rendered from those rows and no ROADMAP file is read. A
 * ROADMAP file is used only when the database has no slice rows for the
 * milestone (or is unavailable).
 */
export function resolveRoadmapForMilestoneMerge(
  searchPaths: string[],
  milestoneId: string,
  readContent: (path: string) => string,
): string | null {
  if (isDbAvailable() && getMilestoneSlices(milestoneId).length > 0) {
    const content = renderRoadmapContentFromDb(milestoneId);
    if (content) return content;
  }

  const seen = new Set<string>();
  for (const basePath of searchPaths) {
    if (!basePath || seen.has(basePath)) continue;
    seen.add(basePath);

    const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    if (roadmapPath) return readContent(roadmapPath);
  }
  return null;
}
