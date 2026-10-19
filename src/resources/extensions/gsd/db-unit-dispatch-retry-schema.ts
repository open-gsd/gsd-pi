// Project/App: gsd-pi
// File Purpose: Stored retry decision table keyed by the unit_dispatches row (ADR-048).

import type { DbAdapter } from "./db-adapter.js";
import { columnExists, ensureColumn } from "./db-schema-metadata.js";

export function hasUnitDispatchRetrySchema(db: DbAdapter): boolean {
  const table = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'unit_dispatch_retries'",
  ).get();
  return table != null && columnExists(db, "unit_dispatch_retries", "signature");
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
      signature TEXT,
      FOREIGN KEY (dispatch_id) REFERENCES unit_dispatches(id)
    )
  `);
  // A database that got the table before it had the signature column.
  ensureColumn(
    db,
    "unit_dispatch_retries",
    "signature",
    "ALTER TABLE unit_dispatch_retries ADD COLUMN signature TEXT",
  );
}
