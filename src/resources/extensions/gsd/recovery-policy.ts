// Project/App: gsd-pi
// File Purpose: Pure deterministic policy for Task recovery ownership, actions, and budgets.

import { createHash } from "node:crypto";

import type { RecoveryAction, RecoveryFailureKind } from "./recovery-classification.js";

export const TASK_RECOVERY_POLICY_VERSION = "task-recovery-v1" as const;

export type RecoveryOwner = "agent" | "user" | "external";
export type RecoveryPolicyClass =
  | "transient-execution"
  | "deterministic-repair"
  | "schema-correction"
  | "remediation"
  | "objective-uat";
export type HumanBlockerKind =
  | "missing_authority"
  | "missing_access"
  | "external_dependency"
  | "consent"
  | "ambiguous_intent"
  | "subjective_uat"
  | "user_limit";
export type TaskFailureKind =
  | RecoveryFailureKind
  | "transient-execution"
  | "verification-failed"
  | "objective-uat"
  | "plan-invalid"
  | "fatal";

export type RecoveryDecision =
  | {
      owner: "agent";
      action: "retry" | "repair" | "remediate";
      budget: { policyClass: RecoveryPolicyClass; maxUses: 1 | 2 };
      policyVersion: typeof TASK_RECOVERY_POLICY_VERSION;
    }
  | {
      owner: "agent";
      action: "replan" | "abort";
      budget: null;
      policyVersion: typeof TASK_RECOVERY_POLICY_VERSION;
    }
  | {
      owner: "user" | "external";
      action: "clarify" | "pause";
      blockerKind: HumanBlockerKind;
      policyVersion: typeof TASK_RECOVERY_POLICY_VERSION;
    };

export type RecoveryPolicyInput =
  | {
      owner: "agent";
      classification: {
        failureKind: TaskFailureKind;
        action?: RecoveryAction;
      };
      budgetUses: number;
      replanUses?: number;
    }
  | {
      owner: "user" | "external";
      blockerKind: HumanBlockerKind;
    };

type BudgetedRule = {
  action: "retry" | "repair" | "remediate";
  policyClass: RecoveryPolicyClass;
  maxUses: 1 | 2;
  /** Bounded retry wait schedule (#1690): exponential, capped — no unbounded waits. */
  waitMs?: readonly number[];
};

/**
 * Backoff schedule for projection-lock-transient retries (#1690): exponential,
 * capped at 30s. Attempts stay bounded by maxUses; a transient sharing
 * violation (os error 32) needs time to clear instead of an instant re-entry.
 */
export const PROJECTION_LOCK_TRANSIENT_BACKOFF_MS: readonly number[] = [
  1000, 2000, 4000, 8000, 16000, 30000,
];

const CLARIFICATION_BLOCKERS = new Set<HumanBlockerKind>([
  "ambiguous_intent",
  "consent",
  "subjective_uat",
]);

function requireCounter(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function terminalDecision(action: "replan" | "abort"): RecoveryDecision {
  return {
    owner: "agent",
    action,
    budget: null,
    policyVersion: TASK_RECOVERY_POLICY_VERSION,
  };
}

function budgetedRule(
  classification: Extract<RecoveryPolicyInput, { owner: "agent" }>["classification"],
): BudgetedRule | null {
  switch (classification.failureKind) {
    case "transient-execution":
    case "tool-unavailable":
      return { action: "retry", policyClass: "transient-execution", maxUses: 2 };
    case "projection-lock-transient":
      return {
        action: "retry",
        policyClass: "transient-execution",
        maxUses: 2,
        waitMs: PROJECTION_LOCK_TRANSIENT_BACKOFF_MS,
      };
    case "provider":
      return classification.action === "retry"
        ? { action: "retry", policyClass: "transient-execution", maxUses: 2 }
        : null;
    case "tool-schema":
      return { action: "repair", policyClass: "schema-correction", maxUses: 2 };
    case "stale-worker":
    case "worktree-invalid":
    case "reconciliation-drift":
    case "illegal-transition":
      return { action: "repair", policyClass: "deterministic-repair", maxUses: 1 };
    case "verification-drift":
    case "verification-failed":
      return { action: "remediate", policyClass: "remediation", maxUses: 2 };
    case "objective-uat":
      return { action: "retry", policyClass: "objective-uat", maxUses: 2 };
    default:
      return null;
  }
}

export function selectRecoveryDecision(input: RecoveryPolicyInput): RecoveryDecision {
  if (input.owner !== "agent") {
    if (input.owner === "external" && input.blockerKind !== "external_dependency") {
      throw new Error("external recovery requires an external_dependency blocker");
    }
    if (input.owner === "user" && input.blockerKind === "external_dependency") {
      throw new Error("external_dependency recovery requires an external owner");
    }
    return {
      owner: input.owner,
      action: CLARIFICATION_BLOCKERS.has(input.blockerKind) ? "clarify" : "pause",
      blockerKind: input.blockerKind,
      policyVersion: TASK_RECOVERY_POLICY_VERSION,
    };
  }

  requireCounter(input.budgetUses, "budgetUses");
  const replanUses = input.replanUses ?? 0;
  requireCounter(replanUses, "replanUses");
  if (input.classification.failureKind === "plan-invalid" ||
      input.classification.failureKind === "lifecycle-progression") {
    return terminalDecision(replanUses === 0 ? "replan" : "abort");
  }

  const rule = budgetedRule(input.classification);
  if (!rule || input.budgetUses >= rule.maxUses) return terminalDecision("abort");
  return {
    owner: "agent",
    action: rule.action,
    budget: { policyClass: rule.policyClass, maxUses: rule.maxUses },
    policyVersion: TASK_RECOVERY_POLICY_VERSION,
  };
}

export function normalizeFailureFingerprint(
  classification: Extract<RecoveryPolicyInput, { owner: "agent" }>["classification"],
): string {
  const kind = classification.failureKind.trim().toLowerCase();
  if (!kind) throw new Error("failureKind must not be blank");
  const identity = {
    failureKind: kind,
    action: kind === "provider" ? classification.action ?? null : null,
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
