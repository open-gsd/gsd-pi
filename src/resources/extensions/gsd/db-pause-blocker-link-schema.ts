import type { DbAdapter } from "./db-adapter.js";

export function createPauseBlockerLinkSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_pause_blocker_links (
      blocker_id TEXT PRIMARY KEY,
      pause_id TEXT NOT NULL UNIQUE,
      lifecycle_id TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      unit_type TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT DEFAULT NULL,
      FOREIGN KEY (blocker_id) REFERENCES workflow_blockers(blocker_id),
      FOREIGN KEY (lifecycle_id) REFERENCES workflow_item_lifecycles(lifecycle_id)
    )
  `);
}

export function hasPauseBlockerLinkSchema(db: DbAdapter): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'auto_pause_blocker_links'",
  ).get() != null;
}
