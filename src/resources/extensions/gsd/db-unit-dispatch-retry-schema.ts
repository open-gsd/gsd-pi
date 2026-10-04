// Project/App: gsd-pi
// File Purpose: Stored retry decision table keyed by the unit_dispatches row (ADR-048).

import type { DbAdapter } from "./db-adapter.js";

export function hasUnitDispatchRetrySchema(db: DbAdapter): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'unit_dispatch_retries'",
  ).get() != null;
}

/**
 * ADR-048 kernel model: the decision to run a unit again, and the failure
 * context the next run must get, is a child row of the unit's unit_dispatches
 * row. A restart reads the decision the last process made. Idempotent.
 */
export function createUnitDispatchRetrySchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_dispatch_retries (
      dispatch_id INTEGER PRIMARY KEY,
      failure_context TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      created_at TEXT NOT NULL,
      FOREIGN KEY (dispatch_id) REFERENCES unit_dispatches(id)
    )
  `);
}
