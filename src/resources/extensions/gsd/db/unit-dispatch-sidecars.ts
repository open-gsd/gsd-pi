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
// Scope keeps one worker from running the queue of a live other worker (see
// sidecarQueueScope and sidecarReadScope).
//
// This module reads the queue. db/writers/unit-dispatch-sidecars.ts writes it.

import { hostname } from "node:os";

import { _getAdapter, isDbAvailable } from "../gsd-db.js";
import { autoWorkerHeartbeatTtlSeconds } from "./auto-workers.js";
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

/**
 * The WHERE clause for the rows this worker reads, with its parameters. A
 * parallel worker reads its own scope only. Any other start also takes the rows
 * of a parallel scope that no live worker owns (the worker was killed and its
 * milestone has no worker now), so they are not stranded. A live owner is
 * another process with a fresh heartbeat that holds the milestone lease of the
 * scope or ran the unit that queued the row.
 */
export function sidecarReadScope(): { where: string; params: Record<string, string | number> } {
  const scope = sidecarQueueScope();
  if (process.env.GSD_PARALLEL_WORKER) {
    return { where: "unit_dispatch_sidecars.scope = :scope", params: { ":scope": scope } };
  }
  const now = Date.now();
  return {
    where: `(unit_dispatch_sidecars.scope = :scope OR (
      unit_dispatch_sidecars.scope NOT LIKE '/%'
      AND NOT EXISTS (
        SELECT 1 FROM workers w
        WHERE w.status = 'active'
          AND w.last_heartbeat_at >= :heartbeat_cutoff
          AND NOT (w.pid = :pid AND w.host = :host)
          AND (
            w.worker_id IN (
              SELECT l.worker_id FROM milestone_leases l
              WHERE l.milestone_id = substr(unit_dispatch_sidecars.scope, 1, instr(unit_dispatch_sidecars.scope, '/') - 1)
                AND l.status = 'held' AND l.expires_at > :now
            )
            OR w.worker_id = (
              SELECT d.worker_id FROM unit_dispatches d
              WHERE d.id = unit_dispatch_sidecars.trigger_dispatch_id
            )
          )
      )
    ))`,
    params: {
      ":scope": scope,
      ":now": new Date(now).toISOString(),
      ":heartbeat_cutoff": new Date(now - autoWorkerHeartbeatTtlSeconds() * 1000).toISOString(),
      ":pid": process.pid,
      ":host": hostname(),
    },
  };
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
  const { where, params } = sidecarReadScope();
  return _getAdapter()!.prepare(
    `SELECT 1 AS present FROM unit_dispatch_sidecars
     WHERE ${where} AND status = 'held'
     LIMIT 1`,
  ).get(params) != null;
}

/** The items the auto loop must run, oldest first. */
export function listQueuedSidecarItems(): QueuedSidecarItem[] {
  if (!isDbAvailable()) return [];
  const { where, params } = sidecarReadScope();
  const rows = _getAdapter()!.prepare(
    `SELECT id, kind, unit_type, unit_id, prompt, model, capture_id
     FROM unit_dispatch_sidecars
     WHERE ${where} AND status = 'queued'
     ORDER BY id`,
  ).all(params) as unknown as SidecarRow[];
  return rows.map(sidecarItemFromRow);
}
