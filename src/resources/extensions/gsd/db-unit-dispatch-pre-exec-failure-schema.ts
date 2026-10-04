// Project/App: gsd-pi
// File Purpose: Pre-execution failure table keyed by the unit_dispatches row (ADR-048).

import type { DbAdapter } from "./db-adapter.js";

export function hasUnitDispatchPreExecFailureSchema(db: DbAdapter): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'unit_dispatch_pre_exec_failures'",
  ).get() !== undefined;
}

/**
 * ADR-048 kernel model: the findings of a failed pre-execution check belong to
 * the dispatch that made the plan, so they are a child row of it. The next
 * dispatch of the unit reads them from here, not from session memory.
 * Idempotent.
 */
export function createUnitDispatchPreExecFailureSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_dispatch_pre_exec_failures (
      dispatch_id INTEGER PRIMARY KEY,
      blocking_findings TEXT NOT NULL,
      verdict_excerpt TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (dispatch_id) REFERENCES unit_dispatches(id)
    )
  `);
}
