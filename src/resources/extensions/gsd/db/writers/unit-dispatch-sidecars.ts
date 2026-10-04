// Project/App: gsd-pi
// File Purpose: Single-writer layer for the sidecar queue (ADR-048). Owns the
// write SQL of unit_dispatch_sidecars; db/unit-dispatch-sidecars.ts reads it.

import { _getAdapter, isDbAvailable, transaction } from "../engine.js";
import type { SidecarItem } from "../../auto/session.js";
import {
  quickTaskHoldScope,
  sidecarItemFromRow,
  type QueuedSidecarItem,
  type SidecarRow,
  type SidecarTriggerUnit,
} from "../unit-dispatch-sidecars.js";

function insertSidecar(
  scope: string,
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
      ":scope": scope,
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
  scope: string,
  item: SidecarItem,
  trigger: SidecarTriggerUnit | null,
): number {
  return insertSidecar(scope, item, trigger, "queued");
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
  if (open == null) insertSidecar(quickTaskHoldScope(), item, trigger, "held");
}

/**
 * Move the oldest held quick task of this worker to the queue of `queueScope`.
 * Returns it, or null when none waits.
 */
export function promoteHeldQuickTask(queueScope: string): QueuedSidecarItem | null {
  if (!isDbAvailable()) return null;
  return transaction(() => {
    const db = _getAdapter()!;
    const row = db.prepare(
      `SELECT id, kind, unit_type, unit_id, prompt, model, capture_id
       FROM unit_dispatch_sidecars
       WHERE scope = :scope AND status = 'held'
       ORDER BY id
       LIMIT 1`,
    ).get({ ":scope": quickTaskHoldScope() }) as SidecarRow | undefined;
    if (!row) return null;
    db.prepare(
      `UPDATE unit_dispatch_sidecars SET status = 'queued', scope = :scope WHERE id = :id`,
    ).run({ ":id": row.id, ":scope": queueScope });
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
 * A user stop drops the work that did not run yet: the queue of `queueScope`
 * and the quick tasks this worker holds.
 */
export function cancelOpenSidecarItems(queueScope: string): void {
  if (!isDbAvailable()) return;
  transaction(() => {
    _getAdapter()!.prepare(
      `UPDATE unit_dispatch_sidecars
       SET status = 'canceled', settled_at = :settled_at
       WHERE (scope = :queue_scope AND status = 'queued')
          OR (scope = :hold_scope AND status = 'held')`,
    ).run({
      ":queue_scope": queueScope,
      ":hold_scope": quickTaskHoldScope(),
      ":settled_at": new Date().toISOString(),
    });
  });
}
