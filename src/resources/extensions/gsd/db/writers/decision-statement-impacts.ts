// Project/App: gsd-pi
// File Purpose: Statement decision impact rows — written only inside the
// decision.save Domain Operation.

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import type { DecisionStatementImpact } from "../../types.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

export type { DecisionStatementImpact };

export const DECISION_STATEMENT_IMPACT_KINDS = [
  "revalidates",
  "supersedes",
  "blocks",
] as const;

export type DecisionStatementImpactKind = (typeof DECISION_STATEMENT_IMPACT_KINDS)[number];

/** One entry of the gsd_decision_save `impacts` array. */
export interface DecisionStatementImpactInput {
  kind: string;
  milestone_id?: string;
  slice_id?: string;
  task_id?: string;
  /** Free scope text; for kind `supersedes` this is the superseded D### id. */
  scope?: string;
  note?: string;
}

function trimmedOrUndefined(value: unknown, field: string, index: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`decision impact at impacts[${index}] has an invalid ${field}: it must be a non-empty string`);
  }
  return value.trim();
}

function requireUnitExists(
  index: number,
  milestoneId: string,
  sliceId: string | undefined,
  taskId: string | undefined,
): void {
  const db = getDb();
  if (taskId !== undefined) {
    const task = db.prepare(
      "SELECT 1 AS present FROM tasks WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :task_id",
    ).get({ ":milestone_id": milestoneId, ":slice_id": sliceId, ":task_id": taskId });
    if (!task) {
      throw new Error(`decision impact at impacts[${index}] targets unknown task ${milestoneId}/${sliceId}/${taskId}`);
    }
    return;
  }
  if (sliceId !== undefined) {
    const slice = db.prepare(
      "SELECT 1 AS present FROM slices WHERE milestone_id = :milestone_id AND id = :slice_id",
    ).get({ ":milestone_id": milestoneId, ":slice_id": sliceId });
    if (!slice) {
      throw new Error(`decision impact at impacts[${index}] targets unknown slice ${milestoneId}/${sliceId}`);
    }
    return;
  }
  const milestone = db.prepare(
    "SELECT 1 AS present FROM milestones WHERE id = :milestone_id",
  ).get({ ":milestone_id": milestoneId });
  if (!milestone) {
    throw new Error(`decision impact at impacts[${index}] targets unknown milestone ${milestoneId}`);
  }
}

/**
 * Validate the caller's impacts and lay out the rows for one statement save.
 * Ordinals follow the array order; a superseding save appends the supersede
 * row last (the amends target is the `scope`). Throws loudly on an unknown
 * kind, a missing target, or a target that names no existing unit.
 */
export function buildStatementImpactRows(
  decisionId: string,
  impacts: readonly DecisionStatementImpactInput[] | undefined,
  supersedes: string | undefined,
): DecisionStatementImpact[] {
  const rows: DecisionStatementImpact[] = [];
  (impacts ?? []).forEach((impact, index) => {
    if (
      impact === null || typeof impact !== "object" ||
      typeof impact.kind !== "string" ||
      !(DECISION_STATEMENT_IMPACT_KINDS as readonly string[]).includes(impact.kind)
    ) {
      throw new Error(
        `decision impact at impacts[${index}] has unknown kind ${JSON.stringify((impact as { kind?: unknown } | null)?.kind)}; use one of: ${DECISION_STATEMENT_IMPACT_KINDS.join(", ")}`,
      );
    }
    const milestoneId = trimmedOrUndefined(impact.milestone_id, "milestone_id", index);
    const sliceId = trimmedOrUndefined(impact.slice_id, "slice_id", index);
    const taskId = trimmedOrUndefined(impact.task_id, "task_id", index);
    const scope = trimmedOrUndefined(impact.scope, "scope", index);
    if (milestoneId === undefined && scope === undefined) {
      throw new Error(`decision impact at impacts[${index}] needs a target: give milestone_id or scope`);
    }
    if (sliceId !== undefined && milestoneId === undefined) {
      throw new Error(`decision impact at impacts[${index}] needs milestone_id when slice_id is set`);
    }
    if (taskId !== undefined && sliceId === undefined) {
      throw new Error(`decision impact at impacts[${index}] needs slice_id when task_id is set`);
    }
    if (milestoneId !== undefined) requireUnitExists(index, milestoneId, sliceId, taskId);
    rows.push({
      decision_id: decisionId,
      impact_ordinal: rows.length + 1,
      impact_kind: impact.kind as DecisionStatementImpactKind,
      milestone_id: milestoneId ?? null,
      slice_id: sliceId ?? null,
      task_id: taskId ?? null,
      target_scope: scope ?? null,
      payload: typeof impact.note === "string" ? impact.note : "",
    });
  });
  if (supersedes !== undefined) {
    rows.push({
      decision_id: decisionId,
      impact_ordinal: rows.length + 1,
      impact_kind: "supersedes",
      milestone_id: null,
      slice_id: null,
      task_id: null,
      target_scope: supersedes,
      payload: "",
    });
  }
  return rows;
}

/**
 * Insert the rows of one decision save. Only the `decision.save` Domain
 * Operation may write this table; the call must run inside its mutation.
 */
export function insertDecisionStatementImpacts(
  context: Readonly<DomainOperationContext>,
  rows: readonly DecisionStatementImpact[],
): void {
  if (rows.length === 0) return;
  if (requireActiveDomainOperationContext(context) !== "decision.save") {
    throw new Error("decision statement impacts are written only by the decision.save Domain Operation");
  }
  const insert = getDb().prepare(`
    INSERT INTO workflow_decision_statement_impacts (
      decision_id, impact_ordinal, impact_kind,
      milestone_id, slice_id, task_id, target_scope, payload,
      created_at, created_operation_id, created_project_revision
    ) VALUES (
      :decision_id, :impact_ordinal, :impact_kind,
      :milestone_id, :slice_id, :task_id, :target_scope, :payload,
      :created_at, :created_operation_id, :created_project_revision
    )
  `);
  for (const row of rows) {
    insert.run({
      ":decision_id": row.decision_id,
      ":impact_ordinal": row.impact_ordinal,
      ":impact_kind": row.impact_kind,
      ":milestone_id": row.milestone_id,
      ":slice_id": row.slice_id,
      ":task_id": row.task_id,
      ":target_scope": row.target_scope,
      ":payload": row.payload,
      ":created_at": new Date().toISOString(),
      ":created_operation_id": context.operationId,
      ":created_project_revision": context.resultingRevision,
    });
  }
}
