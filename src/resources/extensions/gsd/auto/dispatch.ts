// Project/App: gsd-pi
// File Purpose: Auto-loop dispatch guards for already-closed units.

import { isDbAvailable, getTask, getSlice } from "../gsd-db.js";
import { refreshWorkflowDatabaseFromDisk } from "../db-workspace.js";
import { isClosedStatus } from "../status-guards.js";
import { parseUnitId } from "../unit-id.js";
import type { PendingVerificationRetry } from "./session.js";

export function getAlreadyClosedDispatchReason(unitType: string, unitId: string): string | null {
  if (!isDbAvailable()) return null;
  refreshWorkflowDatabaseFromDisk();
  const { milestone, slice, task } = parseUnitId(unitId);
  if (unitType === "execute-task" && milestone && slice && task) {
    const row = getTask(milestone, slice, task);
    return row && isClosedStatus(row.status)
      ? `execute-task ${unitId} is already ${row.status}`
      : null;
  }
  if (unitType === "complete-slice" && milestone && slice) {
    const row = getSlice(milestone, slice);
    return row && isClosedStatus(row.status)
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
