// Project/App: gsd-pi
// File Purpose: Context-bound writers for the workflow_blockers row of a human
// pause (ADR-046): the row a `pause.blocker.open` Domain Operation opens and a
// `pause.blocker.resolve` Domain Operation resolves or dismisses. The exact
// clear-only `pause.blocker.resolve.by-id` Domain Operation (an explicit
// operator-named auto-pause blocker id) also resolves through this writer,
// atomically with closing the blocker's bound pause row.
// Legacy runtime_kv pauses keep their durable association writes here too;
// the domain layer validates identity before invoking these context-bound writers.

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
    resolutionOwner?: "user" | "external";
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
      :blocker_id, :project_id, :lifecycle_id, :blocker_kind, :resolution_owner,
      'open', :description, :requested_action, '', :opened_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":blocker_id": blockerId,
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":blocker_kind": input.blockerKind,
    ":resolution_owner": input.resolutionOwner ?? "user",
    ":description": input.description.trim(),
    ":requested_action": input.requestedAction.trim(),
    ":opened_at": new Date().toISOString(),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return { blockerId, blockerStatus: "open" };
}

export function insertPauseBlockerLink(
  context: Readonly<DomainOperationContext>,
  input: {
    blockerId: string;
    pauseId: string;
    lifecycleId: string;
    milestoneId: string;
    unitType: string;
    unitId: string;
  },
): void {
  if (requireActiveDomainOperationContext(context) !== "pause.blocker.open") {
    throw new Error("pause.blocker.open Domain Operation required");
  }
  getDb().prepare(`
    INSERT INTO auto_pause_blocker_links (
      blocker_id, pause_id, lifecycle_id, milestone_id, unit_type, unit_id, created_at
    ) VALUES (:blocker_id, :pause_id, :lifecycle_id, :milestone_id, :unit_type, :unit_id, :created_at)
  `).run({
    ":blocker_id": input.blockerId,
    ":pause_id": input.pauseId,
    ":lifecycle_id": input.lifecycleId,
    ":milestone_id": input.milestoneId,
    ":unit_type": input.unitType,
    ":unit_id": input.unitId,
    ":created_at": new Date().toISOString(),
  });
}

export function resolvePauseBlockerLink(
  context: Readonly<DomainOperationContext>,
  blockerId: string,
): void {
  if (requireActiveDomainOperationContext(context) !== "pause.blocker.resolve.by-id") {
    throw new Error("pause.blocker.resolve.by-id Domain Operation required");
  }
  getDb().prepare(`
    UPDATE auto_pause_blocker_links SET resolved_at = :resolved_at
    WHERE blocker_id = :blocker_id AND resolved_at IS NULL
  `).run({ ":resolved_at": new Date().toISOString(), ":blocker_id": blockerId });
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
  const activeOperationType = requireActiveDomainOperationContext(context);
  if (
    activeOperationType !== "pause.blocker.resolve" &&
    activeOperationType !== "pause.blocker.resolve.by-id"
  ) {
    throw new Error(
      "pause.blocker.resolve or pause.blocker.resolve.by-id Domain Operation required",
    );
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
