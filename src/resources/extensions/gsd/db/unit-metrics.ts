// gsd-pi + Unit cost and token rows (unit_metrics)
//
// One row per unit run. The budget ceiling sums `cost` from these rows, so the
// spend does not depend on .gsd/metrics.json: a deleted, pruned or stale file
// does not change it. The history readers (MCP gsd_history, the web history
// panel) read the same rows.
//
// Metrics are telemetry, not workflow state: a row is not a Domain Operation
// and does not change the project revision.

import { _getAdapter, getDb, isDbAvailable, transaction } from "../gsd-db.js";
import type { UnitMetrics } from "../metrics.js";

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

/**
 * Total cost of the stored unit runs in USD. With `sinceMs`, only the runs
 * that started at or after that time. 0 when no database is open.
 */
export function readUnitSpend(sinceMs?: number): number {
  if (!isDbAvailable()) return 0;
  const row = _getAdapter()!.prepare(
    `SELECT COALESCE(SUM(cost), 0) AS spend FROM unit_metrics WHERE started_at >= :since`,
  ).get({ ":since": sinceMs ?? 0 }) as { spend: number } | undefined;
  return row?.spend ?? 0;
}

/** Every stored unit record, oldest first. Empty when no database is open. */
export function listUnitMetrics(): UnitMetrics[] {
  if (!isDbAvailable()) return [];
  const rows = _getAdapter()!.prepare(
    `SELECT metrics_json FROM unit_metrics ORDER BY finished_at, started_at`,
  ).all() as Array<{ metrics_json: string }>;
  return rows.map((row) => JSON.parse(row.metrics_json) as UnitMetrics);
}
