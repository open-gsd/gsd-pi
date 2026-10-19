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
import { autoWorkerHeartbeatTtlSeconds, getAllAutoWorkers, isWorkerProcessAlive } from "./auto-workers.js";
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
 * of a parallel scope that has no owner (the worker was killed and its
 * milestone has no worker now), so they are not stranded.
 *
 * A scope has an owner when another process holds an unexpired milestone lease
 * of the scope, or when the worker that holds the lease or that ran the unit
 * which queued the row is live. A live worker is an active worker of another
 * process with a fresh heartbeat or a process that is alive on this host.
 */
export function sidecarReadScope(): { where: string; params: Record<string, string | number> } {
  const scope = sidecarQueueScope();
  if (process.env.GSD_PARALLEL_WORKER) {
    return { where: "unit_dispatch_sidecars.scope = :scope", params: { ":scope": scope } };
  }
  const now = Date.now();
  const host = hostname();
  const heartbeatCutoff = now - autoWorkerHeartbeatTtlSeconds() * 1000;
  const liveWorkers = getAllAutoWorkers()
    .filter((worker) => worker.status === "active")
    .filter((worker) => !(worker.pid === process.pid && worker.host === host))
    .filter((worker) => Date.parse(worker.last_heartbeat_at) >= heartbeatCutoff || isWorkerProcessAlive(worker))
    .map((worker) => worker.worker_id);
  return {
    where: `(unit_dispatch_sidecars.scope = :scope OR (
      unit_dispatch_sidecars.scope NOT LIKE '/%'
      AND NOT EXISTS (
        SELECT 1 FROM milestone_leases l
        WHERE l.milestone_id = substr(unit_dispatch_sidecars.scope, 1, instr(unit_dispatch_sidecars.scope, '/') - 1)
          AND l.status = 'held'
          AND (
            l.worker_id IN (SELECT value FROM json_each(:live_workers))
            OR (
              l.expires_at > :now
              AND l.worker_id NOT IN (SELECT w.worker_id FROM workers w WHERE w.pid = :pid AND w.host = :host)
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM unit_dispatches d
        WHERE d.id = unit_dispatch_sidecars.trigger_dispatch_id
          AND d.worker_id IN (SELECT value FROM json_each(:live_workers))
      )
    ))`,
    params: {
      ":scope": scope,
      ":now": new Date(now).toISOString(),
      ":live_workers": JSON.stringify(liveWorkers),
      ":pid": process.pid,
      ":host": host,
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
