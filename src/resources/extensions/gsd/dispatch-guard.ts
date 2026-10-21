// GSD Dispatch Guard — prevents out-of-order slice dispatch

import { parseUnitId } from "./unit-id.js";
import { isDbAvailable, getAllMilestones, getMilestoneSliceSummaries, getMilestone } from "./gsd-db.js";
import { isSkippedForDispatch } from "./status-guards.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import type { LoopState } from "./auto/types.js";

const SLICE_DISPATCH_TYPES = new Set([
  "research-slice",
  "plan-slice",
  "replan-slice",
  "execute-task",
  "complete-slice",
]);

const CONSECUTIVE_SAME_UNIT_CAP = 5;

type ConsecutiveDispatchState = Pick<
  LoopState,
  "consecutiveDispatchCount" | "lastDispatchedKey" | "lastDispatchPhase"
>;

/**
 * Prevent repeated dispatches of the same unit within the same phase.
 *
 * Applies to all unit types. The first dispatch for a unit/phase pair starts
 * a counter, phase changes reset tracking, and dispatch is blocked once the
 * counter reaches `CONSECUTIVE_SAME_UNIT_CAP` (5). This remains a last-resort
 * local safety net; the DB-persisted liveness backstop normally trips first
 * when repeated dispatches produce identical non-advancing outcomes.
 *
 * Side effects: mutates `state.consecutiveDispatchCount`,
 * `state.lastDispatchedKey`, and `state.lastDispatchPhase`.
 *
 * Returns `null` when dispatch is allowed, or a blocker message (including
 * guidance to run `/gsd resume`) when the cap is reached.
 */
export function getConsecutiveDispatchBlocker(
  state: ConsecutiveDispatchState,
  phase: string,
  unitType: string,
  unitId: string,
): string | null {
  if (!state.consecutiveDispatchCount) state.consecutiveDispatchCount = new Map<string, number>();

  const key = `${unitType}:${unitId}`;
  const phaseChanged = state.lastDispatchPhase !== phase;
  if (phaseChanged) {
    state.consecutiveDispatchCount.clear();
  }

  const count = state.consecutiveDispatchCount.get(key) ?? 0;
  if (count >= CONSECUTIVE_SAME_UNIT_CAP) {
    return `Cannot dispatch ${unitType} ${unitId}: dispatched ${count} consecutive times; same-unit repeat cap reached. Resolve via /gsd resume.`;
  }

  state.consecutiveDispatchCount.set(key, count + 1);
  state.lastDispatchedKey = key;
  state.lastDispatchPhase = phase;
  return null;
}

export function getPriorSliceCompletionBlocker(
  _base: string,
  _mainBranch: string,
  unitType: string,
  unitId: string,
): string | null {
  const { milestone: targetMid, slice: targetSid } = parseUnitId(unitId);
  const authorityBlocker = getDispatchAuthorityBlocker(unitType, unitId);
  if (authorityBlocker) return authorityBlocker;
  if (!MILESTONE_ID_RE.test(targetMid) || !SLICE_DISPATCH_TYPES.has(unitType)) return null;
  if (!targetSid) return `Cannot dispatch ${unitType} ${unitId}: slice identity is missing.`;

  const allMilestones = getAllMilestones();
  const milestoneById = new Map(allMilestones.map((milestone) => [milestone.id, milestone]));

  const milestoneLock = process.env.GSD_MILESTONE_LOCK;
  const allIds = milestoneLock && targetMid === milestoneLock
    ? [targetMid]
    : allMilestones.map((milestone) => milestone.id);
  const targetIdx = allIds.indexOf(targetMid);
  if (targetIdx < 0) {
    return `Cannot dispatch ${unitType} ${unitId}: milestone ${targetMid} is missing from the workflow DB ordering.`;
  }
  const milestoneIds = allIds.slice(0, targetIdx + 1);

  for (const mid of milestoneIds) {
    const milestoneRow = milestoneById.get(mid);
    if (!milestoneRow) {
      return `Cannot dispatch ${unitType} ${unitId}: milestone ${mid} is missing from the workflow DB.`;
    }
    if (isSkippedForDispatch(milestoneRow.status)) continue;

    const slices = getMilestoneSliceSummaries(mid);
    if (slices.length === 0) {
      // An earlier milestone with no slice rows is a placeholder; it cannot
      // have incomplete slices, so it never gates the target milestone.
      if (mid !== targetMid) continue;
      return `Cannot dispatch ${unitType} ${unitId}: milestone ${mid} has no slice rows in the workflow DB.`;
    }

    if (mid !== targetMid) {
      const incomplete = slices.find((slice) => !slice.done);
      if (incomplete) {
        return `Cannot dispatch ${unitType} ${unitId}: earlier slice ${mid}/${incomplete.id} is not complete.`;
      }
      continue;
    }

    // #4414: Sentinel unitId "{mid}/parallel-research" orchestrates research
    // across multiple real slices and is never inserted into the slices table,
    // so the per-slice identity/dependency checks below cannot apply to it.
    // Earlier-milestone gating above still runs.
    if (targetSid === "parallel-research") continue;

    const targetSlice = slices.find((slice) => slice.id === targetSid);
    if (!targetSlice) {
      return `Cannot dispatch ${unitType} ${unitId}: slice ${targetMid}/${targetSid} is missing from the workflow DB.`;
    }

    if (targetSlice.depends.length > 0) {
      const sliceMap = new Map(slices.map((slice) => [slice.id, slice]));
      for (const depId of targetSlice.depends) {
        const dependency = sliceMap.get(depId);
        if (!dependency) {
          return `Cannot dispatch ${unitType} ${unitId}: dependency slice ${targetMid}/${depId} is missing from the workflow DB.`;
        }
        if (!dependency.done) {
          return `Cannot dispatch ${unitType} ${unitId}: dependency slice ${targetMid}/${depId} is not complete.`;
        }
      }
    } else {
      const milestoneUsesExplicitDeps = slices.some((slice) => slice.depends.length > 0);
      if (milestoneUsesExplicitDeps) return null;

      const reverseDependents = new Set<string>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const slice of slices) {
          if (reverseDependents.has(slice.id)) continue;
          if (slice.depends.some((depId) => depId === targetSid || reverseDependents.has(depId))) {
            reverseDependents.add(slice.id);
            changed = true;
          }
        }
      }

      const targetIndex = slices.findIndex((slice) => slice.id === targetSid);
      const incomplete = slices
        .slice(0, targetIndex)
        .find((slice) => !slice.done && !reverseDependents.has(slice.id));
      if (incomplete) {
        return `Cannot dispatch ${unitType} ${unitId}: earlier slice ${targetMid}/${incomplete.id} is not complete.`;
      }
    }
  }

  return null;
}

export function getDispatchAuthorityBlocker(unitType: string, unitId: string): string | null {
  const { milestone } = parseUnitId(unitId);
  if (!MILESTONE_ID_RE.test(milestone)) return null;
  if (!isDbAvailable()) {
    return `Cannot dispatch ${unitType} ${unitId}: workflow DB is unavailable.`;
  }
  return getMilestone(milestone)
    ? null
    : `Cannot dispatch ${unitType} ${unitId}: milestone ${milestone} is missing from the workflow DB.`;
}
