// Project/App: gsd-pi
// File Purpose: Milestone closeout settlement state across DB proof, artifacts, merge, and cleanup.

import { isInAutoWorktree } from "./auto-worktree-entry.js";
import {
  formatCloseoutProofBlock,
  proveMilestoneCloseout,
} from "./milestone-closeout-proof.js";
import { resolveCloseoutArtifactProjection } from "./artifact-projection.js";

export type MilestoneSettlementOutcome =
  | { ok: true; reason: "settled" | "not-applicable" }
  | {
      ok: false;
      reason: "closeout-blocked" | "merge-pending";
      action: "pause";
      message: string;
      nextAction: string;
      milestoneId: string;
    };

export interface MilestoneSettlementInput {
  milestoneId: string | null | undefined;
  statePhase: string;
  basePath: string;
  originalBasePath: string;
  milestoneMerged: boolean;
}

function isActiveUnmergedWorktree(input: MilestoneSettlementInput): boolean {
  if (!input.milestoneId || input.milestoneMerged) return false;
  return isInAutoWorktree(input.basePath);
}

export function evaluateAllCompleteSettlement(
  input: MilestoneSettlementInput,
): MilestoneSettlementOutcome {
  if (input.statePhase !== "complete") {
    return { ok: true, reason: "not-applicable" };
  }
  if (!isActiveUnmergedWorktree(input)) {
    return { ok: true, reason: "settled" };
  }

  const milestoneId = input.milestoneId;
  if (!milestoneId) {
    return { ok: true, reason: "settled" };
  }

  const projection = resolveCloseoutArtifactProjection({
    milestoneId,
    basePath: input.basePath,
    originalBasePath: input.originalBasePath,
  });
  const proof = proveMilestoneCloseout(milestoneId, {
    refreshFromDisk: true,
    summaryArtifactBasePath: projection.summaryArtifactBasePath,
  });

  if (!proof.ok) {
    return {
      ok: false,
      reason: "closeout-blocked",
      action: "pause",
      message: `${formatCloseoutProofBlock(proof)} The milestone branch has not been merged to main.`,
      nextAction: `Resolve closeout blockers, then retry \`/gsd dispatch complete-milestone ${milestoneId}\`.`,
      milestoneId,
    };
  }

  return {
    ok: false,
    reason: "merge-pending",
    action: "pause",
    message:
      `Milestone ${milestoneId} is complete, but its worktree branch has not been merged to main. ` +
      `Retry with \`/gsd dispatch complete-milestone ${milestoneId}\` to finish the system-owned merge.`,
    nextAction: `Retry \`/gsd dispatch complete-milestone ${milestoneId}\`.`,
    milestoneId,
  };
}
