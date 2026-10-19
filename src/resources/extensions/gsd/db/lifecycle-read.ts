// Project/App: gsd-pi
// File Purpose: The read interface for status, phase, dispatch-eligibility
// and dependency decisions (ADR-046). deriveState, the dispatch guard,
// resolveDispatch, the already-closed dispatch check, the queue commands, the
// auto start and stop completion checks, the closeout, recovery, post-unit and
// verification checks, the preconditions of the planning and completion
// commands, the status response, progress, the project snapshot and the
// dashboards ask their status questions here. It also answers which
// Milestones exist (`readListedMilestoneIds`).
// The project Authority Epoch chooses the read source, in `cutoverHasRun`
// only: canonical lifecycle rows and Waivers after the Cutover, legacy status
// rows (D005) before it. The choice is per Project, never per item.
// The sites that only render or display a status, and the legacy-only paths,
// still read legacy rows directly; docs/dev/state-db-cutover-milestone-decision.md
// (D012) lists them.

import type { DbAdapter } from "../db-adapter.js";
import { getDb } from "./engine.js";
import { compareLifecycleShadow } from "./lifecycle-shadow-comparison.js";
import {
  getAllMilestones,
  getContextArtifactMilestoneIds,
  getHierarchyCompletionCounts,
  getInFlightSliceCount,
  getMilestone,
  getMilestoneSlices,
  getMilestoneStatusCounts,
  getOpenBlockers,
  getOpenQuestions,
  getProjectAuthorityRow,
  getSliceCountsByMilestoneId,
  getSliceStatusSummary,
  getSliceTaskCounts,
  getSliceTasks,
  getSlicesByMilestoneIds,
  type MilestoneStatusCounts,
  type OpenBlockerRow,
  type OpenQuestionRow,
} from "./queries.js";
import {
  isClosedStatus,
  isDiscardedMilestoneStatus,
  isInactiveStatus,
  normalizeLegacyLifecycleStatus,
} from "../status-guards.js";
import type { TaskStatusCounts } from "../db-lightweight-query-rows.js";
import type { MilestoneRow } from "../db-milestone-artifact-rows.js";
import type { SliceRow, TaskRow } from "../db-task-slice-rows.js";

export interface MilestoneRead extends MilestoneRow {
  /** Complete. Only a done Milestone satisfies its dependents. A discarded Milestone is never done. */
  readonly done: boolean;
  /** Takes no further work: done, skipped or cancelled. */
  readonly closed: boolean;
  readonly parked: boolean;
  /** A tombstone that keeps the id reserved. It is not listed and not dispatched. */
  readonly discarded: boolean;
  /**
   * The status in the canonical lifecycle vocabulary, for external contracts.
   * After the Cutover it is the status of the lifecycle row (pending when
   * there is none). Before it, it is the legacy status mapped to that
   * vocabulary; null when the legacy status is not in the map.
   */
  readonly lifecycleStatus: string | null;
  /**
   * A queued shell: the Milestone row is ready and no planning is behind it —
   * no CONTEXT artifact row and no Slice rows. The lifecycle vocabulary has no
   * word for queued, so this field answers the readiness class directly:
   * after the Cutover the lifecycle status `ready` decides, before it the
   * legacy status `queued` does.
   */
  readonly queuedShell: boolean;
}

export interface SliceRead extends SliceRow {
  /** Needs no further work: closed, or deferred by a decision. */
  readonly done: boolean;
  /**
   * Closed: complete or cancelled. Before the Cutover a deferred Slice is not
   * closed (the legacy rule). After the Cutover this is `done`.
   */
  readonly closed: boolean;
  /**
   * Releases the Slices that depend on it. Before the Cutover this is `done`.
   * After the Cutover a cancelled Slice releases them only with an active
   * cancellation Waiver.
   */
  readonly satisfiesDependents: boolean;
}

export interface TaskRead extends TaskRow {
  /** Needs no further work. */
  readonly done: boolean;
}

/**
 * The one place that chooses the read source. An Authority Epoch above 0 means
 * the Cutover has run: every answer of this module then comes from the
 * canonical lifecycle rows. Before that every answer comes from the legacy
 * status rows. `db` is a connection other than the open one.
 */
function cutoverHasRun(db?: DbAdapter): boolean {
  const authorityEpoch = db
    ? db.prepare("SELECT authority_epoch FROM project_authority WHERE singleton = 1").get()?.["authority_epoch"]
    : getProjectAuthorityRow()?.authorityEpoch;
  return Number(authorityEpoch ?? 0) > 0;
}

type ItemKind = "milestone" | "slice" | "task";

/** One hierarchy row as the canonical lifecycle rows describe it. */
interface LifecycleItem {
  /** The status of the legacy row. It is a label only and decides nothing. */
  legacyStatus: string;
  /** Null when the row has no lifecycle row: no work on it is recorded. */
  lifecycleStatus: string | null;
  /** A Slice with an active cancellation Waiver. */
  waived: boolean;
}

type LifecycleItems = Map<string, LifecycleItem>;

const HIERARCHY_SQL = {
  milestone: { table: "milestones", milestone: "hierarchy.id", slice: "NULL", task: "NULL" },
  slice: { table: "slices", milestone: "hierarchy.milestone_id", slice: "hierarchy.id", task: "NULL" },
  task: { table: "tasks", milestone: "hierarchy.milestone_id", slice: "hierarchy.slice_id", task: "hierarchy.id" },
} as const;

/**
 * The lifecycle of every row of one hierarchy table, keyed by item path
 * (`M001`, `M001/S01`, `M001/S01/T01`). Read only after the Cutover.
 */
function readLifecycleItems(
  kind: ItemKind,
  milestoneId?: string,
  sliceId?: string,
  db: DbAdapter = getDb(),
): LifecycleItems {
  const sql = HIERARCHY_SQL[kind];
  const rows = db.prepare(`
    SELECT ${sql.milestone} AS milestone_id, ${sql.slice} AS slice_id, ${sql.task} AS task_id,
           hierarchy.status AS legacy_status, lifecycle.lifecycle_status,
           EXISTS (
             SELECT 1 FROM workflow_waivers waiver
             WHERE waiver.lifecycle_id = lifecycle.lifecycle_id
               AND waiver.project_id = lifecycle.project_id
               AND waiver.waiver_status = 'active'
               AND waiver.scope = 'slice:' || lifecycle.milestone_id || '/' || lifecycle.slice_id
               AND (waiver.expires_at IS NULL OR waiver.expires_at > :now)
           ) AS waived
    FROM ${sql.table} hierarchy
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = '${kind}'
     AND lifecycle.milestone_id = ${sql.milestone}
     AND lifecycle.slice_id IS ${sql.slice}
     AND lifecycle.task_id IS ${sql.task}
     AND lifecycle.project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)
    WHERE (:milestone_id IS NULL OR ${sql.milestone} = :milestone_id)
      AND (:slice_id IS NULL OR ${sql.slice} = :slice_id)
  `).all({
    ":now": new Date().toISOString(),
    ":milestone_id": milestoneId ?? null,
    ":slice_id": sliceId ?? null,
  });
  return new Map(rows.map((row) => [
    [row["milestone_id"], row["slice_id"], row["task_id"]].filter((id) => id != null).join("/"),
    {
      legacyStatus: String(row["legacy_status"]),
      lifecycleStatus: typeof row["lifecycle_status"] === "string" ? row["lifecycle_status"] : null,
      waived: Number(row["waived"]) === 1,
    },
  ]));
}

/** The legacy label of each lifecycle status, for a legacy row that names another status. */
const LIFECYCLE_LABEL: Readonly<Record<string, string>> = {
  pending: "pending",
  ready: "pending",
  in_progress: "in_progress",
  paused: "blocked",
  completed: "complete",
  cancelled: "skipped",
  "blocker-accepted": "blocker-accepted",
};
const MILESTONE_LIFECYCLE_LABEL: Readonly<Record<string, string>> = {
  ...LIFECYCLE_LABEL,
  ready: "active",
  in_progress: "active",
  paused: "parked",
};

/**
 * The status label after the Cutover. The lifecycle row decides it. The legacy
 * label stays when it names the same lifecycle status, because the lifecycle
 * vocabulary has no word for queued, active, parked or deferred. A row with no
 * lifecycle row is pending.
 */
function statusLabel(kind: ItemKind, item: LifecycleItem | undefined): string {
  const lifecycleStatus = item?.lifecycleStatus ?? null;
  if (!item || lifecycleStatus === null) return "pending";
  const agreement = compareLifecycleShadow(item.legacyStatus, lifecycleStatus).kind;
  if (agreement === "match" || agreement === "semantic_match_exact_delta") return item.legacyStatus;
  return (kind === "milestone" ? MILESTONE_LIFECYCLE_LABEL : LIFECYCLE_LABEL)[lifecycleStatus] ?? lifecycleStatus;
}

/** Completed, or closed by an accepted blocker. */
function isComplete(item: LifecycleItem | undefined): boolean {
  return item?.lifecycleStatus === "completed" || item?.lifecycleStatus === "blocker-accepted";
}

function isCancelled(item: LifecycleItem | undefined): boolean {
  return item?.lifecycleStatus === "cancelled";
}

/**
 * The queued-shell inputs of one read: which read source answers, which
 * Milestones have a CONTEXT artifact row, and how many Slices each has.
 */
interface ShellContext {
  cutover: boolean;
  contextIds: Set<string>;
  sliceCounts: Map<string, number>;
}

function readShellContext(cutover: boolean): ShellContext {
  return {
    cutover,
    contextIds: getContextArtifactMilestoneIds(),
    sliceCounts: getSliceCountsByMilestoneId(),
  };
}

function isQueuedShell(row: MilestoneRow, item: LifecycleItem | undefined, shell: ShellContext): boolean {
  const ready = shell.cutover
    ? item?.lifecycleStatus === "ready"
    : row.status === "queued";
  return ready
    && !shell.contextIds.has(row.id)
    && (shell.sliceCounts.get(row.id) ?? 0) === 0;
}

function toMilestoneRead(row: MilestoneRow, items: LifecycleItems | null, shell: ShellContext): MilestoneRead {
  if (items) {
    const item = items.get(row.id);
    const done = isComplete(item);
    const discarded = isCancelled(item);
    return {
      ...row,
      status: statusLabel("milestone", item),
      done,
      closed: done || discarded,
      parked: item?.lifecycleStatus === "paused",
      discarded,
      lifecycleStatus: item?.lifecycleStatus ?? "pending",
      queuedShell: isQueuedShell(row, item, shell),
    };
  }
  const closed = isClosedStatus(row.status);
  const discarded = isDiscardedMilestoneStatus(row.status);
  return {
    ...row,
    done: closed && !discarded,
    closed,
    parked: row.status === "parked",
    discarded,
    lifecycleStatus: normalizeLegacyLifecycleStatus(row.status),
    queuedShell: isQueuedShell(row, undefined, shell),
  };
}

function toSliceRead(row: SliceRow, items: LifecycleItems | null): SliceRead {
  if (items) {
    const item = items.get(`${row.milestone_id}/${row.id}`);
    const complete = isComplete(item);
    const cancelled = isCancelled(item);
    return {
      ...row,
      status: statusLabel("slice", item),
      done: complete || cancelled,
      closed: complete || cancelled,
      satisfiesDependents: complete || (cancelled && item?.waived === true),
    };
  }
  const done = isInactiveStatus(row.status);
  return { ...row, done, closed: isClosedStatus(row.status), satisfiesDependents: done };
}

/** Every Milestone in workflow order (sequence, then id). Includes discarded tombstones. */
export function readMilestones(): MilestoneRead[] {
  const cutover = cutoverHasRun();
  const items = cutover ? readLifecycleItems("milestone") : null;
  const shell = readShellContext(cutover);
  return getAllMilestones().map((row) => toMilestoneRead(row, items, shell));
}

/**
 * The ids of the listed Milestones in workflow order. This is the Milestone
 * universe for every reader that decides or reports: no milestone directory
 * is scanned. A discarded Milestone is a tombstone and is not listed.
 */
export function readListedMilestoneIds(): string[] {
  return readMilestones().filter((milestone) => !milestone.discarded).map((milestone) => milestone.id);
}

export function readMilestone(milestoneId: string): MilestoneRead | null {
  const row = getMilestone(milestoneId);
  if (!row) return null;
  const cutover = cutoverHasRun();
  return toMilestoneRead(row, cutover ? readLifecycleItems("milestone", milestoneId) : null, readShellContext(cutover));
}

/**
 * Whether the Milestone is done in the project database behind `db`, a
 * connection other than the open one (the parallel merge reads the project
 * database this way). The same answer as `readMilestone(...).done`.
 */
export function readMilestoneDoneIn(db: DbAdapter, milestoneId: string): boolean {
  const status = db.prepare("SELECT status FROM milestones WHERE id = :id").get({ ":id": milestoneId })?.["status"];
  if (typeof status !== "string") return false;
  if (cutoverHasRun(db)) return isComplete(readLifecycleItems("milestone", milestoneId, undefined, db).get(milestoneId));
  return isClosedStatus(status) && !isDiscardedMilestoneStatus(status);
}

/** The Slices of one Milestone in workflow order (sequence, then id). */
export function readMilestoneSlices(milestoneId: string): SliceRead[] {
  const items = cutoverHasRun() ? readLifecycleItems("slice", milestoneId) : null;
  return getMilestoneSlices(milestoneId).map((row) => toSliceRead(row, items));
}

/** The ids of the closed Slices of one Milestone, in workflow order. */
export function readClosedSliceIds(milestoneId: string): string[] {
  return readMilestoneSlices(milestoneId).filter((slice) => slice.closed).map((slice) => slice.id);
}

export function readSlice(milestoneId: string, sliceId: string): SliceRead | null {
  return readMilestoneSlices(milestoneId).find((slice) => slice.id === sliceId) ?? null;
}

/** `readMilestoneSlices` for many Milestones in one query. A Milestone with no Slice has no entry. */
export function readSlicesByMilestoneIds(milestoneIds: readonly string[]): Map<string, SliceRead[]> {
  const items = cutoverHasRun() ? readLifecycleItems("slice") : null;
  const slices = new Map<string, SliceRead[]>();
  for (const [milestoneId, rows] of getSlicesByMilestoneIds(milestoneIds)) {
    slices.set(milestoneId, rows.map((row) => toSliceRead(row, items)));
  }
  return slices;
}

export function readSliceTasks(milestoneId: string, sliceId: string): TaskRead[] {
  const items = cutoverHasRun() ? readLifecycleItems("task", milestoneId, sliceId) : null;
  return getSliceTasks(milestoneId, sliceId).map((row) => {
    if (!items) return { ...row, done: isClosedStatus(row.status) };
    const item = items.get(`${milestoneId}/${sliceId}/${row.id}`);
    return { ...row, status: statusLabel("task", item), done: isComplete(item) || isCancelled(item) };
  });
}

export function readTask(milestoneId: string, sliceId: string, taskId: string): TaskRead | null {
  return readSliceTasks(milestoneId, sliceId).find((task) => task.id === taskId) ?? null;
}

export interface MilestoneStatusRead {
  milestone: MilestoneRead;
  slices: Array<{ id: string; status: string; taskCounts: TaskStatusCounts }>;
}

/** The public status answer for one Milestone: its row, each Slice status and the Task counts. */
export function readMilestoneStatus(milestoneId: string): MilestoneStatusRead | null {
  const milestone = readMilestone(milestoneId);
  if (!milestone) return null;
  if (cutoverHasRun()) {
    return {
      milestone,
      slices: readMilestoneSlices(milestoneId).map((slice) => {
        const tasks = readSliceTasks(milestoneId, slice.id);
        const done = tasks.filter((task) => task.done).length;
        return {
          id: slice.id,
          status: slice.status,
          taskCounts: { total: tasks.length, done, pending: tasks.length - done },
        };
      }),
    };
  }
  return {
    milestone,
    slices: getSliceStatusSummary(milestoneId).map((slice) => ({
      id: slice.id,
      status: slice.status,
      taskCounts: getSliceTaskCounts(milestoneId, slice.id),
    })),
  };
}

export interface ProgressCounts {
  milestones: MilestoneStatusCounts;
  slices: { total: number; done: number; active: number; pending: number };
  tasks: { total: number; done: number; pending: number };
}

function isInFlight(kind: ItemKind, item: LifecycleItem): boolean {
  return normalizeLegacyLifecycleStatus(statusLabel(kind, item)) === "in_progress";
}

/** `readProgressCounts` from the canonical lifecycle rows. */
function readLifecycleProgressCounts(): ProgressCounts {
  const milestones = { total: 0, done: 0, active: 0, pending: 0, parked: 0 };
  for (const item of readLifecycleItems("milestone").values()) {
    if (isCancelled(item)) continue;
    milestones.total++;
    if (isComplete(item)) milestones.done++;
    else if (item.lifecycleStatus === "paused") milestones.parked++;
    else if (isInFlight("milestone", item)) milestones.active++;
    else milestones.pending++;
  }
  const slices = { total: 0, done: 0, active: 0, pending: 0 };
  for (const item of readLifecycleItems("slice").values()) {
    slices.total++;
    if (isComplete(item) || isCancelled(item)) slices.done++;
    else if (isInFlight("slice", item)) slices.active++;
    else slices.pending++;
  }
  const tasks = { total: 0, done: 0, pending: 0 };
  for (const item of readLifecycleItems("task").values()) {
    tasks.total++;
    if (isComplete(item) || isCancelled(item)) tasks.done++;
    else tasks.pending++;
  }
  return { milestones, slices, tasks };
}

export type { OpenBlockerRow, OpenQuestionRow } from "./queries.js";

/**
 * The open canonical blockers, oldest first. Canonical storage has no legacy
 * row, so the Authority Epoch does not choose a source for this question: the
 * answer is the same before and after the Cutover. Display readers outside
 * recovery ask it here (the project snapshot), not at their own SQL.
 */
export function readOpenBlockers(): OpenBlockerRow[] {
  return getOpenBlockers();
}

/** The open canonical questions, creation order. Answered like `readOpenBlockers`. */
export function readOpenQuestions(): OpenQuestionRow[] {
  return getOpenQuestions();
}

/**
 * Project-wide counts for every progress surface. The Milestone counts leave
 * out discarded Milestones. A caller that needs the
 * counts to agree with its other reads calls this inside its read transaction.
 */
export function readProgressCounts(): ProgressCounts {
  if (cutoverHasRun()) return readLifecycleProgressCounts();
  const counts = getHierarchyCompletionCounts();
  const slicesActive = getInFlightSliceCount();
  return {
    milestones: getMilestoneStatusCounts(),
    slices: {
      total: counts.slicesTotal,
      done: counts.slices,
      active: slicesActive,
      pending: counts.slicesTotal - counts.slices - slicesActive,
    },
    tasks: {
      total: counts.tasksTotal,
      done: counts.tasks,
      pending: counts.tasksTotal - counts.tasks,
    },
  };
}
