// Project/App: gsd-pi
// File Purpose: Single-writer layer for the runtime-control tables — the unit
// runtime record, the post-unit hook state and the run-uat retry counter.
//
// These are coordination rows (see db-runtime-control-schema.ts). Every reader
// returns "no row" when no database is open; every writer needs an open one.
// Every write runs in a transaction so the database replacement fence applies.

import { _getAdapter, getDb, immediateTransaction, isDbAvailable, transaction } from "../engine.js";

export interface UnitRuntimeRow {
  /** Real path of the worktree or project root that runs the unit. */
  work_root: string;
  unit_type: string;
  unit_id: string;
  started_at: number;
  updated_at: number;
  phase: string;
  wrapup_warning_sent: number;
  continue_here_fired: number;
  timeout_at: number | null;
  last_progress_at: number;
  progress_count: number;
  last_progress_kind: string;
  recovery_attempts: number;
  last_recovery_reason: string | null;
  harness_abort_kind: string | null;
  harness_abort_reason: string | null;
  harness_abort_tool_name: string | null;
  harness_abort_count: number | null;
  harness_abort_recorded_at: number | null;
  end_status: string | null;
  end_artifact_verified: number | null;
  end_error: string | null;
  recovery_json: string | null;
}

const UNIT_RUNTIME_COLUMNS = [
  "work_root",
  "unit_type",
  "unit_id",
  "started_at",
  "updated_at",
  "phase",
  "wrapup_warning_sent",
  "continue_here_fired",
  "timeout_at",
  "last_progress_at",
  "progress_count",
  "last_progress_kind",
  "recovery_attempts",
  "last_recovery_reason",
  "harness_abort_kind",
  "harness_abort_reason",
  "harness_abort_tool_name",
  "harness_abort_count",
  "harness_abort_recorded_at",
  "end_status",
  "end_artifact_verified",
  "end_error",
  "recovery_json",
] as const satisfies readonly (keyof UnitRuntimeRow)[];

export function readUnitRuntimeRow(workRoot: string, unitType: string, unitId: string): UnitRuntimeRow | null {
  if (!isDbAvailable()) return null;
  const row = _getAdapter()!.prepare(
    `SELECT * FROM unit_runtime_records
     WHERE work_root = :work_root AND unit_type = :unit_type AND unit_id = :unit_id`,
  ).get({ ":work_root": workRoot, ":unit_type": unitType, ":unit_id": unitId });
  return (row as unknown as UnitRuntimeRow | undefined) ?? null;
}

/** Rows of every work root. A row belongs to the session that runs in its work root. */
export function listUnitRuntimeRows(): UnitRuntimeRow[] {
  if (!isDbAvailable()) return [];
  return _getAdapter()!.prepare(
    `SELECT * FROM unit_runtime_records ORDER BY work_root, unit_type, unit_id`,
  ).all() as unknown as UnitRuntimeRow[];
}

/**
 * Read-modify-write one unit runtime row under SQLite's writer lock, so two
 * processes that update different fields of the same record cannot lose a
 * write. `next` returns the row to store.
 */
export function updateUnitRuntimeRow(
  workRoot: string,
  unitType: string,
  unitId: string,
  next: (prev: UnitRuntimeRow | null) => UnitRuntimeRow,
): UnitRuntimeRow {
  return immediateTransaction(() => {
    const row = next(readUnitRuntimeRow(workRoot, unitType, unitId));
    getDb().prepare(
      `INSERT OR REPLACE INTO unit_runtime_records (${UNIT_RUNTIME_COLUMNS.join(", ")})
       VALUES (${UNIT_RUNTIME_COLUMNS.map((column) => `:${column}`).join(", ")})`,
    ).run(Object.fromEntries(UNIT_RUNTIME_COLUMNS.map((column) => [`:${column}`, row[column]])));
    return row;
  });
}

export function deleteUnitRuntimeRow(workRoot: string, unitType: string, unitId: string): void {
  if (!isDbAvailable()) return;
  transaction(() => {
    getDb().prepare(
      `DELETE FROM unit_runtime_records
       WHERE work_root = :work_root AND unit_type = :unit_type AND unit_id = :unit_id`,
    ).run({ ":work_root": workRoot, ":unit_type": unitType, ":unit_id": unitId });
  });
}

export function readHookStateJson(scope: string): string | null {
  if (!isDbAvailable()) return null;
  const row = _getAdapter()!.prepare(
    `SELECT state_json FROM hook_state WHERE scope = :scope`,
  ).get({ ":scope": scope }) as { state_json: string } | undefined;
  return row?.state_json ?? null;
}

export function writeHookStateJson(scope: string, stateJson: string): void {
  transaction(() => {
    getDb().prepare(
      `INSERT INTO hook_state (scope, state_json, updated_at)
       VALUES (:scope, :state_json, :updated_at)
       ON CONFLICT (scope) DO UPDATE SET
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    ).run({ ":scope": scope, ":state_json": stateJson, ":updated_at": new Date().toISOString() });
  });
}

export interface UatRetryCounterRow {
  milestone_id: string;
  slice_id: string;
  attempts: number;
}

export function getUatRetryAttempts(milestoneId: string, sliceId: string): number {
  if (!isDbAvailable()) return 0;
  const row = _getAdapter()!.prepare(
    `SELECT attempts FROM uat_retry_counters
     WHERE milestone_id = :milestone_id AND slice_id = :slice_id`,
  ).get({ ":milestone_id": milestoneId, ":slice_id": sliceId }) as { attempts: number } | undefined;
  return row?.attempts ?? 0;
}

/** Add one run-uat attempt for the slice and return the new count. */
export function incrementUatRetryAttempts(milestoneId: string, sliceId: string): number {
  return immediateTransaction(() => {
    getDb().prepare(
      `INSERT INTO uat_retry_counters (milestone_id, slice_id, attempts, updated_at)
       VALUES (:milestone_id, :slice_id, 1, :updated_at)
       ON CONFLICT (milestone_id, slice_id) DO UPDATE SET
         attempts = attempts + 1,
         updated_at = excluded.updated_at`,
    ).run({ ":milestone_id": milestoneId, ":slice_id": sliceId, ":updated_at": new Date().toISOString() });
    return getUatRetryAttempts(milestoneId, sliceId);
  });
}

export function listUatRetryCounters(): UatRetryCounterRow[] {
  if (!isDbAvailable()) return [];
  return _getAdapter()!.prepare(
    `SELECT milestone_id, slice_id, attempts FROM uat_retry_counters ORDER BY milestone_id, slice_id`,
  ).all() as unknown as UatRetryCounterRow[];
}

export function deleteUatRetryCounter(milestoneId: string, sliceId: string): void {
  if (!isDbAvailable()) return;
  transaction(() => {
    getDb().prepare(
      `DELETE FROM uat_retry_counters WHERE milestone_id = :milestone_id AND slice_id = :slice_id`,
    ).run({ ":milestone_id": milestoneId, ":slice_id": sliceId });
  });
}
