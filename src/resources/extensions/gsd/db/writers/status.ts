// Project/App: gsd-pi
// File Purpose: Status Transition Core (ADR-030) — the single row-level
// chokepoint every generic status write funnels through. Owns the milestone
// adopted-lifecycle and closed→open guards and is the one place future
// row-level status policy lands.
// The update*Status faces in gsd-db.ts delegate here.
//
// Two ADR-030 responsibilities remain deferred for safety:
//   - Write-normalization via toStatus(): workflow-reconcile replays journal
//     events that write raw "done"/"in-progress" and tests assert those exact
//     stored values, so converging on write is a separate, behavior-sensitive
//     change (migrate replay/import to canonical first).
//   - Generalizing the closed→open guard to unadopted slices: legitimate reopen
//     callers still use the generic face. Adopted slices are fenced below, but
//     changing unadopted compatibility behavior remains separate work.
import type { DomainOperationContext } from "../domain-operation.js";
import { getDbOrNull, immediateTransaction } from "../engine.js";
import { compareLifecycleShadow } from "../lifecycle-shadow-comparison.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";
import { GSDError, GSD_STALE_STATE } from "../../errors.js";
import { isClosedStatus } from "../../status-guards.js";

/**
 * A single row-level status write, discriminated by entity (the faces' arity).
 *
 * preserveCompletion (#1291): when true, an existing non-null completed_at on the
 * row is kept rather than overwritten. Mirrors the task upsert's guard so a
 * markdown re-import cannot re-stamp an already-complete slice/milestone with the
 * current import time — the DB row is strictly richer than the plan.
 */
export type StatusTransition =
  | { entity: "task"; milestoneId: string; sliceId: string; taskId: string; status: string; completedAt?: string | null; preserveCompletion?: boolean }
  | { entity: "slice"; milestoneId: string; sliceId: string; status: string; completedAt?: string | null; preserveCompletion?: boolean }
  | { entity: "milestone"; milestoneId: string; status: string; completedAt?: string | null; preserveCompletion?: boolean };

function requireDb() {
  const db = getDbOrNull();
  if (!db) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  return db;
}

interface StatusRow {
  status: string | null;
  completedAt: string | null;
  canonicalStatus: string | null;
  canonicalLastOperationId: string | null;
}

function readStatusRow(t: StatusTransition): StatusRow {
  const db = requireDb();
  let row: Record<string, unknown> | undefined;
  if (t.entity === "milestone") {
    row = db.prepare(`
      SELECT hierarchy.status, hierarchy.completed_at,
             lifecycle.lifecycle_status AS canonical_status,
             lifecycle.last_operation_id AS canonical_last_operation_id
      FROM milestones hierarchy
      LEFT JOIN workflow_item_lifecycles lifecycle
        ON lifecycle.milestone_id = hierarchy.id
       AND lifecycle.item_kind = 'milestone'
       AND lifecycle.slice_id IS NULL
       AND lifecycle.task_id IS NULL
       AND lifecycle.project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)
      WHERE hierarchy.id = :milestone_id
    `).get({ ":milestone_id": t.milestoneId });
  } else if (t.entity === "slice") {
    row = db.prepare(`
      SELECT hierarchy.status, hierarchy.completed_at,
             lifecycle.lifecycle_status AS canonical_status,
             lifecycle.last_operation_id AS canonical_last_operation_id
      FROM slices hierarchy
      LEFT JOIN workflow_item_lifecycles lifecycle
        ON lifecycle.milestone_id = hierarchy.milestone_id
       AND lifecycle.slice_id = hierarchy.id
       AND lifecycle.item_kind = 'slice'
       AND lifecycle.task_id IS NULL
       AND lifecycle.project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)
      WHERE hierarchy.milestone_id = :milestone_id AND hierarchy.id = :slice_id
    `).get({ ":milestone_id": t.milestoneId, ":slice_id": t.sliceId });
  } else {
    row = db.prepare(`
      SELECT hierarchy.status, hierarchy.completed_at,
             lifecycle.lifecycle_status AS canonical_status,
             lifecycle.last_operation_id AS canonical_last_operation_id
      FROM tasks hierarchy
      LEFT JOIN workflow_item_lifecycles lifecycle
        ON lifecycle.milestone_id = hierarchy.milestone_id
       AND lifecycle.slice_id = hierarchy.slice_id
       AND lifecycle.task_id = hierarchy.id
       AND lifecycle.item_kind = 'task'
       AND lifecycle.project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)
      WHERE hierarchy.milestone_id = :milestone_id
        AND hierarchy.slice_id = :slice_id
        AND hierarchy.id = :task_id
    `).get({ ":milestone_id": t.milestoneId, ":slice_id": t.sliceId, ":task_id": t.taskId });
  }
  return {
    status: typeof row?.["status"] === "string" ? row["status"] : null,
    completedAt: typeof row?.["completed_at"] === "string" ? row["completed_at"] : null,
    canonicalStatus: typeof row?.["canonical_status"] === "string" ? row["canonical_status"] : null,
    canonicalLastOperationId: typeof row?.["canonical_last_operation_id"] === "string"
      ? row["canonical_last_operation_id"]
      : null,
  };
}

function entityLabel(t: StatusTransition): string {
  if (t.entity === "task") return `Task ${t.taskId}`;
  if (t.entity === "slice") return `Slice ${t.sliceId}`;
  return `Milestone ${t.milestoneId}`;
}

function isAligned(legacyStatus: string, canonicalStatus: string): boolean {
  const comparison = compareLifecycleShadow(legacyStatus, canonicalStatus);
  return comparison.kind === "match" || comparison.kind === "semantic_match_exact_delta";
}

function requireGenericAdoptedWriteIsAligned(t: StatusTransition, row: StatusRow): void {
  if (!row.status || !row.canonicalStatus) return;
  if (!isAligned(row.status, row.canonicalStatus)) {
    throw new Error(
      `Cannot update adopted ${entityLabel(t)} while canonical and legacy status mismatch ` +
      `(canonical=${row.canonicalStatus}, legacy=${row.status}).`,
    );
  }
  if (!isAligned(t.status, row.canonicalStatus)) {
    throw new Error(
      `Cannot change adopted ${entityLabel(t)} legacy status to ${t.status}; ` +
      `canonical lifecycle is ${row.canonicalStatus}. Use the canonical lifecycle operation.`,
    );
  }
}

interface CompletionWrite {
  completedAt: string | null;
  preserveExisting: boolean;
}

function genericCompletionWrite(t: StatusTransition, row: StatusRow): CompletionWrite {
  if (!row.canonicalStatus) {
    return {
      completedAt: t.completedAt ?? null,
      preserveExisting: t.preserveCompletion ?? false,
    };
  }
  if (
    (row.canonicalStatus === "completed" || row.canonicalStatus === "cancelled") &&
    row.status !== null &&
    isClosedStatus(row.status) &&
    isClosedStatus(t.status) &&
    row.completedAt === null &&
    t.completedAt != null
  ) {
    return { completedAt: t.completedAt, preserveExisting: false };
  }
  return {
    completedAt: null,
    preserveExisting: row.completedAt !== null,
  };
}

function writeStatusTransition(
  t: StatusTransition,
  completion: CompletionWrite = {
    completedAt: t.completedAt ?? null,
    preserveExisting: t.preserveCompletion ?? false,
  },
): void {
  const db = requireDb();
  const preserve = completion.preserveExisting ? 1 : 0;
  if (t.entity === "task") {
    db.prepare(
      `UPDATE tasks SET status = :status,
         completed_at = CASE WHEN :preserve_completion = 1 AND tasks.completed_at IS NOT NULL
                             THEN tasks.completed_at ELSE :completed_at END
       WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :id`,
    ).run({
      ":status": t.status,
      ":completed_at": completion.completedAt,
      ":preserve_completion": preserve,
      ":milestone_id": t.milestoneId,
      ":slice_id": t.sliceId,
      ":id": t.taskId,
    });
    return;
  }
  const table = t.entity === "slice" ? "slices" : "milestones";
  const idColumn = t.entity === "slice" ? "milestone_id = :milestone_id AND id" : "id";
  const params: Record<string, unknown> = {
    ":status": t.status,
    ":completed_at": completion.completedAt,
    ":preserve_completion": preserve,
    ":id": t.entity === "slice" ? t.sliceId : t.milestoneId,
  };
  if (t.entity === "slice") params[":milestone_id"] = t.milestoneId;
  db.prepare(
    `UPDATE ${table} SET status = :status,
       completed_at = CASE WHEN :preserve_completion = 1 AND ${table}.completed_at IS NOT NULL
                           THEN ${table}.completed_at ELSE :completed_at END
     WHERE ${idColumn} = :id`,
  ).run(params);
}

/**
 * Apply a row-level status transition. The single chokepoint for generic status
 * writes — the update*Status faces delegate here so the guard and (future)
 * normalization/journal/cache policy live in one place rather than per face.
 *
 * Closed→open guard: generic updates may close or advance Tasks and milestones,
 * but may not reopen closed rows; callers must use the corresponding semantic
 * reopen operation. Slices are not yet guarded — see the file header.
 */
function applyStatusTransitionLocked(t: StatusTransition): void {
  const row = readStatusRow(t);
  requireGenericAdoptedWriteIsAligned(t, row);
  const completion = genericCompletionWrite(t, row);

  switch (t.entity) {
    case "task": {
      const currentStatus = row.status;
      if (currentStatus && isClosedStatus(currentStatus) && !isClosedStatus(t.status)) {
        throw new Error(
          `Cannot update closed task ${t.taskId} from ${currentStatus} to ${t.status}; use gsd_task_reopen for an explicit reopen.`,
        );
      }
      writeStatusTransition(t, completion);
      return;
    }

    case "slice":
      writeStatusTransition(t, completion);
      return;

    case "milestone": {
      const currentStatus = row.status;
      const closesMilestone = isClosedStatus(t.status);
      if (currentStatus && isClosedStatus(currentStatus) && !closesMilestone) {
        throw new Error(
          `Cannot update closed milestone ${t.milestoneId} from ${currentStatus} to ${t.status}; use gsd_milestone_reopen for an explicit reopen.`,
        );
      }
      writeStatusTransition(t, completion);
      return;
    }
  }
}

export function applyStatusTransition(t: StatusTransition): void {
  immediateTransaction(() => applyStatusTransitionLocked(t));
}

/**
 * Project a canonical lifecycle transition back to its legacy hierarchy row.
 * The lifecycle must have been written by this exact active Domain Operation.
 */
export function projectCanonicalStatusToLegacy(
  context: Readonly<DomainOperationContext>,
  transition: StatusTransition,
): void {
  immediateTransaction(() => {
    requireActiveDomainOperationContext(context);
    const row = readStatusRow(transition);
    if (!row.canonicalStatus) {
      throw new Error(
        `Cannot project ${entityLabel(transition)} without a canonical lifecycle.`,
      );
    }
    if (!isAligned(transition.status, row.canonicalStatus)) {
      throw new Error(
        `Cannot project ${entityLabel(transition)} legacy status ${transition.status}; ` +
        `canonical lifecycle is ${row.canonicalStatus}.`,
      );
    }
    if (row.status && isAligned(row.status, row.canonicalStatus)) return;
    if (row.canonicalLastOperationId !== context.operationId) {
      throw new Error(
        `Cannot project ${entityLabel(transition)} without a canonical lifecycle transition from the active Domain Operation.`,
      );
    }
    writeStatusTransition(transition);
  });
}
