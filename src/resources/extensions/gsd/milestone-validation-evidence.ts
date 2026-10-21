// Project/App: gsd-pi
// File Purpose: Forwarded validation evidence rules for milestone validation.

import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { getArtifact, getMilestone, getMilestoneSlices, getSliceRunUatAssessment } from "./gsd-db.js";
import { loadFile } from "./files.js";
import { resolveGsdPathContract, resolveSliceFile } from "./paths.js";
import {
  browserTimelineHasNavigateAndAssert,
  compactTextParts,
  hasBrowserEvidenceText,
  hasPassedStructuredBrowserUatEvidenceText,
  hasBrowserRequiredText,
} from "./browser-evidence.js";

export interface MilestoneValidationEvidenceParams {
  milestoneId: string;
  verdict: "pass" | "needs-attention" | "needs-remediation";
  successCriteriaChecklist: string;
  verificationClasses?: string;
  verdictRationale: string;
  remediationPlan?: string;
  verificationEvidence?: Array<{
    verificationClass?: string;
    evidenceClass?: string;
    commandOrTool?: string;
    observation?: string;
    sliceId?: string;
  }>;
}

function verificationIsPlanned(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[.\s]+$/, "");
  return Boolean(normalized) && !/^(?:none|n\/?a|not[\s_-]+(?:applicable|required|needed|provided))\b/.test(normalized);
}

function hasExplicitBrowserAcceptance(text: string): boolean {
  return /\b(?:browser(?:_[a-z_]+)?|playwright|chrome|screenshot|snapshot)\b/i.test(text) &&
    hasBrowserRequiredText(text);
}

export function browserEvidenceRequired(
  params: MilestoneValidationEvidenceParams,
): boolean {
  const milestone = getMilestone(params.milestoneId);
  const slices = getMilestoneSlices(params.milestoneId);
  const plannedVerification = [
    milestone?.verification_contract,
    milestone?.verification_integration,
    milestone?.verification_operational,
    milestone?.verification_uat,
  ].some(verificationIsPlanned);
  const uatOrBrowserPlanned = verificationIsPlanned(milestone?.verification_uat);
  const sliceAcceptanceRequiresBrowser = slices.some((slice) =>
    hasExplicitBrowserAcceptance(slice.success_criteria ?? ""),
  );

  // Once a milestone declares its verification classes, browser reachability
  // in a demo or endpoint description is not itself a UI acceptance contract.
  // Contract-only API/SSE milestones stay on their declared verification path.
  if (plannedVerification && !uatOrBrowserPlanned && !sliceAcceptanceRequiresBrowser) {
    return false;
  }
  return hasBrowserRequiredText(compactTextParts([
    milestone?.vision,
    milestone?.success_criteria,
    milestone?.verification_uat,
    ...slices.flatMap((slice) => [slice.demo, slice.goal, slice.success_criteria]),
  ]));
}

function browserEvidenceRefs(text: string): string[] {
  return [...text.matchAll(/\bbrowser:([^\s|<>]+)/gi)].map((match) => match[1]!).filter(Boolean);
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function referencedBrowserTimelinePasses(basePath: string, evidenceText: string): boolean {
  const contract = resolveGsdPathContract(basePath);
  const projectRoots = [...new Set([contract.workRoot, contract.projectRoot])];
  const approvedRoots = projectRoots.map((root) => resolve(root, ".artifacts", "browser"));
  for (const ref of browserEvidenceRefs(evidenceText)) {
    const candidates = isAbsolute(ref)
      ? [resolve(ref)]
      : projectRoots.map((root) => resolve(root, ref));
    for (const candidate of candidates) {
      try {
        const realCandidate = realpathSync(candidate);
        const insideApprovedRoot = approvedRoots.some((root) => {
          try {
            return pathIsWithin(realpathSync(root), realCandidate);
          } catch {
            return false;
          }
        });
        if (!insideApprovedRoot) continue;
        if (browserTimelineHasNavigateAndAssert(JSON.parse(readFileSync(realCandidate, "utf8")))) return true;
      } catch {
        // Missing or malformed evidence cannot satisfy the gate.
      }
    }
  }
  return false;
}

function persistedBrowserEvidencePasses(basePath: string, evidenceText: string): boolean {
  return hasPassedStructuredBrowserUatEvidenceText(evidenceText) ||
    referencedBrowserTimelinePasses(basePath, evidenceText);
}

export function hasRuntimeExecutableUatEvidenceText(text: string): boolean {
  if (!/\buatType:\s*runtime-executable\b/i.test(text)) return false;
  if (!/\bverdict:\s*PASS\b/i.test(text)) return false;
  return /^\|\s*[^|\n]+\s*\|\s*runtime\s*\|\s*PASS\s*\|[^|\n]*\bgsd_uat_exec\b/mi.test(text);
}

export async function browserEvidenceGateRequiresAttention(
  params: MilestoneValidationEvidenceParams,
  basePath: string,
  options?: { structuredOnly?: boolean },
): Promise<boolean> {
  if (params.verdict !== "pass") return false;
  if (!browserEvidenceRequired(params)) return false;
  const slices = getMilestoneSlices(params.milestoneId);

  const sliceEvidencePairs: Array<{ sliceId: string; sliceRequirementText: string; evidenceText: string }> = [];
  for (const slice of slices) {
    const chunks: string[] = [];
    const runUatAssessment = getSliceRunUatAssessment(params.milestoneId, slice.id);
    if (runUatAssessment?.fullContent) chunks.push(runUatAssessment.fullContent);
    const artifactPath = `milestones/${params.milestoneId}/slices/${slice.id}/${slice.id}-ASSESSMENT.md`;
    const artifact = getArtifact(artifactPath);
    if (artifact?.full_content) chunks.push(artifact.full_content);
    const assessmentPath = resolveSliceFile(basePath, params.milestoneId, slice.id, "ASSESSMENT");
    const assessmentContent = assessmentPath ? await loadFile(assessmentPath) : null;
    if (assessmentContent) chunks.push(assessmentContent);
    sliceEvidencePairs.push({
      sliceId: slice.id,
      sliceRequirementText: compactTextParts([slice.demo, slice.goal, slice.success_criteria]),
      evidenceText: chunks.join("\n\n"),
    });
  }

  if (options?.structuredOnly) {
    const qualifyingEvidence = (params.verificationEvidence ?? []).filter((evidence) =>
      evidence.verificationClass === "UAT" &&
      evidence.observation === "passed" && (
        evidence.evidenceClass === "browser" ||
        (
          evidence.evidenceClass === "runtime" &&
          /\bgsd_uat_exec\b/i.test(evidence.commandOrTool ?? "")
        )
      )
    );
    const browserRequiringSlices = sliceEvidencePairs.filter((slice) =>
      hasBrowserRequiredText(slice.sliceRequirementText),
    );
    if (browserRequiringSlices.length === 0) {
      return qualifyingEvidence.length === 0 &&
        !sliceEvidencePairs.some((slice) => persistedBrowserEvidencePasses(basePath, slice.evidenceText));
    }
    return browserRequiringSlices.some((slice) =>
      !qualifyingEvidence.some((evidence) => evidence.sliceId === slice.sliceId) &&
      !persistedBrowserEvidencePasses(basePath, slice.evidenceText)
    );
  }

  const browserRequiringSlices = sliceEvidencePairs.filter((slice) =>
    hasBrowserRequiredText(slice.sliceRequirementText),
  );
  const runtimeBypasses =
    browserRequiringSlices.length > 0
      ? browserRequiringSlices.every((slice) => hasRuntimeExecutableUatEvidenceText(slice.evidenceText))
      : sliceEvidencePairs.some((slice) => hasRuntimeExecutableUatEvidenceText(slice.evidenceText));
  if (runtimeBypasses) return false;

  const structuredBrowserPasses =
    browserRequiringSlices.length > 0
      ? browserRequiringSlices.every((slice) =>
          persistedBrowserEvidencePasses(basePath, slice.evidenceText)
        )
      : sliceEvidencePairs.some((slice) =>
          persistedBrowserEvidencePasses(basePath, slice.evidenceText)
        );
  if (structuredBrowserPasses) return false;

  const persistedEvidence = sliceEvidencePairs.map((slice) => slice.evidenceText).join("\n\n");
  const validationEvidence = compactTextParts([
    params.successCriteriaChecklist,
    params.verificationClasses,
    params.verdictRationale,
    params.remediationPlan,
  ]);
  return !hasBrowserEvidenceText(`${persistedEvidence}\n\n${validationEvidence}`);
}

export function applyBrowserEvidenceGate<T extends MilestoneValidationEvidenceParams>(
  params: T,
): Omit<T, "verdict" | "verdictRationale"> & { verdict: "needs-attention"; verdictRationale: string } {
  const note = "Browser evidence gate: Browser-observable acceptance criteria were detected, but no persisted ASSESSMENT or validation evidence recorded browser actions with assertions. Downgraded from pass to needs-attention.";
  return {
    ...params,
    verdict: "needs-attention",
    verdictRationale: params.verdictRationale.trim()
      ? `${params.verdictRationale.trim()}\n\n${note}`
      : note,
  };
}
