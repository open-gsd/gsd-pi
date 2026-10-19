// Project/App: gsd-pi
// File Purpose: Auto-loop dispatch guards for already-closed units.

import { isDbAvailable } from "../gsd-db.js";
import { readMilestoneSlices, readSliceTasks } from "../db/lifecycle-read.js";
import { refreshWorkflowDatabaseFromDisk } from "../db-workspace.js";
import { parseUnitId } from "../unit-id.js";
import type { PendingVerificationRetry } from "./session.js";

export function getAlreadyClosedDispatchReason(unitType: string, unitId: string): string | null {
  if (!isDbAvailable()) return null;
  refreshWorkflowDatabaseFromDisk();
  const { milestone, slice, task } = parseUnitId(unitId);
  if (unitType === "execute-task" && milestone && slice && task) {
    const row = readSliceTasks(milestone, slice).find((entry) => entry.id === task);
    return row?.done
      ? `execute-task ${unitId} is already ${row.status}`
      : null;
  }
  if (unitType === "complete-slice" && milestone && slice) {
    const row = readMilestoneSlices(milestone).find((entry) => entry.id === slice);
    return row?.done
      ? `complete-slice ${unitId} is already ${row.status}`
      : null;
  }
  return null;
}

export function shouldBypassAlreadyClosedForVerificationRetry(
  unitType: string,
  unitId: string,
  retryInfo: PendingVerificationRetry | null | undefined,
): boolean {
  return (
    unitType === "execute-task" &&
    retryInfo?.unitId === unitId &&
    retryInfo.signature?.startsWith("git-commit:") === true
  );
}
