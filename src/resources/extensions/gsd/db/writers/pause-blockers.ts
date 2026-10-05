// Project/App: gsd-pi
// File Purpose: Context-bound writers for the workflow_blockers row of a human
// pause (ADR-046): the row a `pause.blocker.open` Domain Operation opens and a
// `pause.blocker.resolve` Domain Operation resolves or dismisses.

import { randomUUID } from "node:crypto";

import type { AutoPauseBlockerKind } from "../../recovery-policy.js";
import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

/**
 * Open the workflow_blockers row of a human pause. Runs inside the caller's
 * `pause.blocker.open` Domain Operation transaction; the returned blocker id
 * is the row's key and the caller's handle for its resolution.
 */
export function insertOpenPauseBlocker(
  context: Readonly<DomainOperationContext>,
  input: {
    lifecycleId: string;
    blockerKind: AutoPauseBlockerKind;
    description: string;
    requestedAction: string;
  },
): { blockerId: string; blockerStatus: "open" } {
  if (requireActiveDomainOperationContext(context) !== "pause.blocker.open") {
    throw new Error("pause.blocker.open Domain Operation required");
  }
  const blockerId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_blockers (
      blocker_id, project_id, lifecycle_id, blocker_kind, resolution_owner,
      blocker_status, description, requested_action, resolution, opened_at,
      opened_operation_id, opened_project_revision, opened_authority_epoch
    ) VALUES (
      :blocker_id, :project_id, :lifecycle_id, :blocker_kind, 'user',
      'open', :description, :requested_action, '', :opened_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":blocker_id": blockerId,
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":blocker_kind": input.blockerKind,
    ":description": input.description.trim(),
    ":requested_action": input.requestedAction.trim(),
    ":opened_at": new Date().toISOString(),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return { blockerId, blockerStatus: "open" };
}

/**
 * Resolve (or dismiss) the open workflow_blockers row of a pause. A blocker
 * that is unknown or already resolved updates nothing and `resolved: false`
 * comes back.
 */
export function resolveOpenPauseBlocker(
  context: Readonly<DomainOperationContext>,
  input: {
    blockerId: string;
    disposition: "resolved" | "dismissed";
    resolution: string;
  },
): { resolved: boolean } {
  if (requireActiveDomainOperationContext(context) !== "pause.blocker.resolve") {
    throw new Error("pause.blocker.resolve Domain Operation required");
  }
  const result = getDb().prepare(`
    UPDATE workflow_blockers
    SET blocker_status = :status,
        resolution = :resolution,
        resolved_at = :resolved_at,
        resolved_operation_id = :operation_id,
        resolved_project_revision = :project_revision,
        resolved_authority_epoch = :authority_epoch
    WHERE blocker_id = :blocker_id
      AND project_id = :project_id
      AND blocker_status = 'open'
  `).run({
    ":status": input.disposition,
    ":resolution": input.resolution.trim(),
    ":resolved_at": new Date().toISOString(),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
    ":blocker_id": input.blockerId,
    ":project_id": context.projectId,
  });
  return { resolved: Number((result as { changes?: unknown }).changes ?? 0) > 0 };
}
