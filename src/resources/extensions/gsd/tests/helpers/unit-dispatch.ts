// Project/App: gsd-pi
// File Purpose: Test helper that gives a unit the dispatch rows a run in auto-mode gives it.

import { registerAutoWorker } from "../../db/auto-workers.ts";
import { claimMilestoneLease } from "../../db/milestone-leases.ts";
import { markCanceled, recordDispatchClaim } from "../../db/unit-dispatches.ts";

export interface TestUnitDispatch {
  /** End the current dispatch of the unit and claim the next one, as a retry of the unit does. */
  claimNext(): void;
}

/**
 * Claim a dispatch row for the unit in the open database. The milestone row
 * must exist. Retry rows and budget rows of the unit are stored on this row.
 */
export function claimTestDispatch(
  projectRoot: string,
  unit: { milestoneId: string; sliceId?: string; taskId?: string; unitType: string; unitId: string },
): TestUnitDispatch {
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  const lease = claimMilestoneLease(workerId, unit.milestoneId);
  if (!lease.ok) throw new Error(`expected a milestone lease for ${unit.milestoneId}`);
  const claim = (): number => {
    const result = recordDispatchClaim({
      traceId: "test-trace",
      workerId,
      milestoneLeaseToken: lease.token,
      milestoneId: unit.milestoneId,
      sliceId: unit.sliceId ?? null,
      taskId: unit.taskId ?? null,
      unitType: unit.unitType,
      unitId: unit.unitId,
    });
    if (!result.ok) throw new Error(`expected a dispatch claim for ${unit.unitId}: ${result.error}`);
    return result.dispatchId;
  };
  let dispatchId = claim();
  return {
    claimNext() {
      markCanceled(dispatchId, "test: the unit runs again");
      dispatchId = claim();
    },
  };
}
