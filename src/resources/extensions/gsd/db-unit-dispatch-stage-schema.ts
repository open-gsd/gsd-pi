// Project/App: gsd-pi
// File Purpose: Stage checkpoint table keyed by the unit_dispatches row (ADR-048).

import type { DbAdapter } from "./db-adapter.js";

export function hasUnitDispatchStageSchema(db: DbAdapter): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'unit_dispatch_stages'",
  ).get() != null;
}

/**
 * ADR-048 kernel model: the stage a unit has reached is a child row of its
 * unit_dispatches row. A dispatch with no row is in the execute stage. A
 * resume reads the stage, so it does not replay a unit that left execution.
 * Idempotent.
 */
export function createUnitDispatchStageSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_dispatch_stages (
      dispatch_id INTEGER PRIMARY KEY,
      stage TEXT NOT NULL CHECK (stage IN ('verify', 'route', 'closeout')),
      updated_at TEXT NOT NULL,
      FOREIGN KEY (dispatch_id) REFERENCES unit_dispatches(id)
    )
  `);
}
