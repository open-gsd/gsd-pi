// Project/App: gsd-pi
// File Purpose: Enforce active decisions-register rules at gsd_plan_task / gsd_replan_task write time (#2248).

import { deriveSliceScope } from "./slice-scope.js";
import { queryDecisionsFromMemories } from "./context-store.js";
import { getSlice } from "./gsd-db.js";
import type { Decision } from "./types.js";
import { assertVerifyIsShellCheckable, validateVerificationCommand } from "./verification-gate.js";

const VERIFY_DECISION_SCOPE_RE = /verify/i;
const VERIFY_DECISION_TEXT_RE = /\bverify\b/i;

/** Whether a decision governs the task `verify` field. */
export function isVerifyFieldDecision(decision: Decision): boolean {
  return VERIFY_DECISION_SCOPE_RE.test(decision.scope)
    || VERIFY_DECISION_TEXT_RE.test(decision.decision)
    || VERIFY_DECISION_TEXT_RE.test(decision.choice);
}

function uniqueDecisions(decisions: readonly Decision[]): Decision[] {
  const byId = new Map<string, Decision>();
  for (const decision of decisions) {
    byId.set(decision.id, decision);
  }
  return [...byId.values()];
}

/** Active verify-field decisions visible to a planning write for this milestone/slice. */
export function activeVerifyFieldDecisions(
  milestoneId: string,
  sliceScope?: string,
): Decision[] {
  const milestoneDecisions = queryDecisionsFromMemories({ milestoneId });
  const scopedDecisions = sliceScope
    ? queryDecisionsFromMemories({ milestoneId, scope: sliceScope })
    : [];
  return uniqueDecisions([...milestoneDecisions, ...scopedDecisions])
    .filter(isVerifyFieldDecision);
}

export function derivePlanningDecisionScope(
  milestoneId: string,
  sliceId: string,
): string | undefined {
  const slice = getSlice(milestoneId, sliceId);
  if (!slice) return undefined;
  const sliceDescription = slice.goal || slice.demo;
  return deriveSliceScope(slice.title, sliceDescription || undefined);
}

function formatDecisionCitation(decisions: readonly Decision[]): string {
  return decisions.map((decision) => `${decision.id} (${decision.scope})`).join(", ");
}

/**
 * When verify-field decisions are active for this milestone, re-validate the
 * planned verify command and cite the governing decision ids on failure.
 * Returns null when the verify field satisfies all active verify decisions.
 */
export function validateVerifyAgainstActiveDecisions(
  verify: string,
  milestoneId: string,
  sliceScope?: string,
): string | null {
  const decisions = activeVerifyFieldDecisions(milestoneId, sliceScope);
  if (decisions.length === 0) return null;

  try {
    assertVerifyIsShellCheckable(verify);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `verify violates active decision(s) ${formatDecisionCitation(decisions)}: ${message}`;
  }

  const validation = validateVerificationCommand(verify);
  if (!validation.ok) {
    return `verify violates active decision(s) ${formatDecisionCitation(decisions)}: ${validation.reason}`;
  }

  return null;
}
