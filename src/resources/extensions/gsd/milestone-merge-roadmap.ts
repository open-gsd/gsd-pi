// Project/App: gsd-pi
// File Purpose: Resolve milestone ROADMAP content for closeout merge when projection is missing.

import { getMilestone, getMilestoneSlices, isDbAvailable } from "./gsd-db.js";
import { resolveMilestoneFile } from "./paths.js";
import { renderRoadmapContent, renderRoadmapProjection } from "./workflow-projections.js";

export interface MilestoneMergeRoadmapResolution {
  content: string;
  synthesized: boolean;
}

/**
 * Resolve ROADMAP markdown for milestone merge.
 *
 * Closeout merge previously required an on-disk ROADMAP projection. Milestones
 * completed from slice-level planning can be DB-complete while the milestone
 * ROADMAP file was never rendered — leaving the branch stranded even though
 * slice rows and product commits exist. Synthesize from DB in that case.
 */
export function resolveRoadmapForMilestoneMerge(
  searchPaths: string[],
  milestoneId: string,
  readContent: (path: string) => string,
): MilestoneMergeRoadmapResolution | null {
  const seen = new Set<string>();
  for (const basePath of searchPaths) {
    if (!basePath || seen.has(basePath)) continue;
    seen.add(basePath);

    const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    if (roadmapPath) {
      return { content: readContent(roadmapPath), synthesized: false };
    }
  }

  if (!isDbAvailable()) return null;

  const milestone = getMilestone(milestoneId);
  if (!milestone) return null;

  const slices = getMilestoneSlices(milestoneId);
  if (slices.length === 0) return null;

  const persistBase = searchPaths.find(Boolean);
  if (persistBase) {
    try {
      renderRoadmapProjection(persistBase, milestoneId);
    } catch {
      // Best-effort persistence; merge can proceed with in-memory content.
    }
  }

  return {
    content: renderRoadmapContent(milestone, slices),
    synthesized: true,
  };
}
