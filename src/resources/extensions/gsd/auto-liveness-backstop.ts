// Project/App: gsd-pi
// File Purpose: ADR-047 auto-mode liveness backstop — DB-persisted block
// signatures, trip-at-2 wedge records, and the explicit resume contract.

import { createHash, randomUUID } from 'node:crypto';

import {
  _getAdapter,
  acknowledgeLivenessWedgeRecord,
  insertLivenessWedgeRecord,
  isDbAvailable,
  reopenLivenessWedgeRecord,
  transaction,
  upsertLivenessBlockSignature,
} from './gsd-db.js';
import { getLatestForUnit } from './db/unit-dispatches.js';
import { parseUnitId } from './unit-id.js';

/**
 * ADR-047 trip rule: a block signature may not recur with unchanged inputs.
 * There is no legitimate run in which a guard reads byte-identical inputs
 * twice with dispatches in between, so the threshold is 2 (ADR-047 §3).
 */
export const LIVENESS_TRIP_THRESHOLD = 2;

/** Signature guard id for completed-no-advance dispatches (ADR-047 §4). */
export const COMPLETED_NO_ADVANCE_GUARD_ID = 'completed-no-advance';

export interface BlockSignatureInput {
  /** Stable project scope (realpath of the project root). */
  scopeId: string;
  /** Stable guard/gate identity included in the persisted signature. */
  guardId: string;
  unitType: string;
  /** Target identity: milestone/slice/task compound id or 'orchestration'. */
  unitId: string;
  /** The raw payload the guard read; hashed to form the signature input. */
  inputPayload: string;
}

export interface WedgeRecord {
  wedgeId: string;
  scopeId: string;
  guardId: string;
  unitType: string;
  unitId: string;
  inputHash: string;
  occurrenceCount: number;
  sanctionedExit: string;
  forensicsPath: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
}

export type RecordOutcomeResult =
  | { tripped: false; count: number }
  | { tripped: true; count: number; wedge: WedgeRecord }
  | { tripped: false; count: 0; error: string };

export type RecordRecurrenceResult =
  | { recurred: false; count: number }
  | { recurred: true; count: number }
  | { recurred: false; count: 0; error: string };

export type OpenWedgeResult =
  | { ok: true; wedge: WedgeRecord | null }
  | { ok: false; error: string };

export type UnitTargetSnapshotResult =
  | { ok: true; hash: string | null }
  | { ok: false; error: string };

/** Stable content hash of the inputs the guard actually read. */
export function hashBackstopInput(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Stable JSON payload for typed guard evidence recorded by the liveness seam. */
export function serializeNonAdvancingEvidence(evidence: unknown): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return value;
  }
  return JSON.stringify(canonical(evidence));
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToWedge(row: Record<string, unknown>): WedgeRecord {
  return {
    wedgeId: String(row['wedge_id']),
    scopeId: String(row['scope_id']),
    guardId: String(row['guard_id']),
    unitType: String(row['unit_type']),
    unitId: String(row['unit_id']),
    inputHash: String(row['input_hash']),
    occurrenceCount: Number(row['occurrence_count']),
    sanctionedExit: String(row['sanctioned_exit']),
    forensicsPath: row['forensics_path'] == null ? null : String(row['forensics_path']),
    createdAt: String(row['created_at']),
    acknowledgedAt: row['acknowledged_at'] == null ? null : String(row['acknowledged_at']),
  };
}

/**
 * Record a non-advancing dispatch outcome in the DB-persisted ledger.
 *
 * Interleaving-blind by construction: each stable guard and target owns its
 * current input-hash row. Changing that guard's hash clears the superseded row;
 * unrelated guards and targets do not disturb each other (ADR-047 §3).
 *
 * On trip, persists a wedge record carrying the sanctioned exit text. The
 * backstop never mutates workflow state (ADR-047 §2) — surfacing and the
 * exit-10 stop are the caller's job.
 */
export function recordNonAdvancingOutcome(
  input: BlockSignatureInput,
  options?: { sanctionedExit?: string; forensicsPath?: string | null },
): RecordOutcomeResult {
  if (!isDbAvailable()) {
    return { tripped: false, count: 0, error: 'workflow database unavailable' };
  }
  const inputHash = hashBackstopInput(input.inputPayload);
  try {
    return transaction(() => {
      const db = _getAdapter()!;
      const now = nowIso();
      const count = upsertLivenessBlockSignature(
        {
          scopeId: input.scopeId,
          guardId: input.guardId,
          unitType: input.unitType,
          unitId: input.unitId,
          inputHash,
        },
        now,
      );

      if (count < LIVENESS_TRIP_THRESHOLD) return { tripped: false, count };

      // Reuse the wedge for this signature rather than minting a duplicate.
      // An acknowledged wedge represents a one-shot re-entry probe: if the
      // originating guard reads the same input again, reopen that same record.
      const existing = db.prepare(
        `SELECT * FROM liveness_wedge_records
         WHERE scope_id = :scope AND guard_id = :guard
           AND unit_type = :utype AND unit_id = :uid
           AND input_hash = :hash
         ORDER BY created_at DESC LIMIT 1`,
      ).get({
        ':scope': input.scopeId,
        ':guard': input.guardId,
        ':utype': input.unitType,
        ':uid': input.unitId,
        ':hash': inputHash,
      }) as Record<string, unknown> | undefined;
      if (existing) {
        const wedge = rowToWedge(existing);
        if (wedge.acknowledgedAt) reopenLivenessWedgeRecord(wedge.wedgeId, count);
        return {
          tripped: true,
          count,
          wedge: { ...wedge, occurrenceCount: count, acknowledgedAt: null },
        };
      }

      const wedge: WedgeRecord = {
        wedgeId: `W-${randomUUID().slice(0, 8)}`,
        scopeId: input.scopeId,
        guardId: input.guardId,
        unitType: input.unitType,
        unitId: input.unitId,
        inputHash,
        occurrenceCount: count,
        sanctionedExit: options?.sanctionedExit ?? input.inputPayload,
        forensicsPath: options?.forensicsPath ?? null,
        createdAt: now,
        acknowledgedAt: null,
      };
      insertLivenessWedgeRecord(wedge);
      return { tripped: true, count, wedge };
    });
  } catch (err) {
    return {
      tripped: false,
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Count-only variant of recordNonAdvancingOutcome for guards whose trip
 * converts to a deterministic pause-with-cause instead of a wedge (#2198):
 * the same ADR-047 signature ledger and trip-at-2 threshold, but no wedge
 * record is minted, so plain `/gsd auto` re-entry is not gated behind
 * `--resume-wedge` acknowledgement. An unchanged re-entry after the pause
 * trips again; changed input supersedes the row as usual (ADR-047 §3).
 */
export function recordNonAdvancingRecurrence(
  input: BlockSignatureInput,
): RecordRecurrenceResult {
  if (!isDbAvailable()) {
    return { recurred: false, count: 0, error: 'workflow database unavailable' };
  }
  try {
    return transaction(() => {
      const count = upsertLivenessBlockSignature(
        {
          scopeId: input.scopeId,
          guardId: input.guardId,
          unitType: input.unitType,
          unitId: input.unitId,
          inputHash: hashBackstopInput(input.inputPayload),
        },
        nowIso(),
      );
      return { recurred: count >= LIVENESS_TRIP_THRESHOLD, count };
    });
  } catch (err) {
    return {
      recurred: false,
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Oldest unacknowledged wedge record for the project scope, if any. */
export function getOpenWedge(scopeId: string): OpenWedgeResult {
  if (!isDbAvailable()) return { ok: false, error: 'workflow database unavailable' };
  try {
    const row = _getAdapter()!.prepare(
      `SELECT * FROM liveness_wedge_records
       WHERE scope_id = :scope AND acknowledged_at IS NULL
       ORDER BY created_at ASC LIMIT 1`,
    ).get({ ':scope': scopeId }) as Record<string, unknown> | undefined;
    return { ok: true, wedge: row ? rowToWedge(row) : null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type AcknowledgeResult =
  | { ok: true; wedge: WedgeRecord }
  | { ok: false; reason: string };

export type WedgeBlockerRecheck = (
  wedge: WedgeRecord,
) => Promise<{ blocking: boolean; reason?: string }> | { blocking: boolean; reason?: string };

/**
 * Acknowledge a wedge only after its originating guard has been re-evaluated.
 * A still-live blocker leaves the wedge and its signature counter intact.
 * Otherwise the record is acknowledged and one re-entry probe is permitted;
 * the tripped signature is deliberately retained so unchanged guard input
 * immediately reopens the same wedge, while changed input supersedes the old
 * signature during adjudication. Acknowledgment is always explicit (ADR-047 §5).
 */
export async function acknowledgeWedge(
  scopeId: string,
  wedgeId: string,
  recheck: WedgeBlockerRecheck,
): Promise<AcknowledgeResult> {
  if (!isDbAvailable()) return { ok: false, reason: 'workflow database unavailable' };
  try {
    const stored = _getAdapter()!.prepare(
      `SELECT * FROM liveness_wedge_records WHERE wedge_id = :wid AND scope_id = :scope`,
    ).get({ ':wid': wedgeId, ':scope': scopeId }) as Record<string, unknown> | undefined;
    if (!stored) return { ok: false, reason: `no wedge record ${wedgeId} for this project` };
    const currentWedge = rowToWedge(stored);
    if (currentWedge.acknowledgedAt) return { ok: true, wedge: currentWedge };

    const blocker = await recheck(currentWedge);
    if (blocker.blocking) {
      return {
        ok: false,
        reason: blocker.reason
          ? `originating guard ${currentWedge.guardId} still blocks: ${blocker.reason}`
          : `originating guard ${currentWedge.guardId} still blocks ${currentWedge.unitType} ${currentWedge.unitId}`,
      };
    }

    return transaction(() => {
      const db = _getAdapter()!;
      const row = db.prepare(
        `SELECT * FROM liveness_wedge_records WHERE wedge_id = :wid AND scope_id = :scope`,
      ).get({ ':wid': wedgeId, ':scope': scopeId }) as Record<string, unknown> | undefined;
      if (!row) return { ok: false, reason: `no wedge record ${wedgeId} for this project` };
      const wedge = rowToWedge(row);
      if (wedge.acknowledgedAt) return { ok: true, wedge };
      const now = nowIso();
      acknowledgeLivenessWedgeRecord(wedgeId, now);
      return { ok: true, wedge: { ...wedge, acknowledgedAt: now } };
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Hash the DB rows a unit was dispatched to move (its target identity's
 * milestone/slice/task rows, plus unit-specific durable verdict rows). Used to detect completed-no-advance dispatches:
 * a unit that returns while this hash is unchanged did zero target work
 * (ADR-047 §4 — the #1626 zero-work re-dispatch class). Timestamp columns are
 * excluded so bookkeeping touches don't mask a semantic no-advance.
 */
export function snapshotUnitTargetRows(unitType: string, unitId: string): UnitTargetSnapshotResult {
  if (!isDbAvailable()) return { ok: false, error: 'workflow database unavailable' };
  try {
    const db = _getAdapter()!;
    const { milestone, slice, task } = parseUnitId(unitId);
    if (!milestone) return { ok: true, hash: null };
    const rows: unknown[] = [];
    const strip = (r: Record<string, unknown>): Record<string, unknown> => {
      const { created_at: _c, updated_at: _u, ...rest } = r;
      return rest;
    };
    const collect = (sql: string, params: Record<string, unknown>): void => {
      for (const r of db.prepare(sql).all(params) as Record<string, unknown>[]) {
        rows.push(strip(r));
      }
    };
    collect('SELECT * FROM milestones WHERE id = :m', { ':m': milestone });
    if (slice && task) {
      collect('SELECT * FROM slices WHERE milestone_id = :m AND id = :s ORDER BY id', { ':m': milestone, ':s': slice });
      collect('SELECT * FROM tasks WHERE milestone_id = :m AND slice_id = :s AND id = :t ORDER BY id', { ':m': milestone, ':s': slice, ':t': task });
    } else if (slice) {
      collect('SELECT * FROM slices WHERE milestone_id = :m AND id = :s ORDER BY id', { ':m': milestone, ':s': slice });
      collect('SELECT * FROM tasks WHERE milestone_id = :m AND slice_id = :s ORDER BY id', { ':m': milestone, ':s': slice });
      if (unitType === 'run-uat') {
        collect(
          `SELECT milestone_id, slice_id, scope, status
             FROM assessments
            WHERE milestone_id = :m AND slice_id = :s AND scope = 'run-uat'
            ORDER BY created_at DESC, ROWID DESC
            LIMIT 1`,
          { ':m': milestone, ':s': slice },
        );
        collect(
          `SELECT milestone_id, slice_id, gate_id, scope, task_id, status, verdict
             FROM quality_gates
            WHERE milestone_id = :m AND slice_id = :s AND gate_id = 'UAT'
            ORDER BY task_id`,
          { ':m': milestone, ':s': slice },
        );
      }
    } else {
      collect('SELECT * FROM slices WHERE milestone_id = :m ORDER BY id', { ':m': milestone });
    }
    return { ok: true, hash: hashBackstopInput(`${unitType}\n${JSON.stringify(rows)}`) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Latest dispatch-ledger error for a unit — the canonical failure payload the
 * loop settled before routing a retry. The ledger keys rows by bare unit id
 * with the unit type in its own column, so the lookup must use the bare id
 * and require a unit_type match (another unit type's error on the same id
 * must never feed this unit's signature).
 */
export function lookupLatestLedgerError(unitType: string, unitId: string): string | undefined {
  try {
    const row = getLatestForUnit(unitId);
    if (!row || row.unit_type !== unitType) return undefined;
    return row.error_summary ?? undefined;
  } catch {
    return undefined;
  }
}

/** The resume command for a wedge — the single sanctioned re-entry (ADR-047 §5). */
export function wedgeResumeCommand(wedge: WedgeRecord): string {
  return `/gsd auto --resume-wedge ${wedge.wedgeId}`;
}

/**
 * Terminal notice emitted when the backstop trips. Routed through
 * markBlockedStopReason → "Auto-mode blocked — …" so the headless host exits
 * 10 and the acceptance-bed classifier reads it as a wedge.
 */
export function formatWedgeTripNotice(wedge: WedgeRecord): string {
  return (
    `liveness backstop tripped: ${wedge.guardId} recurred ${wedge.occurrenceCount}x with unchanged inputs ` +
    `for ${wedge.unitType} ${wedge.unitId} (wedge ${wedge.wedgeId}). ` +
    `Sanctioned exit: ${wedge.sanctionedExit} ` +
    `After resolving, acknowledge with \`${wedgeResumeCommand(wedge)}\` to re-enter auto-mode.`
  );
}

/**
 * Refusal notice reprinted while an unacknowledged wedge record exists.
 * Deliberately prefix-free: callers compose it under the canonical blocked
 * stop-notice prefix ("Auto-mode blocked — …") so the headless host and the
 * acceptance-bed classifier read the refusal as a blocked terminal notice.
 */
export function formatWedgeRefusalNotice(wedge: WedgeRecord): string {
  return (
    `wedged (${wedge.wedgeId}): ${wedge.guardId} recurred ${wedge.occurrenceCount}x with unchanged inputs ` +
    `for ${wedge.unitType} ${wedge.unitId}. ` +
    `Sanctioned exit: ${wedge.sanctionedExit} ` +
    `Auto-mode will not re-enter until you acknowledge with \`${wedgeResumeCommand(wedge)}\`.`
  );
}
