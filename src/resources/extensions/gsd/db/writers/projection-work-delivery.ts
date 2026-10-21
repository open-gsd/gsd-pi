// Project/App: gsd-pi
// File Purpose: Single-writer transitions for durable Projection Work delivery.

import { getDbOrNull, immediateTransaction } from "../engine.js";

export type ProjectionDeliveryAttempt =
  | { outcome: "rendered"; contentHash: string }
  | { outcome: "failed"; error: string };

type ProjectionWorkRow = {
  projection_work_id: string;
  source_project_revision: number;
  state_version: number;
  updated_at: string;
};

export interface ProjectionDeliveryBatch {
  work: readonly ProjectionWorkRow[];
}

function nextIso(after: string, candidate = new Date()): string {
  const afterMs = Date.parse(after);
  const nextMs = Number.isFinite(afterMs)
    ? Math.max(candidate.getTime(), afterMs + 1)
    : candidate.getTime();
  return new Date(nextMs).toISOString();
}

/**
 * Capture the exact due current heads that the next full render will cover.
 */
export function captureCurrentProjectionWork(): ProjectionDeliveryBatch {
  const db = getDbOrNull();
  if (!db) return { work: [] };
  const selectedAt = new Date().toISOString();
  const work = db.prepare(`
    SELECT work.projection_work_id, work.source_project_revision,
           work.state_version, work.updated_at
    FROM workflow_projection_work work
    WHERE work.delivery_state = 'pending'
      AND (work.next_attempt_at = '' OR julianday(work.next_attempt_at) <= julianday(:now))
      AND NOT EXISTS (
        SELECT 1 FROM workflow_projection_work successor
        WHERE successor.supersedes_projection_work_id = work.projection_work_id
      )
    ORDER BY work.source_project_revision, work.projection_work_id
  `).all({ ":now": selectedAt }) as ProjectionWorkRow[];
  return { work };
}

/**
 * Settle only captured work that is still the unchanged current head.
 * Claim and settlement share one immediate transaction. The one-millisecond
 * timestamps are the minimum distinct values representable by the schema.
 */
export function settleProjectionWork(
  batch: ProjectionDeliveryBatch,
  attempt: ProjectionDeliveryAttempt,
): number {
  const db = getDbOrNull();
  if (!db || batch.work.length === 0) return 0;
  return immediateTransaction(() => {
    const selectedAt = new Date();

    const claim = db.prepare(`
      UPDATE workflow_projection_work
      SET delivery_state = 'claimed', claim_owner = 'projection-worker',
          claim_fencing_token = claim_fencing_token + 1,
          claimed_at = :claimed_at, claim_expires_at = :claim_expires_at,
          state_version = state_version + 1, updated_at = :claimed_at
      WHERE projection_work_id = :id
        AND source_project_revision = :source_project_revision
        AND state_version = :state_version
        AND delivery_state = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM workflow_projection_work successor
          WHERE successor.supersedes_projection_work_id = :id
        )
    `);
    const rendered = db.prepare(`
      UPDATE workflow_projection_work
      SET delivery_state = 'rendered', claim_owner = NULL,
          claimed_at = NULL, claim_expires_at = NULL,
          attempt_count = attempt_count + 1,
          rendered_content_hash = :hash, rendered_at = :settled_at,
          state_version = state_version + 1, updated_at = :settled_at
      WHERE projection_work_id = :id AND delivery_state = 'claimed'
        AND claim_owner = 'projection-worker'
    `);
    const retry = db.prepare(`
      UPDATE workflow_projection_work
      SET delivery_state = 'pending', claim_owner = NULL,
          claimed_at = NULL, claim_expires_at = NULL,
          attempt_count = attempt_count + 1,
          next_attempt_at = :retry_at, last_error = :error,
          state_version = state_version + 1, updated_at = :settled_at
      WHERE projection_work_id = :id AND delivery_state = 'claimed'
        AND claim_owner = 'projection-worker'
    `);

    let settled = 0;
    for (const row of batch.work) {
      const claimedAt = nextIso(row.updated_at, selectedAt);
      const claimExpiresAt = nextIso(claimedAt);
      const settledAt = nextIso(claimExpiresAt);
      const claimed = claim.run({
        ":id": row.projection_work_id,
        ":source_project_revision": row.source_project_revision,
        ":state_version": row.state_version,
        ":claimed_at": claimedAt,
        ":claim_expires_at": claimExpiresAt,
      });
      if (Number((claimed as { changes?: number }).changes ?? 0) !== 1) continue;
      if (attempt.outcome === "rendered") {
        rendered.run({
          ":id": row.projection_work_id,
          ":hash": attempt.contentHash,
          ":settled_at": settledAt,
        });
      } else {
        retry.run({
          ":id": row.projection_work_id,
          ":error": attempt.error,
          ":settled_at": settledAt,
          ":retry_at": nextIso(settledAt),
        });
      }
      settled += 1;
    }
    return settled;
  });
}
