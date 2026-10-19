// Project/App: gsd-pi
// File Purpose: Deletes stale artifact rows in one Domain Operation, so the
// prune has an operation row, a revision and an event that lists every path.

import { executeDomainOperation } from "../domain-operation.js";
import { getDb } from "../engine.js";
import { readDomainOperationFence } from "./lifecycle-commands.js";

/**
 * Delete the artifact rows at `paths`. `source` names the caller; it is part
 * of the idempotency key and of the stored request. Returns the number of
 * paths. No paths means no operation.
 */
export function pruneArtifactRows(
  source: { name: string; actorType: "operator" | "system" },
  paths: readonly string[],
): number {
  const unique = [...new Set(paths)].sort();
  if (unique.length === 0) return 0;
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "artifact.rows.prune",
    idempotencyKey: `${source.name}/artifact-row-prune/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: source.actorType,
    sourceTransport: "internal",
    payload: { source: source.name, paths: unique },
  }, () => {
    const remove = getDb().prepare("DELETE FROM artifacts WHERE path = :path");
    for (const path of unique) remove.run({ ":path": path });
    return {
      events: [{
        eventType: "artifact.rows.pruned",
        entityType: "project",
        entityId: fence.projectId,
        payload: { source: source.name, paths: unique },
        destinations: ["db"],
      }],
      // The prune changes no hierarchy file; STATE.md is its projection.
      projections: [{ projectionKey: "artifacts/prune", projectionKind: "state", rendererVersion: "1" }],
    };
  });
  return unique.length;
}
