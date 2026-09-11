// Project/App: gsd-pi
// File Purpose: v50 `blocker-accepted` operator closeout disposition (#2202).
//
// Two schema layers move together:
//  1. `workflow_item_lifecycles.lifecycle_status` gains the terminal
//     `blocker-accepted` value. SQLite cannot ALTER a CHECK constraint, so
//     databases created before V50 need the documented foreign-keys-off table
//     rebuild (`rebuildWorkflowItemLifecyclesForBlockerAccepted`). Fresh
//     installs already get the extended CHECK from the V32 DDL and skip it.
//  2. The lifecycle transition trigger is recreated with the disposition's
//     edges: task `in_progress → blocker-accepted` (closeout) and
//     `blocker-accepted → ready` (reopen parity with completed/cancelled).

import type { DbAdapter } from "./db-adapter.js";

const LIFECYCLE_TABLE_DDL = `
  CREATE TABLE {NAME} (
    lifecycle_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    item_kind TEXT NOT NULL CHECK (item_kind IN ('milestone', 'slice', 'task')),
    milestone_id TEXT NOT NULL,
    slice_id TEXT DEFAULT NULL,
    task_id TEXT DEFAULT NULL,
    lifecycle_status TEXT NOT NULL CHECK (
      lifecycle_status IN (
        'pending', 'ready', 'in_progress', 'paused', 'completed', 'cancelled', 'blocker-accepted'
      )
    ),
    state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_operation_id TEXT NOT NULL,
    last_project_revision INTEGER NOT NULL CHECK (last_project_revision > 0),
    last_authority_epoch INTEGER NOT NULL CHECK (last_authority_epoch >= 0),
    UNIQUE (lifecycle_id, project_id),
    CHECK (
      (item_kind = 'milestone' AND slice_id IS NULL AND task_id IS NULL) OR
      (item_kind = 'slice' AND slice_id IS NOT NULL AND task_id IS NULL) OR
      (item_kind = 'task' AND slice_id IS NOT NULL AND task_id IS NOT NULL)
    ),
    FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
    FOREIGN KEY (milestone_id) REFERENCES milestones(id),
    FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id),
    FOREIGN KEY (milestone_id, slice_id, task_id) REFERENCES tasks(milestone_id, slice_id, id),
    FOREIGN KEY (last_operation_id, project_id, last_project_revision, last_authority_epoch)
      REFERENCES workflow_operations(
        operation_id, project_id, resulting_revision, resulting_authority_epoch
      )
  )
`;

const LIFECYCLE_INDEX_DDL = [
  "CREATE INDEX IF NOT EXISTS idx_workflow_lifecycle_milestone ON workflow_item_lifecycles(project_id, milestone_id) WHERE item_kind = 'milestone'",
  "CREATE INDEX IF NOT EXISTS idx_workflow_lifecycle_slice ON workflow_item_lifecycles(project_id, milestone_id, slice_id) WHERE item_kind = 'slice'",
  "CREATE INDEX IF NOT EXISTS idx_workflow_lifecycle_task ON workflow_item_lifecycles(project_id, milestone_id, slice_id, task_id) WHERE item_kind = 'task'",
];

// The final transition trigger: the V45 form plus the #2202 disposition edges.
const LIFECYCLE_TRIGGER_DDL = [
  `
    CREATE TRIGGER IF NOT EXISTS trg_workflow_lifecycle_identity_immutable
    BEFORE UPDATE ON workflow_item_lifecycles
    WHEN NEW.lifecycle_id != OLD.lifecycle_id
      OR NEW.project_id != OLD.project_id
      OR NEW.item_kind != OLD.item_kind
      OR NEW.milestone_id != OLD.milestone_id
      OR NEW.slice_id IS NOT OLD.slice_id
      OR NEW.task_id IS NOT OLD.task_id
      OR NEW.created_at != OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'workflow lifecycle identity is immutable');
    END
  `,
  `
    CREATE TRIGGER IF NOT EXISTS trg_workflow_lifecycle_transition
    BEFORE UPDATE ON workflow_item_lifecycles
    WHEN NOT (
        NEW.lifecycle_status != OLD.lifecycle_status
        AND (
          NEW.last_project_revision <= OLD.last_project_revision
          OR NEW.last_authority_epoch < OLD.last_authority_epoch
        )
      )
      AND (
        NEW.lifecycle_status = OLD.lifecycle_status
        OR NEW.state_version != OLD.state_version + 1
        OR NEW.updated_at = OLD.updated_at
        OR NOT (
          (OLD.lifecycle_status = 'pending' AND NEW.lifecycle_status IN ('ready', 'cancelled')) OR
          (OLD.lifecycle_status = 'ready' AND NEW.lifecycle_status IN ('in_progress', 'paused', 'cancelled')) OR
          (OLD.item_kind = 'slice' AND OLD.lifecycle_status = 'ready' AND NEW.lifecycle_status = 'completed') OR
          (
            OLD.item_kind = 'milestone'
            AND OLD.lifecycle_status IN ('ready', 'in_progress')
            AND NEW.lifecycle_status = 'completed'
            AND EXISTS (
              SELECT 1
              FROM workflow_operations operation
              WHERE operation.operation_id = NEW.last_operation_id
                AND operation.project_id = NEW.project_id
                AND operation.operation_type = 'milestone.complete'
                AND operation.resulting_revision = NEW.last_project_revision
                AND operation.resulting_authority_epoch = NEW.last_authority_epoch
            )
          )
          OR (
            OLD.lifecycle_status = 'in_progress'
            AND NEW.lifecycle_status IN ('paused', 'completed', 'cancelled')
            AND NOT (OLD.item_kind = 'milestone' AND NEW.lifecycle_status = 'completed')
          )
          OR (
            OLD.item_kind = 'task'
            AND OLD.lifecycle_status = 'in_progress'
            AND NEW.lifecycle_status = 'blocker-accepted'
          )
          OR (OLD.lifecycle_status = 'paused' AND NEW.lifecycle_status IN ('ready', 'in_progress', 'cancelled'))
          OR (OLD.lifecycle_status IN ('completed', 'cancelled', 'blocker-accepted') AND NEW.lifecycle_status = 'ready')
          OR (
            OLD.lifecycle_status = 'completed'
            AND NEW.lifecycle_status = 'cancelled'
            AND EXISTS (
              SELECT 1
              FROM workflow_operations operation
              WHERE operation.operation_id = NEW.last_operation_id
                AND operation.project_id = NEW.project_id
                AND operation.operation_type = 'import.forward_repair'
                AND operation.resulting_revision = NEW.last_project_revision
                AND operation.resulting_authority_epoch = NEW.last_authority_epoch
            )
          )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid workflow lifecycle transition');
    END
  `,
  `
    CREATE TRIGGER IF NOT EXISTS trg_workflow_lifecycle_causal_provenance
    BEFORE UPDATE ON workflow_item_lifecycles
    WHEN NEW.lifecycle_status != OLD.lifecycle_status
      AND (
        NEW.last_project_revision <= OLD.last_project_revision
        OR NEW.last_authority_epoch < OLD.last_authority_epoch
      )
    BEGIN
      SELECT RAISE(ABORT, 'workflow lifecycle causal provenance must advance');
    END
  `,
  `
    CREATE TRIGGER IF NOT EXISTS trg_workflow_lifecycle_delete
    BEFORE DELETE ON workflow_item_lifecycles
    BEGIN
      SELECT RAISE(ABORT, 'workflow lifecycle records are durable history');
    END
  `,
  `
    CREATE TRIGGER IF NOT EXISTS trg_workflow_lifecycle_milestone_completion_insert
    BEFORE INSERT ON workflow_item_lifecycles
    WHEN NEW.item_kind = 'milestone'
      AND NEW.lifecycle_status = 'completed'
      AND NEW.state_version > 0
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_operations operation
        WHERE operation.operation_id = NEW.last_operation_id
          AND operation.project_id = NEW.project_id
          AND operation.operation_type = 'milestone.complete'
          AND operation.resulting_revision = NEW.last_project_revision
          AND operation.resulting_authority_epoch = NEW.last_authority_epoch
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid workflow lifecycle transition');
    END
  `,
  `
    CREATE TRIGGER IF NOT EXISTS trg_workflow_lifecycle_reopen_authorization
    BEFORE UPDATE ON workflow_item_lifecycles
    WHEN OLD.lifecycle_status IN ('completed', 'cancelled', 'blocker-accepted')
      AND NEW.lifecycle_status = 'ready'
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_operations operation
        WHERE operation.operation_id = NEW.last_operation_id
          AND operation.project_id = NEW.project_id
          AND operation.resulting_revision = NEW.last_project_revision
          AND operation.resulting_authority_epoch = NEW.last_authority_epoch
          AND (
            (
              NEW.item_kind = 'milestone'
              AND operation.operation_type = 'milestone.reopen'
            )
            OR (
              NEW.item_kind = 'slice'
              AND operation.operation_type IN ('slice.reopen', 'milestone.reopen')
            )
            OR (
              NEW.item_kind = 'task'
              AND operation.operation_type IN (
                'task.reopen', 'slice.reopen', 'milestone.reopen'
              )
            )
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid workflow lifecycle reopen authorization');
    END
  `,
];

/**
 * Relax the V32 `lifecycle_status` CHECK so the terminal `blocker-accepted`
 * value can persist. Runs SQLite's prescribed table rebuild with foreign keys
 * disabled — the pragma cannot change inside a transaction, so callers MUST
 * invoke this before opening the migration transaction (fresh installs skip
 * it: their V32 DDL already carries the extended CHECK).
 *
 * Triggers defined on OTHER tables whose bodies read
 * `workflow_item_lifecycles` (e.g. attempt fencing) cannot survive the DROP:
 * SQLite validates the whole schema when the parent disappears. They are
 * captured verbatim and recreated after the swap. `legacy_alter_table` keeps
 * the RENAME from rewriting child foreign-key clauses, and child FK clauses
 * still name `workflow_item_lifecycles`, which the renamed rebuild restores.
 */
export function rebuildWorkflowItemLifecyclesForBlockerAccepted(db: DbAdapter): void {
  const tableSql = (db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_item_lifecycles'
  `).get() as Record<string, unknown> | undefined)?.["sql"];
  if (typeof tableSql !== "string") return; // not created yet — V32 DDL carries the relaxed CHECK
  if (tableSql.includes("'blocker-accepted'")) return;

  const externalTriggers = db.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger'
      AND tbl_name != 'workflow_item_lifecycles'
      AND sql LIKE '%workflow_item_lifecycles%'
  `).all() as Array<Record<string, unknown>>;

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("PRAGMA legacy_alter_table = ON");
  db.exec("BEGIN");
  try {
    for (const trigger of externalTriggers) {
      db.exec(`DROP TRIGGER IF EXISTS ${String(trigger.name)}`);
    }
    db.exec(LIFECYCLE_TABLE_DDL.replace("{NAME}", "workflow_item_lifecycles_v50"));
    db.exec(`
      INSERT INTO workflow_item_lifecycles_v50 (
        lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
        lifecycle_status, state_version, created_at, updated_at,
        last_operation_id, last_project_revision, last_authority_epoch
      )
      SELECT
        lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
        lifecycle_status, state_version, created_at, updated_at,
        last_operation_id, last_project_revision, last_authority_epoch
      FROM workflow_item_lifecycles
    `);
    db.exec("DROP TABLE workflow_item_lifecycles");
    db.exec("ALTER TABLE workflow_item_lifecycles_v50 RENAME TO workflow_item_lifecycles");
    for (const trigger of externalTriggers) {
      db.exec(String(trigger.sql));
    }
    // Deliberately no PRAGMA foreign_key_check gate here: the rebuild copies
    // rows 1:1 and re-points the same table name, so it cannot introduce
    // violations — and pre-existing dangling rows in legacy databases must
    // not brick startup.
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA legacy_alter_table = OFF");
  }
}

/**
 * Idempotent V50 schema objects: the lifecycle indexes plus the final trigger
 * set, including the transition trigger with the `blocker-accepted` edges.
 * Safe to run on fresh installs (rebuild skipped, V32 DDL already relaxed) and
 * on rebuilt databases.
 */
export function createBlockerAcceptedCloseoutSchemaV50(db: DbAdapter): void {
  const lifecycleTable = db.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'workflow_item_lifecycles'
  `).get() as Record<string, unknown> | undefined;
  if (!lifecycleTable) {
    // Synthetic or partially-provisioned databases (e.g. sealed import
    // fixtures stamped at a newer version without every foundation table)
    // carry no lifecycle state to police — there is nothing to index or gate.
    return;
  }
  for (const ddl of LIFECYCLE_INDEX_DDL) db.exec(ddl);
  for (const ddl of LIFECYCLE_TRIGGER_DDL) {
    db.exec(`DROP TRIGGER IF EXISTS ${/CREATE TRIGGER IF NOT EXISTS (\S+)/.exec(ddl)![1]}`);
    db.exec(ddl);
  }
}
