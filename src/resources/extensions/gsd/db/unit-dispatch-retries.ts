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
// Each retry of a unit opens a new dispatch row, so the rows of the earlier
// dispatches are the failure history of the unit. The duplicate-failure check
// reads the retry before the current one from that history.
//
// State derivation selects a unit again when its verification failed, because
// the unit is not complete. Two retries are for a unit that state derivation
// does not select again, so the dispatch rules select the unit by the row:
// - a pre-execution retry (signature `pre-execution:`): the planner saved a
//   plan, and the pre-execution check refused it;
// - a git-commit repair retry (signature `git-commit:`): the task is closed,
//   and the commit hook refused its changes.
// The check that stored such a row releases it. A verification gate that
// clears the retry state of the unit does not.
//
// A unit that runs with no dispatch row has no durable identity. Nothing is
// stored for it and the caller keeps the failure context in session memory.
//
// See the 2026-10-04 amendments in ADR-048.

import { _getAdapter, isDbAvailable } from "../gsd-db.js";
import type { PendingVerificationRetry } from "../auto/session.js";
import {
  deleteUnitDispatchRetries,
  deleteUnitVerificationRetries,
  setDispatchRetry,
} from "./unit-dispatches.js";

interface StoredRetryRow {
  unit_id: string;
  failure_context: string;
  signature: string | null;
  attempt: number;
}

const STORED_RETRY = `SELECT dispatch.unit_id AS unit_id,
            retry.failure_context AS failure_context,
            retry.signature AS signature,
            retry.attempt AS attempt
     FROM unit_dispatch_retries retry
     JOIN unit_dispatches dispatch ON dispatch.id = retry.dispatch_id`;

function toRetry(row: StoredRetryRow | undefined): PendingVerificationRetry | null {
  if (!row) return null;
  return {
    unitId: row.unit_id,
    failureContext: row.failure_context,
    ...(row.signature ? { signature: row.signature } : {}),
    attempt: row.attempt,
  };
}

/** Store the retry on the newest dispatch row of the unit. */
export function storeUnitRetry(unitType: string, retry: PendingVerificationRetry): void {
  if (!isDbAvailable()) return;
  const row = _getAdapter()!.prepare(
    `SELECT id FROM unit_dispatches
     WHERE unit_type = :unit_type AND unit_id = :unit_id
     ORDER BY id DESC
     LIMIT 1`,
  ).get({ ":unit_type": unitType, ":unit_id": retry.unitId }) as { id: number } | undefined;
  if (row) setDispatchRetry(row.id, retry);
}

/** The stored retry of the unit, or null when it has none. */
export function readStoredUnitRetry(unitType: string, unitId: string): PendingVerificationRetry | null {
  if (!isDbAvailable()) return null;
  return toRetry(_getAdapter()!.prepare(
    `${STORED_RETRY}
     WHERE dispatch.unit_type = :unit_type AND dispatch.unit_id = :unit_id
     ORDER BY dispatch.id DESC
     LIMIT 1`,
  ).get({ ":unit_type": unitType, ":unit_id": unitId }) as StoredRetryRow | undefined);
}

/**
 * The retry that an earlier dispatch of the unit stored: the failure before
 * the one the newest dispatch of the unit ended with. Null when there is none.
 */
export function readPreviousUnitRetry(unitType: string, unitId: string): PendingVerificationRetry | null {
  if (!isDbAvailable()) return null;
  return toRetry(_getAdapter()!.prepare(
    `${STORED_RETRY}
     WHERE dispatch.unit_type = :unit_type AND dispatch.unit_id = :unit_id
       AND dispatch.id < (
         SELECT MAX(id) FROM unit_dispatches
         WHERE unit_type = :unit_type AND unit_id = :unit_id
       )
     ORDER BY dispatch.id DESC
     LIMIT 1`,
  ).get({ ":unit_type": unitType, ":unit_id": unitId }) as StoredRetryRow | undefined);
}

/** True when the pre-execution check refused the plan of the unit and the retry is not released. */
export function hasStoredPreExecutionRetry(unitType: string, unitId: string): boolean {
  if (!isDbAvailable()) return false;
  return _getAdapter()!.prepare(
    `${STORED_RETRY}
     WHERE dispatch.unit_type = :unit_type AND dispatch.unit_id = :unit_id
       AND retry.signature LIKE 'pre-execution:%'
     LIMIT 1`,
  ).get({ ":unit_type": unitType, ":unit_id": unitId }) !== undefined;
}

/** The newest stored git-commit repair retry of a task of the slice, or null. */
export function readStoredCommitRepairRetry(
  milestoneId: string,
  sliceId: string,
): PendingVerificationRetry | null {
  if (!isDbAvailable()) return null;
  return toRetry(_getAdapter()!.prepare(
    `${STORED_RETRY}
     WHERE dispatch.unit_type = 'execute-task'
       AND substr(dispatch.unit_id, 1, length(:prefix)) = :prefix
       AND retry.signature LIKE 'git-commit:%'
     ORDER BY dispatch.id DESC
     LIMIT 1`,
  ).get({ ":prefix": `${milestoneId}/${sliceId}/` }) as StoredRetryRow | undefined);
}

/** Release every stored retry of the unit, and its failure history. */
export function releaseUnitRetry(unitType: string, unitId: string): void {
  if (isDbAvailable()) deleteUnitDispatchRetries(unitType, unitId);
}

/**
 * Release the stored retries of the unit that a verification gate made. A
 * pre-execution retry and a git-commit repair retry stay.
 */
export function releaseVerificationRetry(unitType: string, unitId: string): void {
  if (isDbAvailable()) deleteUnitVerificationRetries(unitType, unitId);
}
