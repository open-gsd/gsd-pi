// Project/App: gsd-pi
// File Purpose: Runtime-control tables — the database homes for the unit
// runtime record, the post-unit hook state, the run-uat retry counter and the
// pending discuss-to-auto handoff.

import type { DbAdapter } from './db-adapter.js';

const RUNTIME_CONTROL_TABLES = [
  'unit_runtime_records',
  'hook_state',
  'uat_retry_counters',
  'discussion_handoffs',
] as const;

/** Whether every non-versioned runtime-control table is present. */
export function hasRuntimeControlSchema(db: DbAdapter): boolean {
  const rows = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('unit_runtime_records', 'hook_state', 'uat_retry_counters', 'discussion_handoffs')
  `).all();
  return RUNTIME_CONTROL_TABLES.every((name) => rows.some((row) => row['name'] === name));
}

/**
 * ADR-046: runtime control state must not live in files. These rows drive the
 * retry budget, the harness-abort tool block, the hook outcome, the pending
 * gate block and the start of auto-mode after a discussion, so a deleted
 * .gsd/runtime directory, a deleted hook-state.json or a restart must not
 * change any of them. They are coordination rows (like unit_dispatches), not
 * workflow state, so they are written outside Domain Operations.
 */
export function createRuntimeControlSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_runtime_records (
      work_root TEXT NOT NULL,
      unit_type TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      phase TEXT NOT NULL,
      wrapup_warning_sent INTEGER NOT NULL DEFAULT 0,
      continue_here_fired INTEGER NOT NULL DEFAULT 0,
      timeout_at INTEGER,
      last_progress_at INTEGER NOT NULL,
      progress_count INTEGER NOT NULL DEFAULT 0,
      last_progress_kind TEXT NOT NULL,
      recovery_attempts INTEGER NOT NULL DEFAULT 0,
      last_recovery_reason TEXT,
      harness_abort_kind TEXT,
      harness_abort_reason TEXT,
      harness_abort_tool_name TEXT,
      harness_abort_count INTEGER,
      harness_abort_recorded_at INTEGER,
      end_status TEXT,
      end_artifact_verified INTEGER,
      end_error TEXT,
      recovery_json TEXT,
      PRIMARY KEY (work_root, unit_type, unit_id)
    );

    CREATE TABLE IF NOT EXISTS hook_state (
      scope TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS uat_retry_counters (
      milestone_id TEXT NOT NULL,
      slice_id TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (milestone_id, slice_id)
    );

    CREATE TABLE IF NOT EXISTS discussion_handoffs (
      base_path TEXT PRIMARY KEY,
      milestone_id TEXT NOT NULL,
      step INTEGER,
      start_auto INTEGER,
      session_id TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}
