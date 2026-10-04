// Project/App: gsd-pi
// File Purpose: Unit cost and token table that the budget ceiling and the history readers use.

import type { DbAdapter } from "./db-adapter.js";

export function hasUnitMetricsSchema(db: DbAdapter): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'unit_metrics'",
  ).get() != null;
}

/**
 * One row per unit run, keyed like the metrics ledger (type, id, start time).
 * `cost` is a column because the budget ceiling sums it. The other fields of
 * the unit record are telemetry and stay in `metrics_json`. Idempotent.
 */
export function createUnitMetricsSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_metrics (
      unit_type TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      cost REAL NOT NULL CHECK (cost >= 0),
      metrics_json TEXT NOT NULL,
      PRIMARY KEY (unit_type, unit_id, started_at)
    )
  `);
}
