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
import { runnableTaskPlanCommands } from "../verification-gate.js";
import {
  deleteUnitCommitRepairRetries,
  deleteUnitDispatchRetries,
  deleteUnitVerificationRetries,
  setDispatchRetry,
} from "./unit-dispatches.js";

interface StoredRetryRow {
  unit_id: string;
  failure_context: string;
  signature: string | null;
  attempt: number;
  verify_contract: string | null;
}

const STORED_RETRY = `SELECT dispatch.unit_id AS unit_id,
            retry.failure_context AS failure_context,
            retry.signature AS signature,
            retry.attempt AS attempt,
            retry.verify_contract AS verify_contract
     FROM unit_dispatch_retries retry
     JOIN unit_dispatches dispatch ON dispatch.id = retry.dispatch_id`;

function toRetry(row: StoredRetryRow | undefined): PendingVerificationRetry | null {
  if (!row) return null;
  return {
    unitId: row.unit_id,
    failureContext: row.failure_context,
    ...(row.signature ? { signature: row.signature } : {}),
    attempt: row.attempt,
    ...(row.verify_contract ? { verifyContract: row.verify_contract } : {}),
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

/** True when the unit holds a stored git-commit repair retry that is not released. */
export function hasStoredCommitRepairRetry(unitType: string, unitId: string): boolean {
  if (!isDbAvailable()) return false;
  return _getAdapter()!.prepare(
    `${STORED_RETRY}
     WHERE dispatch.unit_type = :unit_type AND dispatch.unit_id = :unit_id
       AND retry.signature LIKE 'git-commit:%'
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

// ── Verification contract identity (#3089) ─────────────────────────────────
//
// A verification retry is evidence about a specific Verify contract. The
// dispatch row is keyed by unit, not by contract, so a replan that replaces
// `tasks.verify` leaves the old retry on an earlier dispatch row. The retry is
// still useful evidence, but it must not be presented as the current gate
// failure. The comparison below is read-time: it works for rows written before
// this fix and after a process restart, and it keeps the historical row.

/**
 * The commands the host gate will actually run for a Task Verify field.
 * Kept behind this helper so contract comparison uses the gate's own splitter
 * rather than a second, drifting parser.
 */
function currentRunnableCommands(currentVerify: string): string[] {
  return runnableTaskPlanCommands(currentVerify).map((command) => command.trim()).filter(Boolean);
}

/**
 * A recorded verification command is obsolete when it is not one of the
 * commands the Task's current Verify contract runs. Unknown/synthetic
 * evidence is preserved: if the current field has no runnable commands, the
 * comparison cannot prove replacement and must not suppress the retry.
 */
export function isVerifyCommandSuperseded(
  recordedCommand: string | null | undefined,
  currentVerify: string | null | undefined,
): boolean {
  const recorded = recordedCommand?.trim();
  if (!recorded || !currentVerify?.trim()) return false;
  const currentCommands = currentRunnableCommands(currentVerify);
  if (currentCommands.length === 0) return false;
  return !currentCommands.some((command) => command === recorded);
}

const NON_VERIFICATION_SIGNATURE_PREFIXES = [
  "pre-execution:",
  "git-commit:",
  "closeout-refusal:",
];

/** Commands named by a failure signature (`<command>#<exit code>` per line). */
function commandsFromFailureSignature(signature: string | undefined): string[] {
  if (!signature) return [];
  if (NON_VERIFICATION_SIGNATURE_PREFIXES.some((prefix) => signature.startsWith(prefix))) return [];
  const commands: string[] = [];
  for (const line of signature.split("\n")) {
    const match = /^(.*)#(-?\d+)$/.exec(line.trim());
    if (match) commands.push(match[1].trim());
  }
  return commands;
}

/** Commands named by the rendered verification failure context. */
function commandsFromFailureContext(failureContext: string): string[] {
  const commands: string[] = [];
  const heading = /^### ❌ `([^`]+)` \(exit code -?\d+\)$/gm;
  let match: RegExpExecArray | null;
  while ((match = heading.exec(failureContext)) !== null) commands.push(match[1].trim());
  return commands;
}

/**
 * The Verify command(s) a stored verification retry failed against. New rows
 * carry the contract explicitly; legacy rows derive it from the recorded
 * failure signature/context. Non-verification retries return no command.
 * Signature and context are combined because a multiline command can make a
 * single signature line ambiguous, while the rendered context keeps its
 * heading block.
 */
export function verificationFailureCommands(retry: PendingVerificationRetry): string[] {
  if (retry.verifyContract?.trim()) return [retry.verifyContract.trim()];
  const commands = [
    ...commandsFromFailureSignature(retry.signature),
    ...commandsFromFailureContext(retry.failureContext),
  ];
  return [...new Set(commands.filter(Boolean))];
}

/**
 * True when the stored retry belongs to a Verify contract that the Task no
 * longer has. Explicit contracts compare as a whole field: a replan that
 * changes the field starts a new contract even if an old command still
 * appears inside it. Legacy signatures name individual checks, so they are
 * compared against the gate's runnable commands; an unchanged multi-command
 * contract with one failed check keeps its legitimate retry. When the
 * contract cannot be determined, the retry is preserved.
 */
export function isVerificationRetrySuperseded(
  retry: PendingVerificationRetry | null | undefined,
  currentVerify: string | null | undefined,
): boolean {
  if (!retry || !currentVerify?.trim()) return false;
  if (retry.verifyContract?.trim()) {
    return retry.verifyContract.trim() !== currentVerify.trim();
  }
  const recorded = verificationFailureCommands(retry);
  if (recorded.length === 0) return false;
  return recorded.every((command) => isVerifyCommandSuperseded(command, currentVerify));
}

/**
 * Release the stored git-commit repair retries of the unit: its commit
 * succeeded, or its repair dispatch failed and the loop abandoned the retry
 * so the unit is not reselected (#2806). A retry that another check stored
 * stays.
 */
export function releaseCommitRepairRetry(unitType: string, unitId: string): void {
  if (isDbAvailable()) deleteUnitCommitRepairRetries(unitType, unitId);
}

// ── Closeout refusal (#2046) ──────────────────────────────────────────────
//
// A unit that deliberately declines closeout writes its `*VERIFICATION-FAILED`
// report. The report on disk is the agent's channel and a render for the
// operator; the refusal a decision reads is the row this module stores on the
// unit's newest dispatch. A verification gate that clears the retry state of
// the unit releases the refusal with it, so a close-out that passes clears it.

/** Signature prefix of a stored closeout refusal. */
export const CLOSEOUT_REFUSAL_SIGNATURE_PREFIX = "closeout-refusal:";

/**
 * Store the deliberate closeout refusal of the unit on its newest dispatch
 * row (#2046). The relative report path rides on the signature so the
 * operator notice names the report without reading the file again.
 *
 * The retry row is a single slot per dispatch: storing the refusal clobbers
 * any retry state the newest dispatch already holds, and a retry another
 * check stores on that dispatch later clobbers the refusal.
 */
export function storeCloseoutRefusal(unitType: string, unitId: string, markerRelPath: string): void {
  storeUnitRetry(unitType, {
    unitId,
    failureContext: `${unitType} ${unitId} declined closeout (see ${markerRelPath})`,
    signature: `${CLOSEOUT_REFUSAL_SIGNATURE_PREFIX}${markerRelPath}`,
    attempt: 1,
  });
}

/**
 * The relative report path of the closeout refusal the unit's newest dispatch
 * row holds, or null when it has none. The report file on disk is not read.
 */
export function readStoredCloseoutRefusal(unitType: string, unitId: string): string | null {
  const retry = readStoredUnitRetry(unitType, unitId);
  if (!retry?.signature?.startsWith(CLOSEOUT_REFUSAL_SIGNATURE_PREFIX)) return null;
  return retry.signature.slice(CLOSEOUT_REFUSAL_SIGNATURE_PREFIX.length);
}
