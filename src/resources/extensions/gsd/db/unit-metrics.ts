// gsd-pi + Unit cost and token rows (unit_metrics)
//
// One row per unit run. The budget ceiling sums `cost` from these rows, so the
// spend does not depend on .gsd/metrics.json: a deleted, pruned or stale file
// does not change it. The history readers (MCP gsd_history, the web history
// panel) read the same rows.
//
// Metrics are telemetry, not workflow state: a row is not a Domain Operation
// and does not change the project revision. The write is in
// db/writers/unit-metrics.ts.

import { _getAdapter, isDbAvailable } from "../gsd-db.js";
import type { UnitMetrics } from "../metrics.js";

/**
 * Total cost of the stored unit runs in USD. With `sinceMs`, only the runs
 * that started at or after that time. With `unitScope` (`<MID>` or
 * `<MID>/<SID>`), only the runs of that Milestone or Slice. 0 when no database
 * is open.
 */
export function readUnitSpend(sinceMs?: number, unitScope?: string): number {
  if (!isDbAvailable()) return 0;
  const row = _getAdapter()!.prepare(
    `SELECT COALESCE(SUM(cost), 0) AS spend FROM unit_metrics
     WHERE started_at >= :since
       AND (:scope = '' OR unit_id = :scope OR substr(unit_id, 1, length(:scope) + 1) = :scope || '/')`,
  ).get({ ":since": sinceMs ?? 0, ":scope": unitScope ?? "" }) as { spend: number } | undefined;
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
