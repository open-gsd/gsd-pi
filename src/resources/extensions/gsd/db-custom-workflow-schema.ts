// Project/App: gsd-pi
// File Purpose: Custom workflow run, step and step verification tables (ADR-046).

import type { DbAdapter } from "./db-adapter.js";

const TABLES = ["custom_workflow_runs", "custom_workflow_steps", "custom_workflow_step_verifications"];

export function hasCustomWorkflowSchema(db: DbAdapter): boolean {
  return TABLES.every((name) => db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = :name",
  ).get({ ":name": name }) != null);
}

/**
 * A custom workflow run is database state. run_id is "<name>/<timestamp>", the
 * path of the run directory under .gsd/workflow-runs. definition_json is the
 * definition frozen at run creation. GRAPH.yaml, DEFINITION.yaml and
 * PARAMS.json in the run directory are renders of these rows. Idempotent.
 *
 * A verification row with verdict 'inconclusive' and a waiver_rationale is a
 * step that advanced with no check that could pass or fail it.
 */
export function createCustomWorkflowSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_workflow_runs (
      run_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      params_json TEXT,
      created_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      FOREIGN KEY (operation_id) REFERENCES workflow_operations(operation_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_workflow_steps (
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'complete', 'expanded')),
      prompt TEXT NOT NULL,
      depends_on_json TEXT NOT NULL,
      parent_step_id TEXT,
      started_at TEXT,
      finished_at TEXT,
      verify_retries INTEGER NOT NULL DEFAULT 0 CHECK (verify_retries >= 0),
      PRIMARY KEY (run_id, step_id),
      FOREIGN KEY (run_id) REFERENCES custom_workflow_runs(run_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_workflow_step_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'inconclusive')),
      evidence_json TEXT NOT NULL,
      waiver_rationale TEXT,
      recorded_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      FOREIGN KEY (run_id, step_id) REFERENCES custom_workflow_steps(run_id, step_id),
      FOREIGN KEY (operation_id) REFERENCES workflow_operations(operation_id)
    )
  `);
}
