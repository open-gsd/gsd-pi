// Project/App: gsd-pi
// File Purpose: The workflow_blockers row of a human pause (ADR-046): the
// seven human blocker kinds are human-only, so a pause for one of them opens a
// blocker for the paused item, and the resolution of the pause resolves it.
// A machine_fixable or user_request pause opens no blocker.

import {
  executeDomainOperation,
  type DomainJsonValue,
} from "./db/domain-operation.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import { insertOpenPauseBlocker, resolveOpenPauseBlocker } from "./db/writers/pause-blockers.js";
import { getDb } from "./gsd-db.js";
import type { AutoPauseBlockerKind } from "./recovery-policy.js";

/** The blocker kinds a pause opens a workflow_blockers row for. */
const HUMAN_PAUSE_BLOCKER_KINDS: ReadonlySet<string> = new Set([
  "missing_authority",
  "missing_access",
  "external_dependency",
  "consent",
  "ambiguous_intent",
  "subjective_uat",
  "user_limit",
]);

export function isHumanPauseBlockerKind(kind: AutoPauseBlockerKind): boolean {
  return HUMAN_PAUSE_BLOCKER_KINDS.has(kind);
}

/** The lifecycle row of the paused item, most specific first: task, slice, milestone. */
export function findPauseLifecycleId(input: {
  milestoneId?: string | null;
  unitType?: string | null;
  unitId?: string | null;
}): string | null {
  const db = getDb();
  const parts = (input.unitId ?? "").split("/");
  const milestoneId = input.milestoneId ?? parts[0] ?? null;
  const sliceId = parts[1] ?? null;
  const taskId = parts[2] ?? null;
  if (!milestoneId) return null;
  const specific = taskId
    ? db.prepare(
        `SELECT lifecycle_id FROM workflow_item_lifecycles
         WHERE item_kind = 'task' AND milestone_id = :milestone_id AND slice_id = :slice_id AND task_id = :task_id`,
      ).get({ ":milestone_id": milestoneId, ":slice_id": sliceId, ":task_id": taskId })
      ?? db.prepare(
        `SELECT lifecycle_id FROM workflow_item_lifecycles
         WHERE item_kind = 'slice' AND milestone_id = :milestone_id AND slice_id = :slice_id`,
      ).get({ ":milestone_id": milestoneId, ":slice_id": sliceId })
    : sliceId
      ? db.prepare(
          `SELECT lifecycle_id FROM workflow_item_lifecycles
           WHERE item_kind = 'slice' AND milestone_id = :milestone_id AND slice_id = :slice_id`,
        ).get({ ":milestone_id": milestoneId, ":slice_id": sliceId })
      : null;
  const row = (specific
    ?? db.prepare(
      `SELECT lifecycle_id FROM workflow_item_lifecycles
       WHERE item_kind = 'milestone' AND milestone_id = :milestone_id`,
    ).get({ ":milestone_id": milestoneId })
  ) as { lifecycle_id: string } | undefined;
  return row ? String(row.lifecycle_id) : null;
}

function pauseBlockerRequest(
  operationType: string,
  idempotencyKey: string,
  payload: DomainJsonValue,
) {
  const fence = readDomainOperationFence(idempotencyKey);
  return {
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload,
  };
}

/**
 * Open the workflow_blockers row of a human pause. The paused item must have a
 * lifecycle row; a pause of an item the lifecycle graph does not know (a
 * project-setup unit, a pause with no active unit and no milestone) opens no
 * blocker and the pause row alone records it.
 */
export function openPauseBlockerRow(input: {
  lifecycleId: string;
  blockerKind: AutoPauseBlockerKind;
  description: string;
  requestedAction: string;
  idempotencyKey: string;
}): { blockerId: string } {
  if (!isHumanPauseBlockerKind(input.blockerKind)) {
    throw new Error(`${input.blockerKind} is not a human blocker kind and opens no workflow_blockers row`);
  }
  let blockerId = "";
  executeDomainOperation(
    pauseBlockerRequest("pause.blocker.open", input.idempotencyKey, {
      lifecycleId: input.lifecycleId,
      blockerKind: input.blockerKind,
      description: input.description,
      requestedAction: input.requestedAction,
    }),
    (context) => {
      const opened = insertOpenPauseBlocker(context, {
        lifecycleId: input.lifecycleId,
        blockerKind: input.blockerKind,
        description: input.description,
        requestedAction: input.requestedAction,
      });
      blockerId = opened.blockerId;
      return {
        events: [{
          eventType: "pause.blocker.opened",
          entityType: "pause",
          entityId: blockerId,
          payload: { blockerId, blockerKind: input.blockerKind } satisfies DomainJsonValue,
          destinations: ["projection"],
        }],
        // No renderer is registered for this kind, so the projection worker
        // skips it; the domain operation protocol requires a projection target.
        projections: [{
          projectionKey: `pause-blocker/${blockerId}`,
          projectionKind: "pause-blocker",
          rendererVersion: "1",
        }],
      };
    },
  );
  return { blockerId };
}

/**
 * Resolve (or dismiss) the open workflow_blockers row of a pause. An unknown
 * or already-resolved blocker resolves nothing and false comes back.
 */
export function resolvePauseBlockerRow(input: {
  blockerId: string;
  disposition: "resolved" | "dismissed";
  resolution: string;
  idempotencyKey: string;
}): boolean {
  let resolved = false;
  executeDomainOperation(
    pauseBlockerRequest("pause.blocker.resolve", input.idempotencyKey, {
      blockerId: input.blockerId,
      disposition: input.disposition,
      resolution: input.resolution,
    }),
    (context) => {
      const settled = resolveOpenPauseBlocker(context, {
        blockerId: input.blockerId,
        disposition: input.disposition,
        resolution: input.resolution,
      });
      resolved = settled.resolved;
      return {
        events: [{
          eventType: "pause.blocker.resolved",
          entityType: "pause",
          entityId: input.blockerId,
          payload: { blockerId: input.blockerId, disposition: input.disposition, resolved } satisfies DomainJsonValue,
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: `pause-blocker/${input.blockerId}`,
          projectionKind: "pause-blocker",
          rendererVersion: "1",
        }],
      };
    },
  );
  return resolved;
}
