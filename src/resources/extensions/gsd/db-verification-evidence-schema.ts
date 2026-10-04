// Project/App: gsd-pi
// File Purpose: Verification evidence SQLite schema helpers for the GSD database facade.

import type { DbAdapter } from "./db-adapter.js";
import { ensureColumn } from "./db-schema-metadata.js";

/** The dedup index is present in the form that keeps the claims of each Attempt apart. */
export function hasVerificationEvidenceDedupIndex(db: DbAdapter): boolean {
  return !!db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_verification_evidence_dedup' AND sql LIKE '%attempt_ref%'",
  ).get();
}

export function dedupeVerificationEvidenceRows(db: DbAdapter): void {
  db.exec(`
    DELETE FROM verification_evidence
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM verification_evidence
      GROUP BY task_id, slice_id, milestone_id, attempt_ref, command, verdict
    )
  `);
}

/**
 * A claim row records the Attempt that made it (`attempt_ref`, '' when no
 * Attempt made it), so a retry Attempt stores its own claims next to those of
 * the earlier Attempt. Idempotent; replaces the index that had no Attempt.
 */
export function ensureVerificationEvidenceDedupIndex(db: DbAdapter): void {
  if (hasVerificationEvidenceDedupIndex(db)) return;
  ensureColumn(
    db,
    "verification_evidence",
    "attempt_ref",
    "ALTER TABLE verification_evidence ADD COLUMN attempt_ref TEXT NOT NULL DEFAULT ''",
  );
  dedupeVerificationEvidenceRows(db);
  db.exec("DROP INDEX IF EXISTS idx_verification_evidence_dedup");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_evidence_dedup ON verification_evidence(task_id, slice_id, milestone_id, attempt_ref, command, verdict)");
}
