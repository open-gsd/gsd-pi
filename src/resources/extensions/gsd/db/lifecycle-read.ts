// Project/App: gsd-pi
// File Purpose: The read interface for status, phase, dispatch-eligibility
// and dependency decisions (ADR-046). deriveState, the dispatch guard, the
// milestone guard of resolveDispatch, the status response, progress and the
// project snapshot ask their status questions here.
// Other decision sites still read legacy rows directly and apply the status
// vocabulary themselves; docs/dev/state-db-cutover-milestone-decision.md
// (D012) lists them. The answers come from the legacy status rows (D005).
// The read cutover to canonical lifecycle rows must route those sites here
// before it changes this module.

import {
  getAllMilestones,
  getHierarchyCompletionCounts,
  getInFlightSliceCount,
  getMilestone,
  getMilestoneSlices,
  getMilestoneStatusCounts,
  getSliceStatusSummary,
  getSliceTaskCounts,
  getSliceTasks,
  getSlicesByMilestoneIds,
  type MilestoneStatusCounts,
} from "./queries.js";
import { isClosedStatus, isDiscardedMilestoneStatus, isInactiveStatus } from "../status-guards.js";
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
}

export interface SliceRead extends SliceRow {
  /** Needs no further work: closed, or deferred by a decision. Satisfies its dependents. */
  readonly done: boolean;
}

export interface TaskRead extends TaskRow {
  /** Needs no further work. */
  readonly done: boolean;
}

function toMilestoneRead(row: MilestoneRow): MilestoneRead {
  const closed = isClosedStatus(row.status);
  const discarded = isDiscardedMilestoneStatus(row.status);
  return { ...row, done: closed && !discarded, closed, parked: row.status === "parked", discarded };
}

function toSliceRead(row: SliceRow): SliceRead {
  return { ...row, done: isInactiveStatus(row.status) };
}

/** Every Milestone in workflow order (sequence, then id). Includes discarded tombstones. */
export function readMilestones(): MilestoneRead[] {
  return getAllMilestones().map(toMilestoneRead);
}

export function readMilestone(milestoneId: string): MilestoneRead | null {
  const row = getMilestone(milestoneId);
  return row ? toMilestoneRead(row) : null;
}

/** The Slices of one Milestone in workflow order (sequence, then id). */
export function readMilestoneSlices(milestoneId: string): SliceRead[] {
  return getMilestoneSlices(milestoneId).map(toSliceRead);
}

/** `readMilestoneSlices` for many Milestones in one query. A Milestone with no Slice has no entry. */
export function readSlicesByMilestoneIds(milestoneIds: readonly string[]): Map<string, SliceRead[]> {
  const slices = new Map<string, SliceRead[]>();
  for (const [milestoneId, rows] of getSlicesByMilestoneIds(milestoneIds)) {
    slices.set(milestoneId, rows.map(toSliceRead));
  }
  return slices;
}

export function readSliceTasks(milestoneId: string, sliceId: string): TaskRead[] {
  return getSliceTasks(milestoneId, sliceId).map((row) => ({ ...row, done: isClosedStatus(row.status) }));
}

export interface MilestoneStatusRead {
  milestone: MilestoneRead;
  slices: Array<{ id: string; status: string; taskCounts: TaskStatusCounts }>;
}

/** The public status answer for one Milestone: its row, each Slice status and the Task counts. */
export function readMilestoneStatus(milestoneId: string): MilestoneStatusRead | null {
  const milestone = readMilestone(milestoneId);
  if (!milestone) return null;
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

/**
 * Project-wide counts for every progress surface. The Milestone counts leave
 * out discarded Milestones. A caller that needs the
 * counts to agree with its other reads calls this inside its read transaction.
 */
export function readProgressCounts(): ProgressCounts {
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
