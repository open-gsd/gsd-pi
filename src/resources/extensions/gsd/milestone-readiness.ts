// Project/App: gsd-pi
// File Purpose: Classify milestone readiness from DB status, slices, and artifacts.

// This module has no runtime import, so a reader that does not open the
// workflow database (the web project picker) can apply the same rules.

import type { Phase } from "./types.js";

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

export interface ActiveMilestoneCandidate {
  id: string;
  status: string;
  dependsOn: readonly string[];
  /** Complete. Only a done Milestone satisfies its dependents. */
  done: boolean;
  parked: boolean;
  sliceCount: number;
  hasContext: boolean;
  hasDraftContext: boolean;
}

/**
 * The one rule for the active Milestone. `milestones` are in workflow order
 * and hold no discarded Milestone. `projectSequenceIds` are the Milestone ids
 * in the PROJECT artifact roadmap sequence.
 *
 * The active Milestone is the first that is not parked, not done, has every
 * dependency done and is not a queued shell. When there is none, the first
 * *promotable* queued shell becomes active: one that has draft context
 * (discuss-milestone was started) or is in the roadmap sequence (a real stage
 * that is not planned yet). A queued shell that is neither is a phantom left
 * by gsd_milestone_generate_id; it is never promoted, because that strands the
 * user on an empty milestone (#1524).
 */
export function selectActiveMilestone<T extends ActiveMilestoneCandidate>(
  milestones: readonly T[],
  projectSequenceIds: ReadonlySet<string>,
): { milestone: T; readiness: MilestoneReadiness } | null {
  const doneIds = new Set(milestones.filter((m) => m.done && !m.parked).map((m) => m.id));
  let firstPromotableQueuedShell: { milestone: T; readiness: MilestoneReadiness } | null = null;

  for (const milestone of milestones) {
    if (milestone.parked || milestone.done) continue;
    if (milestone.dependsOn.some((dep) => !doneIds.has(dep))) continue;

    const readiness = classifyMilestoneReadiness(milestone);
    if (readiness.kind !== "queued-shell") return { milestone, readiness };

    if (!firstPromotableQueuedShell && (readiness.hasDraftContext || projectSequenceIds.has(milestone.id))) {
      firstPromotableQueuedShell = { milestone, readiness };
    }
  }

  return firstPromotableQueuedShell;
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
