// Project/App: gsd-pi
// File Purpose: Single-writer layer for post-unit hook gate verdict rows
// (P18d). Owns the write SQL of the hook-gate assessment rows;
// db/hook-verdicts.ts reads them.

import { getDb, isDbAvailable, transaction } from "../engine.js";
import { hookGateVerdictPath } from "../hook-verdicts.js";

/**
 * Store the verdict a post-unit hook recorded for its trigger unit. The row
 * is idempotent per (hook, trigger unit): a re-recorded verdict overwrites
 * the earlier one, so a re-run gate replaces its stale verdict.
 */
export function upsertHookGateVerdict(entry: {
  hookName: string;
  unitId: string;
  milestoneId: string;
  sliceId?: string | null;
  taskId?: string | null;
  verdict: string;
  rationale: string;
}): void {
  transaction(() => getDb().prepare(
    `INSERT OR REPLACE INTO assessments (path, milestone_id, slice_id, task_id, status, scope, full_content, created_at)
     VALUES (:path, :mid, :sid, :tid, :status, 'hook-gate', :rationale, :created_at)`,
  ).run({
    ":path": hookGateVerdictPath(entry.hookName, entry.unitId),
    ":mid": entry.milestoneId,
    ":sid": entry.sliceId ?? null,
    ":tid": entry.taskId ?? null,
    ":status": entry.verdict,
    ":rationale": entry.rationale,
    ":created_at": new Date().toISOString(),
  }));
}

/**
 * Delete the verdict row of one (hook, trigger unit). Dispatching the hook
 * calls this: the verdict belongs to one attempt, so a re-dispatched hook
 * that never records its verdict (crash, tool error, omitted call) cannot
 * decide its gate on the previous attempt's row — a stale pass would skip
 * the gate and a stale needs-rework would route rework.
 */
export function deleteHookGateVerdict(hookName: string, unitId: string): void {
  if (!isDbAvailable()) return;
  transaction(() => getDb().prepare(
    `DELETE FROM assessments WHERE path = :path AND scope = 'hook-gate'`,
  ).run({ ":path": hookGateVerdictPath(hookName, unitId) }));
}
