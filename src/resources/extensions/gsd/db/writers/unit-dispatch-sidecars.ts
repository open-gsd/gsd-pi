// Project/App: gsd-pi
// File Purpose: Single-writer layer for the sidecar queue (ADR-048). Owns the
// write SQL of unit_dispatch_sidecars; db/unit-dispatch-sidecars.ts reads it.

import { _getAdapter, isDbAvailable, transaction } from "../engine.js";
import type { SidecarItem } from "../../auto/session.js";
import {
  sidecarQueueScope,
  sidecarReadScope,
  sidecarItemFromRow,
  type QueuedSidecarItem,
  type SidecarRow,
  type SidecarTriggerUnit,
} from "../unit-dispatch-sidecars.js";

function insertSidecar(
  item: SidecarItem,
  trigger: SidecarTriggerUnit | null,
  status: "held" | "queued",
): number {
  if (!isDbAvailable()) {
    throw new Error("sidecar queue: DB unavailable");
  }
  return transaction(() => {
    const db = _getAdapter()!;
    const triggerRow = trigger
      ? db.prepare(
        `SELECT id FROM unit_dispatches
         WHERE unit_type = :unit_type AND unit_id = :unit_id
         ORDER BY id DESC
         LIMIT 1`,
      ).get({ ":unit_type": trigger.type, ":unit_id": trigger.id }) as { id: number } | undefined
      : undefined;
    const result = db.prepare(
      `INSERT INTO unit_dispatch_sidecars
         (trigger_dispatch_id, scope, kind, unit_type, unit_id, prompt, model, capture_id, status, queued_at)
       VALUES
         (:trigger_dispatch_id, :scope, :kind, :unit_type, :unit_id, :prompt, :model, :capture_id, :status, :queued_at)`,
    ).run({
      ":trigger_dispatch_id": triggerRow?.id ?? null,
      ":scope": sidecarQueueScope(),
      ":kind": item.kind,
      ":unit_type": item.unitType,
      ":unit_id": item.unitId,
      ":prompt": item.prompt,
      ":model": item.model ?? null,
      ":capture_id": item.captureId ?? null,
      ":status": status,
      ":queued_at": new Date().toISOString(),
    });
    return Number((result as { lastInsertRowid?: number | bigint }).lastInsertRowid);
  });
}

/** Queue an item for the auto loop. `trigger` is the unit whose close-out queued it. */
export function enqueueSidecarItem(
  item: SidecarItem,
  trigger: SidecarTriggerUnit | null,
): number {
  return insertSidecar(item, trigger, "queued");
}

/**
 * Keep a quick task for later. A capture that already has a held or queued row
 * is not added again, so a second triage run does not run it twice.
 */
export function holdQuickTask(
  item: SidecarItem & { captureId: string },
  trigger: SidecarTriggerUnit | null,
): void {
  if (!isDbAvailable()) {
    throw new Error("sidecar queue: DB unavailable");
  }
  const open = _getAdapter()!.prepare(
    `SELECT 1 AS present FROM unit_dispatch_sidecars
     WHERE capture_id = :capture_id AND status IN ('held', 'queued')
     LIMIT 1`,
  ).get({ ":capture_id": item.captureId });
  if (open == null) insertSidecar(item, trigger, "held");
}

/**
 * Move the oldest held quick task of this worker to its queue. The unit id
 * takes the milestone the session runs now, not the one that held the task.
 * Returns the task, or null when none waits.
 */
export function promoteHeldQuickTask(milestoneId: string | null): QueuedSidecarItem | null {
  if (!isDbAvailable()) return null;
  return transaction(() => {
    const db = _getAdapter()!;
    const { where, params } = sidecarReadScope();
    const row = db.prepare(
      `SELECT id, kind, unit_type, unit_id, prompt, model, capture_id
       FROM unit_dispatch_sidecars
       WHERE ${where} AND status = 'held'
       ORDER BY id
       LIMIT 1`,
    ).get(params) as SidecarRow | undefined;
    if (!row) return null;
    row.unit_id = `${milestoneId}/${row.capture_id}`;
    db.prepare(
      `UPDATE unit_dispatch_sidecars SET status = 'queued', unit_id = :unit_id WHERE id = :id`,
    ).run({ ":id": row.id, ":unit_id": row.unit_id });
    return sidecarItemFromRow(row);
  });
}

/** Close a queued item after the loop iteration that ran it. */
export function settleSidecarItem(id: number): void {
  if (!isDbAvailable()) return;
  transaction(() => {
    _getAdapter()!.prepare(
      `UPDATE unit_dispatch_sidecars
       SET status = 'done', settled_at = :settled_at
       WHERE id = :id AND status = 'queued'`,
    ).run({ ":id": id, ":settled_at": new Date().toISOString() });
  });
}

/**
 * A user stop drops the work of this worker that did not run yet: its queue
 * and the quick tasks it holds.
 */
export function cancelOpenSidecarItems(): void {
  if (!isDbAvailable()) return;
  transaction(() => {
    const { where, params } = sidecarReadScope();
    _getAdapter()!.prepare(
      `UPDATE unit_dispatch_sidecars
       SET status = 'canceled', settled_at = :settled_at
       WHERE ${where} AND status IN ('held', 'queued')`,
    ).run({
      ...params,
      ":settled_at": new Date().toISOString(),
    });
  });
}
