// gsd-pi + Unit retry and recovery budgets on the dispatch row (ADR-048)
//
// A budget counts the automatic retries of one kind that one unit has used.
// The count is a child row of the unit's unit_dispatches row, so a restart
// reads the count the last process wrote. A retry opens a new dispatch row for
// the same unit; the newest row of the unit that holds the kind is the count,
// and a reset writes 0 on the newest row.
//
// A unit that runs with no dispatch row (custom-engine steps, no database) has
// no durable identity. Its count stays in the caller's `unclaimed` map and
// lasts for the process only.

import { _getAdapter, isDbAvailable } from "../gsd-db.js";
import { setDispatchBudgetUsed } from "./unit-dispatches.js";

export type UnitBudgetKind = "zero-tool" | "tool-unavailable" | "pre-exec";

export interface UnitBudgetRef {
  unitType: string;
  unitId: string;
  kind: UnitBudgetKind;
}

function unclaimedKey(ref: UnitBudgetRef): string {
  return `${ref.kind}:${ref.unitType}/${ref.unitId}`;
}

function latestDispatchId(ref: UnitBudgetRef): number | null {
  if (!isDbAvailable()) return null;
  const row = _getAdapter()!.prepare(
    `SELECT id FROM unit_dispatches
     WHERE unit_type = :unit_type AND unit_id = :unit_id
     ORDER BY id DESC
     LIMIT 1`,
  ).get({ ":unit_type": ref.unitType, ":unit_id": ref.unitId }) as { id: number } | undefined;
  return row?.id ?? null;
}

function writeUnitBudget(unclaimed: Map<string, number>, ref: UnitBudgetRef, used: number): void {
  const dispatchId = latestDispatchId(ref);
  if (dispatchId === null) {
    if (used > 0) unclaimed.set(unclaimedKey(ref), used);
    else unclaimed.delete(unclaimedKey(ref));
    return;
  }
  setDispatchBudgetUsed(dispatchId, ref.kind, used);
}

/** How much of the budget the unit has used. 0 when it never spent any. */
export function readUnitBudget(unclaimed: Map<string, number>, ref: UnitBudgetRef): number {
  if (latestDispatchId(ref) === null) return unclaimed.get(unclaimedKey(ref)) ?? 0;
  const row = _getAdapter()!.prepare(
    `SELECT budget.used AS used
     FROM unit_dispatch_budgets budget
     JOIN unit_dispatches dispatch ON dispatch.id = budget.dispatch_id
     WHERE dispatch.unit_type = :unit_type
       AND dispatch.unit_id = :unit_id
       AND budget.kind = :kind
     ORDER BY dispatch.id DESC
     LIMIT 1`,
  ).get({
    ":unit_type": ref.unitType,
    ":unit_id": ref.unitId,
    ":kind": ref.kind,
  }) as { used: number } | undefined;
  return row?.used ?? 0;
}

/** Use one retry of the budget. Returns the new used count. */
export function spendUnitBudget(unclaimed: Map<string, number>, ref: UnitBudgetRef): number {
  const used = readUnitBudget(unclaimed, ref) + 1;
  writeUnitBudget(unclaimed, ref, used);
  return used;
}

/** Give the unit a full budget again. */
export function resetUnitBudget(unclaimed: Map<string, number>, ref: UnitBudgetRef): void {
  if (readUnitBudget(unclaimed, ref) > 0) writeUnitBudget(unclaimed, ref, 0);
}
