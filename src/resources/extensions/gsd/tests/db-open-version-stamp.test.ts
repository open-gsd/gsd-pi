// Project/App: gsd-pi
// File Purpose: V46 state-DB cutover stamps + typed refuse-newer surfacing.
//
// Covers T005:
//   (a) v45→v46 migration stamps PRAGMA application_id, PRAGMA user_version,
//       and MAX(schema_version.version) = 46; fresh DBs get the same stamps.
//   (b) opening a v47 database throws the typed SchemaTooNewError with the
//       exact refuse-newer message, and openWorkflowDatabase maps it to
//       { ok: false, reason: "schema-too-new" } with the error attached.
//   (c) the v45→v46 migration created a verified gsd.db.backup-v45.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeDatabase,
  openDatabase,
  GSD_APPLICATION_ID,
  isSchemaTooNewError,
  SchemaTooNewError,
  SCHEMA_VERSION,
  _getAdapter,
  _setStartupSchemaDetectionForTest,
  getDbStatus,
} from "../gsd-db.ts";
import { openWorkflowDatabase } from "../db-workspace.ts";
import { recordSchemaVersion } from "../db-schema-metadata.ts";

const tempDirs = new Set<string>();

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-db-version-stamp-"));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  _setStartupSchemaDetectionForTest(null);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function pragmaInt(db: NonNullable<ReturnType<typeof _getAdapter>>, name: string): number {
  return Number(db.prepare(`PRAGMA ${name}`).get()?.[name] ?? 0);
}

function maxSchemaVersion(db: NonNullable<ReturnType<typeof _getAdapter>>): number {
  return Number(db.prepare("SELECT MAX(version) AS v FROM schema_version").get()?.["v"] ?? 0);
}

/** Create a fresh (v46) DB, then rewind it to a pre-cutover v45 stamp. */
function makeV45Database(dbPath: string): void {
  assert.equal(openDatabase(dbPath), true);
  const db = _getAdapter();
  assert.ok(db);
  db.exec("DELETE FROM schema_version");
  recordSchemaVersion(db, 45);
  db.exec("PRAGMA user_version = 0");
  db.exec("PRAGMA application_id = 0");
  closeDatabase();
}

test("v45→v50 migration stamps application_id, user_version, and schema_version (with backup)", () => {
  const dir = makeTempDir();
  const dbPath = join(dir, "gsd.db");
  makeV45Database(dbPath);

  assert.equal(openDatabase(dbPath), true);
  const db = _getAdapter();
  assert.ok(db);
  assert.equal(SCHEMA_VERSION, 50);
  assert.equal(pragmaInt(db, "application_id"), GSD_APPLICATION_ID);
  assert.equal(pragmaInt(db, "user_version"), 50);
  assert.equal(maxSchemaVersion(db), 50);
  assert.ok(db.prepare("PRAGMA table_info(tasks)").all().some((column) => column["name"] === "required_workflow_tools"));
  // The migration left a verified same-directory backup of the v45 database
  // (creation aborts the migration when verification fails).
  assert.equal(existsSync(`${dbPath}.backup-v45`), true);
});

test("fresh databases get the same three V46 stamps as migrated databases", () => {
  const dir = makeTempDir();
  const dbPath = join(dir, "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  const db = _getAdapter();
  assert.ok(db);
  assert.equal(pragmaInt(db, "application_id"), GSD_APPLICATION_ID);
  assert.equal(pragmaInt(db, "user_version"), 50);
  assert.equal(maxSchemaVersion(db), 50);
});

test("opening a newer (v51) database throws SchemaTooNewError with the exact message", () => {
  const dir = makeTempDir();
  const dbPath = join(dir, "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  const db = _getAdapter();
  assert.ok(db);
  recordSchemaVersion(db, 51);
  closeDatabase();

  let thrown: unknown;
  try {
    openDatabase(dbPath);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof SchemaTooNewError, `expected SchemaTooNewError, got ${String(thrown)}`);
  assert.equal(isSchemaTooNewError(thrown), true);
  assert.equal(thrown.name, "GSDSchemaTooNewError");
  assert.equal(thrown.currentVersion, 51);
  assert.equal(thrown.supportedVersion, 50);
  assert.match(thrown.message, /newer than the v50 this gsd-pi supports/);
  assert.equal(
    thrown.message,
    "gsd.db schema is v51, newer than the v50 this gsd-pi supports. " +
    "Update gsd-pi (npm i -g @opengsd/gsd-pi) before opening this project.",
  );
});

test("openWorkflowDatabase maps refuse-newer to a schema-too-new result with the error attached", () => {
  const dir = makeTempDir();
  const gsdDir = join(dir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const dbPath = join(gsdDir, "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  const db = _getAdapter();
  assert.ok(db);
  recordSchemaVersion(db, 51);
  closeDatabase();

  const result = openWorkflowDatabase(dir);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "schema-too-new");
  assert.ok(result.error instanceof SchemaTooNewError);
  assert.equal(
    result.error.message,
    "gsd.db schema is v51, newer than the v50 this gsd-pi supports. " +
    "Update gsd-pi (npm i -g @opengsd/gsd-pi) before opening this project.",
  );
});

test("non-version open failures keep the open-failed reason", () => {
  const dir = makeTempDir();
  const gsdDir = join(dir, ".gsd");
  // A directory named gsd.db cannot be opened as SQLite → generic failure.
  mkdirSync(join(gsdDir, "gsd.db"), { recursive: true });

  const result = openWorkflowDatabase(dir);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "open-failed");
});

test("SQLite busy failures surface a locked reason and open phase", () => {
  const dir = makeTempDir();
  const gsdDir = join(dir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const dbPath = join(gsdDir, "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  _setStartupSchemaDetectionForTest(() => {
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errcode: 5 });
  });
  const result = openWorkflowDatabase(dir);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "locked");
  assert.equal(getDbStatus().lastPhase, "locked");
});

test("openDatabase retries transient SQLite busy failures", () => {
  const dir = makeTempDir();
  const dbPath = join(dir, "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  let attempts = 0;
  _setStartupSchemaDetectionForTest(() => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errcode: 5 });
    }
  });

  assert.equal(openDatabase(dbPath), true);
  assert.equal(attempts, 2);
  assert.equal(getDbStatus().lastPhase, null);
});
