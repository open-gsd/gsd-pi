// Project/App: gsd-pi
// File Purpose: Single reader and writer of the write_gate_state table.
//
// These are enforcement rows (see db-write-gate-schema.ts). The reader returns
// no rows when no database is open; the writer needs an open one.

import { _getAdapter, getDb, immediateTransaction, isDbAvailable } from "../engine.js";

export type WriteGateKind = "depth_verified" | "approval_verified" | "pending" | "queue_phase";

export interface WriteGateRow {
  gate_kind: WriteGateKind;
  gate_id: string;
}

export function listWriteGateRows(): WriteGateRow[] {
  if (!isDbAvailable()) return [];
  return _getAdapter()!.prepare(
    `SELECT gate_kind, gate_id FROM write_gate_state ORDER BY gate_kind, gate_id`,
  ).all() as unknown as WriteGateRow[];
}

/**
 * Read-modify-write the gate rows under SQLite's writer lock, so the host and
 * the workflow MCP child cannot lose each other's change. `next` returns the
 * rows to keep, or null to leave the table as it is (the result is then false).
 */
export function updateWriteGateRows(
  writer: string,
  next: (rows: readonly WriteGateRow[]) => readonly WriteGateRow[] | null,
): boolean {
  return immediateTransaction(() => {
    const before = listWriteGateRows();
    const after = next(before);
    if (after === null) return false;
    const key = (row: WriteGateRow): string => `${row.gate_kind}\u0000${row.gate_id}`;
    const kept = new Set(after.map(key));
    const stored = new Set(before.map(key));
    const db = getDb();
    for (const row of before) {
      if (kept.has(key(row))) continue;
      db.prepare(
        `DELETE FROM write_gate_state WHERE gate_kind = :gate_kind AND gate_id = :gate_id`,
      ).run({ ":gate_kind": row.gate_kind, ":gate_id": row.gate_id });
    }
    const updatedAt = new Date().toISOString();
    for (const row of after) {
      if (stored.has(key(row))) continue;
      db.prepare(
        `INSERT OR IGNORE INTO write_gate_state (gate_kind, gate_id, writer, updated_at)
         VALUES (:gate_kind, :gate_id, :writer, :updated_at)`,
      ).run({
        ":gate_kind": row.gate_kind,
        ":gate_id": row.gate_id,
        ":writer": writer,
        ":updated_at": updatedAt,
      });
    }
    return true;
  });
}
