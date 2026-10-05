// Project/App: gsd-pi
// File Purpose: Test helpers that write canonical lifecycle rows and advance the Authority Epoch of the open project database.

import assert from "node:assert/strict";

import {
  _executeAuthorityCutoverDomainOperation,
  executeDomainOperation,
  type DomainOperationContext,
  type DomainOperationMutation,
} from "../../db/domain-operation.ts";
import { insertAuthorityCutoverReceipt } from "../../db/writers/authority-recovery.ts";
import { adoptOrTransitionLifecycle, readDomainOperationFence } from "../../db/writers/lifecycle-commands.ts";
import { invalidateStateCache } from "../../state.ts";

export type Lifecycle = Parameters<typeof adoptOrTransitionLifecycle>[1];

function mutation(key: string): DomainOperationMutation {
  return {
    events: [{
      eventType: "authority-cutover-helper.seeded",
      entityType: "project",
      entityId: key,
      payload: { key },
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: `authority-cutover-helper/${key}`,
      projectionKind: "markdown",
      rendererVersion: "v1",
    }],
  };
}

/**
 * Write canonical lifecycle rows in one Domain Operation. The legacy status
 * rows do not change, so a test can make the two disagree.
 */
export function seedLifecycles(key: string, lifecycles: Lifecycle[]): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "authority-cutover-helper.seed",
    idempotencyKey: `authority-cutover-helper/${key}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    actorId: "authority-cutover-helper",
    sourceTransport: "test",
    payload: { key },
  }, (context: Readonly<DomainOperationContext>) => {
    for (const lifecycle of lifecycles) adoptOrTransitionLifecycle(context, lifecycle);
    return mutation(key);
  });
  invalidateStateCache();
}

/** Advance the Authority Epoch of the Project from 0 to 1. */
export function cutOver(): void {
  const fence = readDomainOperationFence();
  const evidenceHash = `sha256:${"3".repeat(64)}`;
  const consentHash = `sha256:${"4".repeat(64)}`;
  const cutover = _executeAuthorityCutoverDomainOperation({
    operationType: "authority.cutover",
    idempotencyKey: "authority-cutover-helper/cutover",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    actorId: "authority-cutover-helper",
    sourceTransport: "internal",
    payload: { authorityContractVersion: 1, evidenceHash, consentHash },
  }, (context) => {
    insertAuthorityCutoverReceipt(context, { authorityContractVersion: 1, evidenceHash, consentHash });
    return mutation("cutover");
  });
  assert.equal(cutover.resultingAuthorityEpoch, 1);
  invalidateStateCache();
}
