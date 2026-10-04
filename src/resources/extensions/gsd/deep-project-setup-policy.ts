import type { GSDPreferences } from "./preferences.js";
import { getProjectResearchStatus } from "./project-research-policy.js";
import {
  isSetupArtifactSaved,
  isWorkflowPreferencesCaptured,
  readResearchDecision,
} from "./project-setup-facts.js";

export type DeepProjectSetupStage =
  | "workflow-preferences"
  | "project"
  | "requirements"
  | "project-research";

export type DeepProjectSetupState =
  | { status: "not-applicable"; stage: null; reason: string }
  | { status: "complete"; stage: null; reason: string }
  | { status: "pending"; stage: DeepProjectSetupStage; reason: string }
  | { status: "blocked"; stage: DeepProjectSetupStage; reason: string };

/**
 * Resolve the deep project setup stage from database rows only. It writes
 * nothing. A saved PROJECT and REQUIREMENTS imply the workflow preferences
 * stage, so a project set up before that fact was recorded is not pending.
 * No recorded research decision means skip.
 */
export function resolveDeepProjectSetupState(
  prefs: GSDPreferences | undefined,
  basePath: string,
): DeepProjectSetupState {
  if (prefs?.planning_depth !== "deep") {
    return {
      status: "not-applicable",
      stage: null,
      reason: "Deep planning mode is not enabled.",
    };
  }

  const projectSaved = isSetupArtifactSaved("project");
  const requirementsSaved = isSetupArtifactSaved("requirements");
  if (!isWorkflowPreferencesCaptured() && !(projectSaved && requirementsSaved)) {
    return {
      status: "pending",
      stage: "workflow-preferences",
      reason: "Deep workflow preferences are not captured.",
    };
  }
  if (!projectSaved) {
    return {
      status: "pending",
      stage: "project",
      reason: "No valid PROJECT artifact is saved in the database.",
    };
  }
  if (!requirementsSaved) {
    return {
      status: "pending",
      stage: "requirements",
      reason: "No valid REQUIREMENTS artifact is saved in the database.",
    };
  }

  if (readResearchDecision() !== "research") {
    return {
      status: "complete",
      stage: null,
      reason: "Project research was skipped.",
    };
  }

  const researchStatus = getProjectResearchStatus(basePath);
  if (researchStatus.globalBlocker) {
    return {
      status: "blocked",
      stage: "project-research",
      reason:
        "Project research wrote PROJECT-RESEARCH-BLOCKER.md, so no verified research exists. Fix the blocker cause, delete the blocker, and rerun auto.",
    };
  }
  if (researchStatus.allDimensionBlockers) {
    return {
      status: "blocked",
      stage: "project-research",
      reason:
        "Project research produced only dimension blocker files, so no usable research exists. Fix the blocker cause, delete the dimension blocker files in `.gsd/research/`, and rerun auto.",
    };
  }
  if (!researchStatus.complete) {
    return {
      status: "pending",
      stage: "project-research",
      reason: researchStatus.missingDimensions.length > 0
        ? `Project research is missing dimensions: ${researchStatus.missingDimensions.join(", ")}.`
        : "Project research has not produced a verified research set.",
    };
  }

  return {
    status: "complete",
    stage: null,
    reason: "All deep project setup gates are complete.",
  };
}
