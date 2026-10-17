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
import type { DomainOperationContext } from "../domain-operation.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

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
  blocker_id: string | null;
}

/** The blocker row the open pause of a worker's scope opened, or null. */
export function readOpenAutoPauseBlockerId(scope: string = sidecarQueueScope()): string | null {
  if (!isDbAvailable()) return null;
  const row = _getAdapter()!.prepare(
    `SELECT blocker_id FROM auto_pauses WHERE scope = :scope AND closed_at IS NULL`,
  ).get({ ":scope": scope }) as { blocker_id: string | null } | undefined;
  return row?.blocker_id ?? null;
}

/** Record the workflow_blockers row a human pause opened on its pause row. */
export function setAutoPauseBlockerId(blockerId: string): void {
  if (!isDbAvailable()) return;
  transaction(() => {
    _getAdapter()!.prepare(
      `UPDATE auto_pauses SET blocker_id = :blocker_id
       WHERE scope = :scope AND closed_at IS NULL`,
    ).run({ ":blocker_id": blockerId, ":scope": sidecarQueueScope() });
  });
}

/**
 * The latest user-requested pause recorded for a unit (open or closed — the
 * table keeps closed rows), or null. #2787: this is the durable signal that a
 * `running` Task Attempt was paused by the user rather than orphaned by a
 * crash, so recovery classifies the interrupt as a user pause, not a stale
 * worker. Both timestamps are `new Date().toISOString()` strings, so the
 * ordering comparison is plain lexicographic.
 */
export function readLatestUserPauseForUnit(
  unitType: string,
  unitId: string,
): { pausedAt: string } | null {
  if (!isDbAvailable()) return null;
  const row = _getAdapter()!.prepare(
    `SELECT paused_at FROM auto_pauses
     WHERE unit_type = :unit_type AND unit_id = :unit_id AND blocker_kind = 'user_request'
     ORDER BY paused_at DESC
     LIMIT 1`,
  ).get({ ":unit_type": unitType, ":unit_id": unitId }) as { paused_at: string } | undefined;
  return row ? { pausedAt: row.paused_at } : null;
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

/** The worker scopes of the project that have an open pause. */
export function listOpenAutoPauseScopes(): string[] {
  if (!isDbAvailable()) return [];
  const rows = _getAdapter()!.prepare(
    `SELECT scope FROM auto_pauses WHERE closed_at IS NULL ORDER BY scope`,
  ).all() as Array<{ scope: string }>;
  return rows.map((row) => row.scope);
}

/** Close the open pause of a scope (default: this worker's scope). The row stays in the table. */
export function closeAutoPause(scope: string = sidecarQueueScope()): void {
  if (!isDbAvailable()) return;
  transaction(() => {
    _getAdapter()!.prepare(
      `UPDATE auto_pauses SET closed_at = :closed_at WHERE scope = :scope AND closed_at IS NULL`,
    ).run({ ":closed_at": new Date().toISOString(), ":scope": scope });
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

/**
 * The one open pause row whose `blocker_id` is the given id, or null when
 * there are zero or multiple matches. Used by the `pause.blocker.resolve.by-id`
 * Domain Operation to bind an exact operator-named blocker to one pause.
 */
export function readOpenAutoPauseByBlockerId(
  blockerId: string,
): { id: number; scope: string } | null {
  if (!isDbAvailable()) return null;
  const rows = _getAdapter()!.prepare(
    `SELECT id, scope FROM auto_pauses WHERE blocker_id = :blocker_id AND closed_at IS NULL LIMIT 2`,
  ).all({ ":blocker_id": blockerId }) as Array<{ id: number; scope: string }>;
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Close the open pause bound to `blockerId`, inside the caller's
 * `pause.blocker.resolve.by-id` Domain Operation transaction. A blocker with
 * anything other than one matching open pause row closes nothing and
 * `closed: false` comes back — the caller must treat this as a failed
 * association, not a partial success.
 */
export function closeAutoPauseForBlocker(
  context: Readonly<DomainOperationContext>,
  blockerId: string,
): { closed: boolean; scope: string | null } {
  if (requireActiveDomainOperationContext(context) !== "pause.blocker.resolve.by-id") {
    throw new Error("pause.blocker.resolve.by-id Domain Operation required");
  }
  const target = readOpenAutoPauseByBlockerId(blockerId);
  if (!target) return { closed: false, scope: null };
  const result = _getAdapter()!.prepare(
    `UPDATE auto_pauses SET closed_at = :closed_at
     WHERE id = :id AND scope = :scope AND blocker_id = :blocker_id AND closed_at IS NULL`,
  ).run({
    ":closed_at": new Date().toISOString(),
    ":id": target.id,
    ":scope": target.scope,
    ":blocker_id": blockerId,
  });
  const closed = Number((result as { changes?: unknown }).changes ?? 0) > 0;
  return { closed, scope: closed ? target.scope : null };
}
