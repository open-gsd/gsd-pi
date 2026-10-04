// gsd-pi + Sidecar queue on the dispatch row (ADR-048)
//
// A unit can queue follow-on work at close-out: a post-unit hook, a capture
// triage, or a quick task. Each item is a row linked to the unit_dispatches row
// of the unit that queued it, so a restart still finds the work.
//
// Status rules:
//   held     a quick task that waits for its turn (one runs between two units)
//   queued   ready; the auto loop runs the oldest one before it selects a unit
//   done     the loop iteration that ran the item ended
//   canceled the user stopped auto-mode before the item ran
// A killed process leaves the row held or queued, so the next start runs it.
//
// Scope keeps one worker from running the queue of another: rows belong to one
// milestone, and to one slice for a slice-parallel worker.

import { _getAdapter, isDbAvailable, transaction } from "../gsd-db.js";
import type { SidecarItem } from "../auto/session.js";

export interface QueuedSidecarItem extends SidecarItem {
  id: number;
}

export interface SidecarTriggerUnit {
  type: string;
  id: string;
}

interface SidecarRow {
  id: number;
  kind: SidecarItem["kind"];
  unit_type: string;
  unit_id: string;
  prompt: string;
  model: string | null;
  capture_id: string | null;
}

export function sidecarQueueScope(milestoneId: string | null): string {
  return `${milestoneId ?? ""}/${process.env.GSD_SLICE_LOCK ?? ""}`;
}

function toItem(row: SidecarRow): QueuedSidecarItem {
  return {
    id: row.id,
    kind: row.kind,
    unitType: row.unit_type,
    unitId: row.unit_id,
    prompt: row.prompt,
    ...(row.model ? { model: row.model } : {}),
    ...(row.capture_id ? { captureId: row.capture_id } : {}),
  };
}

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
  scope: string,
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
  if (open == null) insertSidecar(scope, item, trigger, "held");
}

/** Move the oldest held quick task to the queue. Returns it, or null when none waits. */
export function promoteHeldQuickTask(scope: string): QueuedSidecarItem | null {
  if (!isDbAvailable()) return null;
  return transaction(() => {
    const db = _getAdapter()!;
    const row = db.prepare(
      `SELECT id, kind, unit_type, unit_id, prompt, model, capture_id
       FROM unit_dispatch_sidecars
       WHERE scope = :scope AND status = 'held'
       ORDER BY id
       LIMIT 1`,
    ).get({ ":scope": scope }) as SidecarRow | undefined;
    if (!row) return null;
    db.prepare(
      `UPDATE unit_dispatch_sidecars SET status = 'queued' WHERE id = :id`,
    ).run({ ":id": row.id });
    return toItem(row);
  });
}

export function hasHeldQuickTask(scope: string): boolean {
  if (!isDbAvailable()) return false;
  return _getAdapter()!.prepare(
    `SELECT 1 AS present FROM unit_dispatch_sidecars
     WHERE scope = :scope AND status = 'held'
     LIMIT 1`,
  ).get({ ":scope": scope }) != null;
}

/** The items the auto loop must run, oldest first. */
export function listQueuedSidecarItems(scope: string): QueuedSidecarItem[] {
  if (!isDbAvailable()) return [];
  const rows = _getAdapter()!.prepare(
    `SELECT id, kind, unit_type, unit_id, prompt, model, capture_id
     FROM unit_dispatch_sidecars
     WHERE scope = :scope AND status = 'queued'
     ORDER BY id`,
  ).all({ ":scope": scope }) as unknown as SidecarRow[];
  return rows.map(toItem);
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

/** A user stop drops the work that did not run yet. */
export function cancelOpenSidecarItems(scope: string): void {
  if (!isDbAvailable()) return;
  transaction(() => {
    _getAdapter()!.prepare(
      `UPDATE unit_dispatch_sidecars
       SET status = 'canceled', settled_at = :settled_at
       WHERE scope = :scope AND status IN ('held', 'queued')`,
    ).run({ ":scope": scope, ":settled_at": new Date().toISOString() });
  });
}
