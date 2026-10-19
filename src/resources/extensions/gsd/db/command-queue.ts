// Project/App: gsd-pi
// File Purpose: Coordinator-to-worker commands as command_queue rows.
//
// The coordinator and its workers are separate processes on one project
// database, so a command is a row and not a file. Single-host invariant: see
// db/auto-workers.ts.

import { getDb, getDbOrNull, immediateTransaction, transaction } from "../gsd-db.js";

/** Add a command for `target`. Throws when no database is open. */
export function enqueueCommand(target: string, command: string): void {
  const db = getDb();
  transaction(() => {
    db.prepare(
      `INSERT INTO command_queue (target_worker, command, enqueued_at)
       VALUES (:target, :command, :now)`,
    ).run({ ":target": target, ":command": command, ":now": new Date().toISOString() });
  });
}

/**
 * Take the oldest pending command for `target`. The taker acts on it at once,
 * so the row is claimed and completed in one write and is delivered one time.
 * Returns null when nothing is pending or no database is open.
 */
export function takeNextCommand(
  target: string,
  takenBy: string,
): { command: string; enqueuedAt: string } | null {
  const db = getDbOrNull();
  if (!db) return null;
  const pending = db.prepare(
    `SELECT id, command, enqueued_at FROM command_queue
     WHERE target_worker = :target AND claimed_at IS NULL AND completed_at IS NULL
     ORDER BY id ASC LIMIT 1`,
  );
  // A poll with nothing pending is a plain read: it takes no write lock.
  if (!pending.get({ ":target": target })) return null;
  // BEGIN IMMEDIATE: a read-then-write claim must hold the write lock before
  // the read, or two takers can both read the same pending row.
  return immediateTransaction(() => {
    const row = pending.get({ ":target": target });
    if (!row) return null;
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE command_queue SET claimed_at = :now, claimed_by = :by, completed_at = :now WHERE id = :id",
    ).run({ ":now": now, ":by": takenBy, ":id": row["id"] as number });
    return { command: String(row["command"]), enqueuedAt: String(row["enqueued_at"]) };
  });
}

/** Close every pending command for `target` so that no later taker gets it. No-op when no database is open. */
export function dropPendingCommands(target: string): void {
  const db = getDbOrNull();
  if (!db) return;
  transaction(() => {
    db.prepare(
      "UPDATE command_queue SET completed_at = :now WHERE target_worker = :target AND completed_at IS NULL",
    ).run({ ":now": new Date().toISOString(), ":target": target });
  });
}
