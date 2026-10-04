// Project/App: gsd-pi
// File Purpose: Database record of the branch each milestone merges back to.

import { executeDomainOperation } from "../domain-operation.js";
import { getDbOrNull } from "../engine.js";
import { readDomainOperationFence } from "./lifecycle-commands.js";

/**
 * The recorded integration branch, `null` when the milestone has no row, or
 * `undefined` when no database is open.
 */
export function getRecordedIntegrationBranch(milestoneId: string): string | null | undefined {
  const db = getDbOrNull();
  if (!db) return undefined;
  const row = db.prepare(`
    SELECT integration_branch FROM milestone_integration_branches WHERE milestone_id = :milestone_id
  `).get({ ":milestone_id": milestoneId });
  return typeof row?.["integration_branch"] === "string" ? row["integration_branch"] : null;
}

/**
 * Record the integration branch in one milestone.integration_branch.record
 * Domain Operation. No-op when no database is open.
 */
export function recordIntegrationBranch(milestoneId: string, branch: string): void {
  const db = getDbOrNull();
  if (!db) return;
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "milestone.integration_branch.record",
    // The host has no call identity, and a branch can be recorded again after
    // another one, so the key is the project revision.
    idempotencyKey: `internal:milestone.integration_branch.record:${milestoneId}:${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "system",
    sourceTransport: "internal",
    payload: { milestoneId, integrationBranch: branch },
  }, () => {
    const previous = getRecordedIntegrationBranch(milestoneId) ?? null;
    db.prepare(`
      INSERT INTO milestone_integration_branches (milestone_id, integration_branch, updated_at)
      VALUES (:milestone_id, :integration_branch, :updated_at)
      ON CONFLICT (milestone_id) DO UPDATE SET
        integration_branch = excluded.integration_branch,
        updated_at = excluded.updated_at
    `).run({
      ":milestone_id": milestoneId,
      ":integration_branch": branch,
      ":updated_at": new Date().toISOString(),
    });
    return {
      events: [{
        eventType: "milestone.integration_branch.recorded",
        entityType: "milestone",
        entityId: milestoneId,
        payload: { milestoneId, integrationBranch: branch, previous },
        destinations: ["db"],
      }],
      // No hierarchy file changes; the root files are the projection of the operation.
      projections: [{
        projectionKey: `milestone/${milestoneId.toLowerCase()}/integration-branch`,
        projectionKind: "milestone-status",
        rendererVersion: "1",
      }],
    };
  });
}
