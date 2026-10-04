// Project/App: gsd-pi
// File Purpose: Test helper that writes a Slice row and its lifecycle row in one Domain Operation, for a database that is cut over.

import {
  adoptOrTransitionLifecycle,
  executeDomainOperation,
  insertSlice,
  readDomainOperationFence,
} from "../../gsd-db.ts";

/**
 * After the Authority Epoch cutover a hierarchy row needs a lifecycle row from
 * the same Domain Operation. This writes a pending Slice as planning does: the
 * row and a `ready` lifecycle row.
 */
export function insertPlannedSlice(milestoneId: string, sliceId: string, title: string): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.slice.plan",
    idempotencyKey: `test/slice-plan/${milestoneId}/${sliceId}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId, sliceId },
  }, (context) => {
    insertSlice({ id: sliceId, milestoneId, title, status: "pending", risk: "low", depends: [] });
    adoptOrTransitionLifecycle(context, { itemKind: "slice", milestoneId, sliceId, lifecycleStatus: "ready" });
    return {
      events: [{
        eventType: "test.slice.planned",
        entityType: "slice",
        entityId: `${milestoneId}/${sliceId}`,
        payload: { milestoneId, sliceId },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/slice-plan/${milestoneId}/${sliceId}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}
