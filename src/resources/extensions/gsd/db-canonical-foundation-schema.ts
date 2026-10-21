// Project/App: gsd-pi
// File Purpose: Additive v31 authority, operation provenance, domain event, and outbox schema.

import type { DbAdapter } from "./db-adapter.js";

export function hasCanonicalOutboxInvariantsV31(db: DbAdapter): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'trigger'
      AND name IN ('trg_workflow_outbox_safe_identity', 'trg_workflow_outbox_delete')
  `).get();
  return Number(row?.["count"]) === 2;
}

export function ensureCanonicalOutboxInvariantsV31(db: DbAdapter): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_outbox_safe_identity
    AFTER INSERT ON workflow_outbox
    WHEN NEW.outbox_id > 9007199254740991
    BEGIN
      SELECT RAISE(ABORT, 'outbox identity exceeds safe integer range');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_outbox_delete
    BEFORE DELETE ON workflow_outbox
    BEGIN
      SELECT RAISE(ABORT, 'outbox rows are durable history');
    END
  `);
}

/**
 * v31 mapping:
 * - schema_version remains DDL compatibility, not the domain revision.
 * - audit_events remains optional operational telemetry, not domain history.
 * - milestone_commit_attributions remains Git-specific, not operation provenance.
 * - command_queue and runtime_kv remain coordination/cache surfaces, not an outbox.
 */
export function createCanonicalFoundationSchemaV31(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_authority (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      project_id TEXT NOT NULL UNIQUE,
      project_root_realpath TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      authority_epoch INTEGER NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0),
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_operations (
      operation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
      resulting_revision INTEGER NOT NULL CHECK (resulting_revision = expected_revision + 1),
      expected_authority_epoch INTEGER NOT NULL CHECK (expected_authority_epoch >= 0),
      resulting_authority_epoch INTEGER NOT NULL CHECK (
        resulting_authority_epoch = expected_authority_epoch OR
        resulting_authority_epoch = expected_authority_epoch + 1
      ),
      actor_type TEXT NOT NULL,
      actor_id TEXT DEFAULT NULL,
      source_transport TEXT NOT NULL,
      trace_id TEXT DEFAULT NULL,
      turn_id TEXT DEFAULT NULL,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (project_id, idempotency_key),
      UNIQUE (project_id, resulting_revision),
      UNIQUE (operation_id, project_id, resulting_revision, resulting_authority_epoch),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_domain_events (
      event_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      event_index INTEGER NOT NULL DEFAULT 0 CHECK (event_index >= 0),
      project_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      caused_by_event_id TEXT DEFAULT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE (operation_id, event_index),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        ),
      FOREIGN KEY (caused_by_event_id) REFERENCES workflow_domain_events(event_id)
    )
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_domain_events_immutable_update
    BEFORE UPDATE ON workflow_domain_events
    BEGIN
      SELECT RAISE(ABORT, 'workflow domain events are immutable');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_workflow_domain_events_immutable_delete
    BEFORE DELETE ON workflow_domain_events
    BEGIN
      SELECT RAISE(ABORT, 'workflow domain events are immutable');
    END
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_outbox (
      outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      destination TEXT NOT NULL,
      available_at TEXT NOT NULL DEFAULT '',
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      claimed_by TEXT DEFAULT NULL,
      claim_expires_at TEXT DEFAULT NULL,
      delivered_at TEXT DEFAULT NULL,
      last_error TEXT DEFAULT NULL,
      UNIQUE (event_id, destination),
      FOREIGN KEY (event_id) REFERENCES workflow_domain_events(event_id)
    )
  `);
  ensureCanonicalOutboxInvariantsV31(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_operations_created
    ON workflow_operations(project_id, created_at, operation_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_domain_events_entity
    ON workflow_domain_events(project_id, entity_type, entity_id, project_revision, event_index)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_outbox_pending
    ON workflow_outbox(delivered_at, available_at, outbox_id)
  `);

  db.exec(`
    INSERT OR IGNORE INTO project_authority (
      singleton, project_id, project_root_realpath,
      revision, authority_epoch, created_at, updated_at
    ) VALUES (
      1, lower(hex(randomblob(16))), '',
      0, 0, '', ''
    )
  `);
}
