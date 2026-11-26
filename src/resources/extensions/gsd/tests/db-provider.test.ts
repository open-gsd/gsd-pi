// Project/App: gsd-pi
// File Purpose: Tests for SQLite provider loading and close lifecycle behavior.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createSqliteProviderLoader, type SqliteProviderDeps } from "../db-provider.ts";

const require = createRequire(import.meta.url);

type RawDatabase = {
  exec(sql: string): void;
  prepare(sql: string): { get(): Record<string, unknown> };
  close(): void;
};

type FakeDatabaseOptions = { readOnly?: boolean };

class FakeNodeDatabase {
  static instances: FakeNodeDatabase[] = [];
  readonly path: string;
  readonly options: FakeDatabaseOptions | undefined;
  closed = false;
  closeCalls = 0;
  failProbe = false;
  failClose = false;
  failCloseAfter = false;
  journalMode = "wal";

  constructor(path: string, options?: FakeDatabaseOptions) {
    this.path = path;
    this.options = options;
    FakeNodeDatabase.instances.push(this);
  }

  exec(): void {}

  prepare(sql = ""): { get(): Record<string, unknown> } {
    return {
      get: () => {
        if (this.closed) throw new Error("database is not open");
        if (this.failProbe) throw new Error("guard probe failed");
        if (sql === "PRAGMA journal_mode") return { journal_mode: this.journalMode };
        return {};
      },
    };
  }

  close(): void {
    this.closeCalls += 1;
    if (this.failClose) throw new Error(this.options?.readOnly ? "guard close failed" : "writable close failed");
    this.closed = true;
    if (this.failCloseAfter) throw new Error(this.options?.readOnly ? "guard post-close failed" : "writable post-close failed");
  }
}

function createDeps(overrides: Partial<SqliteProviderDeps> = {}): SqliteProviderDeps & { stderr: string[] } {
  const stderr: string[] = [];
  return {
    tryRequireNodeSqlite(): unknown {
      return { DatabaseSync: FakeNodeDatabase };
    },
    suppressSqliteWarning(): void {},
    nodeVersion: "22.19.0",
    writeStderr(message: string): void {
      stderr.push(message);
    },
    stderr,
    ...overrides,
  };
}

function assertWalSurvivesClose(loader: ReturnType<typeof createSqliteProviderLoader>): void {
  const directory = mkdtempSync(join(tmpdir(), "gsd-provider-close-"));
  const path = join(directory, "gsd.db");
  const walPath = `${path}-wal`;

  try {
    const rawDb = loader.openRaw(path) as RawDatabase;
    rawDb.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE close_probe(value TEXT); INSERT INTO close_probe VALUES ('committed');");
    const walSizeBeforeClose = statSync(walPath).size;

    rawDb.close();

    assert.equal(existsSync(walPath), true, "close must not delete the committed WAL");
    assert.equal(statSync(walPath).size, walSizeBeforeClose, "close must not checkpoint committed WAL frames");

    const immutablePath = pathToFileURL(path);
    immutablePath.searchParams.set("immutable", "1");
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: URL, options: { readOnly: boolean }) => RawDatabase;
    };
    const databaseFileOnly = new DatabaseSync(immutablePath, { readOnly: true });
    try {
      assert.throws(
        () => databaseFileOnly.prepare("SELECT value FROM close_probe").get(),
        /no such table: close_probe/,
        "the database file must not contain frames left in the WAL",
      );
    } finally {
      databaseFileOnly.close();
    }

    const reopened = loader.openRaw(path) as RawDatabase;
    try {
      assert.equal(reopened.prepare("SELECT value FROM close_probe").get().value, "committed");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("db-provider", () => {
  test("file-backed node:sqlite preserves committed WAL frames across close and reopen", () => {
    const loader = createSqliteProviderLoader(createDeps({
      tryRequireNodeSqlite(): unknown {
        return require("node:sqlite");
      },
    }));

    assertWalSurvivesClose(loader);
  });

  test("opens a read-only close guard without enabling extension loading", (t) => {
    FakeNodeDatabase.instances = [];
    const loader = createSqliteProviderLoader(createDeps());
    const directory = mkdtempSync(join(tmpdir(), "gsd-provider-guard-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "gsd.db");

    const rawDb = loader.openRaw(path) as RawDatabase;

    assert.equal(loader.getProviderName(), "node:sqlite");
    assert.equal(FakeNodeDatabase.instances.length, 2);
    assert.deepEqual(FakeNodeDatabase.instances.map(({ path, options }) => ({ path, options })), [
      { path, options: { readOnly: true } },
      { path, options: undefined },
    ]);

    rawDb.close();
    assert.equal(FakeNodeDatabase.instances.every((database) => database.closed), true);
  });

  test("closes the read-only guard when the writable open fails", (t) => {
    const opened: FakeNodeDatabase[] = [];
    class FailingWritableDatabase extends FakeNodeDatabase {
      constructor(path: string, options?: FakeDatabaseOptions) {
        if (!options?.readOnly) throw new Error("writable open failed");
        super(path, options);
        opened.push(this);
      }
    }
    const loader = createSqliteProviderLoader(createDeps({
      tryRequireNodeSqlite(): unknown {
        return { DatabaseSync: FailingWritableDatabase };
      },
    }));
    const directory = mkdtempSync(join(tmpdir(), "gsd-provider-failed-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));

    assert.throws(() => loader.openRaw(join(directory, "gsd.db")), /writable open failed/);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].closed, true);
  });

  test("keeps both handles open when the close guard probe fails", (t) => {
    FakeNodeDatabase.instances = [];
    const loader = createSqliteProviderLoader(createDeps());
    const directory = mkdtempSync(join(tmpdir(), "gsd-provider-probe-failed-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const rawDb = loader.openRaw(join(directory, "gsd.db")) as RawDatabase;
    const [guard, writable] = FakeNodeDatabase.instances;
    guard.failProbe = true;

    assert.throws(() => rawDb.close(), /guard probe failed/);
    assert.equal(guard.closed, false);
    assert.equal(writable.closed, false);

    guard.failProbe = false;
    rawDb.close();
    assert.equal(guard.closed, true);
    assert.equal(writable.closed, true);
  });

  test("closes without a guard probe after coordinated DELETE mode", (t) => {
    FakeNodeDatabase.instances = [];
    const loader = createSqliteProviderLoader(createDeps());
    const directory = mkdtempSync(join(tmpdir(), "gsd-provider-delete-close-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const rawDb = loader.openRaw(join(directory, "gsd.db")) as RawDatabase;
    const [guard, writable] = FakeNodeDatabase.instances;
    guard.failProbe = true;
    writable.journalMode = "delete";

    rawDb.close();

    assert.equal(writable.closed, true);
    assert.equal(guard.closed, true);
  });

  test("keeps the guard open until a failed writable close succeeds", (t) => {
    FakeNodeDatabase.instances = [];
    const loader = createSqliteProviderLoader(createDeps());
    const directory = mkdtempSync(join(tmpdir(), "gsd-provider-writable-close-failed-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const rawDb = loader.openRaw(join(directory, "gsd.db")) as RawDatabase;
    const [guard, writable] = FakeNodeDatabase.instances;
    writable.failClose = true;

    assert.throws(() => rawDb.close(), /writable close failed/);
    assert.equal(guard.closed, false);
    assert.equal(writable.closed, false);

    writable.failClose = false;
    rawDb.close();
    assert.equal(guard.closed, true);
    assert.equal(writable.closed, true);
  });

  test("retries only the guard after writable close succeeds", (t) => {
    FakeNodeDatabase.instances = [];
    const loader = createSqliteProviderLoader(createDeps());
    const directory = mkdtempSync(join(tmpdir(), "gsd-provider-guard-close-failed-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const rawDb = loader.openRaw(join(directory, "gsd.db")) as RawDatabase;
    const [guard, writable] = FakeNodeDatabase.instances;
    guard.failClose = true;

    assert.throws(() => rawDb.close(), /guard close failed/);
    assert.equal(writable.closed, true);
    assert.equal(guard.closed, false);

    guard.failClose = false;
    rawDb.close();
    assert.equal(writable.closeCalls, 1);
    assert.equal(guard.closed, true);
  });

  test("completes cleanup when writable close reports an error after closing", (t) => {
    FakeNodeDatabase.instances = [];
    const loader = createSqliteProviderLoader(createDeps());
    const directory = mkdtempSync(join(tmpdir(), "gsd-provider-writable-post-close-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const rawDb = loader.openRaw(join(directory, "gsd.db")) as RawDatabase;
    const [guard, writable] = FakeNodeDatabase.instances;
    writable.failCloseAfter = true;

    rawDb.close();
    rawDb.close();

    assert.equal(writable.closeCalls, 1);
    assert.equal(guard.closeCalls, 1);
    assert.equal(guard.closed, true);
  });

  test("completes cleanup when guard close reports an error after closing", (t) => {
    FakeNodeDatabase.instances = [];
    const loader = createSqliteProviderLoader(createDeps());
    const directory = mkdtempSync(join(tmpdir(), "gsd-provider-guard-post-close-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const rawDb = loader.openRaw(join(directory, "gsd.db")) as RawDatabase;
    const [guard, writable] = FakeNodeDatabase.instances;
    guard.failCloseAfter = true;

    rawDb.close();
    rawDb.close();

    assert.equal(writable.closeCalls, 1);
    assert.equal(guard.closeCalls, 1);
    assert.equal(guard.closed, true);
  });

  test("openRaw without createIfMissing refuses a deleted path without recreating it (#2158)", () => {
    const directory = mkdtempSync(join(tmpdir(), "gsd-provider-no-recreate-"));
    try {
      const deps = createDeps();
      const loader = createSqliteProviderLoader(deps);
      const missing = join(directory, "gsd.db");
      FakeNodeDatabase.instances.length = 0;

      assert.throws(
        () => loader.openRaw(missing, { createIfMissing: false }),
        (err: NodeJS.ErrnoException) => err.code === "SQLITE_CANTOPEN",
      );
      assert.equal(existsSync(missing), false, "a no-create open must not recreate the DB file");
      assert.equal(FakeNodeDatabase.instances.length, 0, "no database handle may be created for a missing path");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports provider unavailability with the supported Node version", () => {
    const deps = createDeps({
      tryRequireNodeSqlite(): unknown {
        throw new Error("unavailable");
      },
      nodeVersion: "22.17.1",
    });
    const loader = createSqliteProviderLoader(deps);

    assert.equal(loader.openRaw(":memory:"), null);

    assert.equal(loader.getProviderName(), null);
    assert.equal(deps.stderr.length, 1);
    assert.match(deps.stderr[0], /No SQLite provider available/);
    assert.match(deps.stderr[0], /Node >= 22\.19\.0/);
    assert.doesNotMatch(deps.stderr[0], /better-sqlite3/);
  });
});
