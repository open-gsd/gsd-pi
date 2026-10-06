// Project/App: gsd-pi
// File Purpose: Sidecar queue table (hooks, triage, quick tasks) linked to the unit_dispatches row that queued the work (ADR-048).

import type { DbAdapter } from "./db-adapter.js";

export function hasUnitDispatchSidecarSchema(db: DbAdapter): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'unit_dispatch_sidecars'",
  ).get() != null;
}

/**
 * ADR-048 kernel model: follow-on work that a unit queues at close-out is a
 * child row of that unit's unit_dispatches row, so a restart still finds it.
 * trigger_dispatch_id is NULL when the unit ran with no dispatch row, and when
 * a resume queues a restored hook again. Idempotent.
 */
export function createUnitDispatchSidecarSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_dispatch_sidecars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_dispatch_id INTEGER,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('hook', 'triage', 'quick-task')),
      unit_type TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model TEXT,
      capture_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('held', 'queued', 'done', 'canceled')),
      queued_at TEXT NOT NULL,
      settled_at TEXT,
      FOREIGN KEY (trigger_dispatch_id) REFERENCES unit_dispatches(id)
    )
  `);
}
