// Project/App: gsd-pi
// File Purpose: Classify milestone readiness from DB status, slices, and artifacts.

import type { Phase } from "./types.js";
import { getMilestone, getMilestoneSlices } from "./gsd-db.js";

export type MilestoneReadinessKind =
  | "queued-shell"
  | "needs-discussion"
  | "planning-pending"
  | "executable-plan"
  | "terminal";

export interface MilestoneReadiness {
  kind: MilestoneReadinessKind;
  hasContext: boolean;
  hasDraftContext: boolean;
  hasExecutablePlan: boolean;
}

export interface MilestoneReadinessInput {
  status?: string | null;
  hasContext?: boolean;
  hasDraftContext?: boolean;
  hasSummary?: boolean;
  sliceCount?: number;
}

export interface HandoffReadinessInput {
  milestoneId: string;
  hasContext: boolean;
}

export function classifyMilestoneReadiness(input: MilestoneReadinessInput): MilestoneReadiness {
  const hasContext = input.hasContext === true;
  const hasDraftContext = !hasContext && input.hasDraftContext === true;
  const hasSummary = input.hasSummary === true;
  const sliceCount = input.sliceCount ?? 0;
  const hasExecutablePlan = sliceCount > 0;
  const status = input.status ?? null;

  if (status === "complete" || hasSummary) {
    return { kind: "terminal", hasContext, hasDraftContext, hasExecutablePlan };
  }

  if (status === "queued" && !hasContext && sliceCount === 0) {
    return { kind: "queued-shell", hasContext, hasDraftContext, hasExecutablePlan };
  }

  if ((status === "needs-discussion" && !hasContext) || hasDraftContext) {
    return { kind: "needs-discussion", hasContext, hasDraftContext, hasExecutablePlan };
  }

  if (hasExecutablePlan) {
    return { kind: "executable-plan", hasContext, hasDraftContext, hasExecutablePlan };
  }

  return { kind: "planning-pending", hasContext, hasDraftContext, hasExecutablePlan };
}

export function readinessNeedsDiscussion(readiness: MilestoneReadiness): boolean {
  return readiness.kind === "needs-discussion" ||
    (readiness.kind === "queued-shell" && readiness.hasDraftContext);
}

export function describeMilestoneReadinessPhase(
  phase: Phase,
): { label: string; description: string } | null {
  switch (phase) {
    case "needs-discussion":
      return {
        label: "Discuss milestone draft",
        description: "Milestone has a draft context — needs discussion before planning.",
      };
    case "pre-planning":
      return {
        label: "Research & plan milestone",
        description: "Scout the landscape and create the roadmap.",
      };
    default:
      return null;
  }
}

/** Readiness reads DB rows only; the caller has already required an open DB. */
export function assessMilestoneHandoffReadiness(
  input: HandoffReadinessInput,
): MilestoneReadiness {
  return classifyMilestoneReadiness({
    status: getMilestone(input.milestoneId)?.status,
    hasContext: input.hasContext,
    sliceCount: getMilestoneSlices(input.milestoneId).length,
  });
}

export function formatAcceptedDiscussHandoffMessage(
  milestoneId: string,
  readiness: MilestoneReadiness,
): string {
  if (readiness.hasExecutablePlan) return `Milestone ${milestoneId} ready.`;
  if (readiness.hasContext) {
    return `Milestone ${milestoneId} context captured. Continuing the planning pipeline.`;
  }
  return `Milestone ${milestoneId} planning artifacts captured. Continuing the planning pipeline.`;
}
