// Project/App: gsd-pi
// File Purpose: Behavior tests — DB open, recovery and restore fail closed and keep a copy.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleDbRestoreBackup, handleRecover, rebuildMarkdownProjectionsFromDb } from "../commands-maintenance.ts";
import { closeDatabase, insertSlice, isSchemaTooNewError, openDatabase, _getAdapter } from "../gsd-db.ts";
import { ensureWorkflowDbAtPath, ensureWorkflowDbForBase, openWorkflowDatabase, resolveProjectRootDbPath } from "../db-workspace.ts";
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
function makeRestoreFixture(withSlices = false): { base: string; dbPath: string; backupPath: string; backupSha: string } {
  const { base, dbPath } = makeProject();
  const seedSlice = (milestoneId: string): void => {
    if (withSlices) insertSlice({ id: "S01", milestoneId, title: `${milestoneId} slice`, status: "pending", risk: "low", depends: [] });
  };
  assert.equal(openWorkflowDatabase(base).ok, true);
  const db = _getAdapter()!;
  db.prepare("INSERT INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)")
    .run("M999", "sentinel-milestone", "active", "2026-01-01T00:00:00.000Z");
  seedSlice("M999");
  db.exec("DELETE FROM schema_version");
  recordSchemaVersion(db, 45);
  db.exec("PRAGMA user_version = 0");
  db.exec("PRAGMA application_id = 0");
  closeDatabase();

  assert.equal(openWorkflowDatabase(base).ok, true);
  const backupPath = `${dbPath}.backup-v45`;
  assert.equal(existsSync(backupPath), true);
  const live = _getAdapter()!;
  live.exec("DELETE FROM slices; DELETE FROM milestones;");
  live.prepare("INSERT INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)")
    .run("M100", "post-cutover", "active", "2026-01-02T00:00:00.000Z");
  seedSlice("M100");
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

test("(1a) flat-phase projections without gsd.db: authority-missing and no file", async () => {
  const { base, dbPath } = makeProject();
  mkdirSync(join(base, ".gsd", "phases", "01-foo"), { recursive: true });
  writeFileSync(join(base, ".gsd", "phases", "01-foo", "01-ROADMAP.md"), "# M001\n");

  await assert.rejects(executeSummarySave({} as never, base), /authority-missing/);
  assert.equal(openWorkflowDatabase(base).reason, "authority-missing");
  assert.equal(existsSync(dbPath), false, "no empty authority may be created");
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

  // The milestone shell a new project gets before its first database open.
  const shell = makeProject();
  mkdirSync(join(shell.base, ".gsd", "phases", "01-new-milestone-m001"), { recursive: true });
  assert.equal(openWorkflowDatabase(shell.base).reason, "created-empty");
  closeDatabase();

  const legacy = makeProject();
  mkdirSync(join(legacy.base, ".gsd", "milestones", "M001"), { recursive: true });
  const created = openWorkflowDatabase(legacy.base, { createEmptyAuthority: true });
  assert.equal(created.ok, true);
  assert.equal(created.reason, "created-empty");
});

test("(1d) /gsd recover starts a database beside markdown only when the import is applied", async () => {
  const { base, dbPath } = makeProject();
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# M001: Recovery Test\n\n**Vision:** Recover.\n\n## Slices\n\n- [ ] **S01: Setup** `risk:low` `depends:[]`\n  > After this: done.\n",
  );

  // Preview only (no approval): the empty database is not left behind.
  const preview = makeCtx();
  await handleRecover(preview.ctx, base, "");
  const previewHash = /--preview=(sha256:[0-9a-f]{64})/.exec(preview.notes.map((note) => note.message).join("\n"))?.[1];
  assert.ok(previewHash, JSON.stringify(preview.notes));
  assert.equal(existsSync(dbPath), false, "a recover that applied nothing must not leave an empty authority");
  assert.equal(openWorkflowDatabase(base).reason, "authority-missing");

  // Declined interactively, and the bare command error path: still no database.
  const declined = makeCtx();
  declined.ctx.ui.confirm = async () => false;
  await handleRecover(declined.ctx, base, "");
  assert.equal(existsSync(dbPath), false);
  await handleRecover(makeCtx().ctx, base, "--restore");
  assert.equal(existsSync(dbPath), false);

  // Approved: the database stays.
  const applied = makeCtx();
  await handleRecover(applied.ctx, base, `--preview=${previewHash}`);
  assert.ok(!applied.notes.some((note) => /cannot open the project database/.test(note.message)), JSON.stringify(applied.notes));
  closeDatabase();
  assert.equal(existsSync(dbPath), true, JSON.stringify(applied.notes));
  assert.equal(openWorkflowDatabase(base).ok, true);
});

test("(1e) reopen seams refuse a zero-byte gsd.db beside history instead of creating a schema", () => {
  const { base, dbPath } = makeProject();
  mkdirSync(join(base, ".gsd", "phases", "01-foo"), { recursive: true });
  writeFileSync(join(base, ".gsd", "phases", "01-foo", "01-ROADMAP.md"), "# M001\n");
  writeFileSync(dbPath, "");

  assert.throws(() => ensureWorkflowDbForBase(base), /authority-missing/);
  assert.throws(() => ensureWorkflowDbAtPath(dbPath), /authority-missing/);
  assert.equal(readFileSync(dbPath).length, 0, "the lost authority must stay zero bytes");
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
  closeDatabase();
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

test("(4b) a healthy database locked by another process is refused, not replaced as corrupt", async () => {
  const fixture = makeRestoreFixture();
  rawExec(
    fixture.dbPath,
    `UPDATE project_authority SET authority_epoch = authority_epoch + 1 WHERE singleton = 1;
     PRAGMA wal_checkpoint(TRUNCATE);`,
  );
  const before = sha256File(fixture.dbPath);

  // The state during another process's startup migration or maintenance claim.
  const holder = new sqlite.DatabaseSync(fixture.dbPath);
  const { ctx, notes } = makeCtx();
  try {
    holder.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; ROLLBACK;");
    await handleDbRestoreBackup(ctx, fixture.base, consentArgs(fixture));
  } finally {
    holder.close();
  }
  closeDatabase();

  assert.ok(!notes.some((note) => note.kind === "success"), JSON.stringify(notes));
  const refusal = notes.find((note) => note.kind === "error");
  assert.ok(refusal, JSON.stringify(notes));
  assert.match(refusal.message, /in use by another process\. Nothing was restored/);
  assert.equal(sha256File(fixture.dbPath), before, "a locked live database must not be touched");
  assert.deepEqual(
    readdirSync(join(fixture.base, ".gsd")).filter((entry) => entry.startsWith("gsd.db.quarantine-")),
    [],
  );
  assert.deepEqual(milestoneIds(fixture.dbPath), ["M100"]);
});

test("(3c) restore refuses before claiming its intent when the WAL cannot be checkpointed", async () => {
  const fixture = makeRestoreFixture();
  const before = milestoneIds(fixture.dbPath);

  // Another process holds a read snapshot, so wal_checkpoint(TRUNCATE) is busy.
  const reader = new sqlite.DatabaseSync(fixture.dbPath);
  const { ctx, notes } = makeCtx();
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS n FROM milestones").get();
    await handleDbRestoreBackup(ctx, fixture.base, consentArgs(fixture));
  } finally {
    reader.exec("ROLLBACK");
    reader.close();
  }
  closeDatabase();

  assert.ok(!notes.some((note) => note.kind === "success"), JSON.stringify(notes));
  assert.match(notes.find((note) => note.kind === "error")?.message ?? "", /WAL could not be checkpointed/);
  assert.equal(existsSync(join(`${fixture.dbPath}.recovery`, "active.json")), false, "no restore intent may be claimed");
  assert.deepEqual(milestoneIds(fixture.dbPath), before);
});

test("(5) after a restore the projection tree equals a clean render of the restored database", async () => {
  const fixture = makeRestoreFixture(true);
  // Projections describe the live database (M100) before the restore.
  assert.equal(openWorkflowDatabase(fixture.base).ok, true);
  await rebuildMarkdownProjectionsFromDb(fixture.base);
  closeDatabase();
  const projectionTree = (): Record<string, string> => {
    const tree: Record<string, string> = {};
    const walk = (dir: string, rel: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}${entry.name}/`);
        else tree[`${rel}${entry.name}`] = readFileSync(join(dir, entry.name), "utf8");
      }
    };
    for (const layout of ["milestones", "phases"]) walk(join(fixture.base, ".gsd", layout), `${layout}/`);
    return tree;
  };
  assert.match(Object.values(projectionTree()).join("\n"), /M100/);

  const { ctx, notes } = makeCtx();
  await handleDbRestoreBackup(ctx, fixture.base, consentArgs(fixture));
  assert.match(notes.find((note) => note.kind === "success")?.message ?? "", /Projections rebuilt/, JSON.stringify(notes));
  const afterRestore = projectionTree();
  closeDatabase();

  for (const layout of ["milestones", "phases"]) rmSync(join(fixture.base, ".gsd", layout), { recursive: true, force: true });
  assert.equal(openWorkflowDatabase(fixture.base).ok, true);
  await rebuildMarkdownProjectionsFromDb(fixture.base);
  const cleanRender = projectionTree();

  assert.match(Object.values(cleanRender).join("\n"), /M999/);
  assert.deepEqual(afterRestore, cleanRender);
});

test("(6) a .latest migration backup is listed as the newer copy and can be restored", async () => {
  const fixture = makeRestoreFixture();
  const latestPath = `${fixture.backupPath}.latest`;
  writeFileSync(latestPath, readFileSync(fixture.backupPath));
  rawExec(
    latestPath,
    `INSERT INTO milestones (id, title, status, created_at) VALUES ('M555', 'newer', 'active', '2026-01-03T00:00:00.000Z');
     PRAGMA wal_checkpoint(TRUNCATE);`,
  );
  for (const suffix of ["-wal", "-shm"]) rmSync(`${latestPath}${suffix}`, { force: true });
  const latestSha = sha256File(latestPath);

  const listing = makeCtx();
  await handleDbRestoreBackup(listing.ctx, fixture.base, "");
  const listed = listing.notes.map((note) => note.message).join("\n");
  assert.match(listed, /gsd\.db\.backup-v45\.latest .*\(newer copy of gsd\.db\.backup-v45\)/);
  assert.ok(listed.includes(latestSha), listed);

  const { ctx, notes } = makeCtx();
  await handleDbRestoreBackup(ctx, fixture.base, consentArgs({ backupPath: latestPath, backupSha: latestSha }));
  closeDatabase();
  assert.ok(notes.some((note) => note.kind === "success"), JSON.stringify(notes));
  assert.deepEqual(milestoneIds(fixture.dbPath), ["M555", "M999"]);
});

test("(6b) restoring backup-v45 beside an existing .latest keeps both earlier backups", async () => {
  const fixture = makeRestoreFixture();
  const latestPath = `${fixture.backupPath}.latest`;
  writeFileSync(latestPath, readFileSync(fixture.backupPath));
  rawExec(
    latestPath,
    `INSERT INTO milestones (id, title, status, created_at) VALUES ('M555', 'newer', 'active', '2026-01-03T00:00:00.000Z');
     PRAGMA wal_checkpoint(TRUNCATE);`,
  );
  for (const suffix of ["-wal", "-shm"]) rmSync(`${latestPath}${suffix}`, { force: true });
  const latestSha = sha256File(latestPath);

  const { ctx, notes } = makeCtx();
  await handleDbRestoreBackup(ctx, fixture.base, consentArgs(fixture));
  closeDatabase();
  const success = notes.find((note) => note.kind === "success");
  assert.ok(success, JSON.stringify(notes));
  assert.match(success.message, new RegExp(`Migrated to schema v${SCHEMA_VERSION}`));

  assert.equal(sha256File(fixture.backupPath), fixture.backupSha, "backup-v45 must survive");
  assert.equal(sha256File(latestPath), latestSha, "the existing .latest must survive");
  assert.deepEqual(milestoneIds(`${fixture.backupPath}.latest-2`), ["M999"], "the new pre-migration copy takes a new name");

  const listing = makeCtx();
  await handleDbRestoreBackup(listing.ctx, fixture.base, "");
  assert.match(listing.notes.map((note) => note.message).join("\n"), /gsd\.db\.backup-v45\.latest-2 .*\(newer copy of gsd\.db\.backup-v45\)/);
  const latest2 = `${fixture.backupPath}.latest-2`;
  const restored = makeCtx();
  await handleDbRestoreBackup(restored.ctx, fixture.base, consentArgs({ backupPath: latest2, backupSha: sha256File(latest2) }));
  closeDatabase();
  assert.ok(restored.notes.some((note) => note.kind === "success"), JSON.stringify(restored.notes));
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

test("a state-directory move whose source cleanup fails still succeeds with the complete copy", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("needs POSIX permissions enforced for the current user");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "gsd-state-move-"));
  tempDirs.add(root);
  const from = join(root, "old");
  const to = join(root, "new");
  mkdirSync(join(from, "locked"), { recursive: true });
  writeFileSync(join(from, "gsd.db"), "db");
  writeFileSync(join(from, "locked", "entry"), "x");
  // A non-empty destination forces copy-then-delete; a read-only subdirectory
  // makes the source delete fail after the copy completed.
  mkdirSync(to);
  writeFileSync(join(to, "stale"), "s");
  chmodSync(join(from, "locked"), 0o500);
  try {
    assert.doesNotThrow(() => moveStateDirectory(from, to));
  } finally {
    chmodSync(join(from, "locked"), 0o700);
  }
  assert.equal(readFileSync(join(to, "gsd.db"), "utf8"), "db");
  assert.equal(readFileSync(join(to, "locked", "entry"), "utf8"), "x");
});
