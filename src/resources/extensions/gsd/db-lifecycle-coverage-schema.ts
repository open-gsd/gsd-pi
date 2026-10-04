// Project/App: gsd-pi
// File Purpose: Triggers that fence the hierarchy tables after the Authority Epoch cutover: no row without a lifecycle row, no status change outside a Domain Operation.

import type { DbAdapter } from "./db-adapter.js";

/** Each hierarchy table, with the identity of the lifecycle row of the row that an UPDATE changes. */
const HIERARCHY_TABLES = {
  milestones: "lifecycle.item_kind = 'milestone' AND lifecycle.milestone_id = OLD.id",
  slices: `lifecycle.item_kind = 'slice' AND lifecycle.milestone_id = OLD.milestone_id
            AND lifecycle.slice_id = OLD.id`,
  tasks: `lifecycle.item_kind = 'task' AND lifecycle.milestone_id = OLD.milestone_id
            AND lifecycle.slice_id = OLD.slice_id AND lifecycle.task_id = OLD.id`,
} as const;

const FENCE_TRIGGERS = [
  ...Object.keys(HIERARCHY_TABLES).flatMap((table) => [
    `trg_${table}_lifecycle_coverage`,
    `trg_${table}_status_authority`,
  ]),
  "trg_project_authority_lifecycle_coverage",
];

export function hasLifecycleCoverageFence(db: DbAdapter): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'trigger'
      AND name IN (${FENCE_TRIGGERS.map((name) => `'${name}'`).join(", ")})
  `).get();
  return Number(row?.["count"]) === FENCE_TRIGGERS.length;
}

const UNCOVERED_MESSAGE = "a hierarchy row has no lifecycle row";

/** Every hierarchy row with no lifecycle row, as `kind id="raw status"`. */
export function listUncoveredHierarchyRows(db: DbAdapter): string[] {
  const uncovered = (kind: string, slice: string, task: string) => `NOT EXISTS (
        SELECT 1 FROM workflow_item_lifecycles lifecycle
        WHERE lifecycle.item_kind = '${kind}'
          AND lifecycle.milestone_id = item.${kind === "milestone" ? "id" : "milestone_id"}
          AND lifecycle.slice_id IS ${slice}
          AND lifecycle.task_id IS ${task}
      )`;
  return db.prepare(`
    SELECT 'milestone ' || item.id AS label, item.status FROM milestones item
    WHERE ${uncovered("milestone", "NULL", "NULL")}
    UNION ALL
    SELECT 'slice ' || item.milestone_id || '/' || item.id, item.status FROM slices item
    WHERE ${uncovered("slice", "item.id", "NULL")}
    UNION ALL
    SELECT 'task ' || item.milestone_id || '/' || item.slice_id || '/' || item.id, item.status FROM tasks item
    WHERE ${uncovered("task", "item.slice_id", "item.id")}
  `).all().map((row) => `${row["label"]}=${JSON.stringify(row["status"])}`);
}

/**
 * The error of the commit trigger, with the rows and the remedy. Call it
 * before the transaction rolls back, so a row that the refused Domain
 * Operation inserted is named too. Any other error comes back as it is.
 */
export function describeLifecycleCoverageRefusal(db: DbAdapter, error: unknown): unknown {
  if (!(error instanceof Error) || !error.message.includes(UNCOVERED_MESSAGE)) return error;
  return new LifecycleCoverageRefusedError(
    `${UNCOVERED_MESSAGE}: ${listUncoveredHierarchyRows(db).join(", ")}. The Domain Operation was not committed. ` +
      "Run /gsd db adopt to preview the lifecycle backfill, then /gsd db adopt --apply.",
    { cause: error },
  );
}

/** The commit trigger refused a Domain Operation: a hierarchy row has no lifecycle row. */
export class LifecycleCoverageRefusedError extends Error {
  override readonly name = "LifecycleCoverageRefusedError";
}

function missingLifecycle(table: string, alias: string, identity: string): string {
  return `EXISTS (
        SELECT 1 FROM ${table} ${alias}
        WHERE NOT EXISTS (
          SELECT 1 FROM workflow_item_lifecycles lifecycle
          WHERE lifecycle.project_id = NEW.project_id
            AND ${identity}
        )
      )`;
}

/**
 * ADR-046 migration step 5. When the Authority Epoch of the Project is above
 * 0, every Milestone, Slice and Task row has a lifecycle row:
 *
 * - A hierarchy row can be inserted only while a Domain Operation is open
 *   (its operation row holds the next project revision). AFTER INSERT does not
 *   fire for an upsert that updates a row or for an ignored insert, so writes
 *   to rows that exist are not fenced here.
 * - The Domain Operation cannot commit (the project_authority update) while a
 *   hierarchy row has no lifecycle row. The same check refuses the cutover
 *   itself, so the epoch cannot advance over an unadopted row.
 *
 * - The legacy status of a hierarchy row that has a lifecycle row can change
 *   only while a Domain Operation is open: the status is a projection of the
 *   lifecycle row, which only a Domain Operation writes. Other columns (plan
 *   text, summaries) are not fenced. A row with no lifecycle row (left by an
 *   earlier build) is not fenced, so its status can be fixed for the backfill.
 *   No delete fence is needed: the foreign key of the lifecycle row, which
 *   cannot be deleted, already keeps the hierarchy row.
 *
 * Epoch 0 is not fenced: legacy writers and unadopted rows are still valid
 * there. Not versioned: the triggers hold no data, so every open creates the
 * ones that are missing.
 */
export function ensureLifecycleCoverageFence(db: DbAdapter): void {
  const outsideDomainOperation = `(SELECT authority_epoch FROM project_authority WHERE singleton = 1) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM workflow_operations operation
          JOIN project_authority authority ON authority.project_id = operation.project_id
          WHERE authority.singleton = 1
            AND operation.resulting_revision = authority.revision + 1
        )`;
  for (const [table, lifecycleOfOldRow] of Object.entries(HIERARCHY_TABLES)) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_lifecycle_coverage
      AFTER INSERT ON ${table}
      WHEN ${outsideDomainOperation}
      BEGIN
        SELECT RAISE(ABORT, 'a hierarchy row needs a lifecycle row from the same Domain Operation');
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_status_authority
      BEFORE UPDATE OF status ON ${table}
      WHEN NEW.status IS NOT OLD.status AND ${outsideDomainOperation}
        AND EXISTS (SELECT 1 FROM workflow_item_lifecycles lifecycle WHERE ${lifecycleOfOldRow})
      BEGIN
        SELECT RAISE(ABORT, 'the status of a hierarchy row changes only in a Domain Operation');
      END
    `);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_project_authority_lifecycle_coverage
    BEFORE UPDATE OF revision, authority_epoch ON project_authority
    WHEN NEW.authority_epoch > 0 AND (
      ${missingLifecycle("milestones", "milestone", `lifecycle.item_kind = 'milestone'
            AND lifecycle.milestone_id = milestone.id`)}
      OR ${missingLifecycle("slices", "slice", `lifecycle.item_kind = 'slice'
            AND lifecycle.milestone_id = slice.milestone_id
            AND lifecycle.slice_id = slice.id`)}
      OR ${missingLifecycle("tasks", "task", `lifecycle.item_kind = 'task'
            AND lifecycle.milestone_id = task.milestone_id
            AND lifecycle.slice_id = task.slice_id
            AND lifecycle.task_id = task.id`)}
    )
    BEGIN
      SELECT RAISE(ABORT, '${UNCOVERED_MESSAGE}');
    END
  `);
}
