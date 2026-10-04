// gsd-pi + Stored retry decision on the dispatch row (ADR-048)
//
// When the host decides to run a unit again, the decision and the failure
// context the next run must get are a child row of the unit's unit_dispatches
// row. Advance and the unit prompt read the row, so a restart does the same
// work a live process does.
//
// The stored retry of a unit is the row on its newest dispatch that holds one.
// It stays until it is released: the next close-out of the unit asks for no
// retry, or the retry cap or the retry policy pauses auto-mode for a person. A
// new dispatch of the unit does not release it, so a process that is killed in
// the middle of the retry runs the retry again.
//
// A unit that runs with no dispatch row has no durable identity. Nothing is
// stored for it and the caller keeps the decision in session memory.
//
// Today only the pre-execution check of plan-slice and refine-slice stores a
// retry. See the second 2026-10-04 amendment in ADR-048.

import { _getAdapter, isDbAvailable } from "../gsd-db.js";
import type { PendingVerificationRetry } from "../auto/session.js";
import { deleteUnitDispatchRetries, setDispatchRetry } from "./unit-dispatches.js";

/** Store the retry on the newest dispatch row of the unit. */
export function storeUnitRetry(unitType: string, retry: PendingVerificationRetry): void {
  if (!isDbAvailable()) return;
  const row = _getAdapter()!.prepare(
    `SELECT id FROM unit_dispatches
     WHERE unit_type = :unit_type AND unit_id = :unit_id
     ORDER BY id DESC
     LIMIT 1`,
  ).get({ ":unit_type": unitType, ":unit_id": retry.unitId }) as { id: number } | undefined;
  if (row) setDispatchRetry(row.id, retry.failureContext, retry.attempt);
}

/** The stored retry of the unit, or null when it has none. */
export function readStoredUnitRetry(unitType: string, unitId: string): PendingVerificationRetry | null {
  if (!isDbAvailable()) return null;
  const row = _getAdapter()!.prepare(
    `SELECT retry.failure_context AS failure_context, retry.attempt AS attempt
     FROM unit_dispatch_retries retry
     JOIN unit_dispatches dispatch ON dispatch.id = retry.dispatch_id
     WHERE dispatch.unit_type = :unit_type AND dispatch.unit_id = :unit_id
     ORDER BY dispatch.id DESC
     LIMIT 1`,
  ).get({ ":unit_type": unitType, ":unit_id": unitId }) as
    | { failure_context: string; attempt: number }
    | undefined;
  return row ? { unitId, failureContext: row.failure_context, attempt: row.attempt } : null;
}

/** Release the stored retry of the unit. */
export function releaseUnitRetry(unitType: string, unitId: string): void {
  if (isDbAvailable()) deleteUnitDispatchRetries(unitType, unitId);
}
