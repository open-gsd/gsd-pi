// Project/App: gsd-pi
// File Purpose: The milestone.register Domain Operation, the one writer of a new milestone row before it is planned.

import { getDb } from "./db/engine.js";
import { adoptOrTransitionLifecycle, readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import {
  executeDomainOperation,
  type DomainOperationContext,
  type DomainOperationMutation,
  getMilestone,
  insertMilestone,
  upsertMilestonePlanning,
} from "./gsd-db.js";

export interface MilestoneRegistration {
  id: string;
  title?: string;
  /** Replace the title of a row that already exists. A new row always gets the title. */
  retitle?: boolean;
}

function isRegistered(milestone: MilestoneRegistration): boolean {
  const row = getMilestone(milestone.id);
  return row !== null && !(milestone.retitle && milestone.title && row.title !== milestone.title);
}

/** True when no milestone of the list needs a new row or a retitle. */
export function milestonesRegistered(milestones: ReadonlyArray<MilestoneRegistration>): boolean {
  return milestones.every(isRegistered);
}

/**
 * Write the milestone rows inside the Domain Operation of the caller: insert a
 * `queued` row for each id that has none, and apply the requested retitles.
 * Adds the id of each new row to `created`. Returns the events and the
 * Projection Work that the operation must commit.
 *
 * A new row gets its lifecycle row in the same operation, as `ready`: the
 * status that planning and the lifecycle backfill give an open milestone, and
 * the one that park (`ready` to `paused`) can leave. A row that existed before
 * this operation is adopted by planning, park, discard or the backfill.
 */
export function registerMilestoneRows(
  context: DomainOperationContext,
  milestones: ReadonlyArray<MilestoneRegistration>,
  source: string,
  created: string[] = [],
): DomainOperationMutation {
  return {
    events: milestones.map((milestone) => {
      const title = milestone.title ?? "";
      const existing = getMilestone(milestone.id);
      if (!existing) {
        insertMilestone({ id: milestone.id, title, status: "queued" });
        adoptOrTransitionLifecycle(context, {
          itemKind: "milestone",
          milestoneId: milestone.id,
          lifecycleStatus: "ready",
        });
        created.push(milestone.id);
      } else if (milestone.retitle && title && existing.title !== title) {
        upsertMilestonePlanning(milestone.id, { title });
      }
      return {
        eventType: "milestone.registered",
        entityType: "milestone",
        entityId: milestone.id,
        payload: { milestoneId: milestone.id, title, source, created: !existing },
        destinations: ["db"],
      };
    }),
    projections: [{
      projectionKey: "milestones/register",
      projectionKind: "milestone-status",
      rendererVersion: "1",
    }],
  };
}

/**
 * Register milestones in one milestone.register Domain Operation. Returns the
 * ids of the rows this call created.
 *
 * A caller without a call identity (a command or a hook) writes nothing when
 * every row is already as requested. A tool call passes its invocation: the
 * operation always runs and is the receipt of the call, so a retry replays it
 * (see `readMilestoneRegistration`).
 */
export function registerMilestones(
  milestones: ReadonlyArray<MilestoneRegistration>,
  source: string,
  invocation?: ExecutionInvocation,
): string[] {
  if (!invocation && milestonesRegistered(milestones)) return [];
  const fence = readDomainOperationFence(invocation?.idempotencyKey);
  const created: string[] = [];
  executeDomainOperation({
    operationType: "milestone.register",
    idempotencyKey: invocation?.idempotencyKey ?? `command/register/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: invocation?.actorType ?? "operator",
    ...(invocation?.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation?.sourceTransport ?? "internal",
    ...(invocation?.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation?.turnId ? { turnId: invocation.turnId } : {}),
    payload: {
      source,
      milestones: milestones.map((milestone) => ({
        id: milestone.id,
        title: milestone.title ?? "",
        retitle: milestone.retitle === true,
      })),
    },
  }, (context) => registerMilestoneRows(context, milestones, source, created));
  return created;
}

/**
 * The milestone ids of the milestone.register operation that a tool call
 * committed, or null when no operation has that call's key.
 */
export function readMilestoneRegistration(idempotencyKey: string): string[] | null {
  const rows = getDb().prepare(`
    SELECT event.entity_id
    FROM workflow_operations operation
    JOIN workflow_domain_events event ON event.operation_id = operation.operation_id
    WHERE operation.operation_type = 'milestone.register'
      AND operation.idempotency_key = :idempotency_key
    ORDER BY event.event_index
  `).all({ ":idempotency_key": idempotencyKey });
  return rows.length > 0 ? rows.map((row) => String(row["entity_id"])) : null;
}
