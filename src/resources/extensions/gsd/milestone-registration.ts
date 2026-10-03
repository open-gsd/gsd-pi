// Project/App: gsd-pi
// File Purpose: The milestone.register Domain Operation, the one writer of a new milestone row before it is planned.

import { getDb } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import {
  executeDomainOperation,
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

/**
 * Register milestones in one milestone.register Domain Operation: insert a
 * `queued` row for each id that has none, and apply the requested retitles.
 * Returns the ids of the rows this call created.
 *
 * A caller without a call identity (a command or a hook) writes nothing when
 * every row is already as requested. A tool call passes its invocation: the
 * operation always runs and is the receipt of the call, so a retry replays it
 * (see `readMilestoneRegistration`).
 *
 * The row gets no lifecycle row here. Planning, park and discard adopt it.
 */
export function registerMilestones(
  milestones: ReadonlyArray<MilestoneRegistration>,
  source: string,
  invocation?: ExecutionInvocation,
): string[] {
  if (!invocation && milestones.every(isRegistered)) return [];
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
  }, () => ({
    events: milestones.map((milestone) => {
      const title = milestone.title ?? "";
      const existing = getMilestone(milestone.id);
      if (!existing) {
        insertMilestone({ id: milestone.id, title, status: "queued" });
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
  }));
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
