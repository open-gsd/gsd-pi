// Project/App: gsd-pi
// File Purpose: Write-gate state table — the database home for discussion
// depth verification, approval gates, the pending gate and the queue phase.

import type { DbAdapter } from "./db-adapter.js";

export function hasWriteGateSchema(db: DbAdapter): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'write_gate_state'",
  ).get() != null;
}

/**
 * ADR-046: write-gate state must not live in a file. One row per fact:
 *
 *   depth_verified     gate_id = milestone id the user confirmed
 *   approval_verified  gate_id = gate question id the user confirmed
 *   pending            gate_id = gate question id that waits for an answer
 *   queue_phase        gate_id = 'active' while /gsd queue runs
 *
 * These are enforcement rows (like the runtime-control tables), not workflow
 * state, so they are written outside Domain Operations. Idempotent.
 */
export function createWriteGateSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS write_gate_state (
      gate_kind TEXT NOT NULL CHECK (
        gate_kind IN ('depth_verified', 'approval_verified', 'pending', 'queue_phase')
      ),
      gate_id TEXT NOT NULL,
      writer TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (gate_kind, gate_id)
    )
  `);
}
