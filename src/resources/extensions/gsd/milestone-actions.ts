/**
 * GSD Milestone Actions — Park, Unpark, and Discard operations.
 *
 * Each action is one Domain Operation that adopts the milestone lifecycle
 * when it has none, so every milestone takes the same path. Files are
 * projections handled after the commit: the PARKED marker is rendered from
 * the park record, and discard removes the milestone tree only after the
 * cancellation is durable.
 */

import { existsSync } from "node:fs";
import { resolveMilestonePath } from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { renderStateProjection } from "./workflow-projections.js";
import { loadQueueOrder, renderQueueOrder } from "./queue-order.js";
import {
  executeDomainOperation,
  isDbAvailable,
  projectCanonicalStatusToLegacy,
} from "./gsd-db.js";
import { readMilestone } from "./db/lifecycle-read.js";
import { getDb } from "./db/engine.js";
import type { DomainOperationContext } from "./db/domain-operation.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import {
  adoptOrTransitionLifecycle,
  grantCancellationWaiver,
  readDomainOperationFence,
  type CancellationWaiverInput,
} from "./db/writers/lifecycle-commands.js";
import { removeWorktree } from "./worktree-manager.js";
import { logWarning } from "./workflow-logger.js";
import { isAutoActive } from "./auto-runtime-state.js";
import { adoptionLifecycleStatus, isClosedStatus } from "./status-guards.js";
import { removeManagedProjectionTreeExactSync } from "./managed-projection-history.js";
import { GSDError, GSD_STALE_STATE } from "./errors.js";
import { readMilestoneParkRecord, renderMilestoneParkedMarker } from "./milestone-park-projection.js";

/**
 * Writer-side assert for mutations that race with auto-mode's squash merge (#4704).
 * The auto loop itself may park an abandoned milestone between units
 * (`fromAutoLoop`); any other call while auto-mode runs is an invariant
 * violation and fails loudly.
 */
function assertNotAutoActive(action: string): void {
  if (isAutoActive()) {
    throw new Error(
      `${action} cannot run while auto-mode is active. Stop auto-mode first with /gsd stop.`,
    );
  }
}

/**
 * Milestone status lives in the DB. With no open DB these actions refuse
 * before touching any file, worktree or branch (ADR-046).
 */
function assertDbAvailable(action: string, milestoneId: string): void {
  if (!isDbAvailable()) {
    throw new GSDError(GSD_STALE_STATE, `${action} ${milestoneId} refused: database unavailable`);
  }
}

type MilestoneCommand = "park" | "unpark" | "discard";

const EVENT_TYPES: Record<MilestoneCommand, string> = {
  park: "milestone.parked",
  unpark: "milestone.unparked",
  discard: "milestone.discarded",
};

/** A tool call that already committed under its key; its retry replays the receipt. */
function isReplay(invocation: ExecutionInvocation | undefined): boolean {
  return invocation !== undefined && readDomainOperationFence(invocation.idempotencyKey).replay;
}

/**
 * Run one milestone Domain Operation. A slash command has no call identity,
 * so its key is the project revision. A tool call passes its invocation: the
 * key is the tool-call key, and a retry of the same call replays the receipt.
 * `eventDetails` holds values that differ between a call and its retry (the
 * park time); they go in the event only, not in the replay-checked request.
 */
function runMilestoneOperation(
  command: MilestoneCommand,
  milestoneId: string,
  payload: Record<string, string | boolean>,
  apply: (context: Readonly<DomainOperationContext>) => void,
  invocation?: ExecutionInvocation,
  eventDetails: Record<string, string> = {},
): void {
  const fence = readDomainOperationFence(invocation?.idempotencyKey);
  const fullPayload = { milestoneId, ...payload };
  executeDomainOperation({
    operationType: `milestone.${command}`,
    idempotencyKey: invocation?.idempotencyKey ?? `command/${command}/${milestoneId}/${fence.revision}`,
    // The caller's revision is a precondition of the first send only. A retry
    // can carry a newer revision, so a replay uses the recorded one.
    expectedRevision: fence.replay ? fence.revision : invocation?.expectedRevision ?? fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: invocation?.actorType ?? "operator",
    ...(invocation?.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation?.sourceTransport ?? "internal",
    ...(invocation?.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation?.turnId ? { turnId: invocation.turnId } : {}),
    payload: fullPayload,
  }, (context) => {
    apply(context);
    return {
      events: [{
        eventType: EVENT_TYPES[command],
        entityType: "milestone",
        entityId: milestoneId,
        payload: { ...fullPayload, ...eventDetails },
        destinations: ["db"],
      }],
      projections: [{
        projectionKey: `milestone/${milestoneId.toLowerCase()}/${command}`,
        projectionKind: "milestone-status",
        rendererVersion: "1",
      }],
    };
  });
}

/**
 * Legacy `parked` maps to canonical `paused`. A milestone without a lifecycle
 * row is adopted in the same operation (#2126).
 */
function writeMilestoneParkStatus(
  context: Readonly<DomainOperationContext>,
  milestoneId: string,
  parked: boolean,
): void {
  adoptOrTransitionLifecycle(context, {
    itemKind: "milestone",
    milestoneId,
    lifecycleStatus: parked ? "paused" : "in_progress",
    ...(parked ? {} : { adoptedFromStatus: "paused" as const }),
  });
  projectCanonicalStatusToLegacy(context, {
    entity: "milestone",
    milestoneId,
    status: parked ? "parked" : "active",
  });
}

function renderParkedMarkerAfterCommit(basePath: string, milestoneId: string): void {
  try {
    renderMilestoneParkedMarker(basePath, milestoneId);
  } catch (err) {
    logWarning("projection", `PARKED marker render failed for ${milestoneId}: ${(err as Error).message}`);
  }
}

// ─── Park ──────────────────────────────────────────────────────────────────

/**
 * Park a milestone: one milestone.park Domain Operation records status
 * 'parked' with the reason and time, then the PARKED marker is rendered.
 * Parked milestones are skipped during active-milestone discovery.
 * Returns false when the milestone is not in the database, already parked,
 * or closed. Throws when the database write fails (#2255).
 */
export async function parkMilestone(
  basePath: string,
  milestoneId: string,
  reason: string,
  options: { fromAutoLoop?: boolean; invocation?: ExecutionInvocation } = {},
): Promise<boolean> {
  if (!options.fromAutoLoop) assertNotAutoActive("park milestone");
  assertDbAvailable("parkMilestone", milestoneId);
  const milestone = readMilestone(milestoneId);
  // Do not park a closed milestone — it would corrupt depends_on satisfaction.
  if (
    !isReplay(options.invocation) &&
    (!milestone || milestone.parked || milestone.closed)
  ) return false;

  try {
    runMilestoneOperation(
      "park",
      milestoneId,
      { parked: true, reason },
      (context) => writeMilestoneParkStatus(context, milestoneId, true),
      options.invocation,
      { parkedAt: new Date().toISOString() },
    );
  } catch (err) {
    throw new Error(`parkMilestone DB sync failed for ${milestoneId}: ${(err as Error).message}`);
  }
  renderParkedMarkerAfterCommit(basePath, milestoneId);
  invalidateAllCaches();
  await renderStateProjection(basePath);
  return true;
}

// ─── Unpark ────────────────────────────────────────────────────────────────

/**
 * Unpark a milestone: one milestone.unpark Domain Operation, then the PARKED
 * marker is removed. Returns false when the milestone is not parked in the
 * database. Throws when the database write fails.
 */
export async function unparkMilestone(
  basePath: string,
  milestoneId: string,
  invocation?: ExecutionInvocation,
): Promise<boolean> {
  assertNotAutoActive("unpark milestone");
  assertDbAvailable("unparkMilestone", milestoneId);
  if (!isReplay(invocation) && !readMilestone(milestoneId)?.parked) return false;

  try {
    runMilestoneOperation("unpark", milestoneId, { parked: false }, (context) =>
      writeMilestoneParkStatus(context, milestoneId, false), invocation);
  } catch (err) {
    throw new Error(`unparkMilestone DB sync failed for ${milestoneId}: ${(err as Error).message}`);
  }
  renderParkedMarkerAfterCommit(basePath, milestoneId);
  invalidateAllCaches();
  await renderStateProjection(basePath);
  return true;
}

// ─── Discard ───────────────────────────────────────────────────────────────

interface DiscardRow {
  slice_id: string | null;
  task_id: string | null;
  status: string;
  lifecycle_status: string | null;
}

function loadDiscardRows(milestoneId: string): DiscardRow[] {
  const lifecycleJoin = (kind: string, slice: string, task: string) => `
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = '${kind}'
     AND lifecycle.milestone_id = :milestone_id
     AND lifecycle.slice_id IS ${slice}
     AND lifecycle.task_id IS ${task}`;
  return getDb().prepare(`
    SELECT task.slice_id, task.id AS task_id, task.status, lifecycle.lifecycle_status
    FROM tasks task ${lifecycleJoin("task", "task.slice_id", "task.id")}
    WHERE task.milestone_id = :milestone_id
    UNION ALL
    SELECT slice.id, NULL, slice.status, lifecycle.lifecycle_status
    FROM slices slice ${lifecycleJoin("slice", "slice.id", "NULL")}
    WHERE slice.milestone_id = :milestone_id
    UNION ALL
    SELECT NULL, NULL, milestone.status, lifecycle.lifecycle_status
    FROM milestones milestone ${lifecycleJoin("milestone", "NULL", "NULL")}
    WHERE milestone.id = :milestone_id
  `).all({ ":milestone_id": milestoneId }) as unknown as DiscardRow[];
}

/**
 * Tombstone the milestone: every open task, slice and the milestone itself
 * moves to cancelled (legacy 'skipped') and a milestone-scoped Waiver records
 * why. Closed work stays closed. Rows are kept, so the id is never reused.
 */
function cancelMilestoneHierarchy(
  context: Readonly<DomainOperationContext>,
  milestoneId: string,
  reason: string,
  grantedBy: Pick<CancellationWaiverInput, "grantedByActorType" | "grantedByActorId">,
): void {
  const rows = loadDiscardRows(milestoneId);
  if (rows.some((row) => row.lifecycle_status === "in_progress" && row.task_id !== null)) {
    throw new Error(`${milestoneId} has running task work; settle it first with /gsd task settle`);
  }
  let milestoneLifecycleId = "";
  for (const row of rows) {
    if (isClosedStatus(row.status) && row.task_id !== null) continue;
    if (isClosedStatus(row.status) && row.slice_id !== null) continue;
    const identity = row.task_id !== null
      ? { itemKind: "task" as const, milestoneId, sliceId: row.slice_id!, taskId: row.task_id }
      : row.slice_id !== null
        ? { itemKind: "slice" as const, milestoneId, sliceId: row.slice_id }
        : { itemKind: "milestone" as const, milestoneId };
    const lifecycle = adoptOrTransitionLifecycle(context, {
      ...identity,
      lifecycleStatus: "cancelled",
      ...(row.lifecycle_status === null
        ? { adoptedFromStatus: adoptionLifecycleStatus(`${identity.itemKind} ${milestoneId}`, row.status) }
        : {}),
    });
    if (identity.itemKind === "milestone") milestoneLifecycleId = lifecycle.lifecycleId;
    projectCanonicalStatusToLegacy(context, identity.itemKind === "task"
      ? { entity: "task", milestoneId, sliceId: row.slice_id!, taskId: row.task_id!, status: "skipped" }
      : identity.itemKind === "slice"
        ? { entity: "slice", milestoneId, sliceId: row.slice_id!, status: "skipped" }
        : { entity: "milestone", milestoneId, status: "skipped" });
  }
  grantCancellationWaiver(context, {
    lifecycleId: milestoneLifecycleId,
    scope: `milestone:${milestoneId}`,
    rationale: reason,
    ...grantedBy,
  });
}

/**
 * Discard a milestone: one milestone.discard Domain Operation cancels it and
 * its open work, then the worktree, milestone directory and queue entry are
 * removed as projection cleanup. Returns false when the milestone is not in
 * the database. Throws when the milestone is complete or the write fails.
 *
 * The operator grants the Waiver as the user, from the slash command or from a
 * typed host command. A tool call comes from the agent, so its Waiver is
 * granted by policy, like a slice skip.
 */
export async function discardMilestone(
  basePath: string,
  milestoneId: string,
  options: { reason?: string; invocation?: ExecutionInvocation } = {},
): Promise<boolean> {
  assertNotAutoActive("discard milestone");
  assertDbAvailable("discardMilestone", milestoneId);
  const milestone = readMilestone(milestoneId);
  if (!milestone) return false;
  if (!isReplay(options.invocation) && milestone.closed) {
    throw new Error(`${milestoneId} is already closed (${milestone.status}) and cannot be discarded`);
  }

  const reason = options.reason ?? "Discarded by user";
  const grantedBy = !options.invocation || options.invocation.actorType === "operator"
    ? { grantedByActorType: "user" as const, grantedByActorId: options.invocation?.actorId ?? "gsd-cli-operator" }
    : { grantedByActorType: "policy" as const, grantedByActorId: options.invocation.actorId ?? null };
  runMilestoneOperation("discard", milestoneId, { reason }, (context) =>
    cancelMilestoneHierarchy(context, milestoneId, reason, grantedBy), options.invocation);

  try {
    removeWorktree(basePath, milestoneId, {
      branch: `milestone/${milestoneId}`,
      deleteBranch: true,
    });
  } catch (err) {
    logWarning("engine", `discardMilestone worktree cleanup failed for ${milestoneId}: ${(err as Error).message}`);
  }
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (mDir && existsSync(mDir)) {
    removeManagedProjectionTreeExactSync(basePath, mDir);
  }
  const order = loadQueueOrder(basePath);
  if (order && order.includes(milestoneId)) {
    renderQueueOrder(basePath, order.filter(id => id !== milestoneId));
  }

  invalidateAllCaches();
  await renderStateProjection(basePath);
  return true;
}

// ─── Query ─────────────────────────────────────────────────────────────────

/** Whether the database records the milestone as parked. */
export function isParked(milestoneId: string): boolean {
  return isDbAvailable() && readMilestone(milestoneId)?.parked === true;
}

/** The reason recorded by the park Domain Operation, or null. */
export function getParkedReason(milestoneId: string): string | null {
  return isDbAvailable() ? readMilestoneParkRecord(milestoneId)?.reason ?? null : null;
}
