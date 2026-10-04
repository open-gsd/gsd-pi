// gsd-pi + Pre-execution failure of a slice plan on the dispatch row (ADR-048)
//
// The pre-execution check runs after a plan-slice or refine-slice dispatch.
// Its findings are a child row of that dispatch, so a restart reads the
// findings the last process wrote. The planner reads the findings of the
// newest planning dispatch of the slice. A new dispatch has no findings until
// its own check fails, so one failure reaches one re-plan only.

import { _getAdapter, isDbAvailable } from "../gsd-db.js";
import { deleteDispatchPreExecFailure, setDispatchPreExecFailure } from "./unit-dispatches.js";

export interface PreExecFailure {
  /** Verbatim blocking check strings from the failed check run. */
  blockingFindings: string[];
  /** Condensed verdict excerpt for context (status + rationale). */
  verdictExcerpt: string;
}

interface LatestPlanningDispatch {
  id: number;
  blocking_findings: string | null;
  verdict_excerpt: string | null;
}

/** The newest planning dispatch of the slice, with its findings when it has any. */
function latestPlanningDispatch(unitId: string): LatestPlanningDispatch | null {
  if (!isDbAvailable()) return null;
  const row = _getAdapter()!.prepare(
    `SELECT dispatch.id AS id,
            failure.blocking_findings AS blocking_findings,
            failure.verdict_excerpt AS verdict_excerpt
     FROM unit_dispatches dispatch
     LEFT JOIN unit_dispatch_pre_exec_failures failure ON failure.dispatch_id = dispatch.id
     WHERE dispatch.unit_id = :unit_id
       AND dispatch.unit_type IN ('plan-slice','refine-slice')
     ORDER BY dispatch.id DESC
     LIMIT 1`,
  ).get({ ":unit_id": unitId }) as LatestPlanningDispatch | undefined;
  return row ?? null;
}

/** The findings the next plan of the slice must fix, or null when there are none. */
export function readPreExecFailure(unitId: string): PreExecFailure | null {
  const row = latestPlanningDispatch(unitId);
  if (!row || row.blocking_findings === null || row.verdict_excerpt === null) return null;
  return {
    blockingFindings: JSON.parse(row.blocking_findings) as string[],
    verdictExcerpt: row.verdict_excerpt,
  };
}

/**
 * Store the findings on the newest planning dispatch of the slice. Returns
 * false when the slice has no dispatch row: there is no durable place for them.
 */
export function recordPreExecFailure(unitId: string, failure: PreExecFailure): boolean {
  const row = latestPlanningDispatch(unitId);
  if (!row) return false;
  setDispatchPreExecFailure(row.id, failure);
  return true;
}

/** The plan of the slice passed the check: drop the findings of its dispatch. */
export function clearPreExecFailure(unitId: string): void {
  const row = latestPlanningDispatch(unitId);
  if (row && row.blocking_findings !== null) deleteDispatchPreExecFailure(row.id);
}
