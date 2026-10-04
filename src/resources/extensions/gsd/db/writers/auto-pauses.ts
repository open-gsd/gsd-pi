// Project/App: gsd-pi
// File Purpose: Single-writer layer for auto_pauses — the pause row that resume
// routing reads (see db-auto-pause-schema.ts).
//
// One row is open for each worker scope. The scope is the scope of the sidecar
// queue: the project root, or the milestone and slice lock of a parallel
// worker. Every reader returns "no row" when no database is open; every writer
// needs an open one.

import { _getAdapter, isDbAvailable, transaction } from "../engine.js";
import type { PausedSessionMetadata } from "../../interrupted-session.js";
import type { AutoPauseBlockerKind } from "../../recovery-policy.js";
import { sidecarQueueScope } from "../unit-dispatch-sidecars.js";

interface AutoPauseRow {
  blocker_kind: AutoPauseBlockerKind;
  dispatch_id: number | null;
  milestone_id: string | null;
  unit_type: string | null;
  unit_id: string | null;
  worktree_path: string | null;
  original_base_path: string | null;
  step_mode: number;
  session_file: string | null;
  active_engine_id: string | null;
  active_run_dir: string | null;
  auto_start_time: number | null;
  milestone_lock: string | null;
  pause_reason: string | null;
  paused_at: string;
}

/** The open pause of this worker's scope, or null when it has none. */
export function readOpenAutoPause(): PausedSessionMetadata | null {
  if (!isDbAvailable()) return null;
  const row = _getAdapter()!.prepare(
    `SELECT * FROM auto_pauses WHERE scope = :scope AND closed_at IS NULL`,
  ).get({ ":scope": sidecarQueueScope() }) as AutoPauseRow | undefined;
  if (!row) return null;
  return {
    blockerKind: row.blocker_kind,
    dispatchId: row.dispatch_id,
    milestoneId: row.milestone_id ?? undefined,
    unitType: row.unit_type ?? undefined,
    unitId: row.unit_id ?? undefined,
    worktreePath: row.worktree_path,
    originalBasePath: row.original_base_path ?? undefined,
    stepMode: row.step_mode === 1,
    sessionFile: row.session_file,
    activeEngineId: row.active_engine_id ?? undefined,
    activeRunDir: row.active_run_dir,
    autoStartTime: row.auto_start_time ?? undefined,
    milestoneLock: row.milestone_lock,
    pauseReason: row.pause_reason ?? undefined,
    pausedAt: row.paused_at,
  };
}

/** Whether a worker scope of the project has an open pause. */
export function hasOpenAutoPause(): boolean {
  if (!isDbAvailable()) return false;
  return _getAdapter()!.prepare(
    `SELECT 1 AS present FROM auto_pauses WHERE closed_at IS NULL LIMIT 1`,
  ).get() != null;
}

/** Close the open pause of this worker's scope. The row stays in the table. */
export function closeAutoPause(): void {
  if (!isDbAvailable()) return;
  transaction(() => {
    _getAdapter()!.prepare(
      `UPDATE auto_pauses SET closed_at = :closed_at WHERE scope = :scope AND closed_at IS NULL`,
    ).run({ ":closed_at": new Date().toISOString(), ":scope": sidecarQueueScope() });
  });
}

/** Open the pause of this worker's scope. A pause that is still open is closed first. */
export function openAutoPause(
  pause: PausedSessionMetadata & { blockerKind: AutoPauseBlockerKind },
): void {
  if (!isDbAvailable()) {
    throw new Error("auto pause: DB unavailable");
  }
  transaction(() => {
    closeAutoPause();
    _getAdapter()!.prepare(
      `INSERT INTO auto_pauses (
         scope, blocker_kind, dispatch_id, milestone_id, unit_type, unit_id,
         worktree_path, original_base_path, step_mode, session_file,
         active_engine_id, active_run_dir, auto_start_time, milestone_lock,
         pause_reason, paused_at
       ) VALUES (
         :scope, :blocker_kind, :dispatch_id, :milestone_id, :unit_type, :unit_id,
         :worktree_path, :original_base_path, :step_mode, :session_file,
         :active_engine_id, :active_run_dir, :auto_start_time, :milestone_lock,
         :pause_reason, :paused_at
       )`,
    ).run({
      ":scope": sidecarQueueScope(),
      ":blocker_kind": pause.blockerKind,
      ":dispatch_id": pause.dispatchId ?? null,
      ":milestone_id": pause.milestoneId ?? null,
      ":unit_type": pause.unitType ?? null,
      ":unit_id": pause.unitId ?? null,
      ":worktree_path": pause.worktreePath ?? null,
      ":original_base_path": pause.originalBasePath ?? null,
      ":step_mode": pause.stepMode ? 1 : 0,
      ":session_file": pause.sessionFile ?? null,
      ":active_engine_id": pause.activeEngineId ?? null,
      ":active_run_dir": pause.activeRunDir ?? null,
      ":auto_start_time": pause.autoStartTime ?? null,
      ":milestone_lock": pause.milestoneLock ?? null,
      ":pause_reason": pause.pauseReason ?? null,
      ":paused_at": pause.pausedAt ?? new Date().toISOString(),
    });
  });
}
