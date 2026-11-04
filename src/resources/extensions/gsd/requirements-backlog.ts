// Project/App: gsd-pi
// File Purpose: Shared helpers for surfacing unmapped active requirements at project completion.

import { join } from "node:path";
import { existsSync } from "node:fs";

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { showNextAction } from "../shared/next-action-ui.js";
import { isInteractiveCommandContext } from "./command-feedback.js";
import { getActiveRequirements } from "./gsd-db.js";
import type { GSDState, Requirement } from "./types.js";

export interface RequirementsCoverageSummary {
  active: number;
  unmappedActive: number;
  mappedToSlice: number;
  unmappedActiveRequirements: Requirement[];
}

const MILESTONE_OWNER_RE = /^M\d/i;
const SLICE_OWNER_RE = /^M\d+[^/]*\/S\d/i;

/** True when primary_owner points at a milestone (including provisional `M###/none yet`). */
export function isRequirementMappedToMilestone(primaryOwner: string | null | undefined): boolean {
  const owner = (primaryOwner ?? "").trim();
  if (!owner || owner.toLowerCase() === "none") return false;
  return MILESTONE_OWNER_RE.test(owner);
}

/** True when primary_owner names a concrete slice (`M###/S##`). */
export function isRequirementMappedToSlice(primaryOwner: string | null | undefined): boolean {
  const owner = (primaryOwner ?? "").trim();
  if (!owner) return false;
  return SLICE_OWNER_RE.test(owner);
}

export function summarizeRequirementsCoverage(requirements: Requirement[]): RequirementsCoverageSummary {
  const activeRequirements = requirements.filter((req) => req.status?.toLowerCase() === "active");
  const unmappedActiveRequirements = activeRequirements.filter(
    (req) => !isRequirementMappedToMilestone(req.primary_owner),
  );
  const mappedToSlice = activeRequirements.filter(
    (req) => isRequirementMappedToSlice(req.primary_owner),
  ).length;

  return {
    active: activeRequirements.length,
    unmappedActive: unmappedActiveRequirements.length,
    mappedToSlice,
    unmappedActiveRequirements,
  };
}

export function getUnmappedActiveRequirements(): Requirement[] {
  return summarizeRequirementsCoverage(getActiveRequirements()).unmappedActiveRequirements;
}

export function countUnmappedActiveRequirements(): number {
  return getUnmappedActiveRequirements().length;
}

export function formatCompletePhaseNextAction(unmappedActiveCount: number): string {
  if (unmappedActiveCount <= 0) return "All milestones complete.";
  return `All milestones complete. ${unmappedActiveCount} active requirement${unmappedActiveCount === 1 ? "" : "s"} in REQUIREMENTS.md ${unmappedActiveCount === 1 ? "has" : "have"} not been mapped to a milestone.`;
}

export function buildRequirementsBacklogSummaryLines(
  unmappedCount: number,
  sample: Requirement[],
  maxSample = 3,
): string[] {
  if (unmappedCount <= 0) return [];

  const lines = [
    `${unmappedCount} active requirement${unmappedCount === 1 ? "" : "s"} still need milestone ownership — see REQUIREMENTS.md traceability table.`,
  ];

  for (const req of sample.slice(0, maxSample)) {
    const description = req.description.trim();
    const clipped = description.length > 80 ? `${description.slice(0, 80)}…` : description;
    lines.push(`  • ${req.id}: ${clipped || "(no description)"}`);
  }

  if (unmappedCount > maxSample) {
    lines.push(`  • …and ${unmappedCount - maxSample} more`);
  }

  return lines;
}

export function formatRequirementsTraceabilityPreview(
  requirements: Requirement[],
  limit = 12,
): string[] {
  const lines: string[] = [];
  for (const req of requirements.slice(0, limit)) {
    const owner = req.primary_owner?.trim() || "none";
    const proof = req.validation?.trim() || "unmapped";
    lines.push(`  ${req.id} · ${owner} · ${proof} · ${req.description.trim() || "(no description)"}`);
  }
  if (requirements.length > limit) {
    lines.push(`  …and ${requirements.length - limit} more`);
  }
  return lines;
}

export function appendRequirementsBacklogToSummary(
  state: GSDState,
  summary: string[],
  maxSample = 3,
): string[] {
  if (state.phase !== "complete") return summary;
  const unmapped = getUnmappedActiveRequirements();
  if (unmapped.length === 0) return summary;
  return [...summary, ...buildRequirementsBacklogSummaryLines(unmapped.length, unmapped, maxSample)];
}

export type RequirementsBacklogReviewChoice = "new_milestone" | "not_yet";

/** Prompt block injected into discuss-milestone when mapping backlog requirements. */
export function buildRequirementsBacklogDiscussContext(milestoneId: string): string {
  const unmapped = getUnmappedActiveRequirements();
  if (unmapped.length === 0) return "";

  const lines = [
    "## Requirements Backlog — Milestone Ownership",
    "",
    `${unmapped.length} active requirement${unmapped.length === 1 ? "" : "s"} still lack milestone ownership.`,
    `This discuss pass for **${milestoneId}** must assign ownership for requirements that belong in this milestone.`,
    "",
    "Unmapped active requirements:",
    ...formatRequirementsTraceabilityPreview(unmapped, 20),
    "",
    "During this milestone discuss:",
    "1. Read `.gsd/REQUIREMENTS.md` and confirm with the user which of these requirements belong in this milestone.",
    `2. For each requirement assigned here, call \`gsd_requirement_update\` with \`primary_owner: "${milestoneId}/none yet"\` (provisional until slice planning) or \`${milestoneId}/S##\` when slice ownership is already clear.`,
    '3. After updates, call `gsd_summary_save` with `artifact_type: "REQUIREMENTS"` so `.gsd/REQUIREMENTS.md` reflects the new ownership.',
    "4. Do not leave in-scope requirements with `primary_owner: none`.",
    "",
    "Requirements that do not belong in this milestone stay unmapped for a later milestone.",
  ];

  return lines.join("\n");
}

export async function showRequirementsBacklogReview(
  ctx: ExtensionCommandContext,
  basePath: string,
): Promise<RequirementsBacklogReviewChoice> {
  const unmapped = getUnmappedActiveRequirements();
  const requirementsPath = join(basePath, ".gsd", "REQUIREMENTS.md");
  const summary = [
    `${unmapped.length} active requirement${unmapped.length === 1 ? "" : "s"} still need milestone ownership.`,
    "Assign owners during the next milestone discuss/plan pass, or edit REQUIREMENTS.md directly.",
    "",
    "Unmapped active requirements:",
    ...formatRequirementsTraceabilityPreview(unmapped, 12),
  ];

  if (!isInteractiveCommandContext(ctx)) {
    ctx.ui.notify(
      [...summary, existsSync(requirementsPath) ? `Full traceability: ${requirementsPath}` : ""]
        .filter(Boolean)
        .join("\n"),
      "info",
    );
    return "not_yet";
  }

  const choice = await showNextAction(ctx, {
    title: "Requirements backlog",
    summary,
    files: existsSync(requirementsPath) ? [requirementsPath] : undefined,
    actions: [
      {
        id: "new_milestone",
        label: "Start new milestone",
        description: "Open discuss-milestone for the next milestone and map these requirements.",
        recommended: true,
      },
    ],
    notYetMessage: "Review REQUIREMENTS.md when ready.",
  });

  return choice === "new_milestone" ? "new_milestone" : "not_yet";
}
