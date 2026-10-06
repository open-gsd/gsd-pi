// Project/App: gsd-pi
// File Purpose: Single-writer layer for unit_metrics — one row per unit run
// with its cost and token record. The reads are in db/unit-metrics.ts.
//
// Metrics are telemetry, not workflow state: a row is not a Domain Operation
// and does not change the project revision.

import { getDb, transaction } from "../engine.js";
import type { UnitMetrics } from "../../metrics.js";

/**
 * Store the unit records. A second snapshot of the same run (same type, id
 * and start time) replaces the first. Throws when no database is open.
 */
export function recordUnitMetricsRows(units: readonly UnitMetrics[]): void {
  if (units.length === 0) return;
  transaction(() => {
    const insert = getDb().prepare(
      `INSERT INTO unit_metrics (unit_type, unit_id, started_at, finished_at, cost, metrics_json)
       VALUES (:unit_type, :unit_id, :started_at, :finished_at, :cost, :metrics_json)
       ON CONFLICT (unit_type, unit_id, started_at) DO UPDATE SET
         finished_at = excluded.finished_at,
         cost = excluded.cost,
         metrics_json = excluded.metrics_json`,
    );
    for (const unit of units) {
      insert.run({
        ":unit_type": unit.type,
        ":unit_id": unit.id,
        ":started_at": unit.startedAt,
        ":finished_at": unit.finishedAt,
        ":cost": Math.max(0, unit.cost),
        ":metrics_json": JSON.stringify(unit),
      });
    }
  });
}
