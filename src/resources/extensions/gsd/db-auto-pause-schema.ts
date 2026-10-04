// Project/App: gsd-pi
// File Purpose: Auto-mode pause table — the database home of the pause that resume routing reads.

import type { DbAdapter } from "./db-adapter.js";

export function hasAutoPauseSchema(db: DbAdapter): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'auto_pauses'",
  ).get() != null;
}

/**
 * A pause is state of the worker, not of a unit: auto-mode can pause with no
 * active unit, and a custom-engine step has no dispatch row. So the pause has
 * its own row, with a link to the dispatch row of the unit that was active
 * when there is one. One row is open for each worker scope; a resume or a
 * discard closes it and the row stays. Idempotent.
 */
export function createAutoPauseSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_pauses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      blocker_kind TEXT NOT NULL CHECK (blocker_kind IN (
        'missing_authority', 'missing_access', 'external_dependency', 'consent',
        'ambiguous_intent', 'subjective_uat', 'user_limit',
        'user_request', 'machine_fixable'
      )),
      dispatch_id INTEGER,
      milestone_id TEXT,
      unit_type TEXT,
      unit_id TEXT,
      worktree_path TEXT,
      original_base_path TEXT,
      step_mode INTEGER NOT NULL CHECK (step_mode IN (0, 1)),
      session_file TEXT,
      active_engine_id TEXT,
      active_run_dir TEXT,
      auto_start_time INTEGER,
      milestone_lock TEXT,
      pause_reason TEXT,
      paused_at TEXT NOT NULL,
      closed_at TEXT,
      FOREIGN KEY (dispatch_id) REFERENCES unit_dispatches(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_pauses_open_scope
      ON auto_pauses(scope) WHERE closed_at IS NULL;
  `);
}
