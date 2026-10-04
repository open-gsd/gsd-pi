// Project/App: gsd-pi
// File Purpose: exec_runs table — the database record of every host-executed
// gsd_exec / gsd_uat_exec command.

import type { DbAdapter } from "./db-adapter.js";

export function hasExecRunSchema(db: DbAdapter): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'exec_runs'",
  ).get() !== undefined;
}

/**
 * ADR-046: evidence must not live in files. A row is a host fact (what ran,
 * how it ended, which Attempt it ran in), so the host writes it outside Domain
 * Operations, like gate_runs. `.gsd/exec/<id>.*` holds only the output text.
 * Idempotent.
 */
export function createExecRunSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exec_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('exec', 'uat_exec')),
      runtime TEXT NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      exit_code INTEGER,
      signal TEXT,
      timed_out INTEGER NOT NULL,
      aborted INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      output_hash TEXT NOT NULL,
      milestone_id TEXT,
      slice_id TEXT,
      check_id TEXT,
      attempt_ref TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exec_runs_attempt ON exec_runs(attempt_ref);
  `);
}
