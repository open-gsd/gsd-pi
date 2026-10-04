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
// Scope keeps one worker from running the queue of another (see sidecarQueueScope).
//
// This module reads the queue. db/writers/unit-dispatch-sidecars.ts writes it.

import { _getAdapter, isDbAvailable } from "../gsd-db.js";
import type { SidecarItem } from "../auto/session.js";

export interface QueuedSidecarItem extends SidecarItem {
  id: number;
}

export interface SidecarTriggerUnit {
  type: string;
  id: string;
}

export interface SidecarRow {
  id: number;
  kind: SidecarItem["kind"];
  unit_type: string;
  unit_id: string;
  prompt: string;
  model: string | null;
  capture_id: string | null;
}

/**
 * The scope of every row this worker writes and reads. Rows belong to the
 * worker, not to the milestone it runs, so a session that moves to the next
 * milestone (or restarts on it) still runs the rows queued under the last one.
 * A parallel worker never leaves the milestone of its lock, and it shares the
 * database with the other workers, so its scope keeps the milestone, and the
 * slice for a slice-parallel worker.
 */
export function sidecarQueueScope(): string {
  const milestoneLock = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_MILESTONE_LOCK ?? "" : "";
  return `${milestoneLock}/${process.env.GSD_SLICE_LOCK ?? ""}`;
}

export function sidecarItemFromRow(row: SidecarRow): QueuedSidecarItem {
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

export function hasHeldQuickTask(): boolean {
  if (!isDbAvailable()) return false;
  return _getAdapter()!.prepare(
    `SELECT 1 AS present FROM unit_dispatch_sidecars
     WHERE scope = :scope AND status = 'held'
     LIMIT 1`,
  ).get({ ":scope": sidecarQueueScope() }) != null;
}

/** The items the auto loop must run, oldest first. */
export function listQueuedSidecarItems(): QueuedSidecarItem[] {
  if (!isDbAvailable()) return [];
  const rows = _getAdapter()!.prepare(
    `SELECT id, kind, unit_type, unit_id, prompt, model, capture_id
     FROM unit_dispatch_sidecars
     WHERE scope = :scope AND status = 'queued'
     ORDER BY id`,
  ).all({ ":scope": sidecarQueueScope() }) as unknown as SidecarRow[];
  return rows.map(sidecarItemFromRow);
}
