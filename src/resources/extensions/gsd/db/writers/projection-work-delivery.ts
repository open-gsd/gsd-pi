// Project/App: gsd-pi
// File Purpose: Single-writer transitions for durable Projection Work delivery.

import { executeDomainOperation } from "../domain-operation.js";
import { getDbOrNull, immediateTransaction } from "../engine.js";
import { readDomainOperationFence } from "./lifecycle-commands.js";

/** A current (unsuperseded) Projection Work head. */
export interface ProjectionWorkHead {
  projection_work_id: string;
  projection_key: string;
  projection_kind: string;
  delivery_state: string;
  state_version: number;
  attempt_count: number;
  claim_owner: string | null;
  claim_fencing_token: number;
  claim_expires_at: string | null;
  next_attempt_at: string;
  last_error: string;
  updated_at: string;
}

/** A head this worker claimed; only the claim owner and token can settle it. */
export interface ProjectionWorkClaim {
  projectionWorkId: string;
  owner: string;
  fencingToken: number;
  attemptCount: number;
  updatedAt: string;
}

const CURRENT_HEAD = `NOT EXISTS (
  SELECT 1 FROM workflow_projection_work successor
  WHERE successor.supersedes_projection_work_id = work.projection_work_id
)`;

/** A timestamp at `at` or later that is strictly after `after` (the schema needs distinct values). */
function laterIso(after: string, at: Date): string {
  const afterMs = Date.parse(after);
  const nextMs = Number.isFinite(afterMs) ? Math.max(at.getTime(), afterMs + 1) : at.getTime();
  return new Date(nextMs).toISOString();
}

/** Current heads in the given delivery states, oldest revision first. */
export function listProjectionWorkHeads(states: readonly string[]): ProjectionWorkHead[] {
  const db = getDbOrNull();
  if (!db || states.length === 0) return [];
  const params: Record<string, string> = {};
  const placeholders = states.map((state, index) => {
    params[`:s${index}`] = state;
    return `:s${index}`;
  });
  return db.prepare(`
    SELECT work.projection_work_id, work.projection_key, work.projection_kind,
           work.delivery_state, work.state_version, work.attempt_count,
           work.claim_owner, work.claim_fencing_token, work.claim_expires_at,
           work.next_attempt_at, work.last_error, work.updated_at
    FROM workflow_projection_work work
    WHERE work.delivery_state IN (${placeholders.join(", ")}) AND ${CURRENT_HEAD}
    ORDER BY work.source_project_revision, work.projection_work_id
  `).all(params) as unknown as ProjectionWorkHead[];
}

/** Pending heads whose retry time has come. */
export function listDueProjectionWork(now: Date): ProjectionWorkHead[] {
  return listProjectionWorkHeads(["pending"]).filter((head) =>
    head.next_attempt_at === "" || Date.parse(head.next_attempt_at) <= now.getTime());
}

/** Claimed heads whose claim expired before the owner settled them. */
export function listExpiredProjectionClaims(now: Date): ProjectionWorkHead[] {
  return listProjectionWorkHeads(["claimed"]).filter((head) =>
    Date.parse(head.claim_expires_at ?? "") <= now.getTime());
}

/** Claim one pending head before rendering it. Returns null when another writer changed it first. */
export function claimProjectionWork(
  head: ProjectionWorkHead,
  owner: string,
  now: Date,
  claimExpiresAt: Date,
): ProjectionWorkClaim | null {
  const db = getDbOrNull();
  if (!db) return null;
  return immediateTransaction(() => {
    const claimedAt = laterIso(head.updated_at, now);
    const changed = db.prepare(`
      UPDATE workflow_projection_work AS work
      SET delivery_state = 'claimed', claim_owner = :owner,
          claim_fencing_token = claim_fencing_token + 1,
          claimed_at = :claimed_at, claim_expires_at = :claim_expires_at,
          state_version = state_version + 1, updated_at = :claimed_at
      WHERE work.projection_work_id = :id AND work.state_version = :state_version
        AND work.delivery_state = 'pending' AND ${CURRENT_HEAD}
    `).run({
      ":id": head.projection_work_id,
      ":owner": owner,
      ":state_version": head.state_version,
      ":claimed_at": claimedAt,
      ":claim_expires_at": laterIso(claimedAt, claimExpiresAt),
    }) as { changes?: number };
    if (Number(changed.changes ?? 0) !== 1) return null;
    return {
      projectionWorkId: head.projection_work_id,
      owner,
      fencingToken: head.claim_fencing_token + 1,
      attemptCount: head.attempt_count,
      updatedAt: claimedAt,
    };
  });
}

/** Rebuild the claim of an expired head so its failure can be recorded. */
export function expiredProjectionClaim(head: ProjectionWorkHead): ProjectionWorkClaim {
  return {
    projectionWorkId: head.projection_work_id,
    owner: head.claim_owner ?? "",
    fencingToken: head.claim_fencing_token,
    attemptCount: head.attempt_count,
    updatedAt: head.updated_at,
  };
}

function settle(sql: string, claim: ProjectionWorkClaim, params: Record<string, string>): boolean {
  const db = getDbOrNull();
  if (!db) return false;
  return immediateTransaction(() => {
    const changed = db.prepare(`
      UPDATE workflow_projection_work AS work
      SET ${sql}, claim_owner = NULL, claimed_at = NULL, claim_expires_at = NULL,
          attempt_count = attempt_count + 1,
          state_version = state_version + 1, updated_at = :settled_at
      WHERE work.projection_work_id = :id AND work.delivery_state = 'claimed'
        AND work.claim_owner = :owner AND work.claim_fencing_token = :token
        AND ${CURRENT_HEAD}
    `).run({
      ...params,
      ":id": claim.projectionWorkId,
      ":owner": claim.owner,
      ":token": claim.fencingToken,
    }) as { changes?: number };
    return Number(changed.changes ?? 0) === 1;
  });
}

/**
 * Settle a claimed head as rendered with the hash of the files it wrote.
 * Returns false when the claim was lost or a newer revision superseded it.
 */
export function settleRenderedProjectionWork(
  claim: ProjectionWorkClaim,
  contentHash: string,
  now: Date,
): boolean {
  const settledAt = laterIso(claim.updatedAt, now);
  return settle(
    `delivery_state = 'rendered', rendered_content_hash = :hash, rendered_at = :settled_at,
     next_attempt_at = '', last_error = ''`,
    claim,
    { ":hash": contentHash, ":settled_at": settledAt },
  );
}

/**
 * Record a failed attempt. With a retry time the head returns to pending;
 * without one it moves to dead_letter and is not retried.
 */
export function settleFailedProjectionWork(
  claim: ProjectionWorkClaim,
  error: string,
  now: Date,
  retryAt: Date | null,
): boolean {
  const settledAt = laterIso(claim.updatedAt, now);
  const message = error.trim() || "projection render failed";
  if (retryAt === null) {
    return settle(`delivery_state = 'dead_letter', last_error = :error`, claim, {
      ":error": message,
      ":settled_at": settledAt,
    });
  }
  return settle(`delivery_state = 'pending', next_attempt_at = :retry_at, last_error = :error`, claim, {
    ":error": message,
    ":settled_at": settledAt,
    ":retry_at": laterIso(settledAt, retryAt),
  });
}

/**
 * Enqueue a new head for each projection in one Domain Operation, so the
 * Projection Worker renders it again. A delivery row cannot leave dead_letter,
 * so the new head supersedes it. Does nothing for an empty list.
 */
export function requeueProjectionWork(
  projections: ReadonlyArray<{ projectionKey: string; projectionKind: string }>,
): void {
  if (projections.length === 0) return;
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "projection.requeue",
    idempotencyKey: `projection-requeue/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "operator",
    sourceTransport: "internal",
    payload: { projectionKeys: projections.map((projection) => projection.projectionKey) },
  }, () => ({
    events: projections.map((projection) => ({
      eventType: "projection.requeued",
      entityType: "projection",
      entityId: projection.projectionKey,
      payload: { projectionKind: projection.projectionKind },
      destinations: ["db"],
    })),
    projections: projections.map((projection) => ({ ...projection, rendererVersion: "1" })),
  }));
}
