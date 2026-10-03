// Project/App: gsd-pi
// File Purpose: Shared atomic Domain Operation seam for non-hierarchy workflow record writes.

import { executeDomainOperation, type DomainJsonValue } from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import { planningOperationPayload } from "./planning-domain-operation.js";
import type { PlanningInvocation } from "./planning-invocation.js";

export interface RecordDomainOperationInput<T extends { [key: string]: DomainJsonValue }> {
  operationType: string;
  invocation: PlanningInvocation;
  /** Tool parameters. They must be the same on a replay of the same invocation. */
  payload: unknown;
  eventType: string;
  entityType: string;
  /** Projection Work keys to enqueue. Each key needs a renderer in projection-worker.ts. */
  projectionKeys: string[];
  /** Write the rows. Return the entity id and the result that a replay must return. */
  mutate(): { entityId: string; result: T };
}

/**
 * Run one record write as a Domain Operation and return its result. A replay
 * with the same idempotency key writes nothing and returns the stored result.
 */
export function executeRecordDomainOperation<T extends { [key: string]: DomainJsonValue }>(
  input: RecordDomainOperationInput<T>,
): T {
  const { invocation } = input;
  const fence = readDomainOperationFence(invocation.idempotencyKey);
  let committed: T | undefined;
  const operation = executeDomainOperation({
    operationType: input.operationType,
    idempotencyKey: invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: invocation.actorType,
    ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation.sourceTransport,
    ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
    payload: planningOperationPayload(input.payload),
  }, () => {
    const { entityId, result } = input.mutate();
    committed = result;
    return {
      events: [{
        eventType: input.eventType,
        entityType: input.entityType,
        entityId,
        payload: result,
        destinations: ["projection"],
      }],
      projections: input.projectionKeys.map((projectionKey) => ({
        projectionKey,
        projectionKind: "markdown",
        rendererVersion: "1",
      })),
    };
  });
  if (committed) return committed;

  const row = getDb()
    .prepare("SELECT payload_json FROM workflow_domain_events WHERE operation_id = :operation_id AND event_index = 0")
    .get({ ":operation_id": operation.operationId });
  if (typeof row?.["payload_json"] !== "string") {
    throw new Error(`${input.operationType} operation ${operation.operationId} has no stored result`);
  }
  return JSON.parse(row["payload_json"]) as T;
}
