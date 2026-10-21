// Project/App: gsd-pi
// File Purpose: Executable contract for the additive v31 canonical database foundation.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  SCHEMA_VERSION,
  _getAdapter,
  _setMigrationFaultForTest,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";

const require = createRequire(import.meta.url);
const tempDirs = new Set<string>();

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Array<Record<string, unknown>>;
  };
  close(): void;
}

function openRawDatabase(path: string): RawDb {
  const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
  return new sqlite.DatabaseSync(path);
}

function createDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-canonical-foundation-"));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

function tableExists(db: RawDb, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function maxSchemaVersion(db: RawDb): number {
  return Number(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()?.version);
}

function rewindToV30(dbPath: string): void {
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  const raw = openRawDatabase(dbPath);
  try {
    raw.exec(`
      DROP TABLE IF EXISTS workflow_outbox;
      DROP TABLE IF EXISTS workflow_domain_events;
      DROP TABLE IF EXISTS workflow_operations;
      DROP TABLE IF EXISTS project_authority;
      DELETE FROM schema_version;
      INSERT INTO schema_version (version, applied_at) VALUES (30, '2026-07-12T00:00:00.000Z');
      INSERT OR IGNORE INTO milestones (id, title, status, created_at)
      VALUES ('M-LEGACY', 'Preserved legacy milestone', 'active', '2026-07-12T00:00:00.000Z');
      INSERT OR IGNORE INTO audit_events
        (event_id, trace_id, category, type, ts, payload_json)
      VALUES
        ('audit-legacy', 'trace-legacy', 'workflow', 'legacy', '2026-07-12T00:00:00.000Z', '{"kept":true}');
    `);
  } finally {
    raw.close();
  }
}

function inspectFromFreshProcess(dbPath: string): Record<string, unknown> {
  const moduleHref = pathToFileURL(
    join(process.cwd(), "src/resources/extensions/gsd/gsd-db.ts"),
  ).href;
  const script = [
    `import { openDatabase, closeDatabase, _getAdapter } from ${JSON.stringify(moduleHref)};`,
    "const path = process.argv[1];",
    "if (!openDatabase(path)) throw new Error('database open failed');",
    "const db = _getAdapter();",
    "const version = db.prepare('SELECT MAX(version) AS value FROM schema_version').get().value;",
    "const authority = db.prepare('SELECT project_id, revision, authority_epoch FROM project_authority').get();",
    "const legacy = db.prepare(\"SELECT title FROM milestones WHERE id = 'M-LEGACY'\").get();",
    "console.log(JSON.stringify({ version, authority, legacy }));",
    "closeDatabase();",
  ].join("\n");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "./src/resources/extensions/gsd/tests/resolve-ts.mjs",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      script,
      dbPath,
    ],
    { cwd: process.cwd(), encoding: "utf8", env, timeout: 30_000 },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

afterEach(() => {
  _setMigrationFaultForTest(false);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("fresh database creates the v31 authority root and linked operation journal", () => {
  assert.ok(SCHEMA_VERSION >= 31);
  const dbPath = createDatabasePath();
  assert.equal(openDatabase(dbPath), true);
  const db = _getAdapter();
  assert.ok(db);

  const authority = db.prepare(`
    SELECT singleton, project_id, project_root_realpath, revision, authority_epoch
    FROM project_authority
  `).get();
  assert.deepEqual(
    {
      singleton: authority?.singleton,
      projectIdLength: String(authority?.project_id ?? "").length,
      root: authority?.project_root_realpath,
      revision: authority?.revision,
      epoch: authority?.authority_epoch,
    },
    { singleton: 1, projectIdLength: 32, root: "", revision: 0, epoch: 0 },
  );

  assert.throws(
    () => db.exec("INSERT INTO project_authority (singleton, project_id) VALUES (2, 'second')"),
    /CHECK constraint failed/i,
  );
  assert.throws(
    () => db.exec("UPDATE project_authority SET revision = -1 WHERE singleton = 1"),
    /CHECK constraint failed/i,
  );
  assert.throws(
    () => db.exec("UPDATE project_authority SET authority_epoch = -1 WHERE singleton = 1"),
    /CHECK constraint failed/i,
  );

  db.exec(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision,
      expected_authority_epoch, resulting_authority_epoch,
      actor_type, actor_id, source_transport, request_hash, created_at
    )
    SELECT
      'op-1', project_id, 'test.operation', 'idem-1',
      0, 1, 0, 0, 'agent', 'test-agent', 'test', 'request-1', '2026-07-12T00:00:01.000Z'
    FROM project_authority WHERE singleton = 1;

    INSERT INTO workflow_domain_events (
      event_id, operation_id, event_index, project_id, project_revision,
      authority_epoch, event_type, entity_type, entity_id, payload_json, created_at
    )
    SELECT
      'event-1', 'op-1', 0, project_id, 1,
      0, 'test.started', 'project', project_id, '{"step":1}', '2026-07-12T00:00:02.000Z'
    FROM project_authority WHERE singleton = 1;

    INSERT INTO workflow_domain_events (
      event_id, operation_id, event_index, project_id, project_revision,
      authority_epoch, event_type, entity_type, entity_id, caused_by_event_id,
      payload_json, created_at
    )
    SELECT
      'event-2', 'op-1', 1, project_id, 1,
      0, 'test.finished', 'project', project_id, 'event-1',
      '{"step":2}', '2026-07-12T00:00:03.000Z'
    FROM project_authority WHERE singleton = 1;

    INSERT INTO workflow_outbox (event_id, destination, available_at)
    VALUES ('event-2', 'projection', '2026-07-12T00:00:04.000Z');
  `);

  const chain = db.prepare(`
    SELECT
      p.revision AS authority_revision,
      o.expected_revision,
      o.resulting_revision,
      COUNT(DISTINCT e.event_id) AS event_count,
      COUNT(DISTINCT x.outbox_id) AS outbox_count
    FROM project_authority p
    JOIN workflow_operations o ON o.project_id = p.project_id
    JOIN workflow_domain_events e ON e.operation_id = o.operation_id
    LEFT JOIN workflow_outbox x ON x.event_id = e.event_id
    GROUP BY p.revision, o.expected_revision, o.resulting_revision
  `).get();
  assert.deepEqual(chain, {
    authority_revision: 0,
    expected_revision: 0,
    resulting_revision: 1,
    event_count: 2,
    outbox_count: 1,
  });

  assert.throws(
    () => db.exec(`
      INSERT INTO workflow_operations (
        operation_id, project_id, operation_type, idempotency_key,
        expected_revision, resulting_revision,
        expected_authority_epoch, resulting_authority_epoch,
        actor_type, source_transport, request_hash, created_at
      )
      SELECT 'op-duplicate', project_id, 'test.operation', 'idem-1', 1, 2, 0, 0,
             'agent', 'test', 'request-2', '2026-07-12T00:00:05.000Z'
      FROM project_authority WHERE singleton = 1
    `),
    /UNIQUE constraint failed/i,
  );
  assert.throws(
    () => db.exec(`
      INSERT INTO workflow_operations (
        operation_id, project_id, operation_type, idempotency_key,
        expected_revision, resulting_revision,
        expected_authority_epoch, resulting_authority_epoch,
        actor_type, source_transport, request_hash, created_at
      )
      SELECT 'op-same-revision', project_id, 'test.operation', 'idem-2', 0, 1, 0, 0,
             'agent', 'test', 'request-2', '2026-07-12T00:00:05.000Z'
      FROM project_authority WHERE singleton = 1
    `),
    /UNIQUE constraint failed/i,
  );
  assert.throws(
    () => db.exec(`
      INSERT INTO workflow_domain_events (
        event_id, operation_id, event_index, project_id, project_revision,
        authority_epoch, event_type, entity_type, entity_id, payload_json, created_at
      )
      SELECT 'event-duplicate-index', 'op-1', 1, project_id, 1, 0,
             'test.duplicate', 'project', project_id, '{}', '2026-07-12T00:00:06.000Z'
      FROM project_authority WHERE singleton = 1
    `),
    /UNIQUE constraint failed/i,
  );
  assert.throws(
    () => db.exec(`
      INSERT INTO workflow_domain_events (
        event_id, operation_id, event_index, project_id, project_revision,
        authority_epoch, event_type, entity_type, entity_id, payload_json, created_at
      )
      SELECT 'event-wrong-revision', 'op-1', 2, project_id, 2, 0,
             'test.wrong-revision', 'project', project_id, '{}', '2026-07-12T00:00:06.000Z'
      FROM project_authority WHERE singleton = 1
    `),
    /FOREIGN KEY constraint failed/i,
  );
  assert.throws(
    () => db.exec(`
      INSERT INTO workflow_outbox (event_id, destination, available_at)
      VALUES ('missing-event', 'projection', '2026-07-12T00:00:07.000Z')
    `),
    /FOREIGN KEY constraint failed/i,
  );
  assert.throws(
    () => db.exec(`
      INSERT INTO workflow_outbox (event_id, destination, available_at)
      VALUES ('event-2', 'projection', '2026-07-12T00:00:08.000Z')
    `),
    /UNIQUE constraint failed/i,
  );
});

test("operations record the resulting authority epoch used by their events", () => {
  const dbPath = createDatabasePath();
  assert.equal(openDatabase(dbPath), true);
  const db = _getAdapter();
  assert.ok(db);

  db.exec(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision,
      expected_authority_epoch, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    )
    SELECT 'op-cutover', project_id, 'authority.cutover', 'idem-cutover',
           0, 1, 0, 1, 'agent', 'test', 'request-cutover', '2026-07-12T00:00:01.000Z'
    FROM project_authority WHERE singleton = 1;

    INSERT INTO workflow_domain_events (
      event_id, operation_id, event_index, project_id, project_revision,
      authority_epoch, event_type, entity_type, entity_id, payload_json, created_at
    )
    SELECT 'event-cutover', 'op-cutover', 0, project_id, 1, 1,
           'authority.cutover', 'project', project_id, '{}', '2026-07-12T00:00:02.000Z'
    FROM project_authority WHERE singleton = 1;

    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision,
      expected_authority_epoch, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    )
    SELECT 'op-unchanged-epoch', project_id, 'test.operation', 'idem-unchanged-epoch',
           1, 2, 1, 1, 'agent', 'test', 'request-unchanged', '2026-07-12T00:00:03.000Z'
    FROM project_authority WHERE singleton = 1;
  `);

  assert.throws(
    () => db.exec(`
      INSERT INTO workflow_domain_events (
        event_id, operation_id, event_index, project_id, project_revision,
        authority_epoch, event_type, entity_type, entity_id, payload_json, created_at
      )
      SELECT 'event-stale-epoch', 'op-cutover', 1, project_id, 1, 0,
             'authority.stale', 'project', project_id, '{}', '2026-07-12T00:00:04.000Z'
      FROM project_authority WHERE singleton = 1
    `),
    /FOREIGN KEY constraint failed/i,
  );
  assert.throws(
    () => db.exec(`
      INSERT INTO workflow_operations (
        operation_id, project_id, operation_type, idempotency_key,
        expected_revision, resulting_revision,
        expected_authority_epoch, resulting_authority_epoch,
        actor_type, source_transport, request_hash, created_at
      )
      SELECT 'op-epoch-jump', project_id, 'authority.cutover', 'idem-epoch-jump',
             2, 3, 1, 3, 'agent', 'test', 'request-jump', '2026-07-12T00:00:05.000Z'
      FROM project_authority WHERE singleton = 1
    `),
    /CHECK constraint failed/i,
  );
});

test("domain events reject updates and deletes", () => {
  const dbPath = createDatabasePath();
  assert.equal(openDatabase(dbPath), true);
  const db = _getAdapter();
  assert.ok(db);

  db.exec(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision,
      expected_authority_epoch, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    )
    SELECT 'op-immutable', project_id, 'test.operation', 'idem-immutable',
           0, 1, 0, 0, 'agent', 'test', 'request-immutable', '2026-07-12T00:00:01.000Z'
    FROM project_authority WHERE singleton = 1;

    INSERT INTO workflow_domain_events (
      event_id, operation_id, event_index, project_id, project_revision,
      authority_epoch, event_type, entity_type, entity_id, payload_json, created_at
    )
    SELECT 'event-immutable', 'op-immutable', 0, project_id, 1, 0,
           'test.recorded', 'project', project_id, '{"original":true}', '2026-07-12T00:00:02.000Z'
    FROM project_authority WHERE singleton = 1;
  `);

  assert.throws(
    () => db.exec(`UPDATE workflow_domain_events SET payload_json = '{}' WHERE event_id = 'event-immutable'`),
    /workflow domain events are immutable/i,
  );
  assert.throws(
    () => db.exec(`DELETE FROM workflow_domain_events WHERE event_id = 'event-immutable'`),
    /workflow domain events are immutable/i,
  );
});

test("v30 upgrade preserves legacy rows and creates an independently healthy backup", () => {
  const dbPath = createDatabasePath();
  rewindToV30(dbPath);

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  let projectId = "";
  const upgraded = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(upgraded), SCHEMA_VERSION);
    assert.equal(tableExists(upgraded, "project_authority"), true);
    assert.equal(upgraded.prepare("SELECT title FROM milestones WHERE id = 'M-LEGACY'").get()?.title, "Preserved legacy milestone");
    assert.equal(upgraded.prepare("SELECT payload_json FROM audit_events WHERE event_id = 'audit-legacy'").get()?.payload_json, '{"kept":true}');
    assert.equal(upgraded.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
    projectId = String(upgraded.prepare("SELECT project_id FROM project_authority").get()?.project_id);
  } finally {
    upgraded.close();
  }

  const backup = openRawDatabase(`${dbPath}.backup-v30`);
  try {
    assert.equal(maxSchemaVersion(backup), 30);
    assert.equal(tableExists(backup, "project_authority"), false);
    assert.equal(backup.prepare("SELECT title FROM milestones WHERE id = 'M-LEGACY'").get()?.title, "Preserved legacy milestone");
    assert.equal(backup.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    backup.close();
  }

  const reopened = inspectFromFreshProcess(dbPath);
  assert.deepEqual(reopened, {
    version: SCHEMA_VERSION,
    authority: { project_id: projectId, revision: 0, authority_epoch: 0 },
    legacy: { title: "Preserved legacy milestone" },
  });

  const restoredPath = join(dirname(dbPath), "restored.db");
  copyFileSync(`${dbPath}.backup-v30`, restoredPath);
  const restored = inspectFromFreshProcess(restoredPath);
  assert.equal(restored.version, SCHEMA_VERSION);
  assert.deepEqual(restored.legacy, { title: "Preserved legacy milestone" });
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(restored.authority as Record<string, unknown>).filter(([key]) => key !== "project_id"),
    ),
    { revision: 0, authority_epoch: 0 },
  );
});

test("faulted v30 migration leaves no v31 state and retries cleanly", () => {
  const dbPath = createDatabasePath();
  rewindToV30(dbPath);

  _setMigrationFaultForTest(true);
  assert.throws(() => openDatabase(dbPath), /migration fault injected/);
  _setMigrationFaultForTest(false);

  const rolledBack = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(rolledBack), 30);
    assert.equal(tableExists(rolledBack, "project_authority"), false);
    assert.equal(tableExists(rolledBack, "workflow_operations"), false);
    assert.equal(tableExists(rolledBack, "workflow_domain_events"), false);
    assert.equal(tableExists(rolledBack, "workflow_outbox"), false);
  } finally {
    rolledBack.close();
  }

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const retried = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(retried), SCHEMA_VERSION);
    assert.equal(retried.prepare("SELECT COUNT(*) AS count FROM project_authority").get()?.count, 1);
    assert.equal(retried.prepare("SELECT COUNT(*) AS count FROM milestones WHERE id = 'M-LEGACY'").get()?.count, 1);
  } finally {
    retried.close();
  }
});
