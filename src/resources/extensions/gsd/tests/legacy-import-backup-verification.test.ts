// Project/App: gsd-pi
// File Purpose: Independent read-only verification contract for legacy-import backup snapshots.

import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { DbAdapter, DbStatement } from "../db-adapter.ts";
import {
  _getAdapter,
  closeDatabase,
  getDbOrNull,
  openDatabase,
} from "../gsd-db.ts";
import {
  captureCurrentLegacyImportBaseSnapshot,
  type LegacyImportBaseSnapshot,
} from "../legacy-import-preview-base.ts";
import {
  hashLegacyImportBytes,
  hashLegacyImportValue,
  sealLegacyImportPreview,
  type LegacyImportPreviewArtifact,
} from "../legacy-import-preview.ts";
import {
  LegacyImportBackupError,
  type LegacyImportBackupSnapshot,
} from "../legacy-import-backup.ts";
import * as legacyImportBackup from "../legacy-import-backup.ts";
import {
  configureSqliteReadOnly,
  openSqliteReadOnly,
  type SqliteReadOnlyConnection,
} from "../sqlite-readonly.ts";

interface VerificationInput {
  preview: LegacyImportPreviewArtifact;
  base: LegacyImportBaseSnapshot;
  snapshot: LegacyImportBackupSnapshot;
}

interface VerificationDependencies {
  openReadOnly(path: string): SqliteReadOnlyConnection;
  configureReadOnly?(connection: SqliteReadOnlyConnection): void;
  removeStagingDirectory?(path: string): void;
  read?(fd: number, buffer: Uint8Array, offset: number, length: number): number;
}

interface VerificationResult {
  snapshot: LegacyImportBackupSnapshot;
  independent_base: LegacyImportBaseSnapshot;
  quick_check: "ok";
  integrity_check: "ok";
  foreign_key_violations: 0;
}

type VerifyForTest = (
  input: VerificationInput,
  dependencies: VerificationDependencies,
) => VerificationResult;

function verificationApi(): {
  publicVerify(input: VerificationInput): VerificationResult;
  testVerify: VerifyForTest;
} {
  const api = legacyImportBackup as Record<string, unknown>;
  assert.equal(typeof api["verifyLegacyImportBackupSnapshot"], "function");
  assert.equal(typeof api["_verifyLegacyImportBackupSnapshotForTest"], "function");
  return {
    publicVerify: api["verifyLegacyImportBackupSnapshot"] as (input: VerificationInput) => VerificationResult,
    testVerify: api["_verifyLegacyImportBackupSnapshotForTest"] as VerifyForTest,
  };
}

function previewArtifact(base: LegacyImportBaseSnapshot): LegacyImportPreviewArtifact {
  const emptyHash = hashLegacyImportValue([]);
  return sealLegacyImportPreview({
    import_kind: "legacy-markdown",
    importer_version: "1",
    base,
    source_set_hash: emptyHash,
    change_set_hash: emptyHash,
    counts: { create: 0, update: 0, delete: 0, preserve: 0, unparsed: 0, unresolved: 0 },
    sources: [],
    changes: [],
    diagnoses: [],
    resolutions: [],
  });
}

function fileIdentity(path: string): { dev: string; ino: string } {
  const stat = statSync(path, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function snapshotFingerprint(directory: string, path: string): unknown {
  const bytes = readFileSync(path);
  const directoryStat = statSync(directory, { bigint: true });
  const fileStat = statSync(path, { bigint: true });
  return {
    directory: {
      dev: String(directoryStat.dev),
      ino: String(directoryStat.ino),
      mode: String(directoryStat.mode),
    },
    children: readdirSync(directory).sort(),
    file: {
      dev: String(fileStat.dev),
      ino: String(fileStat.ino),
      mode: String(fileStat.mode),
      size: String(fileStat.size),
      sha256: hashLegacyImportBytes(bytes),
      header: bytes.subarray(0, 100).toString("hex"),
      read_version: bytes[18],
      write_version: bytes[19],
    },
  };
}

function snapshotFixture(t: TestContext): {
  input: VerificationInput;
  workspace: string;
  stagingDirectory: string;
  snapshotPath: string;
} {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "gsd-backup-verification-")));
  t.after(() => {
    closeDatabase();
    rmSync(workspace, { recursive: true, force: true });
  });
  const livePath = join(workspace, "live.sqlite");
  const stagingDirectory = join(workspace, "private-staging");
  const snapshotPath = join(stagingDirectory, "snapshot.sqlite");
  mkdirSync(stagingDirectory, { mode: 0o700 });

  assert.equal(openDatabase(livePath), true);
  const base = captureCurrentLegacyImportBaseSnapshot();
  const live = _getAdapter();
  assert.ok(live);
  live.prepare("VACUUM INTO ?").run(snapshotPath);
  closeDatabase();
  assert.equal(getDbOrNull(), null, "verification must not depend on the live engine");

  const bytes = readFileSync(snapshotPath);
  const input = {
    preview: previewArtifact(base),
    base,
    snapshot: {
      staging_directory: stagingDirectory,
      staging_directory_identity: fileIdentity(stagingDirectory),
      staging_path: snapshotPath,
      staging_identity: fileIdentity(snapshotPath),
      backup_sha256: hashLegacyImportBytes(bytes),
      backup_byte_size: bytes.byteLength,
    },
  };
  return { input, workspace, stagingDirectory, snapshotPath };
}

function recordingConnection(
  path: string,
  sql: string[],
  closed: { count: number },
): SqliteReadOnlyConnection {
  const connection = openSqliteReadOnly(path);
  const db = connection.db;
  const recorded: DbAdapter = {
    exec(statement) {
      sql.push(statement);
      return db.exec(statement);
    },
    prepare(statement) {
      sql.push(statement);
      return db.prepare(statement);
    },
    close() {
      closed.count += 1;
      return db.close();
    },
  };
  return {
    db: recorded,
    ...(connection.enableDefensive === undefined
      ? {}
      : { enableDefensive: connection.enableDefensive.bind(connection) }),
  };
}

function interceptedConnection(
  path: string,
  options: {
    rows?(sql: string, rows: Record<string, unknown>[]): Record<string, unknown>[];
    exec?(sql: string): void;
    close?(): void;
  },
): SqliteReadOnlyConnection {
  const connection = openSqliteReadOnly(path);
  const underlying = connection.db;
  const db: DbAdapter = {
    exec(sql) {
      options.exec?.(sql);
      underlying.exec(sql);
    },
    prepare(sql): DbStatement {
      const statement = underlying.prepare(sql);
      return {
        run: (...params) => statement.run(...params),
        get: (...params) => options.rows?.(sql, statement.all(...params))[0] ?? statement.get(...params),
        all: (...params) => options.rows?.(sql, statement.all(...params)) ?? statement.all(...params),
      };
    },
    close() {
      try {
        underlying.close();
      } finally {
        options.close?.();
      }
    },
  };
  return {
    db,
    ...(connection.enableDefensive === undefined
      ? {}
      : { enableDefensive: connection.enableDefensive.bind(connection) }),
  };
}

function expectVerificationError(
  fn: () => unknown,
  stage: string,
  code: string,
): LegacyImportBackupError {
  let observed: LegacyImportBackupError | undefined;
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof LegacyImportBackupError);
    assert.equal(error.stage, stage);
    assert.equal(error.code, code);
    assert.equal(error.retryable, false);
    observed = error;
    return true;
  });
  assert.ok(observed);
  return observed;
}

test("legacy import backup verification independently verifies one immutable rollback-journal snapshot", (t) => {
  const { publicVerify, testVerify } = verificationApi();
  const fixture = snapshotFixture(t);
  const before = snapshotFingerprint(fixture.stagingDirectory, fixture.snapshotPath);
  assert.deepEqual(readdirSync(fixture.stagingDirectory), ["snapshot.sqlite"]);
  assert.equal((before as { file: { read_version: number } }).file.read_version, 1);
  assert.equal((before as { file: { write_version: number } }).file.write_version, 1);

  const sql: string[] = [];
  const closed = { count: 0 };
  const observed = testVerify(fixture.input, {
    openReadOnly: (path) => recordingConnection(path, sql, closed),
    configureReadOnly: configureSqliteReadOnly,
  });

  assert.deepEqual(observed, {
    snapshot: fixture.input.snapshot,
    independent_base: fixture.input.base,
    quick_check: "ok",
    integrity_check: "ok",
    foreign_key_violations: 0,
  });
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(Object.isFrozen(observed.snapshot), true);
  assert.equal(Object.isFrozen(observed.independent_base), true);
  assert.equal(closed.count, 1);
  assert.deepEqual(snapshotFingerprint(fixture.stagingDirectory, fixture.snapshotPath), before);
  assert.equal(getDbOrNull(), null);

  const normalizedSql = sql.map((value) => value.trim().replace(/\s+/gu, " ").toLowerCase());
  assert.ok(normalizedSql.includes("pragma database_list"));
  assert.ok(normalizedSql.includes("pragma quick_check"));
  assert.ok(normalizedSql.includes("pragma integrity_check"));
  assert.ok(normalizedSql.includes("pragma foreign_key_check"));
  assert.ok(normalizedSql.includes("begin deferred"));
  assert.ok(normalizedSql.includes("commit"));
  assert.ok(normalizedSql.some((value) => value.includes("from project_authority")));
  for (const forbidden of [
    "journal_mode",
    "wal_checkpoint",
    "vacuum",
    "checkpoint",
    "attach database",
    "insert ",
    "update ",
    "delete ",
    "create ",
    "drop ",
  ]) {
    assert.equal(normalizedSql.some((value) => value.includes(forbidden)), false, forbidden);
  }

  const publicResult = publicVerify(fixture.input);
  assert.deepEqual(publicResult, observed);
  assert.deepEqual(snapshotFingerprint(fixture.stagingDirectory, fixture.snapshotPath), before);
});

test("legacy import backup verification closes failed read-only setup and gives cleanup final precedence", (t) => {
  const { testVerify } = verificationApi();
  const fixture = snapshotFixture(t);
  const closed = { count: 0 };
  const cleanup: string[] = [];
  const connection = recordingConnection(fixture.snapshotPath, [], closed);

  assert.throws(
    () => testVerify(fixture.input, {
      openReadOnly: () => connection,
      configureReadOnly: () => {
        throw new Error("safeguard readback failed");
      },
      removeStagingDirectory: (path) => {
        cleanup.push(path);
        throw new Error("cleanup failed");
      },
    }),
    (error: unknown) => error instanceof LegacyImportBackupError
      && error.stage === "cleanup"
      && error.code === "LEGACY_IMPORT_BACKUP_STAGING_CLEANUP_FAILED",
  );
  assert.equal(closed.count, 1, "an owned connection closes after configuration failure");
  assert.deepEqual(cleanup, [fixture.stagingDirectory]);
});

test("legacy import backup verification rejects sidecars before opening and removes private staging", (t) => {
  const { testVerify } = verificationApi();
  const fixture = snapshotFixture(t);
  writeFileSync(`${fixture.snapshotPath}-wal`, "not-approved");
  let opens = 0;

  assert.throws(
    () => testVerify(fixture.input, {
      openReadOnly: () => {
        opens += 1;
        return openSqliteReadOnly(fixture.snapshotPath);
      },
    }),
    (error: unknown) => error instanceof LegacyImportBackupError
      && error.stage === "snapshot"
      && error.code === "LEGACY_IMPORT_BACKUP_SNAPSHOT_INVALID",
  );
  assert.equal(opens, 0);
  assert.equal(lstatSync(fixture.stagingDirectory, { throwIfNoEntry: false }), undefined);
});

test("legacy import backup verification requires one main database and one ok row from each integrity check", (t) => {
  const { testVerify } = verificationApi();
  const scenarios = [
    {
      name: "attached database",
      match: "pragma database_list",
      rows: [
        { seq: 0, name: "main", file: "replace-with-path" },
        { seq: 2, name: "other", file: "/unapproved.sqlite" },
      ],
      code: "LEGACY_IMPORT_BACKUP_OPEN_FAILED",
    },
    {
      name: "quick_check extra ok row",
      match: "pragma quick_check",
      rows: [{ quick_check: "ok" }, { quick_check: "ok" }],
      code: "LEGACY_IMPORT_BACKUP_INTEGRITY_FAILED",
    },
    {
      name: "quick_check non-ok row",
      match: "pragma quick_check",
      rows: [{ quick_check: "database disk image is malformed" }],
      code: "LEGACY_IMPORT_BACKUP_INTEGRITY_FAILED",
    },
    {
      name: "integrity_check extra ok row",
      match: "pragma integrity_check",
      rows: [{ integrity_check: "ok" }, { integrity_check: "ok" }],
      code: "LEGACY_IMPORT_BACKUP_INTEGRITY_FAILED",
    },
  ] as const;

  for (const scenario of scenarios) {
    const fixture = snapshotFixture(t);
    let opens = 0;
    expectVerificationError(
      () => testVerify(fixture.input, {
        openReadOnly: (path) => {
          opens += 1;
          return interceptedConnection(path, {
            rows(sql, rows) {
              if (!sql.trim().toLowerCase().includes(scenario.match)) return rows;
              return scenario.rows.map((row) => {
                const value = row as Readonly<Record<string, unknown>>;
                return {
                  ...value,
                  ...(value["file"] === "replace-with-path" ? { file: path } : {}),
                };
              });
            },
          });
        },
      }),
      "verification",
      scenario.code,
    );
    assert.equal(opens, 1, `${scenario.name}: no hidden retry`);
    assert.equal(lstatSync(fixture.stagingDirectory, { throwIfNoEntry: false }), undefined);
  }
});

test("legacy import backup verification rejects foreign keys and requires schema v45 anchors", (t) => {
  const { testVerify } = verificationApi();
  const scenarios = [
    {
      name: "foreign key violation",
      match: "pragma foreign_key_check",
      rows: [{ table: "tasks", rowid: 1, parent: "slices", fkid: 0 }],
      code: "LEGACY_IMPORT_BACKUP_FOREIGN_KEY_FAILED",
    },
    {
      name: "missing anchor",
      match: "from sqlite_schema",
      rows: [{ type: "table", name: "project_authority" }],
      code: "LEGACY_IMPORT_BACKUP_SCHEMA_INVALID",
    },
    {
      name: "wrong schema version",
      match: "max(version)",
      rows: [{ version: 43 }],
      code: "LEGACY_IMPORT_BACKUP_SCHEMA_INVALID",
    },
  ] as const;

  for (const scenario of scenarios) {
    const fixture = snapshotFixture(t);
    expectVerificationError(
      () => testVerify(fixture.input, {
        openReadOnly: (path) => interceptedConnection(path, {
          rows: (sql, rows) => sql.toLowerCase().includes(scenario.match)
            ? scenario.rows.map((row) => ({ ...row }))
            : rows,
        }),
      }),
      "verification",
      scenario.code,
    );
  }
});

test("legacy import backup verification requires every v45 recovery receipt anchor", (t) => {
  const { testVerify } = verificationApi();
  for (const missingName of [
    "workflow_authority_cutovers",
    "workflow_import_restores",
    "workflow_import_forward_repairs",
  ]) {
    const fixture = snapshotFixture(t);
    expectVerificationError(
      () => testVerify(fixture.input, {
        openReadOnly: (path) => interceptedConnection(path, {
          rows: (sql, rows) => sql.toLowerCase().includes("from sqlite_schema")
            ? rows.filter((row) => row["name"] !== missingName)
            : rows,
        }),
      }),
      "verification",
      "LEGACY_IMPORT_BACKUP_SCHEMA_INVALID",
    );
  }
});

test("legacy import backup verification captures an independently equal base in its own transaction", (t) => {
  const { testVerify } = verificationApi();
  const fixture = snapshotFixture(t);
  const changedBase = structuredClone(fixture.input.base);
  changedBase.authority.revision += 1;
  const input = {
    ...fixture.input,
    base: changedBase,
    preview: previewArtifact(changedBase),
  };
  const sql: string[] = [];

  expectVerificationError(
    () => testVerify(input, {
      openReadOnly: (path) => recordingConnection(path, sql, { count: 0 }),
    }),
    "verification",
    "LEGACY_IMPORT_BACKUP_VERIFIED_BASE_MISMATCH",
  );
  assert.ok(sql.some((statement) => statement.trim().toLowerCase() === "begin deferred"));
  assert.ok(sql.some((statement) => statement.trim().toLowerCase() === "rollback"));
});

test("legacy import backup verification failure precedence is cleanup then close then rollback then original", (t) => {
  const { testVerify } = verificationApi();
  const scenarios = [
    {
      name: "original",
      rollbackFails: false,
      closeFails: false,
      cleanupFails: false,
      stage: "verification",
      code: "LEGACY_IMPORT_BACKUP_INTEGRITY_FAILED",
    },
    {
      name: "rollback",
      rollbackFails: true,
      closeFails: false,
      cleanupFails: false,
      stage: "verification",
      code: "LEGACY_IMPORT_BACKUP_TRANSACTION_FAILED",
    },
    {
      name: "close",
      rollbackFails: true,
      closeFails: true,
      cleanupFails: false,
      stage: "verification",
      code: "LEGACY_IMPORT_BACKUP_CLOSE_FAILED",
    },
    {
      name: "cleanup",
      rollbackFails: true,
      closeFails: true,
      cleanupFails: true,
      stage: "cleanup",
      code: "LEGACY_IMPORT_BACKUP_STAGING_CLEANUP_FAILED",
    },
  ] as const;

  for (const scenario of scenarios) {
    const fixture = snapshotFixture(t);
    let opens = 0;
    expectVerificationError(
      () => testVerify(fixture.input, {
        openReadOnly: (path) => {
          opens += 1;
          return interceptedConnection(path, {
            rows: (sql, rows) => sql.toLowerCase().includes("pragma quick_check")
              ? [{ quick_check: "not ok" }]
              : rows,
            exec: (sql) => {
              if (scenario.rollbackFails && sql.trim().toLowerCase() === "rollback") {
                throw new Error("rollback failed");
              }
            },
            close: () => {
              if (scenario.closeFails) throw new Error("close failed");
            },
          });
        },
        removeStagingDirectory: scenario.cleanupFails
          ? () => { throw new Error("cleanup failed"); }
          : undefined,
      }),
      scenario.stage,
      scenario.code,
    );
    assert.equal(opens, 1, `${scenario.name}: no retry`);
  }
});

test("legacy import backup verification classifies open and configuration failure and closes owned connections", (t) => {
  const { testVerify } = verificationApi();
  const openFixture = snapshotFixture(t);
  let opens = 0;
  expectVerificationError(
    () => testVerify(openFixture.input, {
      openReadOnly: () => {
        opens += 1;
        throw new Error("provider open failed");
      },
    }),
    "verification",
    "LEGACY_IMPORT_BACKUP_OPEN_FAILED",
  );
  assert.equal(opens, 1);

  const configurationFixture = snapshotFixture(t);
  const closed = { count: 0 };
  expectVerificationError(
    () => testVerify(configurationFixture.input, {
      openReadOnly: (path) => recordingConnection(path, [], closed),
      configureReadOnly: () => { throw new Error("readback mismatch"); },
    }),
    "verification",
    "LEGACY_IMPORT_BACKUP_READ_ONLY_CONFIGURATION_FAILED",
  );
  assert.equal(closed.count, 1);
});

test("legacy import backup verification rejects header drift identity replacement and post-query mutation", (t) => {
  const { testVerify } = verificationApi();

  const headerFixture = snapshotFixture(t);
  const headerBytes = readFileSync(headerFixture.snapshotPath);
  headerBytes[18] = 2;
  headerBytes[19] = 2;
  writeFileSync(headerFixture.snapshotPath, headerBytes);
  headerFixture.input.snapshot.backup_sha256 = hashLegacyImportBytes(headerBytes);
  expectVerificationError(
    () => testVerify(headerFixture.input, { openReadOnly: openSqliteReadOnly }),
    "snapshot",
    "LEGACY_IMPORT_BACKUP_SNAPSHOT_INVALID",
  );

  const identityFixture = snapshotFixture(t);
  const originalBytes = readFileSync(identityFixture.snapshotPath);
  // Allocate the replacement before removing the original: holding the old
  // inode while the new file is created guarantees a different dev:ino
  // identity on every filesystem (a plain rm+write can immediately reuse
  // the freed inode on Linux, which would leave the identity unchanged).
  const stagingPath = `${identityFixture.snapshotPath}-staging`;
  writeFileSync(stagingPath, originalBytes);
  renameSync(stagingPath, identityFixture.snapshotPath);
  expectVerificationError(
    () => testVerify(identityFixture.input, { openReadOnly: openSqliteReadOnly }),
    "snapshot",
    "LEGACY_IMPORT_BACKUP_SNAPSHOT_INVALID",
  );

  const mutationFixture = snapshotFixture(t);
  expectVerificationError(
    () => testVerify(mutationFixture.input, {
      openReadOnly: (path) => interceptedConnection(path, {
        close: () => {
          const bytes = readFileSync(path);
          bytes[100] = (bytes[100]! ^ 0xff) & 0xff;
          writeFileSync(path, bytes);
        },
      }),
    }),
    "snapshot",
    "LEGACY_IMPORT_BACKUP_SNAPSHOT_CHANGED",
  );
});

test("legacy import backup verification reads the rollback-journal header through injectable ops", (t) => {
  const { testVerify } = verificationApi();
  const fixture = snapshotFixture(t);
  const readLengths: number[] = [];
  expectVerificationError(
    () => testVerify(fixture.input, {
      openReadOnly: openSqliteReadOnly,
      read(fd, buffer, offset, length) {
        readLengths.push(length);
        if (length === 20) {
          buffer.fill(0, offset, offset + length);
          return length;
        }
        return readSync(fd, buffer, offset, length, null);
      },
    }),
    "snapshot",
    "LEGACY_IMPORT_BACKUP_SNAPSHOT_INVALID",
  );
  assert.ok(readLengths.includes(20), "header bytes are read through the injected ops.read");
});

test("legacy import backup verification rejects non-exact input before independent open", (t) => {
  const { testVerify } = verificationApi();
  const fixture = snapshotFixture(t);
  let opens = 0;
  const inputs = [
    { ...fixture.input, extra: true },
    { preview: fixture.input.preview, base: fixture.input.base },
    { ...fixture.input, snapshot: { ...fixture.input.snapshot, extra: true } },
    { ...fixture.input, snapshot: { ...fixture.input.snapshot, backup_byte_size: 0 } },
  ];
  for (const input of inputs) {
    expectVerificationError(
      () => testVerify(input as VerificationInput, {
        openReadOnly: (path) => {
          opens += 1;
          return openSqliteReadOnly(path);
        },
      }),
      "contract",
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
    );
  }
  assert.equal(opens, 0);
  assert.ok(lstatSync(fixture.stagingDirectory).isDirectory(), "contract rejection does not claim ownership");
});
