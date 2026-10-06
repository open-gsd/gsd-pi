// Project/App: gsd-pi
// File Purpose: Test helpers to seed and read a unit's retry budgets (ADR-048).

import {
  readUnitBudget,
  spendUnitBudget,
  type UnitBudgetKind,
} from "../../db/unit-dispatch-budgets.ts";

interface BudgetSession {
  unclaimedUnitBudgets: Map<string, number>;
}

/** The count the unit has used of the budget kind (default: verification retries). */
export function usedUnitBudget(
  s: BudgetSession,
  unitType: string,
  unitId: string,
  kind: UnitBudgetKind = "verification",
): number {
  return readUnitBudget(s.unclaimedUnitBudgets, { unitType, unitId, kind });
}

/** Use `count` retries of the budget kind, as `count` failed runs of the unit do. */
export function useUnitBudget(
  s: BudgetSession,
  unitType: string,
  unitId: string,
  count: number,
  kind: UnitBudgetKind = "verification",
): void {
  for (let used = 0; used < count; used++) {
    spendUnitBudget(s.unclaimedUnitBudgets, { unitType, unitId, kind });
  }
}
