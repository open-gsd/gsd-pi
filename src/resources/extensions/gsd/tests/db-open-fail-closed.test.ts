// Project/App: gsd-pi
// File Purpose: Behavior tests — DB open, recovery and restore fail closed and keep a copy.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleDbRestoreBackup, handleRecover } from "../commands-maintenance.ts";
import { closeDatabase, isSchemaTooNewError, openDatabase, _getAdapter } from "../gsd-db.ts";
import { ensureWorkflowDbForBase, openWorkflowDatabase, resolveProjectRootDbPath } from "../db-workspace.ts";
import { ensureDbOpen } from "../bootstrap/dynamic-tools.ts";
import { backupDatabaseBeforeMigration } from "../db-migration-backup.ts";
import { recordSchemaVersion } from "../db-schema-metadata.ts";
import { SCHEMA_VERSION } from "../db/engine.ts";
import { moveStateDirectory } from "../repo-identity.ts";
import { openSqliteReadOnly } from "../sqlite-readonly.ts";
import { executeSummarySave } from "../tools/workflow-tool-executors.ts";

const sqlite = createRequire(import.meta.url)("node:sqlite");
const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeProject(): { base: string; dbPath: string } {
  const base = mkdtempSync(join(tmpdir(), "gsd-fail-closed-"));
  tempDirs.add(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return { base, dbPath: resolveProjectRootDbPath(base) };
}

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function rawExec(dbPath: string, sql: string): void {
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
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

function makeCtx(): { ctx: any; notes: Array<{ message: string; kind: string }> } {
  const notes: Array<{ message: string; kind: string }> = [];
  return {
    ctx: { ui: { notify: (message: string, kind: string) => notes.push({ message, kind }) } },
    notes,
  };
}

/**
 * A project whose live DB holds M100 and whose verified gsd.db.backup-v45
 * holds M999 (same construction as backup-restore-command.test.ts).
 */
function makeRestoreFixture(): { base: string; dbPath: string; backupPath: string; backupSha: string } {
  const { base, dbPath } = makeProject();
  assert.equal(openWorkflowDatabase(base).ok, true);
  const db = _getAdapter()!;
  db.prepare("INSERT INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)")
    .run("M999", "sentinel-milestone", "active", "2026-01-01T00:00:00.000Z");
  db.exec("DELETE FROM schema_version");
  recordSchemaVersion(db, 45);
  db.exec("PRAGMA user_version = 0");
  db.exec("PRAGMA application_id = 0");
  closeDatabase();

  assert.equal(openWorkflowDatabase(base).ok, true);
  const backupPath = `${dbPath}.backup-v45`;
  assert.equal(existsSync(backupPath), true);
  const live = _getAdapter()!;
  live.exec("DELETE FROM milestones");
  live.prepare("INSERT INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)")
    .run("M100", "post-cutover", "active", "2026-01-02T00:00:00.000Z");
  closeDatabase();
  return { base, dbPath, backupPath, backupSha: sha256File(backupPath) };
}

function consentArgs(fixture: { backupPath: string; backupSha: string }): string {
  return `--backup ${fixture.backupPath} --consent=proceed:destructive-database-restore:${fixture.backupSha}`;
}

test("(1) projections without gsd.db: a tool call fails with authority-missing and creates no file", async () => {
  const { base, dbPath } = makeProject();
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");

  await assert.rejects(
    executeSummarySave({} as never, base),
    /authority-missing: .*\/gsd db restore-backup.*\/gsd recover/s,
  );
  assert.equal(existsSync(dbPath), false, "no empty authority may be created");

  const result = openWorkflowDatabase(base);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "authority-missing");
  assert.equal(existsSync(dbPath), false);

  // A zero-byte gsd.db is the same lost authority, and stays zero bytes.
  writeFileSync(dbPath, "");
  assert.equal(openWorkflowDatabase(base).reason, "authority-missing");
  assert.equal(readFileSync(dbPath).length, 0);
});

test("(1b) a leftover migration backup also proves a lost authority", () => {
  const { base, dbPath } = makeProject();
  writeFileSync(`${dbPath}.backup-v45`, "not-inspected");
  assert.equal(openWorkflowDatabase(base).reason, "authority-missing");
  assert.equal(existsSync(dbPath), false);
});

test("(1c) a fresh project and the explicit import path still create the database", () => {
  const fresh = makeProject();
  assert.equal(openWorkflowDatabase(fresh.base).reason, "created-empty");
  closeDatabase();

  const legacy = makeProject();
  mkdirSync(join(legacy.base, ".gsd", "milestones", "M001"), { recursive: true });
  const created = openWorkflowDatabase(legacy.base, { createEmptyAuthority: true });
  assert.equal(created.ok, true);
  assert.equal(created.reason, "created-empty");
});

test("(1d) /gsd recover is the explicit path that starts a database beside existing markdown", async () => {
  const { base, dbPath } = makeProject();
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");

  const { ctx, notes } = makeCtx();
  await handleRecover(ctx, base, "");

  assert.equal(existsSync(dbPath), true);
  assert.ok(!notes.some((note) => /cannot open the project database|No database open/.test(note.message)), JSON.stringify(notes));
});

test("(2) a newer-schema database is refused with its bytes and journal mode unchanged", async () => {
  const { base, dbPath } = makeProject();
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  rawExec(
    dbPath,
    `INSERT INTO schema_version (version, applied_at) VALUES (${SCHEMA_VERSION + 1}, '2026-01-01T00:00:00.000Z');
     PRAGMA wal_checkpoint(TRUNCATE);`,
  );
  const journalMode = (): unknown =>
    readOnly(dbPath, (db) => db.prepare("PRAGMA journal_mode").get()?.["journal_mode"]);
  assert.equal(journalMode(), "wal");
  const before = sha256File(dbPath);

  assert.throws(() => openDatabase(dbPath), isSchemaTooNewError);
  assert.equal(sha256File(dbPath), before, "the older binary must not write to the newer database");
  assert.equal(journalMode(), "wal");

  // Reopen seams surface the typed error instead of "DB unavailable".
  assert.throws(() => ensureWorkflowDbForBase(base), isSchemaTooNewError);
  await assert.rejects(ensureDbOpen(base), isSchemaTooNewError);
  await assert.rejects(executeSummarySave({} as never, base), isSchemaTooNewError);
  assert.equal(sha256File(dbPath), before);
});

test("(3) restore-backup replaces a corrupt database without opening it and keeps the corrupt file", async () => {
  const fixture = makeRestoreFixture();
  for (const suffix of ["-wal", "-shm"]) rmSync(`${fixture.dbPath}${suffix}`, { force: true });
  const corruptBytes = Buffer.alloc(8192, 0xab);
  writeFileSync(fixture.dbPath, corruptBytes);

  const { ctx, notes } = makeCtx();
  await handleDbRestoreBackup(ctx, fixture.base, consentArgs(fixture));

  const success = notes.find((note) => note.kind === "success");
  assert.ok(success, `expected a success notification, got ${JSON.stringify(notes)}`);
  assert.match(success.message, /Receipt: none/);
  assert.equal(sha256File(fixture.dbPath), fixture.backupSha);
  assert.deepEqual(milestoneIds(fixture.dbPath), ["M999"]);

  const quarantined = readdirSync(join(fixture.base, ".gsd")).filter((entry) => entry.startsWith("gsd.db.quarantine-"));
  assert.equal(quarantined.length, 1);
  assert.deepEqual(
    readFileSync(join(fixture.base, ".gsd", quarantined[0]!)),
    corruptBytes,
    "the corrupt database must be kept byte-for-byte, never opened or repaired",
  );
});

test("(3b) restore-backup works when gsd.db is missing", async () => {
  const fixture = makeRestoreFixture();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${fixture.dbPath}${suffix}`, { force: true });

  const { ctx, notes } = makeCtx();
  await handleDbRestoreBackup(ctx, fixture.base, consentArgs(fixture));

  assert.ok(notes.some((note) => note.kind === "success"), JSON.stringify(notes));
  assert.deepEqual(milestoneIds(fixture.dbPath), ["M999"]);
});

test("(4) restore shows the erased Domain Operation range and refuses a higher Authority Epoch", async () => {
  const fixture = makeRestoreFixture();
  const backupRevision = readOnly(fixture.backupPath, (db) =>
    Number(db.prepare("SELECT revision FROM project_authority WHERE singleton = 1").get()?.["revision"]));
  rawExec(fixture.dbPath, "UPDATE project_authority SET revision = revision + 3 WHERE singleton = 1");

  const preview = makeCtx();
  await handleDbRestoreBackup(preview.ctx, fixture.base, `--backup ${fixture.backupPath}`);
  const guidance = preview.notes.find((note) => /consent is required/.test(note.message));
  assert.ok(guidance, JSON.stringify(preview.notes));
  assert.match(
    guidance.message,
    new RegExp(`Erases 3 later Domain Operations: project revisions ${backupRevision + 1}\\.\\.${backupRevision + 3}`),
  );

  rawExec(fixture.dbPath, "UPDATE project_authority SET authority_epoch = authority_epoch + 1 WHERE singleton = 1");
  const before = sha256File(fixture.dbPath);
  const refused = makeCtx();
  await handleDbRestoreBackup(refused.ctx, fixture.base, consentArgs(fixture));
  closeDatabase();

  const refusal = refused.notes.find((note) => note.kind === "error");
  assert.ok(refusal, JSON.stringify(refused.notes));
  assert.match(refusal.message, /Restore Window is closed/);
  assert.match(refusal.message, /\/gsd recover/);
  assert.ok(!refused.notes.some((note) => note.kind === "success"));
  assert.equal(sha256File(fixture.dbPath), before, "a refused restore must not touch the live database");
  assert.deepEqual(milestoneIds(fixture.dbPath), ["M100"]);
});

test("a verified migration backup is not overwritten by a later same-version backup", () => {
  const { dbPath } = makeProject();
  assert.equal(openDatabase(dbPath), true);
  const db = _getAdapter()!;
  const deps = {
    existsSync,
    copyFileSync: (src: string, dest: string) => writeFileSync(dest, readFileSync(src)),
    logWarning: () => assert.fail("backup must not warn"),
  };
  const backupPath = `${dbPath}.backup-v${SCHEMA_VERSION}`;

  backupDatabaseBeforeMigration(db, dbPath, SCHEMA_VERSION, deps);
  const pristine = sha256File(backupPath);

  db.prepare("INSERT INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)")
    .run("M777", "half-migrated", "active", "2026-01-03T00:00:00.000Z");
  backupDatabaseBeforeMigration(db, dbPath, SCHEMA_VERSION, deps);

  assert.equal(sha256File(backupPath), pristine, "the first verified backup must survive the retry");
  assert.deepEqual(milestoneIds(backupPath), []);
  assert.deepEqual(milestoneIds(`${backupPath}.latest`), ["M777"]);
});

test("a failed state-directory move leaves the source intact", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-state-move-"));
  tempDirs.add(root);
  const from = join(root, "old");
  const to = join(root, "new");
  mkdirSync(from);
  writeFileSync(join(from, "gsd.db"), "db");
  writeFileSync(join(from, "gsd.db-wal"), "wal");
  // A directory where the source has the WAL file makes the copy fail part-way.
  mkdirSync(join(to, "gsd.db-wal"), { recursive: true });

  assert.throws(() => moveStateDirectory(from, to));
  assert.deepEqual(readdirSync(from).sort(), ["gsd.db", "gsd.db-wal"]);
  assert.equal(readFileSync(join(from, "gsd.db-wal"), "utf8"), "wal");

  rmSync(join(to, "gsd.db-wal"), { recursive: true });
  moveStateDirectory(from, to);
  assert.equal(existsSync(from), false);
  assert.deepEqual(readdirSync(to).sort(), ["gsd.db", "gsd.db-wal"]);
});
