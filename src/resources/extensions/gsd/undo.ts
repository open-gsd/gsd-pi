// GSD Extension — Undo Last Unit + Targeted State Reset
// handleUndo: Rollback the most recent completed unit (revert git, remove state, uncheck plans).
// handleUndoTask: Reopen one Task through canonical authority and re-render markdown.
// handleResetSlice: Reset a slice and all its tasks, re-rendering plan + roadmap.

import type { ExtensionCommandContext, ExtensionAPI } from "@gsd/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { nativeRevertCommit, nativeRevertAbort } from "./native-git-bridge.js";
import { atomicWriteSync, removeProjectionFileSync } from "./atomic-write.js";
import { parseUnitId } from "./unit-id.js";
import { deriveState } from "./state.js";
import { invalidateAllCaches } from "./cache.js";
import { gsdRoot, resolveTasksDir, resolveSlicePath, resolveTaskFile, buildTaskFileName } from "./paths.js";
import { sendDesktopNotification } from "./notifications.js";
import { getDb, getTask, getSlice, getSliceTasks } from "./gsd-db.js";
import { renderPlanCheckboxes } from "./markdown-renderer.js";
import { UNIT_REGISTRY } from "./unit-registry.js";
import { reopenTask } from "./task-lifecycle-domain-operation.js";
import { internalExecutionInvocation } from "./execution-invocation.js";
import { normalizeLegacyLifecycleStatus } from "./db/lifecycle-shadow-comparison.js";
import { executeSliceReopen } from "./tools/workflow-tool-executors.js";
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
  const row = getDb().prepare(`
    SELECT task.status AS legacy_status,
           task.completed_at,
           lifecycle.lifecycle_id,
           lifecycle.lifecycle_status,
           lifecycle.last_operation_id AS lifecycle_operation_id
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task'
     AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id
     AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id
      AND task.slice_id = :slice_id
      AND task.id = :task_id
  `).get({
    ":milestone_id": mid,
    ":slice_id": sid,
    ":task_id": tid,
  }) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Task ${entityId} not found in database.`);
  return {
    legacyStatus: String(row["legacy_status"]),
    completedAt: row["completed_at"] ? String(row["completed_at"]) : null,
    lifecycleId: row["lifecycle_id"] ? String(row["lifecycle_id"]) : null,
    lifecycleStatus: row["lifecycle_status"] ? String(row["lifecycle_status"]) : null,
    lifecycleOperationId: row["lifecycle_operation_id"]
      ? String(row["lifecycle_operation_id"])
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
  const lifecycle = getDb().prepare(`
    SELECT lifecycle.lifecycle_status, lifecycle.last_operation_id,
           operation.operation_type, operation.idempotency_key, event.payload_json
    FROM workflow_item_lifecycles lifecycle
    LEFT JOIN workflow_operations operation
      ON operation.operation_id = lifecycle.last_operation_id
    LEFT JOIN workflow_domain_events event
      ON event.operation_id = operation.operation_id
     AND event.event_type = 'slice.reopened'
    WHERE lifecycle.item_kind = 'slice'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id IS NULL
  `).get({
    ":milestone_id": mid,
    ":slice_id": sid,
  }) as Record<string, unknown> | undefined;
  if (
    lifecycle?.["lifecycle_status"] === "ready"
    && lifecycle["operation_type"] === "slice.reopen"
    && isCurrentSliceReopenOperation(String(lifecycle["last_operation_id"]), {
      milestoneId: mid,
      sliceId: sid,
    })
  ) {
    const payload = JSON.parse(String(lifecycle["payload_json"])) as Record<string, unknown>;
    if (payload["reason"] === RESET_SLICE_REOPEN_REASON) {
      return String(lifecycle["idempotency_key"]);
    }
  }
  const terminalIdentity = lifecycle?.["last_operation_id"] ?? completedAt ?? `legacy:${status}`;
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

/**
 * Undo the last completed unit: revert git commits,
 * delete summary artifacts, and uncheck the task in PLAN.
 * deriveState() handles re-derivation after revert.
 */
export async function handleUndo(args: string, ctx: ExtensionCommandContext, _pi: ExtensionAPI, basePath: string): Promise<void> {
  const force = args.includes("--force");

  // Find the last GSD-related commit from git activity logs
  const activityDir = join(gsdRoot(basePath), "activity");
  if (!existsSync(activityDir)) {
    ctx.ui.notify("Nothing to undo — no activity logs found.", "info");
    return;
  }

  // Parse activity logs to find the most recent unit
  const files = readdirSync(activityDir)
    .filter(f => f.endsWith(".jsonl"))
    .sort()
    .reverse();

  if (files.length === 0) {
    ctx.ui.notify("Nothing to undo — no activity logs found.", "info");
    return;
  }

  // Extract unit type and ID from the most recent activity log filename.
  // Both the unit type and the unit ID may contain hyphens, so anchor on the
  // known unit-type vocabulary instead of guessing the unit-ID shape: a regex
  // tuned to milestone-shaped IDs rejects project-level units whose IDs are
  // symbolic (e.g. discuss-project uses PROJECT, workflow-preferences uses
  // WORKFLOW-PREFS).
  const parsed = parseActivityLogFilename(files[0]);
  if (!parsed) {
    ctx.ui.notify("Nothing to undo — could not parse latest activity log.", "warning");
    return;
  }

  const unitType = parsed.unitType;
  const unitId = parsed.unitId.replace(/-/g, "/");

  if (!force) {
    ctx.ui.notify(
      `Will undo: ${unitType} (${unitId})\n` +
      `This will:\n` +
      `  - Delete summary artifacts\n` +
      `  - Uncheck task in PLAN (if execute-task)\n` +
      `  - Attempt to revert associated git commits\n\n` +
      `Run /gsd undo --force to confirm.`,
      "warning",
    );
    return;
  }

  // 1. Reopen canonical Task authority before updating readable artifacts.
  const { milestone, slice, task } = parseUnitId(unitId);
  if (unitType === "execute-task" && task !== undefined && slice !== undefined &&
      getTask(milestone, slice, task)) {
    reopenTaskForUndo(milestone, slice, task);
  }

  // 2. Delete summary artifact
  let summaryRemoved = false;
  if (task !== undefined && slice !== undefined) {
    // Task-level: M001/S01/T01
    const [mid, sid, tid] = [milestone, slice, task];
    const tasksDir = resolveTasksDir(basePath, mid, sid);
    if (tasksDir) {
      const summaryFile = join(tasksDir, buildTaskFileName(tid, "SUMMARY"));
      if (existsSync(summaryFile)) {
        removeProjectionFileSync(summaryFile);
        summaryRemoved = true;
      }
    }
  } else if (slice !== undefined) {
    // Slice-level: M001/S01
    const [mid, sid] = [milestone, slice];
    const slicePath = resolveSlicePath(basePath, mid, sid);
    if (slicePath) {
      for (const suffix of ["SUMMARY", "COMPLETE"]) {
        const candidates = findFileWithPrefix(slicePath, sid, suffix);
        for (const f of candidates) {
          removeProjectionFileSync(f);
          summaryRemoved = true;
        }
      }
    }
  }

  // 3. Uncheck task in PLAN if execute-task
  let planUpdated = false;
  if (unitType === "execute-task" && task !== undefined && slice !== undefined) {
    const [mid, sid, tid] = [milestone, slice, task];
    planUpdated = uncheckTaskInPlan(basePath, mid, sid, tid);
    if (getTask(mid, sid, tid)) {
      await renderPlanCheckboxes(basePath, mid, sid);
      planUpdated = true;
    }
  }

  // 4. Try to revert git commits from activity log
  let commitsReverted = 0;
  try {
    const commits = findCommitsForUnit(activityDir, unitType, unitId);
    if (commits.length > 0) {
      for (const sha of commits.reverse()) {
        try {
          nativeRevertCommit(basePath, sha);
          commitsReverted++;
        } catch {
          // Revert conflict or already reverted — skip
          try { nativeRevertAbort(basePath); } catch { /* no-op */ }
          break;
        }
      }
    }
  } finally {
    // 4. Re-derive state — always invalidate caches even if git operations fail
    invalidateAllCaches();
    await deriveState(basePath);
  }

  // Build result message
  const results: string[] = [`Undone: ${unitType} (${unitId})`];
  if (summaryRemoved) results.push(`  - Deleted summary artifact`);
  if (planUpdated) results.push(`  - Unchecked task in PLAN`);
  if (commitsReverted > 0) {
    results.push(`  - Reverted ${commitsReverted} commit(s) (staged, not committed)`);
    results.push(`  Review with 'git diff --cached' then 'git commit' or 'git reset HEAD'`);
  }

  ctx.ui.notify(results.join("\n"), "success");
  sendDesktopNotification("GSD", `Undone: ${unitType} (${unitId})`, "info", "complete", basename(basePath));
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

  // Re-render plan checkboxes
  await renderPlanCheckboxes(basePath, mid, sid);

  // Invalidate caches
  invalidateAllCaches();

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

// Known unit types sorted longest-first so a more specific type (e.g.
// "execute-task-simple") matches before a prefix of it ("execute-task") when
// splitting "<seq>-<unitType>-<unitId>.jsonl".
const UNIT_TYPES_BY_LENGTH_DESC: readonly string[] = Object.keys(UNIT_REGISTRY).sort(
  (a, b) => b.length - a.length,
);

/**
 * Parse an activity-log filename of the form `<seq>-<unitType>-<unitId>.jsonl`
 * (the format written by activity-log.ts). Both the unit type and the unit ID
 * may contain hyphens, so we anchor on the known unit-type vocabulary rather
 * than guessing the ID shape. This keeps non-milestone IDs (e.g. PROJECT,
 * WORKFLOW-PREFS) parseable. Returns null when the name has no sequence prefix
 * or does not start with a recognised unit type.
 */
export function parseActivityLogFilename(
  filename: string,
): { unitType: string; unitId: string } | null {
  const seqMatch = filename.match(/^\d+-(.+)\.jsonl$/);
  if (!seqMatch) return null;
  const rest = seqMatch[1];
  for (const unitType of UNIT_TYPES_BY_LENGTH_DESC) {
    const prefix = `${unitType}-`;
    if (rest.startsWith(prefix)) {
      const unitId = rest.slice(prefix.length);
      if (unitId.length > 0) return { unitType, unitId };
    }
  }
  return null;
}

export function uncheckTaskInPlan(basePath: string, mid: string, sid: string, tid: string): boolean {
  const slicePath = resolveSlicePath(basePath, mid, sid);
  if (!slicePath) return false;

  // Find the PLAN file
  const planCandidates = findFileWithPrefix(slicePath, sid, "PLAN");
  if (planCandidates.length === 0) return false;

  const planFile = planCandidates[0];
  let content = readFileSync(planFile, "utf-8");

  // Match checked task line: - [x] **T01** or - [x] T01:
  const regex = new RegExp(`^(\\s*-\\s*)\\[x\\](\\s*\\**${tid}\\**[:\\s])`, "mi");
  if (regex.test(content)) {
    content = content.replace(regex, "$1[ ]$2");
    atomicWriteSync(planFile, content);
    return true;
  }
  return false;
}

function findFileWithPrefix(dir: string, prefix: string, suffix: string): string[] {
  try {
    const files = readdirSync(dir);
    return files
      .filter(f => f.includes(suffix) && (f.startsWith(prefix) || f.startsWith(`${prefix}-`)))
      .map(f => join(dir, f));
  } catch {
    return [];
  }
}

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
