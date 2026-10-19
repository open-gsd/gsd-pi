// Project/App: gsd-pi
// File Purpose: Statement decision impact table — the workflow-state record of
// what a gsd_decision_save statement (D###) revalidates, supersedes or blocks.

import type { DbAdapter } from "./db-adapter.js";

export function hasDecisionStatementImpactSchema(db: DbAdapter): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'workflow_decision_statement_impacts'",
  ).get() != null;
}

/**
 * Impacts of a statement decision. gsd_decision_save records a STATEMENT
 * decision with a free-text scope — no Open Question, no interaction and no
 * Answer — so the conversation-domain `workflow_decision_impacts` table (which
 * requires an accepted Answer written in the same operation) cannot hold them.
 * This table is keyed on the D### decision id instead and is written only by
 * the `decision.save` Domain Operation. Rows are immutable.
 */
export function createDecisionStatementImpactSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_decision_statement_impacts (
      decision_id TEXT NOT NULL CHECK (decision_id GLOB 'D[0-9]*'),
      impact_ordinal INTEGER NOT NULL CHECK (impact_ordinal > 0),
      impact_kind TEXT NOT NULL CHECK (impact_kind IN ('revalidates', 'supersedes', 'blocks')),
      milestone_id TEXT DEFAULT NULL,
      slice_id TEXT DEFAULT NULL,
      task_id TEXT DEFAULT NULL,
      target_scope TEXT DEFAULT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_operation_id TEXT NOT NULL,
      created_project_revision INTEGER NOT NULL CHECK (created_project_revision > 0),
      PRIMARY KEY (decision_id, impact_ordinal),
      CHECK (milestone_id IS NOT NULL OR target_scope IS NOT NULL),
      CHECK (
        (slice_id IS NULL OR milestone_id IS NOT NULL) AND
        (task_id IS NULL OR (milestone_id IS NOT NULL AND slice_id IS NOT NULL))
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_statement_impact_supersedes
      ON workflow_decision_statement_impacts(decision_id) WHERE impact_kind = 'supersedes';

    CREATE INDEX IF NOT EXISTS idx_workflow_statement_impact_milestone
      ON workflow_decision_statement_impacts(milestone_id) WHERE milestone_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_statement_impact_immutable_update
    BEFORE UPDATE ON workflow_decision_statement_impacts
    BEGIN
      SELECT RAISE(ABORT, 'decision statement impacts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_statement_impact_immutable_delete
    BEFORE DELETE ON workflow_decision_statement_impacts
    BEGIN
      SELECT RAISE(ABORT, 'decision statement impacts are immutable');
    END;
  `);
}
