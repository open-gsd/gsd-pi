// Project/App: gsd-pi
// File Purpose: T014 — explicit `gsd db restore-backup` command tests.
//
//   (a) v45 fixture + verified backup-v45, simulated v46 cutover, restore with
//       consent → v45 contents restored, migrated to the current schema with
//       a pre-migration copy kept, and a restore receipt persisted.
//   (b) invocation without consent (or with a stale consent hash) is refused
//       with consent-required guidance and restores nothing.
//   (c) invocation with a corrupt backup fails verification and restores
//       nothing.
//   (d) list-style invocations show candidates and mutate nothing.
//   (e) a backup taken before the Authority Epoch cutover is refused with
//       valid consent and the refusal names Forward Repair.
//   (f) a restore does not cut over the database that it replaces.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleDbRestoreBackup } from "../commands-maintenance.ts";
import { closeDatabase, openDatabase, _getAdapter } from "../gsd-db.ts";
import { openWorkflowDatabase, resolveProjectRootDbPath } from "../db-workspace.ts";
import { recordSchemaVersion } from "../db-schema-metadata.ts";
import { SCHEMA_VERSION } from "../db/engine.ts";
import { openSqliteReadOnly } from "../sqlite-readonly.ts";
import { setAuthorityCutoverFlag } from "./helpers/authority-cutover-flag.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeCtx(): { ctx: any; notes: Array<{ message: string; kind: string }> } {
  const notes: Array<{ message: string; kind: string }> = [];
  return {
    ctx: { ui: { notify: (message: string, kind: string) => notes.push({ message, kind }) } },
    notes,
  };
}

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

interface RestoreFixture {
  base: string;
  dbPath: string;
  backupPath: string;
  backupSha: string;
}

function authorityEpochOf(dbPath: string): number {
  return readOnly(dbPath, (db) =>
    Number(db.prepare("SELECT authority_epoch FROM project_authority").get()?.["authority_epoch"]));
}

/**
 * Build a project DB holding sentinel row M999, rewind it to a v45 stamp, and
 * re-open so the real v45→v46 migration produces a verified gsd.db.backup-v45.
 * - "cut-over-first": the project is cut over before the backup, so the backup
 *   and the live DB are both at Authority Epoch 1. Without
 *   GSD_AUTHORITY_CUTOVER=1 no open cuts over and both stay at epoch 0.
 * - "backup-first": the backup is taken at epoch 0 and that same open cuts the
 *   project over. It needs GSD_AUTHORITY_CUTOVER=1.
 * - "never-cut-over": the migrating open is an engine open, which does not cut
 *   over, so the backup and the live DB are both at epoch 0.
 */
function makeMigrationBackup(mode: "cut-over-first" | "backup-first" | "never-cut-over"): RestoreFixture {
  const base = mkdtempSync(join(tmpdir(), "gsd-backup-restore-"));
  tempDirs.add(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  const dbPath = resolveProjectRootDbPath(base);

  assert.equal(openWorkflowDatabase(base).ok, true);
  if (mode === "cut-over-first") {
    // With the flag on, the first open of the existing database cuts the project over.
    closeDatabase();
    assert.equal(openWorkflowDatabase(base).ok, true);
  }
  const db = _getAdapter();
  assert.ok(db);
  db.prepare("INSERT INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)")
    .run("M999", "sentinel-milestone", "active", "2026-01-01T00:00:00.000Z");
  db.exec("DELETE FROM schema_version");
  recordSchemaVersion(db, 45);
  db.exec("PRAGMA user_version = 0");
  db.exec("PRAGMA application_id = 0");
  closeDatabase();

  assert.equal(mode === "never-cut-over" ? openDatabase(dbPath) : openWorkflowDatabase(base).ok, true);
  const backupPath = `${dbPath}.backup-v45`;
  assert.equal(existsSync(backupPath), true, "migration should leave a verified backup-v45");
  closeDatabase();
  const backupEpoch = authorityEpochOf(backupPath);
  if (mode !== "cut-over-first") assert.equal(backupEpoch, 0);
  assert.equal(authorityEpochOf(dbPath), mode === "backup-first" ? 1 : backupEpoch);
  return { base, dbPath, backupPath, backupSha: sha256File(backupPath) };
}

/**
 * A backup and a live DB in the same Authority Epoch. Then simulate later
 * work: M999 is erased and row M100 is accepted. The backup still holds M999;
 * the live DB holds M100.
 */
function makeFixture(): RestoreFixture {
  const fixture = makeMigrationBackup("cut-over-first");
  assert.equal(openWorkflowDatabase(fixture.base).ok, true);
  const live = _getAdapter();
  assert.ok(live);
  live.exec("DELETE FROM milestones");
  live.prepare("INSERT INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)")
    .run("M100", "post-cutover", "active", "2026-01-02T00:00:00.000Z");
  closeDatabase();
  return fixture;
}

function readOnly<T>(dbPath: string, fn: (db: NonNullable<ReturnType<typeof _getAdapter>>) => T): T {
  const connection = openSqliteReadOnly(dbPath);
  try {
    return fn(connection.db);
  } finally {
    connection.db.close();
  }
}

function milestoneIds(dbPath: string): string[] {
  return readOnly(dbPath, (db) =>
    (db.prepare("SELECT id FROM milestones ORDER BY id").all() as Array<Record<string, unknown>>)
      .map((row) => String(row["id"])));
}

function maxSchemaVersionOf(dbPath: string): number {
  return readOnly(dbPath, (db) =>
    Number(db.prepare("SELECT MAX(version) AS v FROM schema_version").get()?.["v"] ?? 0));
}

test("(a) restore with consent restores v45 contents and persists a receipt", async () => {
  const fixture = makeFixture();
  assert.deepEqual(milestoneIds(fixture.dbPath), ["M100"]);
  assert.equal(maxSchemaVersionOf(fixture.dbPath), SCHEMA_VERSION);

  const { ctx, notes } = makeCtx();
  await handleDbRestoreBackup(
    ctx,
    fixture.base,
    `--backup ${fixture.backupPath} --consent=proceed:destructive-database-restore:${fixture.backupSha}`,
  );

  const success = notes.find((note) => note.kind === "success");
  assert.ok(success, `expected a success notification, got ${JSON.stringify(notes)}`);
  assert.match(success.message, /restored gsd\.db\.backup-v45/);
  assert.match(success.message, /Backup schema: v45/);
  assert.match(success.message, /Receipt: import\.restore committed/);
  assert.match(success.message, new RegExp(`Migrated to schema v${SCHEMA_VERSION}`));
  assert.match(success.message, /Projections rebuilt from the restored database/);

  // The handler reopened the restored DB through the engine, which migrated
  // it to the current schema after keeping a pre-migration copy.
  closeDatabase();
  assert.equal(maxSchemaVersionOf(fixture.dbPath), SCHEMA_VERSION);
  assert.deepEqual(milestoneIds(fixture.dbPath), ["M999"]);
  assert.deepEqual(milestoneIds(`${fixture.backupPath}.latest`), ["M999"]);
  assert.equal(maxSchemaVersionOf(`${fixture.backupPath}.latest`), 45);

  const receipt = readOnly(fixture.dbPath, (db) =>
    db.prepare(
      "SELECT backup_sha256, backup_schema_version, backup_project_revision, resulting_project_revision FROM workflow_import_restores",
    ).all() as Array<Record<string, unknown>>);
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0]!["backup_sha256"], fixture.backupSha);
  assert.equal(receipt[0]!["backup_schema_version"], 45);
  assert.equal(
    Number(receipt[0]!["resulting_project_revision"]),
    Number(receipt[0]!["backup_project_revision"]) + 1,
  );

  // No replacement-fence residue remains.
  assert.equal(existsSync(`${fixture.dbPath}.recovery`), false);
});

test("(b) restore without consent is refused with guidance; stale consent is refused", async () => {
  const fixture = makeFixture();
  const beforeSha = sha256File(fixture.dbPath);

  const missing = makeCtx();
  await handleDbRestoreBackup(missing.ctx, fixture.base, `--backup ${fixture.backupPath}`);
  closeDatabase();
  const guidance = missing.notes.find((note) => /consent is required/.test(note.message));
  assert.ok(guidance, `expected consent guidance, got ${JSON.stringify(missing.notes)}`);
  assert.match(guidance.message, new RegExp(`--consent=proceed:destructive-database-restore:${fixture.backupSha}`));
  assert.ok(!missing.notes.some((note) => note.kind === "success"));
  assert.equal(sha256File(fixture.dbPath), beforeSha);
  assert.equal(maxSchemaVersionOf(fixture.dbPath), SCHEMA_VERSION);
  assert.deepEqual(milestoneIds(fixture.dbPath), ["M100"]);
  assert.equal(existsSync(`${fixture.dbPath}.recovery`), false);

  const stale = makeCtx();
  await handleDbRestoreBackup(
    stale.ctx,
    fixture.base,
    `--backup ${fixture.backupPath} --consent=proceed:destructive-database-restore:sha256:${"0".repeat(64)}`,
  );
  closeDatabase();
  const staleNote = stale.notes.find((note) => /stale consent/.test(note.message));
  assert.ok(staleNote, `expected stale-consent refusal, got ${JSON.stringify(stale.notes)}`);
  assert.equal(sha256File(fixture.dbPath), beforeSha);
  assert.deepEqual(milestoneIds(fixture.dbPath), ["M100"]);
  assert.equal(existsSync(`${fixture.dbPath}.recovery`), false);
});

test("(c) a corrupt backup fails verification and restores nothing", async () => {
  const fixture = makeFixture();
  // Destroy the SQLite magic header so the file cannot be verified.
  const bytes = readFileSync(fixture.backupPath);
  bytes[0] = 0x00;
  bytes[1] = 0x00;
  bytes[2] = 0x00;
  writeFileSync(fixture.backupPath, bytes);
  const corruptSha = sha256File(fixture.backupPath);
  const beforeSha = sha256File(fixture.dbPath);

  const { ctx, notes } = makeCtx();
  await handleDbRestoreBackup(
    ctx,
    fixture.base,
    `--backup ${fixture.backupPath} --consent=proceed:destructive-database-restore:${corruptSha}`,
  );
  closeDatabase();

  const failure = notes.find((note) => note.kind === "error" && /verification failed/.test(note.message));
  assert.ok(failure, `expected a verification failure, got ${JSON.stringify(notes)}`);
  assert.match(failure.message, /Nothing was restored/);
  assert.equal(sha256File(fixture.dbPath), beforeSha);
  assert.equal(maxSchemaVersionOf(fixture.dbPath), SCHEMA_VERSION);
  assert.deepEqual(milestoneIds(fixture.dbPath), ["M100"]);
  assert.equal(existsSync(`${fixture.dbPath}.recovery`), false);
});

test("(d) list-style invocations show candidates and mutate nothing", async () => {
  const fixture = makeFixture();
  const beforeSha = sha256File(fixture.dbPath);

  for (const args of ["", "--list"]) {
    const { ctx, notes } = makeCtx();
    await handleDbRestoreBackup(ctx, fixture.base, args);
    const listing = notes.find((note) => /backup candidate/.test(note.message));
    assert.ok(listing, `expected a candidate listing for args '${args}', got ${JSON.stringify(notes)}`);
    assert.match(listing.message, /gsd\.db\.backup-v45/);
    assert.match(listing.message, /schema v45/);
    assert.match(listing.message, new RegExp(fixture.backupSha));
    assert.match(listing.message, /--consent=proceed:destructive-database-restore:/);
  }

  // Listing never opened or migrated the engine DB: the live database is
  // byte-identical and still holds the post-cutover contents.
  assert.equal(sha256File(fixture.dbPath), beforeSha);
  assert.equal(maxSchemaVersionOf(fixture.dbPath), SCHEMA_VERSION);
  assert.deepEqual(milestoneIds(fixture.dbPath), ["M100"]);
  assert.equal(existsSync(`${fixture.dbPath}.recovery`), false);
});

test("(e) a backup taken before the Authority Epoch cutover is refused with valid consent", async (t) => {
  t.after(setAuthorityCutoverFlag("1"));
  const fixture = makeMigrationBackup("backup-first");
  const beforeSha = sha256File(fixture.dbPath);

  const { ctx, notes } = makeCtx();
  await handleDbRestoreBackup(
    ctx,
    fixture.base,
    `--backup ${fixture.backupPath} --consent=proceed:destructive-database-restore:${fixture.backupSha}`,
  );
  closeDatabase();

  const refusal = notes.find((note) => note.kind === "error");
  assert.ok(refusal, `expected a refusal, got ${JSON.stringify(notes)}`);
  assert.match(refusal.message, /Current Authority Epoch 1 is higher than the backup's epoch 0/);
  assert.match(refusal.message, /Forward Repair/);
  assert.ok(!notes.some((note) => note.kind === "success"));
  assert.equal(sha256File(fixture.dbPath), beforeSha);
  assert.equal(authorityEpochOf(fixture.dbPath), 1);
  assert.equal(existsSync(`${fixture.dbPath}.recovery`), false);
});

test("(f) a restore does not cut over the database that it replaces", async (t) => {
  t.after(setAuthorityCutoverFlag("1"));
  const fixture = makeMigrationBackup("never-cut-over");

  const { ctx, notes } = makeCtx();
  await handleDbRestoreBackup(
    ctx,
    fixture.base,
    `--backup ${fixture.backupPath} --consent=proceed:destructive-database-restore:${fixture.backupSha}`,
  );
  closeDatabase();

  assert.ok(notes.some((note) => note.kind === "success"), `expected a success, got ${JSON.stringify(notes)}`);
  // Only the restored database is cut over, by the open that follows the
  // restore. A cutover of the replaced database would leave a second
  // pre-cutover backup.
  assert.equal(authorityEpochOf(fixture.dbPath), 1);
  assert.deepEqual(
    readdirSync(join(fixture.base, ".gsd")).filter((name) => name.includes(`.backup-v${SCHEMA_VERSION}`) && !/-(wal|shm)$/.test(name)),
    [`gsd.db.backup-v${SCHEMA_VERSION}`],
  );
});
