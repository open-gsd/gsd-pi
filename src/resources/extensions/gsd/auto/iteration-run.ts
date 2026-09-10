// Project/App: gsd-pi
// File Purpose: Single closeout for an auto-mode iteration keyed by dispatchId + unit.

import type { UnitRef } from "./contracts.js";
import {
  settleDispatchCompleted,
  settleDispatchFailed,
} from "./workflow-dispatch-ledger.js";

export type IterationRunOutcome = "completed" | "failed" | "retry" | "canceled";

export interface IterationRun {
  dispatchId: number | null;
  unitType: string;
  unitId: string;
}

export interface SettleIterationRunDeps {
  markFailed: (dispatchId: number, details: { errorSummary: string; exitReason?: string }) => boolean;
  markCompleted: (dispatchId: number) => boolean;
  logWriteFailure: (err: unknown) => void;
  completeActiveUnit?: (unit: UnitRef) => Promise<void>;
  retryActiveUnit?: (unit: UnitRef) => Promise<void>;
  abandonActiveUnit?: (unit: UnitRef, reason: string) => Promise<void>;
}

export interface SettleIterationRunOpts {
  /** Structured exit reason recorded on the dispatch row (e.g. "timeout"). */
  exitReason?: string;
}

/**
 * Settle the durable dispatch row (when present) and clear the orchestrator
 * active-unit using the matching closeout method. Callers pass iterData /
 * observed unit identity — not a second RAM UnitRef copy.
 */
export async function settleIterationRun(
  run: IterationRun,
  outcome: IterationRunOutcome,
  reason: string,
  alreadySettled: boolean,
  deps: SettleIterationRunDeps,
  opts?: SettleIterationRunOpts,
): Promise<boolean> {
  const unit: UnitRef = { unitType: run.unitType, unitId: run.unitId };
  let settled = alreadySettled;
  if (!settled) {
    if (outcome === "completed") {
      settled = settleDispatchCompleted(run.dispatchId, deps);
    } else {
      settled = settleDispatchFailed(run.dispatchId, reason, deps, opts?.exitReason);
    }
  }

  switch (outcome) {
    case "completed":
      await deps.completeActiveUnit?.(unit);
      break;
    case "retry":
      await deps.retryActiveUnit?.(unit);
      break;
    case "failed":
      await deps.abandonActiveUnit?.(unit, reason);
      break;
    case "canceled":
      await deps.abandonActiveUnit?.(unit, reason);
      break;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`Unhandled iteration-run outcome: ${String(exhaustive)}`);
    }
  }

  return settled;
}
