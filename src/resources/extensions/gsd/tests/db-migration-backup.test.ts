// Project/App: gsd-pi
// File Purpose: Tests for pre-migration database backup helper.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MigrationBackupError, backupDatabaseBeforeMigration } from "../db-migration-backup.ts";
import type { DbAdapter, DbStatement } from "../db-adapter.ts";

class FakeStatement implements DbStatement {
  private readonly row: Record<string, unknown> | undefined;

  constructor(row: Record<string, unknown> | undefined = undefined) {
    this.row = row;
  }

  run(): unknown {
    return undefined;
  }

  get(): Record<string, unknown> | undefined {
    return this.row;
  }

  all(): Record<string, unknown>[] {
    return [];
  }
}

class FakeAdapter implements DbAdapter {
  readonly execCalls: string[] = [];
  readonly prepareCalls: string[] = [];
  failCheckpoint = false;
  checkpointRow: Record<string, unknown> = { busy: 0, log: 0, checkpointed: 0 };
  backupCheck = "ok";
  backupVersion = 12;

  exec(sql: string): void {
    this.execCalls.push(sql);
    if (this.failCheckpoint) throw new Error("checkpoint failed");
  }

  prepare(sql: string): DbStatement {
    this.prepareCalls.push(sql);
    if (this.failCheckpoint) throw new Error("checkpoint failed");
    if (sql === "PRAGMA migration_backup.quick_check") {
      return new FakeStatement({ quick_check: this.backupCheck });
    }
    if (sql.includes("migration_backup.schema_version")) {
      return new FakeStatement({ version: this.backupVersion });
    }
    return new FakeStatement(this.checkpointRow);
  }

  close(): void {}
}

describe("db-migration-backup", () => {
  test("skips missing and memory databases but replaces existing backups", () => {
    const db = new FakeAdapter();
    db.backupVersion = 7;
    const copies: Array<[string, string]> = [];
    const warnings: string[] = [];

    backupDatabaseBeforeMigration(db, null, 7, {
      existsSync: () => true,
      copyFileSync: (src, dest) => copies.push([src, dest]),
      logWarning: (_scope, message) => warnings.push(message),
    });
    backupDatabaseBeforeMigration(db, ":memory:", 7, {
      existsSync: () => true,
      copyFileSync: (src, dest) => copies.push([src, dest]),
      logWarning: (_scope, message) => warnings.push(message),
    });
    backupDatabaseBeforeMigration(db, "/tmp/gsd.db", 7, {
      existsSync: () => true,
      copyFileSync: (src, dest) => copies.push([src, dest]),
      logWarning: (_scope, message) => warnings.push(message),
    });

    assert.deepEqual(copies, [["/tmp/gsd.db", "/tmp/gsd.db.backup-v7"]]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(db.prepareCalls, [
      "PRAGMA wal_checkpoint(TRUNCATE)",
      "ATTACH DATABASE ? AS migration_backup",
      "PRAGMA migration_backup.quick_check",
      "SELECT MAX(version) AS version FROM migration_backup.schema_version",
    ]);
  });

  test("checkpoints before copying a file-backed database", () => {
    const db = new FakeAdapter();
    const copies: Array<[string, string]> = [];

    backupDatabaseBeforeMigration(db, "/tmp/gsd.db", 12, {
      existsSync: (path) => path === "/tmp/gsd.db",
      copyFileSync: (src, dest) => copies.push([src, dest]),
      logWarning: () => assert.fail("should not warn"),
    });

    assert.deepEqual(db.prepareCalls, [
      "PRAGMA wal_checkpoint(TRUNCATE)",
      "ATTACH DATABASE ? AS migration_backup",
      "PRAGMA migration_backup.quick_check",
      "SELECT MAX(version) AS version FROM migration_backup.schema_version",
    ]);
    assert.deepEqual(copies, [["/tmp/gsd.db", "/tmp/gsd.db.backup-v12"]]);
  });

  test("accepts a valid legacy backup without schema metadata", () => {
    const db = new FakeAdapter();
    const copies: Array<[string, string]> = [];

    backupDatabaseBeforeMigration(db, "/tmp/legacy.db", 1, {
      existsSync: () => true,
      copyFileSync: (src, dest) => copies.push([src, dest]),
      logWarning: () => assert.fail("should not warn"),
      allowMissingSchemaVersion: true,
    });

    assert.deepEqual(copies, [["/tmp/legacy.db", "/tmp/legacy.db.backup-v1"]]);
    assert.ok(db.prepareCalls.some((sql) => sql.includes("migration_backup.sqlite_master")));
    assert.ok(!db.prepareCalls.some((sql) => sql.includes("MAX(version)")));
  });

  test("throws and skips copying when checkpoint fails", () => {
    const db = new FakeAdapter();
    db.failCheckpoint = true;
    const copies: Array<[string, string]> = [];
    const warnings: string[] = [];

    assert.throws(
      () =>
        backupDatabaseBeforeMigration(db, "/tmp/gsd.db", 12, {
          existsSync: (path) => path === "/tmp/gsd.db",
          copyFileSync: (src, dest) => copies.push([src, dest]),
          logWarning: (_scope, message) => warnings.push(message),
        }),
      /checkpoint failed/,
    );

    assert.deepEqual(db.prepareCalls, ["PRAGMA wal_checkpoint(TRUNCATE)"]);
    assert.deepEqual(copies, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Pre-migration backup failed: checkpoint failed/);
  });

  test("throws and skips copying when checkpoint result is incomplete", () => {
    const db = new FakeAdapter();
    db.checkpointRow = { busy: 1, log: 4, checkpointed: 3 };
    const copies: Array<[string, string]> = [];
    const warnings: string[] = [];

    assert.throws(
      () =>
        backupDatabaseBeforeMigration(db, "/tmp/gsd.db", 12, {
          existsSync: (path) => path === "/tmp/gsd.db",
          copyFileSync: (src, dest) => copies.push([src, dest]),
          logWarning: (_scope, message) => warnings.push(message),
        }),
      MigrationBackupError,
    );

    assert.deepEqual(db.prepareCalls, ["PRAGMA wal_checkpoint(TRUNCATE)"]);
    assert.deepEqual(copies, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Pre-migration backup failed: WAL checkpoint incomplete/);
  });

  test("throws and warns when copy fails", () => {
    const db = new FakeAdapter();
    const warnings: string[] = [];

    assert.throws(
      () =>
        backupDatabaseBeforeMigration(db, "/tmp/fail.db", 13, {
          existsSync: (path) => path === "/tmp/fail.db",
          copyFileSync: () => {
            throw new Error("read only");
          },
          logWarning: (_scope, message) => warnings.push(message),
        }),
      /read only/,
    );

    assert.deepEqual(db.prepareCalls, ["PRAGMA wal_checkpoint(TRUNCATE)"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Pre-migration backup failed: read only/);
  });

  test("throws when the copied backup fails integrity validation", () => {
    const db = new FakeAdapter();
    db.backupCheck = "database disk image is malformed";
    const warnings: string[] = [];

    assert.throws(
      () =>
        backupDatabaseBeforeMigration(db, "/tmp/gsd.db", 12, {
          existsSync: () => true,
          copyFileSync: () => {},
          logWarning: (_scope, message) => warnings.push(message),
        }),
      /failed quick_check/,
    );

    assert.deepEqual(db.execCalls, ["DETACH DATABASE migration_backup"]);
    assert.match(warnings[0], /Pre-migration backup failed/);
  });
});
