// GSD Extension — Undo Last Unit + Targeted State Reset
// handleUndo: Reopen the last completed unit from the DB ledger, then revert its git commits.
// handleUndoTask: Reopen one Task through canonical authority and re-render markdown.
// handleResetSlice: Reset a slice and all its tasks, re-rendering plan + roadmap.

import type { ExtensionCommandContext, ExtensionAPI } from "@gsd/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { nativeRevertCommit, nativeRevertAbort } from "./native-git-bridge.js";
import { removeProjectionFileSync } from "./atomic-write.js";
import { deriveState } from "./state.js";
import { invalidateAllCaches } from "./cache.js";
import { gsdRoot, resolveTasksDir, resolveTaskFile, buildTaskFileName } from "./paths.js";
import { sendDesktopNotification } from "./notifications.js";
import { getDb, getTask, getSlice, getSliceTasks, isDbAvailable } from "./gsd-db.js";
import { readMilestone, readSlice, readTask } from "./db/lifecycle-read.js";
import {
  getLifecycleLastOperationId,
  getSliceReopenOperationRow,
  getUndoTaskStateRow,
} from "./db/lifecycle-queries.js";
import { openExistingWorkflowDatabase } from "./db-workspace.js";
import { renderPlanCheckboxes } from "./markdown-renderer.js";
import { renderStateProjection } from "./workflow-projections.js";
import { reopenTask } from "./task-lifecycle-domain-operation.js";
import { internalExecutionInvocation } from "./execution-invocation.js";
import { normalizeLegacyLifecycleStatus } from "./db/lifecycle-shadow-comparison.js";
import { executeMilestoneReopen, executeSliceReopen } from "./tools/workflow-tool-executors.js";
import { isCurrentSliceReopenOperation } from "./slice-lifecycle-domain-operation.js";

const UNDO_TASK_REOPEN_REASON = "Task reopened by an explicit undo command";
const RESET_SLICE_REOPEN_REASON = "Slice reopened by an explicit full-redo reset command";

interface UndoTaskState {
  legacyStatus: string;
  completedAt: string | null;
  lifecycleId: string | null;
  lifecycleStatus: string | null;
  lifecycleOperationId: string | null;
}

function readUndoTaskState(mid: string, sid: string, tid: string): UndoTaskState {
  const entityId = `${mid}/${sid}/${tid}`;
  const row = getUndoTaskStateRow(mid, sid, tid);
  if (!row) throw new Error(`Task ${entityId} not found in database.`);
  return {
    legacyStatus: String(row.legacy_status),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    lifecycleId: row.lifecycle_id ? String(row.lifecycle_id) : null,
    lifecycleStatus: row.lifecycle_status ? String(row.lifecycle_status) : null,
    lifecycleOperationId: row.lifecycle_operation_id
      ? String(row.lifecycle_operation_id)
      : null,
  };
}

function taskStateDigest(
  mid: string,
  sid: string,
  tid: string,
  state: UndoTaskState,
): string {
  const completionIdentity = state.lifecycleOperationId ?? state.completedAt ?? `legacy:${state.legacyStatus}`;
  return createHash("sha256")
    .update(`${mid}/${sid}/${tid}\n${completionIdentity}`)
    .digest("hex");
}

function undoTaskIdempotencyKey(mid: string, sid: string, tid: string, state: UndoTaskState): string {
  return `internal:undo:task.reopen:${taskStateDigest(mid, sid, tid, state)}`;
}

function resolveResetSliceIdempotencyKey(mid: string, sid: string, status: string, completedAt: string | null): string {
  const lifecycle = getSliceReopenOperationRow(mid, sid);
  if (
    lifecycle?.lifecycle_status === "ready"
    && lifecycle.operation_type === "slice.reopen"
    && isCurrentSliceReopenOperation(String(lifecycle.last_operation_id), {
      milestoneId: mid,
      sliceId: sid,
    })
  ) {
    const payload = JSON.parse(String(lifecycle.payload_json)) as Record<string, unknown>;
    if (payload["reason"] === RESET_SLICE_REOPEN_REASON) {
      return String(lifecycle.idempotency_key);
    }
  }
  const terminalIdentity = lifecycle?.last_operation_id ?? completedAt ?? `legacy:${status}`;
  const digest = createHash("sha256").update(`${mid}/${sid}\n${terminalIdentity}`).digest("hex");
  return `internal:undo:slice.reopen:${digest}`;
}

function reopenTaskForUndo(mid: string, sid: string, tid: string): void {
  const state = readUndoTaskState(mid, sid, tid);
  const legacyStatus = normalizeLegacyLifecycleStatus(state.legacyStatus);
  if (state.lifecycleStatus === "ready" && legacyStatus === "pending") return;
  if (state.lifecycleStatus && state.lifecycleStatus !== legacyStatus) {
    throw new Error("Task undo requires matching legacy and canonical lifecycle heads");
  }
  reopenTask({
    invocation: internalExecutionInvocation(undoTaskIdempotencyKey(mid, sid, tid, state)),
    task: { milestoneId: mid, sliceId: sid, taskId: tid },
    reason: UNDO_TASK_REOPEN_REASON,
  });
}

/** Reopen a Task in the DB, then refresh its readable summary and plan. */
async function reopenTaskAndRefresh(basePath: string, mid: string, sid: string, tid: string): Promise<boolean> {
  reopenTaskForUndo(mid, sid, tid);

  // Delete readable summaries after the authoritative reopen. Legacy layouts
  // keep them under tasks/, while flat layouts resolve them beside the plan.
  let summaryDeleted = false;
  const summaryPaths = new Set<string>();
  const resolvedSummary = resolveTaskFile(basePath, mid, sid, tid, "SUMMARY");
  if (resolvedSummary) summaryPaths.add(resolvedSummary);
  const tasksDir = resolveTasksDir(basePath, mid, sid);
  if (tasksDir) summaryPaths.add(join(tasksDir, buildTaskFileName(tid, "SUMMARY")));
  for (const summaryPath of summaryPaths) {
    if (existsSync(summaryPath)) {
      removeProjectionFileSync(summaryPath);
      summaryDeleted = true;
    }
  }

  await renderPlanCheckboxes(basePath, mid, sid);
  invalidateAllCaches();
  return summaryDeleted;
}

// ─── Undo Last Unit ──────────────────────────────────────────────────────────
// The last completed Unit comes from the unit_dispatches ledger, and undo
// reopens its work item through the reopen Domain Operation. A Unit with no
// reopen operation is refused, never reported as undone.

const UNDO_UNIT_REOPEN_REASON = "Reopened by an explicit undo of the last completed unit";
const UNDO_TASK_UNIT_TYPES = new Set(["execute-task", "execute-task-simple"]);

interface CompletedUnit {
  unitType: string;
  unitId: string;
  milestoneId: string;
  sliceId: string | null;
  taskId: string | null;
}

export interface UndoUnitInfo {
  lastUnitType: string | null;
  lastUnitId: string | null;
  lastUnitKey: string | null;
  completedCount: number;
  commits: string[];
  /** The exact changes undo makes for this Unit, shown before the operator confirms. */
  effects: string[];
}

export interface UndoUnitResult {
  success: boolean;
  message: string;
}

/** Open the existing project DB when no session has opened it. Never creates one. */
function openUndoDatabase(basePath: string): string | null {
  if (isDbAvailable()) return null;
  const opened = openExistingWorkflowDatabase(basePath);
  return opened.ok ? null : `GSD database is not available (${opened.reason}); nothing can be undone.`;
}

function readCompletedUnits(): { last: CompletedUnit | null; count: number } {
  const db = getDb();
  const count = db.prepare(
    "SELECT COUNT(*) AS count FROM unit_dispatches WHERE status = 'completed'",
  ).get() as Record<string, unknown> | undefined;
  const row = db.prepare(`
    SELECT unit_type, unit_id, milestone_id, slice_id, task_id
    FROM unit_dispatches
    WHERE status = 'completed'
    ORDER BY ended_at DESC, id DESC
    LIMIT 1
  `).get() as Record<string, unknown> | undefined;
  return {
    count: Number(count?.["count"] ?? 0),
    last: row
      ? {
          unitType: String(row["unit_type"]),
          unitId: String(row["unit_id"]),
          milestoneId: String(row["milestone_id"]),
          sliceId: row["slice_id"] ? String(row["slice_id"]) : null,
          taskId: row["task_id"] ? String(row["task_id"]) : null,
        }
      : null,
  };
}

function unitCommits(basePath: string, unit: CompletedUnit): string[] {
  const activityDir = join(gsdRoot(basePath), "activity");
  return existsSync(activityDir) ? findCommitsForUnit(activityDir, unit.unitType, unit.unitId) : [];
}

function undoEffects(unit: CompletedUnit, commitCount: number): string[] {
  const { milestoneId: mid, sliceId: sid, taskId: tid } = unit;
  let effects: string[];
  if (UNDO_TASK_UNIT_TYPES.has(unit.unitType) && sid && tid) {
    effects = [
      `Reopen task ${mid}/${sid}/${tid} in the database (status pending)`,
      "Delete the task summary file",
    ];
  } else if (unit.unitType === "complete-slice" && sid) {
    effects = [
      `Reopen slice ${mid}/${sid} in the database`,
      `Reset ${getSliceTasks(mid, sid).length} task(s) of the slice to pending`,
      "Clear the slice summary and UAT in the database",
      "Delete the slice summary, slice UAT and task summary files",
    ];
  } else if (unit.unitType === "complete-milestone") {
    effects = [
      `Reopen milestone ${mid} in the database; its slices and tasks stay complete`,
      "Delete the milestone summary file",
    ];
  } else {
    return [`Change nothing: a ${unit.unitType} unit has no reopen operation, so undo refuses it`];
  }
  if (commitCount > 0) effects.push(`Attempt to revert ${commitCount} git commit(s) (staged, not committed)`);
  return effects;
}

/** Describe the Unit that /gsd undo and web undo would reopen. */
export async function describeLastCompletedUnit(basePath: string): Promise<UndoUnitInfo> {
  const empty: UndoUnitInfo = { lastUnitType: null, lastUnitId: null, lastUnitKey: null, completedCount: 0, commits: [], effects: [] };
  const dbError = openUndoDatabase(basePath);
  if (dbError) throw new Error(dbError);
  const { last, count } = readCompletedUnits();
  if (!last) return { ...empty, completedCount: count };
  const commits = unitCommits(basePath, last);
  return {
    lastUnitType: last.unitType,
    lastUnitId: last.unitId,
    lastUnitKey: `${last.unitType}/${last.unitId}`,
    completedCount: count,
    commits,
    effects: undoEffects(last, commits.length),
  };
}

function undoReopenKey(kind: string, entityId: string, terminalIdentity: string): string {
  const digest = createHash("sha256").update(`${entityId}\n${terminalIdentity}`).digest("hex");
  return `internal:undo:${kind}.reopen:${digest}`;
}

/** Reopen the last completed Unit in the DB, then revert its commits. */
export async function undoLastCompletedUnit(basePath: string): Promise<UndoUnitResult> {
  const dbError = openUndoDatabase(basePath);
  if (dbError) return { success: false, message: dbError };
  const { last: unit } = readCompletedUnits();
  if (!unit) return { success: false, message: "Nothing to undo — no completed unit is recorded in the database." };
  const label = `${unit.unitType} (${unit.unitId})`;
  const { milestoneId: mid, sliceId: sid, taskId: tid } = unit;
  const results: string[] = [`Undone: ${label}`];

  if (UNDO_TASK_UNIT_TYPES.has(unit.unitType) && sid && tid) {
    const task = readTask(mid, sid, tid);
    if (!task) return { success: false, message: `Cannot undo ${label}: task not found in database.` };
    if (!task.done) return { success: false, message: `Nothing to undo — ${label} is already open.` };
    let summaryDeleted: boolean;
    try {
      summaryDeleted = await reopenTaskAndRefresh(basePath, mid, sid, tid);
    } catch (error) {
      return { success: false, message: `Cannot undo ${label}: ${error instanceof Error ? error.message : String(error)}` };
    }
    results.push(`  - Reopened task ${mid}/${sid}/${tid} in the database`);
    if (summaryDeleted) results.push("  - Deleted task summary file");
  } else if (unit.unitType === "complete-slice" && sid) {
    const slice = readSlice(mid, sid);
    if (!slice) return { success: false, message: `Cannot undo ${label}: slice not found in database.` };
    if (!slice.closed) return { success: false, message: `Nothing to undo — ${label} is already open.` };
    const terminal = getLifecycleLastOperationId("slice", mid, sid) ?? slice.completed_at ?? `legacy:${slice.status}`;
    const result = await executeSliceReopen(
      { milestoneId: mid, sliceId: sid, reason: UNDO_UNIT_REOPEN_REASON },
      basePath,
      internalExecutionInvocation(undoReopenKey("slice", `${mid}/${sid}`, terminal)),
    );
    if (result.isError) {
      return { success: false, message: `Cannot undo ${label}: ${String(result.details["error"] ?? result.content[0]?.text)}` };
    }
    results.push(`  - Reopened slice ${mid}/${sid} in the database`);
  } else if (unit.unitType === "complete-milestone") {
    const milestone = readMilestone(mid);
    if (!milestone) return { success: false, message: `Cannot undo ${label}: milestone not found in database.` };
    if (!milestone.closed) return { success: false, message: `Nothing to undo — ${label} is already open.` };
    const terminal = getLifecycleLastOperationId("milestone", mid, null) ?? milestone.completed_at ?? `legacy:${milestone.status}`;
    // Undo reverses only the complete-milestone Unit: slices, tasks and their
    // summaries stay complete.
    const result = await executeMilestoneReopen(
      { milestoneId: mid, reason: UNDO_UNIT_REOPEN_REASON, keepCompleted: true },
      basePath,
      internalExecutionInvocation(undoReopenKey("milestone", mid, terminal)),
    );
    if (result.isError) {
      return { success: false, message: `Cannot undo ${label}: ${String(result.details["error"] ?? result.content[0]?.text)}` };
    }
    results.push(`  - Reopened milestone ${mid} in the database`);
  } else {
    return {
      success: false,
      message: `Cannot undo ${label}: only execute-task, complete-slice and complete-milestone units have a reopen operation.`,
    };
  }

  // Git commits are evidence of the Unit's work, not workflow state. Revert
  // them best-effort only after the DB reopen has committed.
  let commitsReverted = 0;
  try {
    for (const sha of unitCommits(basePath, unit).reverse()) {
      try {
        nativeRevertCommit(basePath, sha);
        commitsReverted++;
      } catch {
        // Revert conflict or already reverted — skip
        try { nativeRevertAbort(basePath); } catch { /* no-op */ }
        break;
      }
    }
  } finally {
    // Re-render STATE.md — always invalidate caches even if git operations fail
    invalidateAllCaches();
    await renderStateProjection(basePath);
  }
  if (commitsReverted > 0) {
    results.push(`  - Reverted ${commitsReverted} commit(s) (staged, not committed)`);
    results.push(`  Review with 'git diff --cached' then 'git commit' or 'git reset HEAD'`);
  }
  return { success: true, message: results.join("\n") };
}

/** /gsd undo: reopen the last completed Unit after an explicit --force. */
export async function handleUndo(args: string, ctx: ExtensionCommandContext, _pi: ExtensionAPI, basePath: string): Promise<void> {
  if (!args.includes("--force")) {
    const dbError = openUndoDatabase(basePath);
    if (dbError) {
      ctx.ui.notify(dbError, "warning");
      return;
    }
    const info = await describeLastCompletedUnit(basePath);
    if (!info.lastUnitType) {
      ctx.ui.notify("Nothing to undo — no completed unit is recorded in the database.", "info");
      return;
    }
    ctx.ui.notify(
      `Will undo: ${info.lastUnitType} (${info.lastUnitId})\n` +
      `This will:\n` +
      info.effects.map((effect) => `  - ${effect}\n`).join("") +
      `\nRun /gsd undo --force to confirm.`,
      "warning",
    );
    return;
  }

  const result = await undoLastCompletedUnit(basePath);
  ctx.ui.notify(result.message, result.success ? "success" : "warning");
  if (result.success) {
    sendDesktopNotification("GSD", result.message.split("\n")[0], "info", "complete", basename(basePath));
  }
}

// ─── Targeted State Reset ────────────────────────────────────────────────────

/**
 * Parse a task identifier from args. Accepts:
 *   T01, S01/T01, M001/S01/T01
 * Resolves missing parts from current state via deriveState().
 */
async function parseTaskId(
  raw: string,
  basePath: string,
): Promise<{ mid: string; sid: string; tid: string } | string> {
  const parts = raw.split("/");
  if (parts.length === 3) {
    return { mid: parts[0], sid: parts[1], tid: parts[2] };
  }
  // Need to resolve from state
  const state = await deriveState(basePath);
  if (parts.length === 2) {
    // S01/T01 — resolve milestone
    const mid = state.activeMilestone?.id;
    if (!mid) return "Cannot resolve milestone — no active milestone in state.";
    return { mid, sid: parts[0], tid: parts[1] };
  }
  if (parts.length === 1) {
    // T01 — resolve milestone + slice
    const mid = state.activeMilestone?.id;
    const sid = state.activeSlice?.id;
    if (!mid) return "Cannot resolve milestone — no active milestone in state.";
    if (!sid) return "Cannot resolve slice — no active slice in state.";
    return { mid, sid, tid: parts[0] };
  }
  return "Invalid task ID format. Use T01, S01/T01, or M001/S01/T01.";
}

/**
 * Parse a slice identifier from args. Accepts:
 *   S01, M001/S01
 * Resolves missing milestone from current state.
 */
async function parseSliceId(
  raw: string,
  basePath: string,
): Promise<{ mid: string; sid: string } | string> {
  const parts = raw.split("/");
  if (parts.length === 2) {
    return { mid: parts[0], sid: parts[1] };
  }
  if (parts.length === 1) {
    const state = await deriveState(basePath);
    const mid = state.activeMilestone?.id;
    if (!mid) return "Cannot resolve milestone — no active milestone in state.";
    return { mid, sid: parts[0] };
  }
  return "Invalid slice ID format. Use S01 or M001/S01.";
}

/**
 * Reset a single task's completion state:
 * - Reopen the canonical lifecycle to ready and its legacy shadow to pending
 * - Delete the task summary file
 * - Re-render plan checkboxes
 */
export async function handleUndoTask(
  args: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  basePath: string,
): Promise<void> {
  const force = args.includes("--force");
  const rawId = args.replace("--force", "").trim();

  if (!rawId) {
    ctx.ui.notify(
      "Usage: /gsd undo-task <taskId> [--force]\n\n" +
      "Accepts: T01, S01/T01, or M001/S01/T01\n" +
      "Reopens the task for execution and re-renders plan checkboxes.",
      "warning",
    );
    return;
  }

  const parsed = await parseTaskId(rawId, basePath);
  if (typeof parsed === "string") {
    ctx.ui.notify(parsed, "error");
    return;
  }

  const { mid, sid, tid } = parsed;

  // Validate task exists in DB
  const task = getTask(mid, sid, tid);
  if (!task) {
    ctx.ui.notify(`Task ${mid}/${sid}/${tid} not found in database.`, "error");
    return;
  }

  if (!force) {
    ctx.ui.notify(
      `Will reset: task ${mid}/${sid}/${tid}\n` +
      `  Current status: ${task.status}\n` +
      `This will:\n` +
      `  - Reopen task status to "ready" in DB\n` +
      `  - Delete task summary file (if exists)\n` +
      `  - Re-render plan checkboxes\n\n` +
      `Run /gsd undo-task ${rawId} --force to confirm.`,
      "warning",
    );
    return;
  }

  const summaryDeleted = await reopenTaskAndRefresh(basePath, mid, sid, tid);
  await renderStateProjection(basePath);

  const results: string[] = [`Reset task ${mid}/${sid}/${tid} to "pending".`];
  if (summaryDeleted) results.push("  - Deleted task summary file");
  results.push("  - Plan checkboxes re-rendered");

  ctx.ui.notify(results.join("\n"), "success");
}

/**
 * Reset a slice and all its tasks:
 * - Set all task DB statuses to "pending"
 * - Set slice DB status to "in_progress"
 * - Delete task summary files, slice summary, and UAT files
 * - Re-render plan + roadmap checkboxes
 */
export async function handleResetSlice(
  args: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  basePath: string,
): Promise<void> {
  const force = args.includes("--force");
  const rawId = args.replace("--force", "").trim();

  if (!rawId) {
    ctx.ui.notify(
      "Usage: /gsd reset-slice <sliceId> [--force]\n\n" +
      "Accepts: S01 or M001/S01\n" +
      "Resets the slice and all its tasks, re-renders plan + roadmap checkboxes.",
      "warning",
    );
    return;
  }

  const parsed = await parseSliceId(rawId, basePath);
  if (typeof parsed === "string") {
    ctx.ui.notify(parsed, "error");
    return;
  }

  const { mid, sid } = parsed;

  // Validate slice exists in DB
  const slice = getSlice(mid, sid);
  if (!slice) {
    ctx.ui.notify(`Slice ${mid}/${sid} not found in database.`, "error");
    return;
  }

  const tasks = getSliceTasks(mid, sid);

  if (!force) {
    ctx.ui.notify(
      `Will reset: slice ${mid}/${sid}\n` +
      `  Current status: ${slice.status}\n` +
      `  Tasks to reset: ${tasks.length}\n` +
      `This will:\n` +
      `  - Set all task statuses to "pending" in DB\n` +
      `  - Set slice status to "in_progress" in DB\n` +
      `  - Delete task summary files, slice summary, and UAT files\n` +
      `  - Re-render plan + roadmap checkboxes\n\n` +
      `Run /gsd reset-slice ${rawId} --force to confirm.`,
      "warning",
    );
    return;
  }

  const result = await executeSliceReopen(
    { milestoneId: mid, sliceId: sid, reason: RESET_SLICE_REOPEN_REASON },
    basePath,
    internalExecutionInvocation(resolveResetSliceIdempotencyKey(mid, sid, slice.status, slice.completed_at)),
  );
  if (result.isError) {
    ctx.ui.notify(String(result.details["error"] ?? result.content[0]?.text ?? "Slice reset failed"), "error");
    return;
  }

  const duplicate = result.details["duplicate"] === true;
  const superseded = result.details["superseded"] === true;
  const stale = result.details["stale"] === true;
  if (superseded) {
    ctx.ui.notify([
      `Reset receipt for slice ${mid}/${sid} is no longer current.`,
      `  - ${String(result.details["tasksReset"] ?? tasks.length)} historical task reset(s) recorded`,
      "  - Slice projections were not refreshed",
    ].join("\n"), "warning");
    return;
  }

  ctx.ui.notify([
    duplicate
      ? `Reused the current reset for slice ${mid}/${sid}.`
      : `Reset slice ${mid}/${sid} to "in_progress".`,
    `  - ${String(result.details["tasksReset"] ?? tasks.length)} task(s) reset to "pending"`,
    stale
      ? "  - Slice projection refresh is pending repair"
      : "  - Slice projections refreshed",
  ].join("\n"), stale ? "warning" : "success");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function findCommitsForUnit(activityDir: string, unitType: string, unitId: string): string[] {
  const safeUnitId = unitId.replace(/\//g, "-");
  const commitSet = new Set<string>();
  const commits: string[] = [];

  try {
    const files = readdirSync(activityDir)
      .filter(f => f.includes(unitType) && f.includes(safeUnitId) && f.endsWith(".jsonl"))
      .sort()
      .reverse();

    if (files.length === 0) return [];

    // Parse the most recent activity log for this unit
    const content = readFileSync(join(activityDir, files[0]), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        // Look for tool results containing git commit output
        if (entry?.message?.content) {
          const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
          for (const block of blocks) {
            if (block.type === "tool_result" && typeof block.content === "string") {
              for (const sha of extractCommitShas(block.content)) {
                if (!commitSet.has(sha)) {
                  commitSet.add(sha);
                  commits.push(sha);
                }
              }
            }
          }
        }
      } catch { /* malformed JSON line — skip */ }
    }
  } catch { /* activity dir issues — skip */ }

  return commits;
}

export function extractCommitShas(content: string): string[] {
  const seen = new Set<string>();
  const commits: string[] = [];
  for (const match of content.matchAll(/\[[\w/.-]+\s+([a-f0-9]{7,40})\]/g)) {
    const sha = match[1];
    if (sha && !seen.has(sha)) {
      seen.add(sha);
      commits.push(sha);
    }
  }
  return commits;
}
