// Project/App: gsd-pi
// File Purpose: Single proof surface for milestone closeout readiness/finality.

import {
  CLOSEOUT_CONSISTENCY_BLOCKED_REASON,
  checkCloseoutConsistencyGate,
  type CloseoutConsistencyFailureReason,
  type CloseoutConsistencyResult,
} from "./closeout-consistency-gate.js";
import { hasImplementationArtifacts } from "./milestone-implementation-evidence.js";

export type CloseoutProofFailureReason =
  | CloseoutConsistencyFailureReason
  | "implementation-evidence-missing";

export type ImplementationEvidenceRequirement = "present" | "not-absent";

export type CloseoutProofResult =
  | { ok: true }
  | {
      ok: false;
      reason: CloseoutProofFailureReason;
      recoveryReason: typeof CLOSEOUT_CONSISTENCY_BLOCKED_REASON;
      message: string;
    };

export interface CloseoutProofOptions {
  refreshFromDisk?: boolean;
  allowOpenMilestone?: boolean;
  /** Root of the tree the milestone ran in; the consistency gate reads it. */
  artifactBasePath?: string;
  implementationEvidence?: {
    basePath: string;
    requirement: ImplementationEvidenceRequirement;
  };
}

function blocked(reason: CloseoutProofFailureReason, message: string): CloseoutProofResult {
  return {
    ok: false,
    reason,
    recoveryReason: CLOSEOUT_CONSISTENCY_BLOCKED_REASON,
    message,
  };
}

function fromConsistencyResult(result: CloseoutConsistencyResult): CloseoutProofResult {
  if (result.ok) return result;
  return {
    ok: false,
    reason: result.reason,
    recoveryReason: result.recoveryReason,
    message: result.message,
  };
}

function checkImplementationEvidence(
  milestoneId: string,
  basePath: string,
  requirement: ImplementationEvidenceRequirement,
): CloseoutProofResult {
  const evidence = hasImplementationArtifacts(basePath, milestoneId);
  if (requirement === "present" && evidence === "present") return { ok: true };
  if (requirement === "not-absent" && evidence !== "absent") return { ok: true };

  return blocked(
    "implementation-evidence-missing",
    `Closeout proof blocked for ${milestoneId}: implementation evidence is ${evidence}.`,
  );
}

export function proveMilestoneCloseout(
  milestoneId: string,
  options: CloseoutProofOptions = {},
): CloseoutProofResult {
  const consistency = checkCloseoutConsistencyGate(milestoneId, {
    refreshFromDisk: options.refreshFromDisk,
    allowOpenMilestone: options.allowOpenMilestone,
    artifactBasePath: options.artifactBasePath,
  });
  if (!consistency.ok) return fromConsistencyResult(consistency);

  if (options.implementationEvidence) {
    const implementation = checkImplementationEvidence(
      milestoneId,
      options.implementationEvidence.basePath,
      options.implementationEvidence.requirement,
    );
    if (!implementation.ok) return implementation;
  }

  return { ok: true };
}

export function formatCloseoutProofBlock(result: CloseoutProofResult): string {
  if (result.ok) return "";
  if (result.reason === "validation-source-revision-mismatch") {
    return `${result.message} Recovery reason: ${result.recoveryReason}. Restore or remove unintended working-tree drift, or re-run milestone validation against the intended current content, then run /gsd auto.`;
  }
  if (result.reason.startsWith("implementation-")) {
    return `${result.message} Recovery reason: ${result.recoveryReason}. Resolve the closeout evidence and run /gsd auto to retry.`;
  }
  return `${result.message} Recovery reason: ${result.recoveryReason}. Resolve the canonical DB state and run /gsd auto to retry.`;
}
