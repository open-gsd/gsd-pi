// gsd-pi + Verification retry state of a unit (ADR-048)
//
// The decision to run a unit again after a failed verification, the failure
// context, and the count of retries are rows of the unit's dispatch row. This
// module is the one place that changes the three together, so the session and
// the database do not drift apart.

import { resetUnitBudget, type UnitBudgetRef } from "../db/unit-dispatch-budgets.js";
import { releaseVerificationRetry, storeUnitRetry } from "../db/unit-dispatch-retries.js";
import type { AutoSession, PendingVerificationRetry } from "./session.js";

type RetrySession = Pick<AutoSession, "pendingVerificationRetry" | "unclaimedUnitBudgets">;

/** The count of verification retries the unit has used. */
export function verificationBudget(unitType: string, unitId: string): UnitBudgetRef {
  return { unitType, unitId, kind: "verification" };
}

/**
 * Record the decision to run the unit again. The session copy serves the
 * close-out that is in progress; the dispatch row serves the next dispatch,
 * in this process or after a restart.
 */
export function setVerificationRetry(
  s: RetrySession,
  unitType: string,
  retry: PendingVerificationRetry,
): void {
  s.pendingVerificationRetry = retry;
  storeUnitRetry(unitType, retry);
}

/**
 * Forget the verification retry state of the unit: the retry decision of a
 * verification gate, its failure history, and the retry count. A pre-execution
 * retry and a git-commit repair retry stay stored; their own checks release
 * them.
 */
export function clearVerificationRetry(s: RetrySession, unitType: string, unitId: string): void {
  s.pendingVerificationRetry = null;
  resetUnitBudget(s.unclaimedUnitBudgets, verificationBudget(unitType, unitId));
  releaseVerificationRetry(unitType, unitId);
}
