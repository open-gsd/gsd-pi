// Project/App: gsd-pi
// File Purpose: Retry and recovery budget table keyed by the unit_dispatches row (ADR-048).

import type { DbAdapter } from "./db-adapter.js";

export function hasUnitDispatchBudgetSchema(db: DbAdapter): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'unit_dispatch_budgets'",
  ).get() !== undefined;
}

/**
 * ADR-048 kernel model: the claimed unit_dispatches row is the durable identity
 * of a running unit, so the budget a unit has used is a child row of it. A
 * restart reads the count the last process wrote. Idempotent.
 */
export function createUnitDispatchBudgetSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_dispatch_budgets (
      dispatch_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      used INTEGER NOT NULL CHECK (used >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (dispatch_id, kind),
      FOREIGN KEY (dispatch_id) REFERENCES unit_dispatches(id)
    )
  `);
}
