// gsd-pi — DB engine failure-branch log coverage.
//
// `checkpointDatabase` / `closeDatabase` / `vacuumDatabase` in db/engine.ts are
// the highest-frequency runtime paths (called every turn and at closeout).
// Explicit checkpoint/vacuum maintenance and connection close failures remain
// observable without making close itself a database mutation boundary.
//
// This file pins the log output for the three checkpoint/vacuum/close failure
// branches by stubbing the live adapter's `exec`/`close` to throw on demand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkpointDatabase, closeDatabase, openDatabase, vacuumDatabase, _getAdapter } from "../gsd-db.ts";
import {
  readTransaction,
  transaction,
  _openCorrelatedRawDatabaseForTest,
} from "../db/engine.ts";
import { GSDError, GSD_STALE_STATE } from "../errors.ts";
import {
  drainLogs,
  peekLogs,
  setStderrLoggingEnabled,
  _resetLogs,
  type LogEntry,
} from "../workflow-logger.ts";
import type { DbAdapter } from "../db-adapter.ts";

function makeBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-db-engine-logs-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

/** Capture log entries emitted while running fn. Stderr is suppressed. */
function captureLogs<T>(fn: () => T): { result: T; logs: LogEntry[] } {
  const previous = setStderrLoggingEnabled(false);
  _resetLogs();
  try {
    const result = fn();
    return { result, logs: drainLogs() };
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previous);
  }
}

/**
 * Wrap the live adapter's `exec` so it throws for SQL matching `needle`,
 * delegating everything else to the original. Returns a restore function.
 */
function breakExecOn(adapter: DbAdapter, needle: string): () => void {
  const origExec = adapter.exec.bind(adapter);
  adapter.exec = (sql: string): void => {
    if (sql.includes(needle)) throw new Error(`forced failure for: ${needle}`);
    return origExec(sql);
  };
  return () => {
    adapter.exec = origExec;
  };
}

test("checkpointDatabase logs a `db` warning when the WAL checkpoint throws", () => {
  const base = makeBase();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  try {
    const adapter = _getAdapter();
    assert.ok(adapter, "an adapter must be open");
    const restore = breakExecOn(adapter!, "wal_checkpoint");

    const { logs } = captureLogs(() => checkpointDatabase());
    restore();

    const dbWarn = logs.find((e) => e.component === "db" && e.severity === "warn");
    assert.ok(dbWarn, "a db warning must be logged on checkpoint failure");
    assert.match(dbWarn!.message, /WAL checkpoint failed/u);
    assert.match(dbWarn!.message, /forced failure for: wal_checkpoint/u);
    // checkpointDatabase must not rethrow — orchestration continues.
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("vacuumDatabase logs a `db` warning when VACUUM throws", () => {
  const base = makeBase();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  try {
    const adapter = _getAdapter();
    assert.ok(adapter);
    const restore = breakExecOn(adapter!, "VACUUM");

    const { logs } = captureLogs(() => vacuumDatabase());
    restore();

    const dbWarn = logs.find((e) => e.component === "db" && e.severity === "warn");
    assert.ok(dbWarn, "a db warning must be logged on VACUUM failure");
    assert.match(dbWarn!.message, /VACUUM failed/u);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("closeDatabase retains ownership when close throws", () => {
  const base = makeBase();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const adapter = _getAdapter();
  assert.ok(adapter);
  const origClose = adapter!.close.bind(adapter!);
  adapter!.close = (): void => {
    throw new Error("forced close failure");
  };

  assert.throws(() => captureLogs(() => closeDatabase()), /forced close failure/);
  adapter!.close = origClose;

  try {
    assert.equal(_getAdapter(), adapter, "engine must retain the adapter after a broken close");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("closeDatabase closes the connection without running maintenance", () => {
  const base = makeBase();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const adapter = _getAdapter();
  assert.ok(adapter);
  const statements: string[] = [];
  const originalExec = adapter!.exec.bind(adapter!);
  adapter!.exec = (sql: string): void => {
    statements.push(sql);
    originalExec(sql);
  };

  try {
    closeDatabase();
    assert.deepEqual(statements, [], "connection close must not checkpoint or vacuum");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("checkpointDatabase and vacuumDatabase are no-ops (and log nothing) when no DB is open", () => {
  _resetLogs();
  const previous = setStderrLoggingEnabled(false);
  try {
    checkpointDatabase();
    vacuumDatabase();
    assert.equal(peekLogs().length, 0, "no-db paths must not emit any logs");
  } finally {
    setStderrLoggingEnabled(previous);
    _resetLogs();
  }
});

test("readTransaction logs a db error when ROLLBACK fails after a read error (split-brain signal)", () => {
  const base = makeBase();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const adapter = _getAdapter();
  assert.ok(adapter);
  // Make ROLLBACK throw so the read-failure path invokes the rollback-error
  // callback (engine.ts:768-775), which logs the split-brain error.
  const restore = breakExecOn(adapter!, "ROLLBACK");

  const { logs } = captureLogs(() => {
    assert.throws(
      () => readTransaction(() => {
        throw new Error("read body failed");
      }),
      /read body failed/u,
      "the original read error must still propagate",
    );
  });
  restore();
  closeDatabase();
  try {
    const err = logs.find((e) => e.component === "db" && e.severity === "error");
    assert.ok(err, "a db error must be logged when ROLLBACK fails");
    assert.equal(err!.message, "snapshotState ROLLBACK failed");
    assert.match(err!.context?.error ?? "", /forced failure for: ROLLBACK/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("openCorrelatedRawDatabase degrades a null provider handle without leaking the identity capture", () => {
  const base = makeBase();
  try {
    const dbPath = join(base, ".gsd", "gsd.db");
    // providerLoader.openRaw() returns null when no SQLite provider is
    // available. The open path must surface that as { raw: null } so the
    // caller's `if (!rawDb) return false` guard runs, instead of dying on
    // createDbAdapter(null).exec and then escaping through a second TypeError
    // from null.close() before the identity capture is released.
    const result = _openCorrelatedRawDatabaseForTest(dbPath, () => null);
    assert.equal(result.raw, null);
    assert.equal(result.identity, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("openCorrelatedRawDatabase surfaces the correlation failure even when handle close throws", () => {
  const base = makeBase();
  try {
    const dbPath = join(base, ".gsd", "gsd.db");
    // exec fails during open correlation and close() throws too. The identity
    // capture must still be released (try/finally — the leak is an open file
    // handle on Windows) and the caller must see the correlation GSDError,
    // not the secondary close failure.
    const raw = {
      exec(): void { throw new Error("correlation exec blew up"); },
      close(): void { throw new Error("handle close blew up"); },
    };
    assert.throws(
      () => _openCorrelatedRawDatabaseForTest(dbPath, () => raw),
      (error: unknown) => {
        assert.ok(error instanceof GSDError, "must surface the correlation GSDError, not the close failure");
        assert.equal(error.code, GSD_STALE_STATE);
        assert.match(error.message, /Database path changed while its handle opened/u);
        return true;
      },
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("checkpointDatabase and vacuumDatabase defer gracefully inside an open transaction", () => {
  const base = makeBase();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  try {
    const { logs } = captureLogs(() => {
      transaction(() => {
        // BEGIN IMMEDIATE inside an open transaction would fail raw with
        // "cannot start a transaction within a transaction" — maintenance must
        // defer with a warning instead of throwing out of the caller.
        checkpointDatabase();
        vacuumDatabase();
      });
    });
    const skipped = logs.filter((e) => e.component === "db" && e.severity === "warn"
      && /skipped inside an open transaction/u.test(e.message));
    assert.equal(skipped.length, 2, "both maintenance calls must defer with a db warning");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
