// Project/App: gsd-pi
// File Purpose: Resolves closeout artifact projection roots across project and milestone worktrees.

import { resolveCanonicalMilestoneRoot } from "./worktree-manager.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";

export interface CloseoutArtifactProjectionInput {
  milestoneId: string;
  basePath: string;
  originalBasePath?: string;
}

export interface CloseoutArtifactProjection {
  projectRoot: string;
  canonicalMilestoneRoot: string;
  summaryArtifactBasePath: string;
  gateEvidenceBasePath: string;
}

export function resolveCloseoutArtifactProjection(
  input: CloseoutArtifactProjectionInput,
): CloseoutArtifactProjection {
  const projectRoot = resolveWorktreeProjectRoot(input.basePath, input.originalBasePath);
  const canonicalMilestoneRoot = resolveCanonicalMilestoneRoot(projectRoot, input.milestoneId);
  return {
    projectRoot,
    canonicalMilestoneRoot,
    summaryArtifactBasePath: canonicalMilestoneRoot,
    gateEvidenceBasePath: canonicalMilestoneRoot,
  };
}
